# Latency investigation — Apex PathLabs pilot (Workstream E)

**Goal:** break the 20–54 s end-to-end turn down into stages, say what is *measured*
and what is *not*, and propose only optimizations that are safe and tied to code we
actually read.

**Hard constraints for this document**
- Model, provider and token budgets stay **unchanged** (`qwen/qwen3.7-flash`,
  ~126k input / ~7.2k output tokens per turn are *observations*, not knobs to turn).
- No guardrail, gate, anti-ban control or deliberate wait may be removed as a "fix".
- Every claim below cites code. Anything not cited is marked
  **UNMEASURED — needs instrumentation**.

## 1. The pipeline, stage by stage

```
inbound msg → drain → enqueue(+debounce) → queue wait → claim → turn processing
  → context build → classifiers → model loop (N steps) → before_send chain
  → channel dispatch (WAHA) → closing checkpoint → job done
```

| # | Stage | Lives in | Nature |
|---|---|---|---|
| 1 | Inbound ingest / drain | `lib/agent-engine/edge/crm/drain.ts`, debounce in `edge/crm/debounce.ts` | deliberate wait (`INBOUND_DEBOUNCE_MS`, default **8000 ms** — `env.ts:148`) |
| 2 | Queue claim (`FOR UPDATE SKIP LOCKED`) | `lib/agent-engine/queue/queue.ts:126-149` (CLAIM_SQL), clock at `:194`, loop `workers/agent-worker/main.ts:529-545` | **queue wait** |
| 3 | Context build (opening ritual) | `lib/agent-engine/agent/inbound-turn.ts:1970-1975, 2396-2433, 2457-2464` | processing |
| 4 | Turn classifiers | `inbound-turn.ts:4494-4535` | processing (LLM) |
| 5 | Model call / agent loop | `edge/llm/run-model-call.ts`, call site `inbound-turn.ts:4686` | processing (LLM) |
| 6 | Before-send chain (advisory lock) | `guardrails/before-send.ts:1246-1491` | processing |
| 7 | Channel dispatch (WAHA) | `edge/channel/waha-adapter.ts:45` → `sendTurnMessage` | processing (network) |
| 8 | Post-send: closing checkpoint | `inbound-turn.ts:4943` (`purpose: 'checkpoint'`) | processing (LLM) |

### Queue wait vs processing — they are already separated

- `run_queue_wait_ms` = `claim − created_at`, **includes debounce** (`obs/metrics.ts:30,108`).
- `run_wall_ms` = `now − claim`, DB clock both ends (`obs/metrics.ts:33,125`).
- To split *deliberate* vs *slow*, the runbook already has the query:
  **`docs/runbooks/medir-custo-e-latencia-da-ia.md` §4** produces p50/p95 for
  `webhook → espera do dreno → debounce → fila → turno` and §5 for the two job metrics.
- Within *processing*, `run_llm_latency_ms` = sum of `llm_calls.latency_ms`
  (`obs/metrics.ts:104`, written at `run-model-call.ts:548,1063,1103,1117`).

**Queue wait is bounded by polling:** `QUEUE_POLL_INTERVAL_MS` default **2000 ms**
(`env.ts:84`, consumed at `main.ts:545`), claim retry 250 ms (`env.ts:90`), and drain
polls at 2000 ms idle 15000 ms (`env.ts:134-135`).

## 2. What can add latency, per stage (code evidence)

**1 — Ingest.** `INBOUND_DEBOUNCE_MS = 8000` default: a patient who types in bursts
waits the coalescing window before a job even exists. The runbook §3 calls reducing it
"uma decisão de anti-banimento, não conserto de desempenho".

**2 — Queue.** Up to one full poll interval before a ready job is claimed; up to
`QUEUE_MAX_CONCURRENCY = 8` (`env.ts:72`) jobs in flight; a lane is serialized per
`contact_id` (CLAIM_SQL dedup step), so a second job for the same contact waits.
Time the session was down is absorbed into this bucket (runbook §4 footnote).

**3 — Context build.** Already partly parallel: "as leituras da abertura correm em
QUATRO trilhas paralelas … em série eram 8 RTTs … assim são 2" (`inbound-turn.ts:2387-2395`).
Still **serial after** that: `lerCamadasDaOrg` (`:1970`), `fusoDaOrganizacao` (`:1975`),
then `getLeadContext` (`:2457`) and the channel instantiation. `get_lead_context` is
re-callable by the model as a free tool (`inbound-turn.ts:21`), i.e. each re-read is
also a whole extra model step, not just a query.

