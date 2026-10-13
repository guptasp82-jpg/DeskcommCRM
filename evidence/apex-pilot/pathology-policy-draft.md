# STATUS: DRAFT — NOT PUBLISHED, NOT BOUND TO v4

> **This document is a DRAFT reference only.** It is not published, not pushed to any
> knowledge base, not bound to the production prompt, and not attached to any session
> binding. The production v4 prompt, the production pointer, session bindings, model
> configuration and the real business WhatsApp number remain **unchanged**.
> Nothing here may be copied into a live prompt without the owner's explicit review.

**Workstream D — Apex PathLabs (dummy-WhatsApp pilot)**

## 0. Two negative facts that scope everything below

- **No Qmarksoft integration exists, and none may be assumed.** There is no connector,
  no API client, no table, no tool and no configuration anywhere in this codebase that
  reaches a LIS/Qmarksoft system. The agent has **no** access to any laboratory
  information system, and none should be implied to the patient.
- **No report status and no report link may ever be invented.** The agent cannot and
  must not produce "ready" / "pending" / "processing" / "collected", a download URL, a
  portal link, or any other artifact of a retrieval it did not perform. Fabricating any
  of those is the single highest-severity failure mode in this workstream.

---

## 1. Scope

Covers two question families arriving on WhatsApp for Apex PathLabs:

| # | Family | In scope | Out of scope |
|---|---|---|---|
| A | **Pathology report enquiries** ("is my report ready?", "where is my CBC?", "when will I get it?") | Minimal identification, expectation-setting, routing to a human | Locating, reading, summarising or statusing any report |
| B | **Biopsy / imaging (radiology) questions** ("what is a biopsy?", "how do I prepare for the CT?", "how long does the report take?", "what does my BI-RADS mean?") | Explaining what a test is, preparation, turnaround — **only** when grounded in the org knowledge base | Diagnosis, interpretation of any result, prognosis, treatment advice |

Explicitly **out of scope**: urgent symptom triage (route to a human immediately),
minors without a guardian, requests for a medico-legal document (laudo/atestado), and
anything a qualified professional must sign.

---

## 2. Grounding: what already exists in the code

The policy below is written against real, existing mechanisms — no new machinery is
assumed. Tool names are exactly as the runtime defines them
(`AGENT_TOOL_DEFS`, `lib/agent-engine/agent/inbound-turn.ts:320`):

| Mechanism | Where | What it does today |
|---|---|---|
| `search_knowledge` | def `inbound-turn.ts:421`, exec `:3220`, impl `lib/agent-engine/agent/search-knowledge.ts:42` | RAG over the org's knowledge base (embed + `retrieve_top_k_chunks`). Its own description says: *"Sem resultados = diga que vai confirmar, nunca chute."* Citations are emitted to `messages.metadata.citations`. |
| `get_lead_context` | def `inbound-turn.ts:321`, impl `lib/agent-engine/edge/crm/get-lead-context.ts` | Reads contact + last N messages. It reads **conversation**, not any lab system. |
| `request_human_handoff` | def `inbound-turn.ts:433`, impl `lib/agent-engine/agent/human-handoff.ts` | Model-triggered handoff. `performHumanHandoff` sets `contacts.force_human=true` (irrevocable, hard rule 2), silences the bot, cancels pending crons, writes the handoff record and an inbox item. There is also a **deterministic** regex trigger that runs before the model. |
| `open_human_case` / `provide_case_update` | `lib/agent-engine/agent/human-cases.ts`, spec `docs/specs/15-spec-casos-humanos.md` | Opens `agent_cases` with `status='awaiting_human'` + `blocker` text; the conversation keeps going. A guardrail auto-opens a case if the model repeatedly promises a human without opening one. |
| `send_message` | def `inbound-turn.ts:326` | The **only** way a message reaches the patient. Free text outside a tool call is discarded. |
| `clinical_claim` gate | `lib/agent-engine/guardrails/afirmacao-clinica.ts`, gate 6.8 in `before-send.ts` (`BEFORE_SEND_CHAIN_VERSION = 9`) | Blocks four categories: `diagnostico`, `prescricao`, `promessa_de_resultado`, `afirmacao_oncologica`. **Off by default per org** — a health organisation turns the `afirmacao_clinica` layer on in *Segurança*. |
| `factual_claim` gate | `before-send.ts:926` | Checks factual statements against evidence consulted **in this turn**; `nao_conferido` passes with the reason recorded. |
| `semantic_promise` gate | `before-send.ts` (gate 6) | Blocks free-text promises the regex cannot see. |
| Handoff precedent for health | `.claude/skills/deskcomm-cliente-novo/references/nichos.md:48-50` | *"Você não dá diagnóstico, não interpreta exame… Chama uma pessoa quando: … pedido de laudo/atestado."* |

