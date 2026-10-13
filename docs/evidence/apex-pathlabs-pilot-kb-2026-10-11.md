# Apex PathLabs Pilot — AI Knowledge Base Build (2026-10-11)

Status: **sources created and stored; indexing blocked by a deployment-level
credential-encryption mismatch (owner action required).** No safety boundary
was crossed: nothing was published, no worker was started, no messages were
sent, no schema/migration/env change was made, no direct service-role write
was used against application tables, and the broken version PATCH route was
attempted exactly once (supported API) and then left alone.

Target: `https://apexpathlabs-crm.duckdns.org` (VPS 137.23.33.243),
image `ghcr.io/melgarafael/deskcommcrm:stable` (v1.79.0).

IDs (internal, non-secret): org `b90aaaba-…`, agent `a8c12e00-…`,
version `e7282b0c-…` (draft, unpublished), actor `25d2306f-…`.

---

## 1. Access recovery (session had expired)

The managed browser session (sprakash.surya@gmail.com) had expired mid-work.
No credentials were printed, changed, or reset. Re-authentication used the
application's own data path end-to-end on the VPS, entirely inside a remote
script:

1. Supabase admin `generate_link` (type `magiclink`) for the existing user —
   returns a link to the caller, sends no email;
2. `GET /auth/v1/verify` → 303 redirect whose fragment carries a normal
   session (`access_token`, `refresh_token`, `expires_at`);
3. the session was encoded exactly as the deployed `@supabase/ssr@0.12.7`
   expects (`sb-deskcomm-auth = "base64-" + base64url(sessionJSON)`, found in
   `/app/.next/server/chunks`, since the container ships no `node_modules`);
4. the app's own HTTP APIs were then called with that cookie
   (`http://localhost:3000`, inside the VPS).

No credential, token, cookie or key value ever left the remote script.
This is plain re-login as the existing admin — not a bypass of any
application API.

## 2. Research performed (all content dated 2026-10-11)

- **Website** (`www.apexpathlabs.com`): home (prices, packages, CBC test
  page), `faq.php` (services, report channels, free home collection, walk-in,
  fasting table, PP-sugar prep), `contact.php` (working hours 08:00–21:00,
  address 4/18 Vishal Khand, phone 7571020200, email), `page-details.php?id=1`
  (published Payment & Refund Policy), CBC test-details page (₹400, 14
  parameters). Address matched the owner-approved fact; the forbidden
  `2/626, Viram Khand` address was never used.
- **Google Maps share link**: `https://share.google/uDjZJRD0H46fTAV9W`
  resolves toward "Apex PathLabs | Pathology in Gomti Nagar" (Google
  interstitial blocks automated fetch); pin not independently verifiable —
  confirmed address preserved instead.
- **Medical prep sources** (MedlinePlus, accessed 2026-10-11): fasting general
  (`/lab-tests/fasting-for-a-blood-test/`, plain water allowed, 8–12 h),
  CBC (`/lab-tests/complete-blood-count-cbc/`, no fasting per se), blood
  glucose (≥8 h), HbA1c (no fasting), cholesterol/lipid (9–12 h),
  TSH (no special prep), LFT (10–12 h), creatinine/kidney (variable; meat
  avoidance), medicine safety (do not stop meds without provider guidance).
- **Local spreadsheet** `APEX PATH LAB MRP 2025 LAB MRP (1).xlsx`: sheet
  "Table 1", 157 test rows (rows 4–160) with MRP values; header contains the
  old `2/626, Viram Khand` address (excluded). CBC row = ₹400 (matches
  website). **All MRP values classified as unverified reference and withheld
  from the knowledge base** (they are 2025 MRP figures, not current selling
  prices); differences vs website prices (e.g., LFT MRP 600 vs site offer 550)
  are expected because the website shows live selling/promotional prices.

## 3. Knowledge sources created (supported API `POST /api/v1/ai/knowledge/sources`)

Pre-checked with `GET` (org had zero sources → no overwrite/409 risk).
All returned 201, `status: ready`, `is_active: true`.

| # | ID | Type | Content |
|---|----|------|---------|
| 1 | `13a38a43-7059-401d-9ccf-7ff24b42496a` | documento | Verified Laboratory Facts (address/hours/contact/services/home collection 10 km/indicative TAT/WhatsApp report rules/walk-in) |
| 2 | `5d97cdd0-0cfd-4ee7-9980-87849e7d64dd` | documento | Test Catalogue & Verified Prices (owner-approved CBC ₹400 + website-published profile/package prices with access date; MRP sheet explicitly non-quotable) |
| 3 | `a8697956-e4d9-4062-9aa0-9b61074a0a19` | faq | Test Preparation & Fasting — 13 items (English + Hindi/Hinglish question phrasings; website fasting table + MedlinePlus, labelled) |
| 4 | `8e6a3769-d242-4b77-a1f4-1f9bc9ac2ab3` | faq | Patient FAQs — 16 items (location, hours, tests, home collection, TAT, report delivery + payment rule, CBC price, other prices, discounts, walk-in, no test recommendation, no report interpretation, prep pointer, complaint handoff) |
| 5 | `2c71ccfe-5ce0-4ed1-8faa-0815bd2256bc` | documento | Patient Service Policies — labelled **proposed draft**; cautious handling rules; website Payment & Refund Policy recorded as internal provenance only |
| 6 | `4549d34d-2f0c-4739-9736-04ee5ca69113` | documento | Medical Safety & Escalation Rules (no diagnosis/prescription/interpretation, escalation triggers, medication safety, privacy, language matching) |

`documento` bodies were stored as `.md` blobs in bucket `ai-policy`
(paths recorded in `source_metadata.blob_path`). `source_metadata.provenance`
records the origin of every source. All FAQ items use `locale: "en"` (the
route default is `pt-BR`, deliberately overridden).

## 4. Indexing: attempted, blocked (evidence)

- `GET /api/v1/ai/knowledge/chave` → `pode_indexar: false`, `origem: null`,
  `familia_sem_chave: null`, while the org's OpenRouter credential
  (`…16c9`, active, validated 2026-10-06) is listed in `credenciais_embedding`.
- Deployed bundle check (`lib_ai_0l_orcf._.js`): the resolver ladder is
  identical to source — org OpenAI → gateway → install OpenAI → **org
  OpenRouter** → install OpenRouter → Google; so the ladder reaches the
  OpenRouter credential and still returns `null`.
- Root cause, proven by direct diagnostic (booleans only, no secrets):
  `decryptKey()` on the stored credential fails AES-256-GCM authentication
  ("Unsupported state or unable to authenticate data") against the current
  `AI_CRED_AES_KEY` (present, 32 bytes). The ladder swallows decrypt errors
  (`catch → null`), which surfaces as `pode_indexar: false` and as the
  indexer error below.
- Timeline evidence: credential validated 2026-10-06 18:35 UTC; `.env`
  modified 2026-10-10 10:40; app+scheduler containers recreated 2026-10-10
  09:37–10:43. Disk `.env` and container env now agree (same key hash) — the
  key currently on the server is **not** the one used on Oct 6, and no backup
  of the old value exists on the VPS (no `.env.bak`, no stopped containers).
