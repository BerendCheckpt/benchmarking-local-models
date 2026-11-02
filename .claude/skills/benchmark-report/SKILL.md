---
name: benchmark-report
description: Write a Markdown report on a benchmark run from benchmark_results.rsults. Every answer is categorized by question type and persona, scored 0–3 against the production reference, and weighted by what the agent could access, how costly a wrong answer is and who asked. Use for "report on the latest run", "judge run 1793258147", "how did <model> do", or to compare a new run with an earlier report.
argument-hint: "[run_id] [input.jsonl]"
---

# Benchmark report

Produces `reports/run-<run_id>.md` in the format of `reports/run-1793258147.md`. Read
that report first: it is the model for structure, tone and table layout.

Arguments: `$ARGUMENTS`. The first is a run id; without one, take the most recent run.
The second is the input `.jsonl` the run was started with.

## 1. Find the run and its input file

- The input files live in `C:\Users\hulshofb\Documents\Benchmark tests local models`.
- Without an input argument, pick the file whose line count matches the run's message
  count and whose first question matches the first prompt. Prefer the `.tagged.jsonl`
  variant when both match.
- The export script checks the match and refuses a file that doesn't line up.

## 2. Export

```bash
node .claude/skills/benchmark-report/scripts/export-run.mjs --run <run_id> --input "<file.jsonl>"
```

This writes `reports/work/<run_id>/` (git-ignored):
- `items.json`: one item per message.
- `run.json`: the run facts.
- `chunk1-5.json`: the asked messages to judge. Skipped ones are left out.

Postgres is reached with `docker exec postgres psql -U n8n -d n8n`.

## 3. Establish what the agent could access in this run

Judges score against what was actually reachable, not an ideal agent. Build the access
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
- the run facts and the access table from step 3
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
  node .claude/skills/benchmark-report/scripts/aggregate.mjs reports/work/<run_id>
  ```

  It prints every results table as Markdown, the token-limit cascades, the low scores
  and the better-than-reference items. It also writes `appendix.md` and `rows.json`.
  It refuses to run while items are unjudged.
- Check root causes against the raw data before writing them as findings. Examples:
  timeouts (latency near the time budget plus "I ran out of time"), token-limit
  cascades, or a missing mount.

## 6. Write the report

Write `reports/run-<run_id>.md` with these sections, in this order:
1. A facts table: run, model, input, reference, judging date.
2. **Summary**: 5–6 bold-led bullets with the numbers that matter.
3. **Methodology**: the access table for this run, the 0–3 scale and the weights.
   Copy the weights from `aggregate.mjs` (category × persona × answerability) and
   explain them as the earlier report does.
4. **What was asked**: question types, personas, type × persona, observations
   (languages, single-turn sessions, repeated questions).
5. **Results**: by outcome, type, persona, access, grounding. Add recapped follow-ups
   and skipped messages when there are any.
6. **Findings**: numbered, each backed by item ids and numbers.
7. **Recommendations**: a table of actions with expected effect.
8. **Limitations**.
9. **Appendix**: the generated `appendix.md`, with a key for the outcome and
   answerability codes. The outcome codes are `ans`, `time`, `tok`, `net` and `skip`;
   `R` marks a recapped message.
   It is **grouped by session, then ordered by `created_at`**: the order the run
   asked them. Don't sort by `askedAt` (the original question date) or any other
   column, and don't split the sessions into parts. Where a run's rows share one
   backfilled `created_at`, the input order breaks the tie.
   - A sessions table comes first: one row per session, linking to its section.
   - Then one section per session, holding that session's message table (Turn
     is the message's position in its session).
   - In a Claude Docs doc, which has no collapsible block, use the same shape. The
     links go to the session headings' block ids.

If an earlier report exists for the same input, add a short comparison: the same
questions, what changed in setup, and the score deltas per type.

## Care points

- The appendix holds customer names and order numbers from real sessions. Say so when
  you hand the report over, and don't publish it outside the repo without asking.
- Don't read `.env`. Everything needed comes from Postgres, Docker and the input file.
- Personas are inferred, not recorded. Say so in Limitations.
- When done, give the path to the report and the headline numbers in your answer.
