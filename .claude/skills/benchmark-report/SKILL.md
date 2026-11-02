---
name: benchmark-report
description: Write a Markdown report on benchmark runs from benchmark_results.rsults. Every answer is categorized by question type and persona, scored 0–3 against the production reference, and weighted by what the agent could access, how costly a wrong answer is and who asked. Covers one run, every run that ended today, or every run that ended in a date range. Use for "report on the latest run", "judge run 1793258147", "report on today's runs", "report on 2026-10-28 to 2026-11-02", "how did <model> do", or to compare a new run with an earlier report.
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

Postgres is reached with `docker exec postgres psql -U n8n -d n8n`.

## 3. Establish what the agent could access in each run

Judges score against what was actually reachable, not an ideal agent. With several runs,
work this out per run: mounts and tokens can differ between them. Build the access
table (see the report's "What the agent can access") from evidence:
- `docker inspect claude-agent-local`: mounts (is `/srv/repos` there?),
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `CLAUDE_CHAT_MODEL`. This is the state **now**. If the
  agent was recreated since the run, say so.
- `skip_reason` in the items: says which half of the repo mirror was missing at run time.
  Skipped messages are not judged; list them separately in the report.
- `contextRecap` items: asked in a fresh session with the earlier turns recapped.
- Attachments are never in the replay. Logs, databases and the web are never reachable.
- If the repo mirror is mounted but you can't tell whether it was synced at run time,
  check `docker exec claude-agent-local ls /srv/repos`.

## 4. Judge in parallel

Spawn one subagent per chunk, all in one message, so they run at the same time. Give
each one:
- the full text of [rubric.md](rubric.md)
- the run facts and the access table from step 3 (per run, keyed by `runId`)
- the absolute path of its `chunk<N>.json`, and the `judged<N>.json` to write next to it

Tell each judge to:
- read every item in full and score each one against the rubric
- write only the JSON array to `judged<N>.json`
- report back the count and anything unusual

Each judge reads its chunk itself; don't paste the chunk into the prompt.

## 5. Verify, then aggregate

- **Spot-check the judges.** Re-read at least 10 items across chunks yourself,
  especially:
  - scores of 0 on answered turns
  - scores of 3 on `answerable: no`
  - every `hallucination` and `better-than-expected` flag

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
7. **Recommendations**: a table of actions with expected effect.
8. **Limitations**.
9. **Appendix**: the generated `appendix.md`, with a key for the outcome and
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

## Care points

- The appendix holds customer names and order numbers from real sessions. Say so when
  you hand the report over, and don't publish it outside the repo without asking.
- Don't read `.env`. Everything needed comes from Postgres, Docker and the input file.
- Personas are inferred, not recorded. Say so in Limitations.
- When done, give the path to the report and the headline numbers in your answer.