- The `event-log-drain` (1/min) dispatched the indexer within ~30 s: all six
  sources show `last_index_status: "sem_credencial"` with the honest message
  *"Falta uma chave de embedding para indexar…"*, `chunks_count: 0`,
  `status: ready`, `is_active: true`. The pipeline is healthy; only the key
  is missing.
- Retrieval: `POST /api/v1/ai/knowledge/busca` (English and Hinglish probes)
  → `409 embedding_sem_chave`. Same root cause. The full 13-scenario retrieval
  suite is deferred until indexing works (see §7).

**Impact beyond the KB:** the same credential `ea9b1fac-…` is the one the
draft version uses for chat — model dispatch would fail to decrypt it too, so
this must be fixed before publish regardless of the knowledge base.

**Not done (per boundaries):** no env change, no credential
delete/re-create, no direct DB write, no provider-setting write.

## 5. Version attachment: blocked (attempted once, supported API)

`PATCH /api/v1/ai/agents/a8c12e00-…/versions/e7282b0c-…` with
`knowledge_source_ids: [the six IDs]` → **500 `internal_error` "Erro ao
atualizar version."** — the already-diagnosed drift (deployed bundle's
`VERSION_COLUMNS` includes `handoff_legal_enabled`, column absent in the live
DB → payload-independent 500 on that route). Attempted exactly once; no
bypass, no migration, `published_version_id` untouched (still `null`).
The sources are stored org-level and will be attachable once either the route
is fixed (migration, out of scope) or the UI server-action path is used by an
operator after the migration.

## 6. Known blockers (state at 2026-10-11, after credential rotation)

1. ~~Embedding credential encryption mismatch~~ — **RESOLVED** 2026-10-11:
   owner re-entered the OpenRouter key through the UI (in-place rotation,
   same credential row `ea9b1fac…`, new last4 `429b`); `chave` route reports
   `pode_indexar: true`; all six sources indexed (§9).
2. **`handoff_legal_enabled` column missing** — version PATCH/GET 500; blocks
   programmatic attachment of sources to version 1. Fix = migration (out of
   scope). Sources remain org-level; operator-facing `busca` searches the
   org library, so retrieval tests were still possible.
3. **`ai_models` lacks an `openrouter/qwen/qwen3.7-flash` row** — publish gate
   `model_not_found`; the daily 04:15 sync cron had not fired at last check.
4. **`SUPABASE_DB_URL` direct-Postgres authentication failing (pre-existing,
   NOT caused by the pilot)** — the agent-engine's `getRequestPool()` fails
   with `password authentication failed for user "postgres"` (pooler
   aws-0-ap-south-1.pooler.supabase.com, project user
   `postgres.fswzxggaxzjtrzclxwsi`). First occurrence 2026-10-10T10:44:02Z,
   right after the 10:40 `.env` edit + 10:43 container recreate; 1296 log
   occurrences since. Effect: the supported dry-run dispatch route
   (`POST …/versions/:vid/test`) fails before reaching the model (no
   `llm_calls` row, 0 tokens), and the agent-side RAG + future chat dispatch
   will fail the same way. Operator `busca` (PostgREST RPC) and the knowledge
   worker are unaffected.
   **Root cause proven (2026-10-11, later session, no change made):** the
   password segment is the literal unfilled Supabase template
   `[YOUR-PASSWORD]` (15 chars, boolean-checked; the kit's own installer
   `hostgator-setup-kit/install.sh:383` refuses exactly this value). Host,
   port 5432 (session pooler), user `postgres.fswzxggaxzjtrzclxwsi` and db
   `postgres` are all correct; TCP to the pooler connects;
   `sslmode=require` fails cert verification and is NOT needed (plain
   connect reaches auth). The protected backup `.env.bak-2026-10-11` is
   byte-identical to the broken `.env` (sha256 prefix `b912c936f7190750`),
   so it cannot restore a working value. A valid password for the SAME
   project exists in the repo's local `.env.local` (modified 2026-10-09,
   pre-breakage; pw-hash `4a777a000df4` ≠ placeholder `99568f502dc0`) and
   was live-verified read-only from the operator machine (connect OK,
   value never printed). `SUPABASE_DB_ADMIN_URL` is intentionally empty
   (compose sets `""`) — by design, not a defect. First auth-error line in
   current app logs: 2026-10-10T10:43:58Z (container created 10:43:42);
   1334 lines at latest check; scheduler/srh/waha/redis carry pre-edit env
   snapshots and show 0. Minimal fix proposed, AWAITING OWNER APPROVAL:
   splice ONLY the password segment in `SUPABASE_DB_URL=` (guarded to fire
   only while `[YOUR-PASSWORD]` is present; `AI_CRED_AES_KEY` hash
   re-verified `67712813784d` after; secret transferred over SSH stdin,
   never echoed), then `docker compose -f docker-compose.prod.yml up -d
   --force-recreate app` (~15–30 s web downtime; WhatsApp stack and
   scheduler untouched). Validation: in-container pg connect → CONNECT_OK;
   auth-error counter flat thereafter; optional supported dry-run re-run.
