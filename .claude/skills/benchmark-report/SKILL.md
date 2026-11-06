---
name: benchmark-report
description: Write a Markdown report on benchmark runs from benchmark_results.rsults. Every answer is categorized by question type and persona, scored 0–3 against the production reference, and weighted by what the agent could access, how costly a wrong answer is and who asked. The report advises how Hanuman should answer each role, whether it stops at irrelevant questions, and compares labelizer questions with their RetailerIntegration correction history. Covers one run, every run that ended today, or every run that ended in a date range. Use for "report on the latest run", "judge run 1793258147", "report on today's runs", "report on 2026-10-28 to 2026-11-02", "how did <model> do", or to compare a new run with an earlier report.
argument-hint: "[run_id [input.jsonl] | today | <from> [<to>]]"
---

# Benchmark report

Produces a report in the format of `reports/run-1793258147.md`. Read that report first:
it is the model for structure, tone and table layout.

Arguments: `$ARGUMENTS`. Three ways to pick what the report covers:

| Arguments | Covers | Report |
|---|---|---|
| none | the most recent run | `reports/run-<run_id>.md` |
| `<run_id> [input.jsonl]` | that run | `reports/run-<run_id>.md` |
| `today` | every run that ended today | `reports/runs-<YYYY-MM-DD>.md` |
| `<from> [<to>]` (`YYYY-MM-DD`) | every run that ended from `<from>` to `<to>`, both days included; `<from>` alone is that one day | `reports/runs-<from>_<to>.md` (`runs-<day>.md` for one day) |

Label details from RetailerIntegration (step 2b) are always fetched when an item names a
label id. An old `labels` argument is accepted and ignored.

A run *ended* on the day its last message was saved, in local time. A run that is still
going (the app at `http://127.0.0.1:4202` says so) is left out; say so in the report.
If a window holds exactly one run, write the usual `reports/run-<run_id>.md` instead.

## 1. Find the runs and their input files

- The input files live in `C:\Users\hulshofb\Documents\Benchmark tests local models`.
- The export script finds each run's file itself: the one whose every line matches a
  row of the run, preferring the `.tagged.jsonl` variant. An input argument (single run
  only) overrides that, and the script refuses a file that doesn't line up.
- A run that was stopped early matches the first lines of several files. It gets the
  newest file that existed when the run started, marked `partial` in `run.json`.
- A run with no matching file is still exported, but without original sessions and
  dates. Say so in Limitations.
- A run of messages chosen on the app's selection page saves each row's input line
  (`input_line`) and is matched by line number. `run.json` then has
  `selection: { asked, of }`.

## 2. Export

```bash
node .claude/skills/benchmark-report/scripts/export-run.mjs --run <run_id> [--input "<file.jsonl>"]
node .claude/skills/benchmark-report/scripts/export-run.mjs --today
node .claude/skills/benchmark-report/scripts/export-run.mjs --from <YYYY-MM-DD> --to <YYYY-MM-DD>
```

It prints the runs it took, with model and input file. It writes
`reports/work/<run_id>/`, or `reports/work/<from>_<to>/` for a window (`<day>/` when
from and to are the same day), git-ignored:
- `items.json`: one item per message.
- `run.json`: the window and each run's facts (model, input, first and last message).
- `chunk1-5.json`: the asked messages to judge. Skipped ones are left out. For a large
  window, pass `--chunks <n>` so each chunk stays around 50 messages.

Item `id`s number the messages across all runs; `line` is the line in that run's input
file, and `runId` and `model` say where each one came from.

Postgres is reached with `docker exec postgres psql -U n8n -d n8n`: the app on this PC.

**A run on the spark server** (the Portainer stack in `deploy/spark/`) is in that
stack's own Postgres. Open a tunnel first, then add `--server` to the export:

```bash
ssh -N -L 5433:127.0.0.1:5433 <spark>
```

```bash
node .claude/skills/benchmark-report/scripts/export-run.mjs --server --run <run_id>
```

`--server` reads `RESULTS_PGHOST`, `RESULTS_PGPORT`, `RESULTS_PGDATABASE`,
`RESULTS_PGUSER` and `RESULTS_PGPASSWORD` from `.env` itself; don't read `.env`.
The app's status for a running-run check comes from `http://127.0.0.1:4202`,
which needs the page tunnel too (README, "Deploy on spark").

## 2b. Label history (always, before judging)

```bash
node .claude/skills/benchmark-report/scripts/label-ri.mjs reports/work/<name>
```

This step is deterministic and needs no reasoning. Run the command once, and read
only its one-line output. **Don't open `labels.json` or `labels.md`, don't print or
query RI rows yourself, and don't run other queries against RetailerIntegration.**

For every item that names a label id, the script runs one query per distinct id against
the RetailerIntegration Postgres (`ri.labelizer_generation_feedback`, read-only, this
one table only). It finds label ids in two places:
- labelizer generation calls: `Target LabelId: <n>` in the prompt (source `generation`)
- questions naming one: "label id 103", "Labelid 103" (source `question`); a mention
  without a number is left out