**Open point for the owner:** confirm the `afirmacao_clinica` layer is **enabled** for
this organisation. It is the deterministic net under the prompt; without it the whole
clinical safety rests on instruction alone, which the file header itself says does not
hold (`afirmacao-clinica.ts:6-11`).

---

## 3. Family A — report enquiries

### 3.1 What the agent MUST do

1. **Ask for the minimum identifying set, one item at a time.** Allowed fields, and
   nothing else:
   - full name as given at registration;
   - the **appointment / registration (token) number**, if the patient has it;
   - the test or specimen name in the patient's own words (" biopsy", "blood count").
2. **Say plainly that it cannot see the system.** Canonical shape (owner to finalise):
   > "I don't have access to the lab system, so I can't check the status of your report.
   > I'll pass this to a person on the team who can look it up."
3. **Hand off** as soon as identification is complete (§5 triggers) — the *retrieval*
   is always a human act.
4. **Set expectations only from the knowledge base.** A general turnaround statement is
   allowed *only* if `search_knowledge` returned a matching chunk from the org's
   material, and it must be phrased as the org's published turnaround — never as a
   status of this particular report. Absent a chunk: say it will be confirmed.
5. **Quote its sources.** Answers built on retrieved chunks carry the citations the
   runtime already attaches.
6. **Log nothing extra.** No report identifiers, results or clinical content into logs
   or error messages (PII-out-of-log is a hard rule in this codebase).

### 3.2 What the agent must NEVER do

- ❌ State or imply a status for a specific report: "ready", "pending", "processing",
  "released", "will be ready tomorrow", "already with your doctor".
- ❌ Produce a link, URL, portal path, file name or attachment for a report — invented
  or recalled.
- ❌ Claim to have looked something up: "I checked", "let me see", "I found your
  report", "our system shows…".
- ❌ Summarise, translate, normalise or explain any result value it was told, including
  values the patient pastes into the chat.
- ❌ Ask for city, state or PIN/CEP — see §4.
- ❌ Promise a delivery time, an SMS, an email or a callback it has no mechanism to
  perform.
- ❌ Repeat back identifiers it was not given, or guess one to "help".

### 3.3 Why this is enforceable

- The claim to have accessed a result is a **factual claim**: the `factual_claim` gate
  vetoes statements with no evidence consulted in the turn
  (`before-send.ts:926-942`).
- Any "your report is clear / normal / negative" is an **oncological or diagnostic
  assertion** and is caught by `clinical_claim` when the layer is on.
- A "someone will call you with the result" is a **promise** and passes through the
  `promise` / `semantic_promise` / `case_promise` gates — and `case_promise` requires a
  case actually opened before such a promise reaches the patient.

---

## 4. Data minimisation

**Rule: collect only what is strictly necessary to route the enquiry.**

- ✅ Allowed: name as registered, appointment/registration number, test name.
- ❌ **Do not request and do not echo**: city, state, PIN/CEP, full address, date of
  birth, government IDs, insurance numbers, and never a clinical value.
- Never ask the patient to **send the report itself** (PDF/image) into the chat. If one
  arrives unsolicited, do not read, repeat, store or forward its contents; acknowledge
  only that a person will follow up.
- If the patient volunteers an address or an ID, do not repeat it back and do not carry
  it into the handoff summary — the handoff carries *what is being asked*, not extra
  identifiers.
- Sample conversational content in this document deliberately contains **no
  city/state/PIN** and no real patient data.

---

## 5. Handoff / escalation triggers (exact)

Reuse the existing tools; do not invent new ones.

| # | Trigger | Mechanism | Why |
|---|---|---|---|
| T1 | Patient asks for the status/whereabouts of a report | `request_human_handoff` (`inbound-turn.ts:433` → `performHumanHandoff`) | Retrieval is a human act; the agent has no system access |
| T2 | Patient pastes or describes any result value | `request_human_handoff` | Interpretation is out of scope |
| T3 | Any request to interpret a biopsy, cytology or imaging report | `request_human_handoff` | Clinical interpretation |
| T4 | Urgent/severe symptom language, or the patient says they feel worse | `request_human_handoff` **immediately**, before any other answer | Existing health-niche rule (`nichos.md:40-41,50`) |
| T5 | Request for a formal report/letter (laudo/atestado) | `request_human_handoff` | Requires a qualified signer |
| T6 | Minor without a responsible adult | `request_human_handoff` | Existing rule |
| T7 | The agent cannot answer from `search_knowledge`, **and** the patient needs a definite answer | `open_human_case` with `blocker` = what is missing | Keeps the conversation going while a human resolves it |
| T8 | The agent has already promised a person will follow up | `open_human_case` **before** the promise is sent | `case_promise` gate vetoes the message otherwise, and auto-opens a case on the 2nd attempt |
| T9 | Patient explicitly asks for a person | Deterministic regex runs **before** the model (`human-handoff.ts:6-9`), or `request_human_handoff` if the model gets there first | Meta/regulated requirement: clear, immediate human escalation |