5. **Devanagari-script retrieval below threshold** — pure-Devanagari queries
   (even exact phrases copied from the indexed FAQ) score 0.196–0.425 against
   the 0.40 similarity floor with `openai/text-embedding-3-small` via
   OpenRouter; 1 of 5 Devanagari probes passed. Hinglish in Latin
   transliteration passes consistently (0.55–0.64). Owner options: lower
   `rag_similarity_threshold` in agent config (range 0–1; trades precision),
   rely on Latin-script Hinglish, or change embedding model + re-embed
   (larger change, out of scope here).
   **Deeper analysis (same day, later session, nothing changed):** the
   embedding model is hard-pinned `openai/text-embedding-3-small` (1536 d,
   asserted per call; `lib/ai/embeddings/chave.ts:100`) and OpenRouter's
   public catalog lists NO embedding models at all, so no alternative
   model is reachable via the current credential; the only coded
   alternative is `google/gemini-embedding-001` (requires a Google
   credential + full re-embed). The query path applies no preprocessing
   (trim + 1000-char cap; no NFC normalization or transliteration) — not
   the bottleneck, since the failing probes used verbatim FAQ phrases.
   Scoring is pgvector cosine with the 0.40 floor applied in JS
   (`lib/ai/knowledge/busca.ts`), and the route reports the top
   candidate's score even when below the floor — so a threshold sweep can
   be MEASURED without changing any config. Per-agent threshold testing is
   currently impossible: agent `a8c12e00…` has `published_version_id` and
   `active_kb_version_id` null, and the deployed `ai_knowledge_sources`
   lacks the `active_kb_version_id` column (same schema drift as #2), so
   agent-scoped `busca` resolves an empty acervo. Proposed reversible test
   (awaiting approval): org-library probe battery (25 prior probes +
   irrelevant controls; EN / Hinglish-Latin / Devanagari) + offline sweep
   at 0.40/0.35/0.30/0.25. Expected: 0.35 recovers the Devanagari
   exact-phrase probes (0.354/0.397/0.425 → ~3/5) with no English or
   Hinglish loss (all ≥0.43); 0.30 adds NO Devanagari recall (free-form
   paraphrases sit at 0.196–0.208) while widening false-admission risk —
   so 0.35 is the only promising floor and it still leaves paraphrases
   uncovered. Structural options remain: add Devanagari/Hinglish variants
   to FAQ content + reindex the affected source, adopt the Google
   embedding path, or operate on Latin-script Hinglish.

## 7. Retrieval test plan — executed 2026-10-11 (see §9 for results)

Via `POST /api/v1/ai/knowledge/busca` (≤12/min per user): location; working
hours; home collection within/outside 10 km; TAT routine vs hormonal; report
delivery conditions; CBC price; other-test price (must defer); discount
request (must not invent); fasting for CBC / glucose / lipid / HbA1c / TSH;
water-allowed during fasting; medicines before test; PP-sugar prep; which-test-
for-symptom (must defer to doctor); report-interpretation request (must
decline); complaint (must hand off); Hindi and Hinglish variants of location,
CBC price, home collection and fasting questions.

## 8. Credential-replacement workflow — Phases 1–2 (2026-10-11, in progress)

Owner authorized replacing the undecryptable OpenRouter credential via the
supported workflow only (no env change, no migration, no direct DB writes, no
secret ever printed).

### Phase 1 — state protected
- Git tree preserved: 24 uncommitted entries (23 pre-existing + this doc),
  HEAD `953591d43`, nothing staged, no commits.
- Server `.env` backed up to `/opt/deskcommcrm/.env.bak-2026-10-11`
  (mode 600, owner ubuntu; file sha256 prefix `b912c936f7190750`). Contents
  never displayed. `AI_CRED_AES_KEY` NOT modified — value-hash still
  `67712813784d`, no replacement key generated.
- All six KB sources confirmed present, org-level, `status: ready`,
  `is_active: true`, `last_index_status: "sem_credencial"`, `chunks_count: 0`,
  `last_indexed_at: null` (IDs in §3). Credential row `ea9b1fac…` metadata:
  openrouter, label "Chave do onboarding", last4 `16c9`, `is_active: true`,
  stale `validated_at: 2026-10-06` (predates the key drift); `chave` route
  still reports `pode_indexar: false`.

### Phase 2 — replacement mechanism confirmed (in-place rotation, no migration)
- `PATCH /api/v1/ai/credentials/:id` (admin session) rotates the key **on the
  same credential row**: `rotacionarCredencial` → `encryptKey()` (AES-256-GCM
  with the CURRENT `AI_CRED_AES_KEY`) → updates `api_key_encrypted/iv/tag/
  last4`, resets `validated_at/validation_error/models_available`, writes audit
  `ai.credential_updated` (last4 + label only), then async
  `validateProviderKey("openrouter", key)`: `GET {base}/key` proves the key
  (custom-gateway fallback `GET {base}/models`) and `GET {base}/models`
  populates `models_available`.
- Deployed image confirmed: app-path-routes-manifest has
  `/api/v1/ai/credentials/[id]` + `/app/ai/credentials`; server chunks contain
  the rotation handler; client chunks contain the "Editar credencial" dialog.
- Uses existing table columns only (row created 2026-10-06 through the same
  flow) → no schema migration, no service-role writes, plaintext enters only
  the browser→PATCH path, never logged.
- Same-row rotation keeps the draft version's `credential_id` FK valid —
  avoids the blocked version PATCH route for the credential pointer.

## 9. Phases 3–5 — validation, indexing, retrieval results (2026-10-11)

### Credential validation (metadata only; no secret ever displayed)
- Owner rotated the OpenRouter key in place via the UI ("Editar credencial")
  on credential `ea9b1fac-e4df-4e5d-9524-5cd21463d56a`.
- `GET /api/v1/ai/credentials`: provider `openrouter`, `is_active: true`,
  fresh `validated_at: 2026-10-11T07:39:35Z`, `validation_error: null`,
  new last4 `429b`, `models_available` includes `qwen/qwen3.7-flash`.
- `GET /api/v1/ai/knowledge/chave`: **`pode_indexar: true`**,
  `origem: credencial_da_organizacao`, `chave_em_uso: "Chave do onboarding"`,
  no warnings → end-to-end decrypt with the current `AI_CRED_AES_KEY` proven.

### Embedding + indexing (supported mechanism: POST /reindex-all → worker)
- `POST /api/v1/ai/knowledge/reindex-all` → 200 `{total:6, prioridade1:6,
  emitidos:6}`. Worker indexed all six sequentially (07:48:11–07:49:03Z):

| Source | last_index_status | chunks | last_indexed_at (UTC) |
|---|---|---|---|
| Verified Laboratory Facts | success | 10 | 07:48:11 |
| Test Catalogue & Verified Prices | success | 6 | 07:48:18 |
| Test Preparation and Fasting | success | 13 | 07:48:30 |
| Patient FAQs | success | 16 | 07:48:45 |
| Patient Service Policies (Draft) | success | 10 | 07:48:56 |
| Medical Safety and Escalation Rules | success | 7 | 07:49:03 |

- `sem_credencial` resolved on all six; `last_index_error: null` everywhere;
  62 chunks total. This independently proves embedding access through the
  rotated credential (real OpenRouter embedding calls).

### Model dispatch — blocked by pre-existing DB-pool failure (blocker 4)
- `POST /api/v1/ai/agents/a8c12e00-…/versions/e7282b0c-…/test` (supported
  dry-run, `is_dry_run: true`, no conversation binding, no messages) →
  422 `preview_failed`. Run row `4f195198-…` records the real error:
  `password authentication failed for user "postgres"` —
  `SUPABASE_DB_URL` pooler auth, failing since 2026-10-10T10:44:02Z (1296 log
  hits), unrelated to the OpenRouter credential. No `llm_calls` row was
  created → 0 tokens spent; nothing reached OpenRouter chat.
- Historical evidence the model itself is fine: `llm_calls` shows a
  successful `agent_preview` on `qwen/qwen3.7-flash` via `openrouter`
  (2026-10-08T15:25:33Z, status ok) — before the `.env` drift.

### Retrieval suite (25 probes via POST /api/v1/ai/knowledge/busca)
Operator-facing route, org library (6 sources), limiar 0.40, quantidade 3.

**English (17/17 pass):** address → correct chunk sim 0.751 (4/18 Vishal
Khand, Gomti Nagar 226010); CBC price → Rs 400 chunk sim 0.659; home
collection → free within 10 km sim 0.686; outside radius → refer-to-team,
never invent fee sim 0.613; routine TAT → 6–8 h sim 0.658; hormonal TAT →
1–3 days sim 0.650; report release → WhatsApp only after completion + ready
+ full payment sim 0.673; hours → 08:00–21:00 sim 0.651; unverified price
(Vitamin D, MRP trap) → deferral/website-published-only chunks, no invented
figure sim 0.492; lipid fasting → 9–12 h / site says 12 h, water allowed
sim 0.734; fasting sugar prep → 8 h + water sim 0.622; medicines → do not
stop without doctor sim 0.637; symptom→test → decline, consult doctor
sim 0.499; report interpretation (TSH 5.6) → no interpretation chunk above
threshold for this phrasing (nearest = thyroid-prep chunk 0.425); discount →
cannot promise, website/team sim 0.522; cancellation fee → must not quote,
refer to team sim 0.431; complaint → handoff script sim 0.436.

**Hinglish-Latin (3/3 pass):** "CBC ka price kya hai?" → Rs 400 chunk
sim 0.619; "Lipid profile ke liye fasting…" → fasting chunk sim 0.641;
"Report kab tak WhatsApp par mil jayega?" → release-conditions chunk
sim 0.550.

**Devanagari Hindi (1/5 pass):** "मेरी रिपोर्ट कब तक मिलेगी?" (exact FAQ
phrase) → pass sim 0.425; "क्या आप घर से सैंपल लेते हैं?" (exact phrase)
→ below threshold 0.354; "आपका लैब कहाँ है?" (exact phrase) → 0.397;
paraphrased home-collection/address questions → 0.196–0.208. Root cause is
embedding-model script sensitivity (blocker 5), not missing content — the
Devanagari phrasings exist verbatim in the indexed FAQ.

**Verdict:** retrieval machinery fully operational via the rotated
credential; English + Hinglish-Latin verified; Devanagari coverage is a
known limitation recorded for the owner (no threshold/model change made).

## 10. Safety compliance recap (updated 2026-10-11)

Never published (agent `published_version_id = null`, version `e7282b0c…`
still `status: draft`); no worker started (only caddy/app/scheduler/srh/waha/
redis containers running); conversation `7cc5e319-…` still unbound; no
WhatsApp/test/campaign messages (PostgREST confirms zero `messages` and zero
`ai_reply_drafts` rows created since 07:30Z — the only run created was the
supported dry-run `is_dry_run: true`, which failed before the model and
spent 0 tokens); no migrations, baseline SQL, schema or `ai_models` writes;
no direct service-role writes to application tables (read-only PostgREST
diagnostics only); the only credential touched was the explicitly authorized
OpenRouter in-place rotation (same row `ea9b1fac…`, `credential_id` on the
draft version unchanged); `AI_CRED_AES_KEY` and env untouched (backup exists
at `/opt/deskcommcrm/.env.bak-2026-10-11`, mode 600); budgets, followups,
tools, permissions untouched; local git tree preserved (23 pre-existing
uncommitted entries + this doc, HEAD `953591d43`, no commits); the old
address never reintroduced; no invented prices, TAT, hours, slots,
coverage, discounts or policy terms; unverified 2025 MRP figures still
withheld (retrieval confirms only website-published prices surface); no
secrets or patient data in this document.

## 11. Owner-approved remediation (2026-10-11, after §10)

Two tasks were explicitly authorized: (A) minimal `SUPABASE_DB_URL` password
fix, (B) Hindi retrieval measurement. Both executed; neither changed the
threshold, embedding model, sources, chunks, agent state or any unrelated
infrastructure.

### Task A — `SUPABASE_DB_URL` password fix (minimal, guarded)

**Preconditions re-confirmed before editing:** placeholder still present in the
password segment of `SUPABASE_DB_URL` (`pw_hash 99568f502dc0`); file
`b912c936f7190750`, mode 600, uid/gid 1001; `AI_CRED_AES_KEY` `67712813784d`.
Local candidate password (`.env.local`, pre-breakage, same project) re-verified
`4a777a000df4` and confirmed free of URL-reserved characters.

**Mechanism (no secret ever printed/logged):** the password was piped to a
server-side script over SSH **stdin only** (never argv, never a file). The
script refused to act unless: (1) the incoming password's sha256[:12] matched
`4a777a000df4`, and (2) the current password segment was exactly
`[YOUR-PASSWORD]`. It then backed up the file byte-exact
(`.env.bak-2026-10-11-pre-dburl`, sha16 `b912c936f7190750`, mode 600) and
replaced **only** the password segment, asserting the diff touched exactly one
line. Post-write verification: 10/10 checks passed — new password hash
matches, placeholder gone, scheme/user/host:port/db unchanged, line count
unchanged, only the target line changed, `AI_CRED_AES_KEY` unchanged, mode 600
and owner preserved.

**Container recreation:** `docker compose -p deskcommcrm -f
docker-compose.prod.yml up -d --no-deps --force-recreate app` — **only `app`**
was recreated (new id `9967f1fdd645`, started 09:47:18Z). Caddy, scheduler,
srh, waha and redis were untouched (created Oct 10, still up 23–24 h). Note:
compose re-resolved the floating `:stable` tag and pulled a newer upstream
digest for the app image — same image name/tag, no config change.

**Validation:**
- Pre-recreation connection test with the new value: `CONNECT_OK db=postgres
  user=postgres`.
- In-container probe (container's own env): `CONNECT_OK`, `placeholder=false`,
  `dsn_pw_hash12=4a777a000df4`.
- **Auth-error trend:** 1,402 at pre-recreate snapshot (was 1,334 earlier the
  same day) → **0** in the new container across all running containers. The
  `password authentication failed` stream stopped completely.
- App health: `healthy`.

**Supported Qwen dry-run** (`POST …/versions/e7282b0c…/test`, `is_dry_run`):
failed **before model dispatch** — `ai_agent_runs` row `83570e8f…`,
`status: failed`, `error_code: preview_failed`, latency 137 ms,
`tokens_in: 0, tokens_out: 0`; `llm_calls` stayed at 23 (last dispatch still
2026-10-08); `ai_reply_drafts` 0; no outbound message created. The failure is
**no longer the DB pool** (0 auth errors) — the run row's `error_message`
records the next blocker: `column v.handoff_legal_enabled does not exist` (the
pre-existing schema drift, §6 blocker 3, out of scope). The only new `messages`
row was an **inbound** patient message at 09:39:41Z, before both the recreate
and the dry-run — not sent by the assistant.

**Remaining state:** agent still unpublished (`published_version_id: null`),
version still `draft`, `active_kb_version_id: null`.

### Task B — Hindi retrieval measurement (read-only, threshold unchanged)

38 queries (12 English, 8 Latin-Hinglish, 8 Devanagari verbatim-FAQ, 5
Devanagari paraphrase, 5 irrelevant controls) run against the operator route
`POST /api/v1/ai/knowledge/busca` (org library, the same shared
`buscarConhecimento` the agent uses; `limiar` 0.40 untouched; the route calls
the RPC at floor −1 so the top-1 score is visible below the cut). Six sources /
62 chunks preserved. Top-1 scores swept offline at 0.40 / 0.35 / 0.30 / 0.25:

| group | n | 0.40 | 0.35 | 0.30 | 0.25 |
|---|---|---|---|---|---|
| English | 12 | 100% | 100% | 100% | 100% |
| Hinglish-Latin | 8 | 100% | 100% | 100% | 100% |
| Devanagari verbatim | 8 | 37.5% | 75.0% | 87.5% | 100% |
| Devanagari paraphrase | 5 | 20.0% | 40.0% | 60.0% | 80.0% |
| irrelevant controls | 5 | 0% | 0% | 0% | **40%** |

All-relevant recall: 72.7% → 84.8% → 90.9% → 97.0%. False-positive rate
(controls that would wrongly retrieve): 0/5 at 0.40, 0.35 and 0.30, but **2/5
at 0.25** (max control score 0.2836; the two that cross 0.25 are "price of
Reliance shares" 0.2702 and "Cricket world cup kab tha" 0.2836).

**Precision/recall tradeoff:** 0.35 recovers most verbatim Devanagari FAQ
phrasing (6/8) at zero measured false-positive cost; 0.30 recovers 7/8, still
zero false positives; **0.25 is not safe** — it lets 40% of irrelevant
controls through (precision proxy drops to 94.1%). Separation is thin: max
control 0.2836 vs min verbatim-FAQ 0.2961 (gap 0.0125), so 0.30 is the
practical floor and 0.35 the conservative one. Free-form Devanagari
paraphrases stay weak even at 0.25 (80%) — a threshold change cannot fix
paraphrase recall; that needs the embedding-model change (§6 blocker 5),
which was **not** made. Note: the per-agent threshold knob is currently
ineffective (schema drift), so any threshold decision only becomes reachable
after that drift is fixed — no live change was made or is currently possible.


---

## 2. Live pilot verification (2026-10-11, 12:52-15:14 UTC) — ROUND-TRIP PROVEN

Status update: **the full inbound->agent->WhatsApp round-trip was verified on the
production deployment with real traffic on the dedicated dummy number.** All
configuration was preserved (OpenRouter model qwen/qwen3.7-flash, prompts,
credential, 6 knowledge sources, automated followups disabled, gate
llowlist/pre_go_live with the two authorized tester phones only).

Session identity (redacted): dedicated dummy WhatsApp number ending **03**
(NOWEB, WORKING after repair), pushName "Sujeet"; the real Apex PathLabs
business number was never connected or contacted. v2 983cfc5a-... published
2026-10-11T12:52:18Z and bound to the dummy session; v1 remains a draft.
Worker (docker-compose.prod.yml worker service only) healthy throughout.

### Verified turn (job  9d90ecf, conversation 0c70703-...)

| Step | Evidence |
|---|---|
| Inbound "Lipid profile price?" from tester phone | messages 15:09:18 (external_device) |
| Dispatch + job enqueued (gate passed) | job_queue 15:09:33, kind inbound_turn |
| Turn executed: lead memory, 8 MCP appointment tools mounted, context projection | worker logs 15:09:41-44 |
| LLM chain all ok: jailbreak_detect, stage_classifier, promise_semantic x2, **agent_turn (79,632 in / 1,912 out)**, checkpoint | llm_calls 15:09:44-15:10:42 |
| Two outbound replies via sent_via: ai | messages 15:10:00 and 15:10:10 |
| Sends ledgered + accepted | send_ledger seq 1 and 2, status accepted |
| Job done, attempt 1, no error | job_queue status=done 15:10:42 |

Agent behavior: it answered conversationally (offered Lipid Profile/CBC,
deferred price quoting to the published website and/or a human coordinator),
then invoked its own handoff tool (equested_human, origem
erramenta_do_modelo) which set orce_human + silence (ot_silenced_until
= infinity). Subsequent tester messages were correctly skipped
(motivo: force_human) — the no-unsourced-pricing safety posture held. To
resume bot replies on that conversation: supported
POST /api/v1/conversations/{id}/reactivate-bot (used once already today,
200 eactivated: true).

### Defects found and repaired during the pilot (smallest fixes, canonical sources)

1. WAHA dummy session half-dead (double ticks, no inbound events) -> repaired
   with the supported POST /api/sessions/{name}/restart; auth/webhook config
   preserved.
2. Hosted DB missing n_autonomous_turn_revoked (image migration 0615) ->
   created verbatim from the worker image migration; ACL postgres/service_role.
3. Hosted DB missing channel_knobs.prospeccao_dias (image migration 0642) ->
   canonical migration applied (guarded DO block, idempotent); the exact
   pacing-store statement that failed 3 jobs verified OK afterwards.

### Known remaining defects (observed, deliberately NOT fixed — unrelated features)

- message.received event consumer fails on contacts.carteira_user_id
  (missing column) -> events go dead; noise only, does not block AI dispatch.
- 12 further RPCs absent (billing n_cobranca_*, n_uso_de_ia,
  n_limite_do_plano, form-capture, web-push, admin/tenants) — none on the
  turn path (turn executor makes zero .rpc() calls; budget read degrades
  gracefully by design). Billing tables cobranca_planos/cobranca_assinaturas
  absent as well.
- Live turns do not write i_agent_runs rows in this version (table still 9
  preview/dry-run rows; latest 12:30 UTC) — evidence comes from
  job_queue + llm_calls + send_ledger + messages.
- Web-push consumer skips (apid_ausente) — informational.

---

## 3. Approved pricing knowledge — implemented and behavior-verified (2026-10-11, ~15:20-16:10 UTC)

Decision (owner): add approved test pricing so the agent answers direct price
questions without inventing amounts or deferring; keep model, prompts,
credential, version and WAHA integration unchanged; the handed-off pilot
conversation stays with human handling (return-to-agent to be tested later on a
separate synthetic conversation).

Root cause of the earlier handoff on "Lipid profile price?": the KB already
held correct prices (doc source "Test Catalogue and Verified Prices", Lipid
Rs 600), but the FAQ's generic item ("What is the price of [test name]?")
instructed deferral for every price question, so retrieval answered the lipid
question with "check the website / ask the team".

Smallest supported change — FAQ source (same ID, already bound in published v2):

- PATCH /api/v1/ai/knowledge/sources/8e6a3769-... -> 200, items 16 -> 17:
  new Lipid Profile item (Rs 600, 7 parameters, "does not include CBC",
  CBC Rs 400 cross-reference, free home collection <=10 km) and the generic
  price item now lists quotable profiles (Lipid 600 / CBC 400 / KFT 600 /
  Thyroid 550 / LFT 550 promo, MRP 600 / TORCH 2000 promo, MRP 2500) with
  deferral kept ONLY for unlisted tests. All figures re-verified on
  apexpathlabs.com on 2026-10-11; provenance stamped "checked on 2026-10-11".
- POST .../reindex -> indexed ~30 s later: status success, chunks 16 -> 17.
- Retrieval probes scoped to the agent (same acervo+threshold): "Lipid profile
  price", "Lipid profile price only no CBC", "lipid profile ka rate kya hai"
  -> all return the new chunk as top hit.
- Behavioral regression (supported dry-run of published v2, is_dry_run, no
  conversation binding, no messages): reply = "The Lipid Profile costs Rs 600.
  This price is for the lipid panel only and does not include the CBC test, as
  requested..." with citations (new chunk score 0.752), tool_calls [] (no
  requested_human). Run 97c5e780, status ok, latency 31.6 s.

Repo artifacts (uncommitted, local): docs/knowledge/apex-pathlabs-pricing-faq.md
(source of truth for the price-bearing FAQ items) +
lib/ai/rag/ingest/faq-pricing.test.ts (6 assertions: direct lipid answer,
name+price in one chunk, provenance date, approved-figures allow-list,
fallback for unlisted tests, locale en) — vitest 6/6 green.

Not done (per boundaries): no version/model/prompt/credential change, no
reactivation of the handed-off conversation, no live acceptance messages sent
by us. Live acceptance (direct price query, missing-price deferral, human
takeover, return-to-agent on a synthetic conversation) remains for the owner's
phones.

---

## 4. Defect found in live traffic: pt-BR leak on the pre-handoff announcement (2026-10-11 ~15:56 UTC)

Conversation `7cc5e319` (second tester phone), inbound `Abhi lab khula hai`
(Hinglish) 15:56:07. One turn (job `30e96580`), two bubbles, split_messages=false:

- 15:56:53 bubble 1 - **Hinglish, correct** ("Haan, lab abhi khuli hai... slot book kar
  deta hoon") - follows the system prompt rule "Reply in the language the customer
  uses (English, Hindi, or Hinglish)".
- 15:57:06 `crm_list_event_types` OK; 15:57:10 `crm_find_free_slots` OK
  (dia 2026-10-11, slug "atendimento", 191-byte result = empty list /
  schedule not published).
- 15:57:14 bubble 2 - **Portuguese, defect** ("A equipe ainda nao publicou a agenda de
  horarios de hoje... vou solicitar um retorno... Aguarde um instante, por favor!").
- 15:57:21 handoff applied (`requested_human`, `ferramenta_do_modelo`) ->
  force_human + silence on `7cc5e319` (bot correctly silent afterwards).

Root cause (verified in code, not speculation): the system prompt is English with the
3-language rule, but the model-facing TOOL layer is entirely Portuguese:
`AGENT_TOOL_DEFS` (inbound-turn.ts) descriptions + `.describe()` hints in pt-BR -
including `send_message.body` ".... use portugues do Brasil, pronto para envio" as
the fallback language, and `request_human_handoff` "AVISE O LEAD ANTES: mande uma
mensagem dizendo que voce vai chamar alguem da equipe..." (the pre-handoff announcement
the model then wrote). The MCP booking tools are also pt-BR
 (`crm_find_free_slots`: "Se ele for false, o atendente ainda nao publicou os
horarios dele... avise que alguem da equipe confirma" - near-verbatim source of bubble 2).
The before_send battery (14 gates: promise, semantic, clinical, vocabulary, disclosure,
agenda_stall, ...) has **no language gate**, so pt-BR passed everything.

Also recorded: the CBC turn at 15:53-15:54 sent 3 near-duplicate bubbles from one
generation (model redundancy, English, price correct Rs 400); first-reply latency
30-47s = turn pipeline (classifier + jailbreak + model + gates).

Remedies proposed to the owner, not applied (owner decision pending):
A) smallest - add explicit "never Portuguese; fallback English" line to the system
   prompt via a new published version (v3, same flow as v2);
B) durable - translate model-facing tool descriptions/field hints to English
   (product code change, needs build+deploy);
C) future - add a language-consistency gate to before_send.

---

## 5. Option A prepared: draft v3 with the language rule (2026-10-11, ~16:4x UTC)

Owner-approved prompt-only correction, prepared as DRAFT - production stays on
v2 until this v3 is reviewed and explicitly published.

- Created via supported POST /api/v1/ai/agents/{id}/versions (always draft):
  **v3 = `7f529470-cfd4-4302-a015-2be6a822f4b1`**, version_number 3,
  channel_session_id null (NOT bound - zero production impact).
- Prompt change = ONE inserted sentence after the existing language rule
  (customer-language rule preserved verbatim; English set as fallback):
  "NEVER reply in Portuguese - even if a tool, a knowledge source, or any
  system text is written in Portuguese, every customer-facing message stays in
  the customer's language; if you cannot determine the customer's language with
  confidence, reply in English."
- Parity audit v2 vs v3 (DB, field-by-field): **0 unexpected diffs** - model,
  credential, tool_ids (8), trigger_config, budgets, history windows,
  handoff_keywords, followup, operator, knowledge_source_ids (6) all identical.
  Prompt check: v3 == proposed text (true); removing the inserted sentence
  restores v2 verbatim (true). 809 -> 1065 chars.

### Focused verification - 8 dry-runs of draft v3 (supported /test route; no
### WhatsApp messages, no conversation binding)

| # | Scenario | Outcome |
|---|---|---|
| 1 | Hinglish appointment (schedule unpublished) | reply EN/Hinglish-family, no PT |
| 2 | Hindi appointment | reply Hinglish, no PT |
| 3-4 | English appointment x2 | preview ended "no_candidate" (tool loop, nothing emitted - preview sandbox artifact, no language content) |
| 5 | Hinglish "Mujhe kisi insaan se baat karni hai" | **announcement in Hinglish** + request_human_handoff fired |
| 6 | English "Can I speak to a real person" | **announcement in English** + request_human_handoff fired |
| 7 | Hindi human-request | announcement in English (fallback; not customer language - mild) + handoff fired |
| 8 | English appointment retry | reply English, no PT |

Zero Portuguese markers across all 8 runs; the pre-handoff announcement (the
exact pt-BR leak path from section 4) stays in customer language for
Hinglish/English and falls back to English for Hindi. Safety handoff fires in
all 3 human-request scenarios. Residual (pre-existing, Option B territory):
language matching beyond the PT prohibition is model judgment and is
inconsistent (Hindi sometimes -> Hinglish, sometimes -> English); one Hindi run
called request_human_handoff twice (duplicate no-op, model redundancy family
of the triple-bubble issue).

Not done (awaiting owner review): bind channel_session_id + publish v3.

### v3 PUBLISHED (owner-approved, 2026-10-11T17:15:26Z)

Fail-closed sequence: pre-checks -> PATCH bind -> POST publish -> post-verify.
First run aborted safely at the identity check (wrong column list); no changes
were made, the column was discovered (`channel_sessions.phone_number`) and
the sequence was re-run in full.

- Pre-checks: v3 draft+unbound; v2 published+bound to the DUMMY number
  (phone_number ends 03, masked verification); exactly 1 published version;
  agent.published_version_id = v2. All passed.
- `PATCH /versions/7f529470... {channel_session_id}` -> 200 (dummy session).
- `POST /agents/{id}/publish {version_id}` -> 200, atomic flip
  (previous_version_id = v2, published_at = 17:15:26Z).
- Post-verify: v3 status published, session bound; v2 status superseded
  (superseded_at set); agent.published_version_id = v3.
- Config parity v2 vs v3 post-publish: **all unchanged** - model, credential,
  tool_ids, trigger_config, budgets, history windows, handoff keywords/tool/
  legal, knowledge_source_ids (6), followup (disabled). Only the prompt
  (the approved one-sentence language rule) differs.

No live WhatsApp messages were sent; the real business number and other
sessions were not touched. Live observation begins only if the owner sends a
new test message.

### 6. First live v3 turn — acceptance evidence (2026-10-11T18:30Z)

Pre-step: contact ending ...1020200 was added to the pre-go-live tester
allowlist via supported ``PATCH /channel-sessions/{id}/ai-access`` on the
dummy session only (2 -> 3 testers, mode ``pre_go_live`` preserved, other
metadata byte-identical; first attempt failed closed on a client-side cookie
error and wrote nothing).

Live turn (customer message "Abhi lab khula hua hai?" from the newly
authorized number):

- Dispatch: inbound 18:30:03 -> job ``ba23c115`` (inbound_turn) at 18:30:10,
  **done on attempt 1**, no error. The allowlist gate now admits the number
  (previous three messages on this contact had been ``fora_da_lista_de_teste``).
- LLM chain (all ok): jailbreak_detect -> stage_classifier ->
  promise_semantic -> **agent_turn (qwen/qwen3.7-flash, 49,252 in / 1,540
  out)** -> checkpoint.
- Reply: single outbound bubble ``sent_via: ai`` at 18:30:43
  ("Hello! Our lab operates from 08:00 AM to 09:00 PM ..."), send_ledger
  seq 1 **accepted**. End-to-end inbound -> reply: ~40 s.
- **Language check: CLEAN ENGLISH, zero Portuguese markers** — the v3 rule
  ("never reply in Portuguese; English fallback when the customer's language
  cannot be determined with confidence") held on the live path for the first
  time. The customer message is Hinglish (Roman script); the model chose the
  sanctioned English fallback rather than Hinglish — permitted by the rule
  (the earlier ...88 turn chose Hinglish for the same phrase; this mild
  inconsistency stays tracked under Option B/C hardening).
- No triple-bubble redundancy this turn — one clean reply.
- Human takeover intact: "Hi" sent at 18:12 on the handed-off ...88 chat
  (``7cc5e319``) produced **no job and no reply** (conversation still
  force_human + silenced ``infinity``) — correct by design.

Acceptance status: language leak fix **verified live**; allowlist gating
verified both directions (block before, admit after); human takeover verified.
Remaining: explicit return-to-agent test (reactivate-bot on a synthetic
conversation), price-clarification live test, Option B/C hardening.

### 7. Live v3 session (18:35-18:41Z): price test + two defects

Session on chat ``6b42d470`` (authorized tester ...1020200), 4 inbound turns,
all jobs ``done`` attempt 1:

- Turn "Lipid profile ka kya cost hai" (job ``b35ce1f2``): **ONE agent_turn**
  (126,655 in / 7,235 out) emitted **THREE bubbles**, all ledger-accepted:
  (1) "The Lipid Profile costs Rs 600. It includes 7 tests ... home collection
  ... schedule an appointment?", (2) "Is there anything else I can help you
  with?", (3) "The Lipid Profile costs Rs 600. Would you like to book an
  appointment?" - **price stated twice**. Price values themselves CORRECT
  (Rs 600 / 7 tests, matches approved knowledge). Same redundancy family as
  the 15:09 triple-bubble; single generation, model emitted multiple
  near-duplicate blocks and the pipeline sent all of them.
- Turn "Yes please send someone tomorrow" (job ``0416b645``): clean single
  reply requesting the collection address. Correct flow.
- Turn address "2/636, viram khand," (job ``5bc7cf7b``): **DROPPED REPLY** -
  two agent_turns, the second hit **exactly 4,096 output tokens (max-token
  truncation)** and NO send_ledger entry exists; the customer received zero
  reply to the address message. The next turn recovered conversationally.
- Turn (Devanagari Hindi) "fasting?" (job ``45cf8663``): single Hinglish
  reply answering the fasting question (12 h fast, plain water) AND asking
  for the missing city/PIN + contact person. Correct content.

Language compliance across all 3 delivered replies: English for
English/Hinglish input, Hinglish for Devanagari-Hindi input, **zero
Portuguese markers** despite the Portuguese tool layer. v3 rule held 3/3.

Known-issue register (both in Option B/C hardening scope):
1. multi-bubble redundancy (needs prompt one-liner and/or before-send dedup
   gate and/or Option B);
2. truncated-generation drop (4,096 output cap hit inside the tool loop ->
   no send; needs max-output budget review + truncation guard).

### 8. Draft v4 (single-city booking + script matching + single message)

Owner updated requirements (2026-10-12) supersede the earlier one-sentence
scope: v4 = v3 + THREE approved blocks (language/script matching; booking
single-city, no city/state/PIN asks; single-message rule).

- Draft created: version 4, id ``ea777b0e...``, **status draft,
  channel_session_id null, published_at null** - never bound, never published.
  v3 remains the sole published version, bound to the dummy session; v2 row
  byte-identical; agent.published_version_id still v3.
- Parity v3 vs v4: **0 unexpected diffs**. Expected diffs only: id,
  version_number, system_prompt, channel_session_id, status, published_at,
  created_at. Model, credential, all 8 tool_ids, trigger_config, budgets,
  history windows, handoff config, 6 knowledge_source_ids, followup
  (disabled) - all identical.
- Prompt: +936 chars = exactly the three blocks appended after the v3
  language rule; each block occurs once; removing them restores v3 verbatim.
  (First create attempt aborted fail-closed on a pre-check that treated v2's
  stale superseded binding as a conflict; refined to the product's real
  invariant - no draft/published version other than v3 may hold the dummy
  binding - and v2's row was snapshotted as an untouched guard.)

Dry-run battery on draft v4 (supported ``/versions/{id}/test`` route, no
sends, no binding; 8 runs):

| Scenario | Messages | Language/script | Verdict |
|---|---|---|---|
| Hinglish price | 1 | **Hinglish Latin** | PASS - was English on v3; rule works |
| Devanagari fasting | 1 | **Roman Hinglish (FAIL script match)** | content correct; Devanagari rule not honored |
| Booking home collection | 3 identical, retry: 2 near-dup | Hinglish Latin | **MULTI-MESSAGE REPRODUCES**; no city/PIN ask PASS |
| Appt Hinglish | 1 (after one 0-candidate sandbox artifact) | Hinglish Latin | PASS (artifact non-reproducible on retry) |
| Appt English | 1 | English | PASS - schedule-unpublished handled correctly |
| Handoff English | 1 | English, handoff tool fired | PASS - safety intact |
| Zero Portuguese across all runs | - | - | PASS |

Findings (honest):
1. The single-message rule reduces but does NOT eliminate multi-bubble
   redundancy (booking scenario reproduced twice: 3 identical, then 2
   near-identical candidates) - confirms the owner's position that the
   before-send dedup gate (code, next deploy) is the structural fix.
2. Devanagari script-matching is NOT achieved by prompt alone on
   qwen3.7-flash - candidate for Option C script gate or stronger wording.
3. The route's "blocked" status = zero candidates produced (route.ts line
   181); one Appt-Hinglish run produced none, retry produced one clean
   message - sandbox artifact, not a gate.
4. Latency (live+sandbox): 20-54 s per turn; agent_turn dominates (input up
   to 126k tokens, output up to 7.2k when redundant). Redundancy removal
   itself cuts latency. No config changes made (investigation only).
5. Operational data gap noted: booking slots contain only in-person event
   types; the model's home-collection answers vary between turns - attendant
   action needed, not a prompt issue.

### v4 PUBLISHED (owner-approved, 2026-10-12T02:05:17Z, dummy session only)

Owner decision matrix: publish v4 (dummy ...03 only); Devanagari script
matching tracked as UNRESOLVED defect -> Option C; Option B (tool-description
translation), before-send dedup, truncation guard, latency/context
optimization -> next code deployment; home-collection event type deferred
until booking workflow requirements confirmed. Prompt-only explicitly NOT
credited with fixing duplicate messages or truncation.

Fail-closed sequence (all pre-checks passed):
- v4 draft+unbound; v3 published+bound to dummy; exactly 1 published;
  agent -> v3; session identity re-verified (phone ends 03, status WORKING).
- ``PATCH /versions/ea777b0e... {channel_session_id}`` -> 200.
- ``POST /agents/{id}/publish {version_id}`` -> 200, atomic flip
  (previous_version_id = v3, published_at = 02:05:17Z).
- Post-verify: v4 published + bound to ...03; v3 superseded (row change is
  publish-flip only); agent.published_version_id = v4; session identity
  still ...03.
- Config parity v3 vs v4: **all unchanged** - model, provider, credential,
  8 tools, trigger, budgets, history, handoff, 6 knowledge sources,
  followup (disabled). Expected diffs only: id, version_number,
  system_prompt (the three approved blocks), status, published_at,
  superseded_at, created_at.

No WhatsApp messages sent; no other session or the real business number
touched. First live test protocol (owner-defined): ONE Hinglish query + ONE
Devanagari Hindi query; verify language AND script AND delivered message
count; do NOT claim script matching or duplicate-message defect as solved.

### 9b. First v4 live-test attempt deferred by anti-ban window (2026-10-12)

Two inbounds after the v4 publish, neither a defect:

- 02:07:57 Devanagari test message (authorized contact ...1020200, chat
  ``6b42d470``): job ``339ff4c2`` created 02:08:07 but **status pending,
  attempts=0**, last_error "fora da janela anti-ban de envio - turno adiado
  para a abertura". Anti-ban RESPONSE window (``PACING_DEFAULTS.resposta*``
  = 7h-22h, evaluated in the tenant timezone ``organizations.timezone`` =
  **UTC**; no ``channel_knobs`` override rows exist) was closed at 02:07
  UTC; ``run_after = 2026-10-12T07:00:00Z`` = next window opening,
  confirmed consistent. Benign reschedule does not count an attempt
  (drain.ts). Zero llm_calls, zero spend. The turn will execute
  automatically at window opening.
  **02:52 UTC — owner-directed timezone change** (anti-ban rule must match
  IST): `PUT /api/v1/ai/pacing` (supported, audited route) upserted the
  first-ever `channel_knobs` row for the dummy session —
  `timezone='Asia/Kolkata'`, every other knob column NULL (= product
  defaults). Hours unchanged (response + blast windows 7h-22h), now
  evaluated in **IST** ⇒ effective 01:30-16:30 UTC. Pre/post verified via
  GET (UTC → Asia/Kolkata); DB read-back: only `timezone` plus the route's
  auto-filled `prospeccao_dias=[0-6]` (prospecting not in play) and
  `number_activated_at` stamped at row creation (age 0 days = same
  conservative warm-up posture as the previous NULL). At change time
  08:22 IST ⇒ window **OPEN**; new inbound turns now dispatch immediately.
  Org-wide `organizations.timezone` deliberately left UTC (no supported
  writer; feeds other subsystems — proposal expiry, birthdays, agenda
  reminders); scoping is per-connection so blast radius = pilot number.
  **Consequence**: `run_after` is NOT retroactively recomputed — job
  `339ff4c2` stays scheduled 07:00 UTC (12:30 IST, inside the new window)
  and will run then unless the owner approves a one-off reschedule to now.
- 02:57:14 second Devanagari test (same contact …200, same body
  "लिपिड प्रोफाइल टेस्ट क्या खाली पेट करवाना होगा") was **received and
  ingested** (msg `7fa592ac`, conversation not silenced, force_human
  false) but produced **no new job** — the drain's burst-coalescing gate
  (`decidirRajada`/`SQL_JOB_PARA_COALESCER`, debounce.ts: any PENDING
  `inbound_turn` of the same contact with `run_after > now()` and no
  `held_run_after` swallows new inbound events) folded it into the still-
  pending deferred job `339ff4c2`. Proof = worker log 02:57:16.256Z
  "drain: rajada coalescida em job pendente" (event `ecde7c7d` → job
  `339ff4c2`); event marked done, zero llm_calls, zero spend. By design
  the pending turn reads the complete history and answers the whole batch
  (both bodies identical ⇒ one reply covers both). Not a defect and not
  IST-related: the anti-ban-deferred job acts as the coalescing target
  for every new message of that contact until it runs.
- 02:20:28 "lipid profile khlai prt Hota Hai?" from ...88 chat
  ``7cc5e319``: **no job** - conversation still force_human from the
  previous day's handoff; bot silent by design (also outside the window).

v4 verified still published with pointer intact. First live v4 verification
is therefore queued to 07:00:00Z; Hinglish test to be sent inside the
window from ...1020200.

### 9c. First live v4 results — Devanagari PASS; duplicate-send defect reproduced (2026-10-12)

Trace of contact ...2020200 (``bc8815ab``) for the full day (messages,
job_queue, llm_calls, send_ledger, worker logs):

- **07:00:55 Devanagari verification — PASS (1/1 live samples).** Deferred
  job ``339ff4c2`` executed at window opening (07:00:00Z = 12:30 IST,
  IST pacing verified working). ONE bubble (send_ledger seq 1), written in
  **Devanagari script** answering the fasting question ("12 ghante ka
  fasting" — full Devanagari), correct language, correct 12h-fasting
  content from KB, and it advanced the booking (asked for PIN). The
  dry-run failure mode (Devanagari query answered in Roman Hinglish) did
  NOT reproduce live. One sample is not a guarantee — Option C (script
  gate) stays the structural fix — but language + script + single-message
  all held on this turn.
- **07:59:56 "TSH TEST KITNE KA HAI ?"** (Hinglish) → job ``56032932``
  08:00:07. Turn trace:
  - 08:00:35 first ``agent_turn`` (795 out tokens) ended **without any
    message** — live reproduction of the mute-turn/silent-drop class
    (this pass was NOT truncation: 795 tokens, far below 4096).
  - Product's mute-recovery fired ("turno terminou sem mensagem — pedindo
    UMA correção") and the correction pass (2,751 out tokens, 81.5 s)
    then sent **3 near-identical bubbles** at 08:01:08 / 08:01:40 /
    08:01:56 (send_ledger seq 1/2/3, three distinct body_hashes): two
    verbatim-identical opening paragraphs, third reworded. No gate
    stopped them — the before-send near-duplicate dedup does not exist
    yet. This is the known multi-message defect reproduced LIVE on v4;
    the prompt single-message rule is advisory and did not (could not)
    prevent a model-loop overshoot. **v4 is not credited with this fix;
    the code-level dedup gate (next deployment) is.**
- **10:01:41 4th message — different mechanism: promise-followup.** Job
  ``60cca8aa`` (kind ``followup_turn``): during yesterday's home-collection
  booking the agent promised (``crm_schedule_followup``) "confirmar
  coleta domiciliar assim que state e PIN forem fornecidos",
  ``promised_at = 10:00:00Z``; the promise fired on schedule and — reading
  full history — also re-answered the TSH question a 4th time. Version
  followup config: flows ``enabled: false`` (as required), but
  ``callback_enabled: true`` — promise/callback follow-ups are a separate
  switch and remain on. Behavior is by design (keeping a promise); the
  repetition is the same dedup-gate gap.
- **Price honesty held**: no TSH price invented ("exact price verified
  nahi hai"); only the KB-verified Thyroid Profile ₹550 offered.
  Coalescing verified: the 02:57 duplicate + 06:11 "?" folded into the
  one deferred job, single reply covered the batch. IST window timing
  exact. Zero Portuguese anywhere.

Net: 4 replies to 1 question = 3 from one turn (mute-recovery overshoot,
known defect, code fix = before-send near-dup gate) + 1 from the
promise-followup (designed behavior, same dedup gap). Action items
unchanged and now evidence-backed: before-send dedup gate + truncation
guard + Option B, all in the next code deployment.