`CreatedBy` is replaced by `User 1`, `User 2`, … as soon as a row is read. Real names are
never written, printed or given to a judge.

It writes:
- `labels.json`, which holds:
  - per label id: the rows once, its retailers, and `shared` (rows for more than one
    retailer, or generations from different PDFs);
  - per item: a summary relative to the question's `askedAt` (generations and
    corrections in total, and before and after the question; minutes to the next
    correction; minutes from the first generation to the first correction), plus
    `pdfMatch`. `pdfMatch` compares the attachment's hash with RI's `pdfHash`:
    `match`, `name only`, `different PDF`, `no RI generation` or `no attachment`.
- `labels.md`: the report's "Label details" section, ready to splice in (step 6).

It also adds each item's summary, `shared` and `pdfMatch` to the chunk items as
`labelFeedback`, so the judges can compare the reply with what was done to the label
(`labelCheck`).

The connection comes from `RI_PGHOST`, `RI_PGPORT`, `RI_PGDATABASE`, `RI_PGUSER`,
`RI_PGPASSWORD` and `RI_PGSSLMODE`, which the script reads from `.env` itself. If it says
they are missing, ask the user once whether to fill them in or go on without. Without
them, write the report without the labelizer comparison and say so in Limitations;
don't read `.env` yourself. A label id whose query fails is logged and recorded with
its error, and the others still run.

## 3. Establish what the agent could access in each run