Notes for the owner:
- T1–T6 **end the bot's participation** (`force_human` is irrevocable and the bot is
  silenced) — choose them for "a human must own this", not for "this is inconvenient".
- T7/T8 keep the bot live; prefer them for answerable-later questions.
- Never tell the patient "a person is coming" without having called one of these tools.

---

## 6. Biopsy / imaging (radiology) policy

### 6.1 MAY say (grounded in the org knowledge base only)

- What a biopsy / X-ray / ultrasound / CT / MRI **is**, in plain, non-technical words —
  only if `search_knowledge` returns supporting material.
- **Preparation** instructions as published (fasting, hydration, arriving with a
  companion, stopping a medication **only** as literally written in the org's material
  and phrased as "as instructed in your booking confirmation").
- **Turnaround**, as the org's published general turnaround — framed as general
  policy, never as the status of a specific pending report.
- Logistics: how to book, where to go *in terms the org publishes*, hours, how to
  cancel or reschedule.
- That a **qualified professional** is the one who evaluates any result.

### 6.2 MUST NOT say

- ❌ **Diagnose**: "you have…", "this suggests…", "it looks like…", "you probably
  have…". Blocked by `clinical_claim.diagnostico`.
- ❌ **Interpret a result**: any statement about what a value, grade, class, score,
  density, lobe, opacity or histology **means** for this patient — including
  "reassuring", "benign", "normal", "nothing to worry about", "no malignancy".
- ❌ **Stage, grade or compare** a lesion; correlate imaging with symptoms; rule
  anything in or out.
- ❌ **Prescribe or adjust medication**, including "you don't need the antibiotic".
  Blocked by `clinical_claim.prescricao`.
- ❌ **Guarantee an outcome** or a timeline for an individual result. Blocked by
  `clinical_claim.promessa_de_resultado`.
- ❌ Say a finding **is / isn't cancer**. Blocked by
  `clinical_claim.afirmacao_oncologica`.
- ❌ Dismiss an urgent symptom ("that's normal after a biopsy") — escalate per T4.
- ❌ Repeat a patient's own hypothesis back as agreement. Conditional phrasing
  ("if it were X, the doctor would…") is service information, not a diagnosis — but
  never let it collapse into an assertion.

### 6.3 The handoff sentence for clinical questions

Canonical shape (owner to finalise), always offered alongside the escalation:

> "I can explain what the exam is and how to prepare, but I can't interpret results —
> that's for the doctor, in a consultation. I'll pass you to a person from the team now."

---

## 7. Summary table

| Action | Allowed |
|---|---|
| Explain what a test is / prep / general turnaround (KB-grounded, cited) | ✅ |
| Ask name + appointment number (minimum set) | ✅ |
| Hand off with `request_human_handoff` / open `open_human_case` | ✅ |
| State a specific report's status | ❌ |
| Give a link/URL for a report | ❌ |
| Claim to have read or accessed a result | ❌ |
| Interpret any biopsy/imaging result | ❌ |
| Diagnose, prescribe, guarantee | ❌ |
| Request or echo city/state/PIN | ❌ |
| Ask the patient to send the report file | ❌ |

---

## 8. Open questions for the owner

1. **Is the `afirmacao_clinica` layer enabled** for this organisation? (Off by default;
   without it there is no deterministic clinical net.)
2. **Which knowledge sources** carry the Apex PathLabs material (test list, prep,
   turnaround, hours)? Are they ingested and versioned — and who owns updating them?
3. **Turnaround wording**: what general turnaround may be quoted per test family, and
   does it differ for biopsy vs. routine haematology?
4. **Identification set**: is appointment/registration number sufficient, or is a second
   factor required before a human may discuss a report with a person?
5. **T1–T3 vs T7**: do report enquiries always end the bot's participation, or may the
   bot stay live for pure logistics questions?
6. **After-hours behaviour**: should T4 (urgent) escalate even outside business hours,
   and who is paged?
7. **Which languages** must be supported for the handoff message?
8. **Is a `clinical` case type needed?** `TIPOS_DE_CASO` (`lib/ai/case-copy.ts:31`)
   currently has only `agendamento | duvida | problema | financeiro | acesso | outro`.
   Adding a type is a product change and is **not** assumed here.
9. **Owner of the sample copy** in §3.1/§6.3 — these are proposed strings, not approved
   strings.

---

*Draft prepared for review. Not published. Not bound to v4. No integration assumed, no
report status or link produced anywhere in this document.*