**4 — Classifiers.** `classifyStage`, `classifyJailbreak` and the Jev run in one
`Promise.all` (`:4494`) — already parallel. Each is still a model call charged to the
turn when enabled.

**5 — Model loop.** `AGENT_MAX_STEPS` default **8** (`env.ts:240`); tool rounds inside
one `runModelCall` are **sequential** (each round waits for the previous). `search_knowledge`
costs an embed HTTP call (`search-knowledge.ts:76`) plus a pgvector query, *inside* a
round — so one redundant knowledge search is worth a full extra round-trip. Then a
**second** model call for the checkpoint (`:4943`) and, if the turn ended silent, a
**third** correction call (`:4783`).

**6 — Before-send.** Runs under `pg_advisory_xact_lock(hashtext(channelSession_id))`
(`before-send.ts:1307`) — per-number serialization, including the channel POST
(header note `:38-40`). Already improved: human pause, `semantic_promise` and
`factual_claim` run **outside** the lock and in parallel (`:1290-1296`). Still inside
the critical path: gate state loads, and `throttleWaitMs` is slept there (`:1491`).

**7 — Deliberate waits (product, not slowness).** Human pause `900 + 22 ms/char`,
clamped `[1200, 7500]` (`atraso-humano.ts:56-65`) — but it **discounts** time already
spent (`inbound-turn.ts:3527`), so it usually approaches 0 on a slow turn. Anti-ban
jitter between bubbles `1200 + rand*800` (`inbound-turn.ts:3545-3551`). Typing signal is
fire-and-forget (`atraso-humano.ts:168`, `inbound-turn.ts:4673`) — not a wait.

**8 — Dispatch.** `waha-adapter.ts:45` → CRM sink HTTP; time is UNMEASURED.

**Prompt cache.** `buildStablePrefix` emits `providerOptions.anthropic.cacheControl`
only (`stable-prefix.ts:8-16,44-47`); providers that ignore the Anthropic namespace get
no provider-side prefix cache. Whether `qwen3.7-flash` hits any cache is directly
readable from `run_cache_read_ratio` (`obs/metrics.ts:27,100`).

## 3. Known vs unknown

| Quantity | Status |
|---|---|
| End-to-end turn: 20–54 s | **MEASURED** (pilot) |
| ~126k input / ~7.2k output tokens per turn | **MEASURED** (pilot) |
| `run_queue_wait_ms`, `run_wall_ms`, `run_llm_latency_ms`, `run_cache_read_ratio` | **AVAILABLE NOW** — same queries, runbook §5 |
| Share of the 20–54 s per stage | **UNMEASURED — needs instrumentation** (§5) |
| Queue wait vs debounce split for these turns | **UNMEASURED — needs instrumentation** (runbook §4 already computes it) |
| Number of model rounds (`steps`) per turn | **UNMEASURED — needs instrumentation** |
| Per-gate before-send time and lock wait | **UNMEASURED — needs instrumentation** |
| WAHA/CRM dispatch time | **UNMEASURED — needs instrumentation** |
| Whether provider prompt caching is active | **UNMEASURED — query `run_cache_read_ratio` first** |

## 4. Safe, evidence-backed shortlist

Ordered by (evidence × safety), not by assumed gain. None changes model, provider,
budget or output.

