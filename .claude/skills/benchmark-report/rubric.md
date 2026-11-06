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

- **Attachments.** When `attachments` is set, the files listed there were recovered
  from the QA session and sent with the replay. These are PDFs and images; judge the
  reply as if the asker attached them. When it is empty but the question names a file,
  the replay ran without it, as all runs before this feature did. A question that
  relied on a screenshot, PDF, XML or spreadsheet then cannot be fully answered. The
  right behaviour is to say the attachment is missing and ask for the key detail, or to
  answer from what the text does give.
- **Label history.** `labelFeedback` on an item gives the RetailerIntegration history
  of each label id the question names (`ri.labelizer_generation_feedback`):
  - generations and corrections in total, and before and after the question;
  - minutes from the question to the next correction;
  - minutes from the first generation to the first correction.

  It also has:
  - `retailers`: the retailers the label id has rows for;
  - `shared`: true when the id covers more than one label (several retailers, or
    generations from different PDFs), so its counts aren't about one template;
  - `pdfMatch`: whether the PDF sent with the message is the one RI generated the label
    from (`match`, `name only`, `different PDF`, `no RI generation`, `no attachment`).

  Corrections after a generation mean someone had to fix the generated template. Use it
  for `labelCheck`. `CreatedBy` is never included.
- **Generation calls.** A message that starts "Use the labelizer skill to convert a
  label PDF…" is a labelizer generation call. When it was replayed against the agent's
  `/from-pdf` endpoint, `reply` is a summary of the generated files: label size, dpi,
  object count and types, and caveats. Judge that summary against `expected`'s
  description of the template.
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
  "flags": ["hallucination"],
  "relevant": "yes",
  "stopped": null,
  "roleFit": "Support wants the status and the next step first; drop the API detail.",
  "labelCheck": "n/a" }
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
- `attachment` (sent when `attachments` is set, missing otherwise)
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

### relevant

- `yes`: within what Hanuman is for. That covers:
  - the CNU Back Office and its master data and orders;
  - Retailer Integration;
  - the Labelizer and Layout Designer;
  - FDS and plugin logic;
  - drafting requests;
  - questions about Hanuman itself.

  A short follow-up in such a conversation counts too.
- `no`: outside that scope. Examples are general knowledge, coding help unrelated to
  CNU, small talk beyond a greeting, other companies' systems, and personal advice.

### stopped (only when `relevant: no`; otherwise `null`)

What Hanuman should do with an irrelevant question: stop, and tell the asker in one or
two sentences that it is outside its scope and what it can help with.
- `yes`: it declined, said why, and pointed to what it can do.
- `partial`: it declined without saying why, or answered and only then noted the scope.
- `no`: it answered as if the question were in scope.

Score an irrelevant question on this: `yes` → 3, `partial` → 1–2, `no` → 0–1. An
answer that is long and confident but off-scope is a 0.

### roleFit

One sentence (≤25 words) on how this reply should change for this persona:
- depth and wording (a support agent needs the status and next step, a developer the
  technical cause);
- whether to ask a clarifying question first;
- which skill or data source to use;
- how to say "not my scope".

Fill it when `score ≤ 2` or `stopped` is not `yes`. Otherwise use `null`.

### labelCheck (only for items with `labelFeedback`; otherwise `n/a`)

- `consistent`: the reply fits the label's history. For example, it flags the same
  problems that later needed corrections, or it says the template needs checking when
  corrections followed.
- `contradicts`: the reply claims something the history disproves. For example, it
  calls the generated template correct or complete while corrections followed soon
  after, or it describes a state the history doesn't show.
- `n/a`: the history says nothing about what the reply claims.