Judges score against what was actually reachable, not an ideal agent. With several runs,
work this out per run: mounts and tokens can differ between them. Build the access
table (see the report's "What the agent can access") from evidence:
- `docker inspect claude-agent-local`: mounts (is `/srv/repos` there?),
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `CLAUDE_CHAT_MODEL`. This is the state **now**. If the
  agent was recreated since the run, say so. For a run on spark, the agent is
  `claude-agent-benchmark` there: `ssh <spark> docker inspect claude-agent-benchmark`.
- `skip_reason` in the items: says which half of the repo mirror was missing at run time.
  Skipped messages are not judged; list them separately in the report.
- `contextRecap` items: asked in a fresh session with the earlier turns recapped.
- Attachments: a message that named a file is replayed with the file recovered from its
  QA session. `attachments` in the item lists what was sent (name, type, size). When the
  file couldn't be recovered (CSV, XML, spreadsheets, a PDF the agent never read), the
  message was skipped, and `skip_reason` says why. Runs from before this feature sent
  no files at all: their items have no `attachments` and no such skip reasons.
- Logs, databases and the web are never reachable.
- If the repo mirror is mounted but you can't tell whether it was synced at run time,
  check `docker exec claude-agent-local ls /srv/repos`.

## 4. Judge in parallel

Spawn one subagent per chunk, all in one message, so they run at the same time. Give
each one:
- the full text of [rubric.md](rubric.md)
- the run facts and the access table from step 3 (per run, keyed by `runId`)
- the absolute path of its `chunk<N>.json`, and the `judged<N>.json` to write next to it

Tell each judge to:
- read every item in full and score each one against the rubric, including `relevant`,
  `stopped`, `roleFit` and, for items with `labelFeedback`, `labelCheck`
- write only the JSON array to `judged<N>.json`
- report back the count and anything unusual

Each judge reads its chunk itself; don't paste the chunk into the prompt.

## 5. Verify, then aggregate

- **Spot-check the judges.** Re-read at least 10 items across chunks yourself,
  especially:
  - scores of 0 on answered turns
  - scores of 3 on `answerable: no`
  - every `hallucination` and `better-than-expected` flag
  - every `relevant: no` (is it really out of scope?) and every `labelCheck: contradicts`

  Fix judgments you disagree with in the `judged*.json` files. Note in Limitations how
  many you changed.
- Run:

  ```bash
  node .claude/skills/benchmark-report/scripts/aggregate.mjs reports/work/<name>
  ```

  It prints every results table as Markdown, the token-limit cascades, the low scores
  and the better-than-reference items. It also writes `appendix.md` and `rows.json`.
  It refuses to run while items are unjudged. With more than one run it adds a "By run"
  table, and a "Question type × model" table when the runs used different models.
  It also prints:
  - "Irrelevant questions" (did Hanuman stop and say so, per persona);
  - "Advice per role", with the judges' `roleFit` notes grouped per persona;
  - with `labels.json`, "Labelizer questions vs RetailerIntegration": one line per label
    id, for every item that names one. The columns are items, category, questions,
    generations, corrections, corrections per question, question → next correction,
    first generation → first correction, retailers, shared, PDF match and `labelCheck`.

    It never prints the RI rows. Those are only in `labels.md`.
- Check root causes against the raw data before writing them as findings. Examples:
  timeouts (latency near the time budget plus "I ran out of time"), token-limit
  cascades, or a missing mount.

## 6. Write the report

Write the report (path from the table above) with these sections, in this order:
1. A facts table: run, model, input, reference, judging date. For a window: the window,
   the runs with model, input and end time, and the judging date.
2. **Summary**: 5–6 bold-led bullets with the numbers that matter.
3. **Methodology**: the access table for this run, the 0–3 scale and the weights.
   Copy the weights from `aggregate.mjs` (category × persona × answerability) and
   explain them as the earlier report does.
4. **What was asked**: question types, personas, type × persona, observations
   (languages, single-turn sessions, repeated questions).
5. **Results**: by run and by model (for a window), then by outcome, type, persona,
   access, grounding. Add recapped follow-ups and skipped messages when there are any.
6. **Findings**: numbered, each backed by item ids and numbers.
7. **How Hanuman answers each role**: one subsection per persona with enough items.
   Use the "Advice per role" table and the `roleFit` notes. For each persona cover:
   - what works;
   - what goes wrong, with item ids;
   - concrete changes to how Hanuman answers that role: order (status and next step
     first for support and operations, technical cause for developers), depth, when
     to ask a clarifying question, which skill or source to use, and language.

   Phrase the changes so they can go straight into the agent's system prompt or a
   skill.
8. **Irrelevant questions**: how many there were, and how often Hanuman stopped and told
   the asker it is out of scope (from the "Irrelevant questions" table). Quote one or
   two replies that got it wrong, give the reply Hanuman should have given (one or two
   sentences: out of scope, and what it can help with), and propose the system-prompt
   rule that makes it do so.
9. **Labelizer vs RetailerIntegration** (when `labels.json` has items). Copy the
   "Labelizer questions vs RetailerIntegration" table and write from it alone:
   - how many corrections followed the questions (corrections per question);
   - how soon (question → next correction, first generation → first correction);
   - what that says about the quality of the generated templates and Hanuman's
     labelizer answers;
   - where replies contradict the history (`labelCheck: contradicts`);
   - which ids are `shared`: their counts cover more than one label.

   Note the items without `askedAt`, which have no time gaps.
10. **Recommendations**: a table of actions with expected effect. It must include actions
    for the role advice, the irrelevant-question rule and the labelizer findings.
11. **Limitations**. For a selection run (`selection` in `run.json`), say "N of M
    messages, chosen by hand". It isn't a sample of the whole file, and comparisons
    with earlier reports cover only the shared questions.
12. **Label details**: a short reading of 3–5 lines, then the line
    `<!-- label-details -->` on its own. Base the reading on the PDF match, Shared and
    Retailers columns of the summary table: which labels have generation and correction
    history, which PDFs don't match, which ids are shared, and which have no rows. Don't
    write the rows: the marker is replaced by `labels.md`.
13. **Appendix**: the key below, then the line `<!-- appendix -->` on its own. The marker
   is replaced by the generated `appendix.md`; don't paste it. The key covers the outcome and
   answerability codes. The outcome codes are `ans`, `time`, `tok`, `net` and `skip`;
   `R` marks a recapped message.
   It is **grouped by session, then ordered by `created_at`**: the order the run
   asked them. For a window it is grouped by run first (in the order they ended), and
   the sessions table gets Run and Model columns. Don't sort by `askedAt` (the
   original question date) or any other column, and don't split the sessions into
   parts. Where a run's rows share one backfilled `created_at`, the input order breaks
   the tie.
   - A sessions table comes first: one row per session, linking to its section.
   - Then one section per session, holding that session's message table (Turn
     is the message's position in its session, # its line in the input file).
   - In a Claude Docs doc, which has no collapsible block, use the same shape. The
     links go to the session headings' block ids.

If an earlier report exists for the same input, or a window holds several runs of the
same input, add a short comparison: the same questions, what changed in setup, and the
score deltas per type.

Finish by splicing in the generated tables:

```bash
node .claude/skills/benchmark-report/scripts/assemble-report.mjs reports/<report>.md reports/work/<name>
```

It replaces `<!-- label-details -->` with `labels.md` and `<!-- appendix -->` with
`appendix.md`. It refuses, and leaves the report unchanged, when a marker or a file is
missing. Run it once and don't read the result back.

## Care points

- The appendix holds customer names and order numbers from real sessions. Say so when
  you hand the report over, and don't publish it outside the repo without asking.
- `CreatedBy` is user data. The scripts pseudonymise it (User 1, User 2, …). Never put a
  real name in the report, and never link a person named in a question to a
  pseudonym or to RI history.
- Don't read `.env`. Everything needed comes from Postgres, Docker and the input file
  (and from `label-ri.mjs`, which reads `.env` itself).
- Personas are inferred, not recorded. Say so in Limitations.
- When done, give the path to the report and the headline numbers in your answer.