| # | Change | Expected effect | Risk | Why it is safe |
|---|---|---|---|---|
| O1 | Run the runbook §4 + §5 queries over the pilot turns **before changing anything** | Converts every "UNMEASURED" above into p50/p95 | none | read-only SQL |
| O2 | Read `run_cache_read_ratio` for this org; if ≈0, verify prefix byte-identity with `scripts/ops-count-prefix.ts` (measures the real prefix without a run) | Identifies whether 126k input is re-sent as cold prefill each turn | none | measurement + existing script; no config change |
| O3 | Fold the still-serial opening reads (`lerCamadasDaOrg`, `fusoDaOrganizacao`, `getLeadContext` — `inbound-turn.ts:1970,1975,2457`) into the existing 4-track `Promise.all` (`:2396`) | Removes ~1–2 RTTs to a *remote* DB per turn | very low — all read-only, no lock, no transaction (the comment's own pool reasoning at `:2391-2395` still holds) | pure reordering of independent reads |
| O4 | In the `search_knowledge` execute (`inbound-turn.ts:3222`), memoise by normalised query **within the same turn** | Skips a repeated embed HTTP + pgvector round inside the agent loop | very low | same query, same KB version ⇒ byte-identical result; no cross-turn cache, no guardrail touched |
| O5 | Tune tool descriptions so the model does not call `get_lead_context` when the opening already carries the window ("context already loaded this turn") | Fewer sequential rounds ⇒ fewer model round-trips | low | description text only; the tool stays available |
| O6 | Re-time the queue poll only after O1 shows `fila` (not `debounce`) is material: `QUEUE_POLL_INTERVAL_MS` is currently 2000 ms (`env.ts:84`) | Up to −2 s of pure polling on a ready job | low–medium: more idle DB queries; the code already warns against ≥10 s (`main.ts:619`) | does not touch model, prompt or any guardrail; behaviour of the job itself is identical |
| O7 | Persist the per-stage timers of §5 as `metrics` rows so the split is re-observable after every change | Regression visibility | none | additive observability |

**Note:** O6 is the only knob on this list, and it should not be touched until O1 says
queue wait is actually a meaningful slice of the 20–54 s.

## 5. What to instrument next

Add stage timers in the turn handler, emitted the same way `recordRunMetrics` already
writes to `metrics` (labels carry ids only — no PII):

1. **`turn_opening_ms`** — around `inbound-turn.ts:1970` → end of `getLeadContext` (`:2464`).
2. **`turn_classifiers_ms`** — around the `Promise.all` at `:4494`.
3. **`turn_model_ms`** — already covered per call by `llm_calls.latency_ms`; add
   **`turn_model_steps`** = `result.usage`/round count from the `runModelCall` at `:4686`
   to expose sequential rounds.
4. **`turn_before_send_ms`** and **`turn_lock_wait_ms`** — split `runBeforeSend`
   (`before-send.ts:1246`) into time-to-lock (`:1298-1307`) and time-under-lock
   (`:1307` → `:1491`); keep the existing `throttleWaitMs` (`:1491`) as its own field.
5. **`turn_dispatch_ms`** — around `waha-adapter.ts:45` (`send` → `sendTurnMessage`).
6. **`turn_checkpoint_ms`** — around `inbound-turn.ts:4943`.
7. **`turn_audience_waits_ms`** — record `atraso_ms` from the existing log line
   (`inbound-turn.ts:3537`) as a metric, so deliberate delay stops being log-only
   (runbook §3 currently admits it is not in the DB).

Then re-run the runbook §4 query: it already separates webhook / drain / **debounce
(deliberate)** / **fila (queue)** / **turno (processing)**, which is exactly the
queue-wait vs processing split this investigation needed.

## 6. Considered and REJECTED

| Idea | Why rejected |
|---|---|
| Swap or downgrade the model (or provider) | Forbidden: model/provider must stay unchanged |
| Lower `maxContextTokens` / history window / output budget to cut the 126k | Changes what the model sees ⇒ changes behaviour; budget constraint |
| Disable `AGENT_MAX_STEPS` rounds or force single-step | Removes tool use; changes behaviour |
| Drop the closing checkpoint call (`inbound-turn.ts:4943`) | Breaks memory/next-turn continuity; it is runtime-mandated |
| Disable any `before_send` gate (stop, LGPD, anti-ban, promise, `factual_claim`, `clinical_claim`, disclosure) | Drops guardrails; chain order/shape is version-locked (`BEFORE_SEND_CHAIN_VERSION = 9`, `before-send.ts:911`) |
| Shorten or remove the human pause / anti-ban jitter (`atraso-humano.ts`, `:3545-3551`) | Deliberate product + ban-protection decision, explicitly *not* a performance fix (runbook §3) |
| Reduce `INBOUND_DEBOUNCE_MS` (8000 default) | Same: coalescing/anti-ban decision, not slowness |
| Skip the anti-jailbreak/stage classifiers | Removes an advisory safety layer |
| Hold the advisory lock shorter by moving `send` out of it | Requires the reserve-then-reconcile redesign the header itself flags (`before-send.ts:38-40`); not a safe tweak |

## 7. Assumptions / blockers

- Pilot numbers (20–54 s, 126k/7.2k tokens, `qwen/qwen3.7-flash`) are taken as given;
  they were not reproducible from this repo alone.
- All SQL references assume the same schema the runbook documents; no DB access was
  performed for this document.
- No code was changed, no git command was run, and no model, budget, prompt pointer or
  session binding was touched.
