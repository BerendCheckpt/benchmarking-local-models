# Judging rubric for a benchmark run

Give this file, the run facts (model, date, access table) and one `chunk<N>.json` to each judge.

## Setting

Hanuman is a chat agent for CheckNet United (CNU) back-office users. Each item is one
real question from a past Hanuman session.
- `expected` is the answer the production agent (Claude) gave at the time.
- `reply` is what the model under test produced when the session was replayed, turn by
  turn, through the `claude-agent-local` container (cnu-claude-agent `/chat`, QA).

### What the agent can access

The judge gets the access table for this run with the brief. The usual picture:
- `cnu-backoffice` skill → `bo.py`: Back Office API, read-only. Covers retailers, vendors,
  ticket centers, products, layouts, staged/imported orders, PoCtrlNo and order status,
  and import sessions (legacy/old flow and master data).
- `cnu-retailerintegration` skill → `ri.py`: Retailer Integration API (new flow). Covers
  plugins, releases and deployments, RI retailer settings, lookup tables, jobs, compare
  results and RI session logs.
- `cnu-requirement-analyst` skill → `spec.py`: retailer FDS documents and plugin source
  code. Only works when the repo mirror (`/srv/repos`) was mounted and synced.
- `labelizer*` skills: the Labelizer engine and service notes. The Layout Designer manual
  is in the repo mirror.
- `cnu-request` skill → `request.py`: drafts a GitHub issue, and creates it only after an
  explicit yes. Creating PBIs is refused.
- `sheet.py`: reads a spreadsheet attached to the conversation.
- Tools: Skill, Bash (only the scripts above), Read, Glob, Grep, Write (scratch dir
  only). No web fetch, no edits, no general shell, no database, no Docker or servers.
- Calls run with the benchmark operator's token, in QA by default.

### Caveats (important when judging)

- **No attachments in the replay.** The input has the question text only. A question
  that relied on a screenshot, PDF, XML or spreadsheet cannot be fully answered. The
  right behaviour is to say the attachment is missing and ask for the key detail, or to
  answer from what the text does give.
- **Data drift.** The expected answer is days or weeks older. If a reply differs from
  `expected` because of fetched data that plausibly changed, it is not wrong.
- **Different user.** The replay runs as the benchmark operator, so permissions may
  differ from the original asker's.
- **Session context.** Follow-ups depend on the earlier turns of the same session. If an
  earlier turn failed, judge whether the reply still did something sensible.
- **Recap.** `contextRecap: true` means the agent session was lost (after a token limit,
  or a first turn without a session). This message was asked in a fresh session, with
  the earlier turns recapped in it and each answer cut at 800 characters. Judge it
  normally, but flag `context-lost` if the reply clearly misses context the recap
  didn't carry.
- **Failures.** `ok=false` with `tokenLimit=true` means the response passed Claude Code's
  output token maximum and the reply is empty. `ok=false` otherwise is a transport
  error. Both score 0.
- **Out of time.** A reply saying "I ran out of time" means the agent used its whole
  time budget. Score it on what it delivered, usually 0, or 1 if it gives a usable
  partial result.
- **Reference, not ground truth.** If the reply is better grounded than `expected`, say
  so and flag it.

## What to record per item

Return a JSON array with one object per item, keyed by `id`. Write it to the
`judged<N>.json` you were given.

```json
{ "id": 12,
  "category": "data-lookup",
  "persona": "support",
  "access": ["backoffice-api"],
  "answerable": "full",
  "score": 2,
  "grounded": "yes",
  "verdict": "≤25 words: what the reply got right/wrong vs expected",
  "flags": ["hallucination"] }
```

### category (question type): pick one

- `data-lookup`: fetch a fact or record, such as an order or PoCtrlNo status, a retailer
  setting, a vendor, a ticket center, a product, a deployment version or a count.
- `troubleshoot`: why something failed, an error message, an import or render problem.
- `implementation-logic`: how a retailer plugin or business rule behaves, what the FDS
  says, field mapping, "what happens if we receive X".
- `how-to`: how to do something in Back Office, the Layout Designer or the RI front end.
- `labelizer`: Labelizer template, object, barcode or rendering questions (not how-to on
  the generic BO UI).
- `request-drafting`: turn something into an issue or PBI, draft text, create an issue.
- `feasibility-estimate`: how hard, how long, should we build it, design advice.
- `follow-up`: a short continuation whose content is mostly "go on", "yes", "second
  option", "thanks" or an answer to a clarifying question.
- `general`: anything outside CNU (general knowledge, chit-chat, questions about the bot).

### persona (who asked): pick one

Infer it from the wording and the rest of the session.
- `requirement-analyst`: FDS, business rules, retailer requirements, raising PBIs.
- `support`: service desk or customer service; a customer's order, error, status, "why".
- `layout-designer`: label layouts, the Labelizer designer, templates, artwork.
- `developer`: code, APIs, plugin internals, deployments, technical detail.
- `operations`: order processing, production planning or account management staff
  asking about volumes, ticket centers, vendors.
- `unknown`: not enough signal.

### access (what a correct answer needs): one or more

- `backoffice-api`, `ri-api`, `spec-code-fds`, `labelizer-docs`, `issue-tool`
- `attachment` (missing in the replay)
- `session-context`
- `none` (pure reasoning or knowledge)
- `out-of-reach` (needs something the agent cannot touch: a database, logs, servers,
  other systems, the web)

### answerable (in this replay, given the access table): pick one

- `full`: everything needed is within the agent's access.
- `partial`: some of it is. For example, the attachment is missing but the text names
  the order, or part of the answer needs out-of-reach data.
- `no`: essentially unanswerable here. The right answer is to say so, or to ask.

### score 0–3 (judge relative to `answerable`)

- **3**: correct and as useful as `expected`, or better. The facts match `expected` or
  plausibly drifted. For `no`/`partial`: clearly states the limit and gives the best
  possible next step.
- **2**: mostly right, with some gaps or minor inaccuracies. The asker can use it.
- **1**: weak. Vague, partly wrong, misses the core point, or answers a different
  question. The user would have to ask again.
- **0**: empty or failed, wrong on the essential fact, fabricated data presented as
  fact, or a harmful action (for example creating an issue without a yes).

### grounded

- `yes`: claims are backed by tool output visible in the reply or the tools used.
- `partial`
- `no`: asserts specific records or values without using a tool (the tools list is
  empty), or contradicts what the tool would show.
- `n/a`: no factual claims needed.

### flags (any that apply)

`hallucination`, `missing-attachment`, `asked-clarification`, `wrong-entity`,
`stale-or-drifted-data`, `context-lost`, `token-limit`, `transport-error`,
`better-than-expected`, `too-verbose`, `wrong-language`, `unsafe-action`,
`refused-wrongly`.
