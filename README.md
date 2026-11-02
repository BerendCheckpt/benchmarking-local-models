# benchmarking-local-models

A small web app for benchmarking local Ollama models through the
cnu-claude-agent `/chat` endpoint. It replaces the
"Agent benchmark" n8n workflow.

You sign in once with your CheckNet account, upload a JSON Lines file of
questions, pick a model from the Ollama server and start the run. The app
switches the claude-agent container to that model, replays every
conversation, and writes one row per answer to Postgres. A live page shows
the request in flight, the last result and per-session totals.

## How it works

```mermaid
flowchart LR
  BR[Browser] -- "127.0.0.1:PORT" --> APP[benchmark container]
  BR -- login --> IDP[(OAuth2 login server)]
  APP -- token / refresh --> IDP
  APP -- "ssh: ollama list" --> OH[Ollama server]
  APP -- "Docker socket: recreate" --> CA[claude-agent container]
  APP -- "POST /chat?stream=1" --> CA
  CA --> OH
  APP -- INSERT --> PG[(Postgres<br/>benchmark_results.rsults)]
```

1. **Login.** OAuth2 Authorization Code with PKCE against the login server and
   client set in `.env`. The refresh token is kept in
   `data/.tokens.json`, so a restart doesn't need a new login. The access token is
   refreshed shortly before it expires, and once more if the agent answers 401.
2. **Model list.** The app runs `ollama list` on the Ollama server over SSH,
   with username and password.
3. **Model switch.** The agent reads `CLAUDE_CHAT_MODEL` only once, at startup
   (`chat.mjs` in cnu-claude-agent). So the app recreates the agent container
   through the Docker Engine API. It copies the container's current config and
   only replaces `CLAUDE_CHAT_MODEL`, `ANTHROPIC_BASE_URL` and
   `CLAUDE_CODE_MAX_OUTPUT_TOKENS` (42000 unless `AGENT_MAX_OUTPUT_TOKENS` says
   otherwise; the agent passes its environment on to Claude Code). When
   `AGENT_REPO_MIRROR` is set it also mounts that mirror read-only at
   `/srv/repos` (see [Repo mirror](#repo-mirror)). Then it waits for
   `/health`. If the container already runs that model with that mount and limit, nothing happens.
4. **Run.** Questions are grouped by `session`. Conversations run one at a time,
   and messages within a conversation run in file order. Each follow-up continues
   the agent session that the previous answer returned. Every POST may take up to
   **10 minutes**, and the agent is told the same through
   `x-assistant-deadline-seconds: 600`.
5. **Results.** The SSE stream is reduced to one row per answer, using the same
   logic as the n8n "Build result" node. Each row is inserted into
   `benchmark_results.rsults` with the model name.

## Requirements

- Docker Desktop. The app runs in a container.
- These containers on the same machine:
  - the claude-agent container, built from cnu-claude-agent, with its port published
  - Postgres, on a Docker network the app can join
- SSH access with username and password to the Ollama server.
- A CheckNet account that can sign in to the QA login server.

## Setup

1. Create your config from the example and replace every `<placeholder>`.
   All hosts, URLs and ports live only in `.env`; the app refuses to start when
   one is missing.
   ```bash
   cp .env.example .env
   ```
2. Build and start:
   ```bash
   docker compose up -d --build
   ```
3. Open `http://127.0.0.1:<PORT>` and click **Log in**.

`.env` and `data/` are git-ignored. Never commit them.

### Repo mirror

The agent answers plugin-logic, FDS and Layout Designer questions from a repo
mirror at `/srv/repos`. In the swarm that is an NFS share filled by the
`claude-mirror-sync` service. Locally you fill a Docker volume once with the
same script, from the agent image. It needs a read-only GitHub token for the
`checkpt-als` org and an Azure DevOps PAT with Code (Read). Without a mirror,
those questions can't be answered, which skews the benchmark.

```bash
docker volume create claude-repos
```

The image runs as `node`, and a new volume is owned by root, so hand it over once:

```bash
docker run --rm --user root -v claude-repos:/srv/repos --entrypoint chown cnu-claude-agent-benchmark:latest node:node /srv/repos
```

Then set `GH_TOKEN` and `AZDO_PAT` in your shell (don't put them in `.env`), and run:

```bash
docker run --rm -e GH_TOKEN -e AZDO_PAT -e CNU_REPO_MIRROR=/srv/repos -v claude-repos:/srv/repos --entrypoint node cnu-claude-agent-benchmark:latest /app/sync-mirror.mjs --once
```

Set `AGENT_REPO_MIRROR=claude-repos` in `.env` and restart the app. The next run
recreates the agent with the mirror mounted. Run the sync again to refresh it;
`/srv/repos/.synced` holds the date of the last clean sync.

**The mirror and its tokens are optional.** At the start of each run the app
checks which half of the mirror the agent has: `github/` (filled with
`GH_TOKEN`) and `devops/` (filled with `AZDO_PAT`). If either is missing, or
`AGENT_REPO_MIRROR` is empty, every message that needs the mirror is **skipped**
with the reason, for example *needs the repo mirror, which is not synced:
GH_TOKEN and AZDO_PAT missing*. The rest of the run goes ahead, and a
conversation carries on past its skipped messages. Once you've synced the
mirror, run the same file again to answer the skipped questions.

### Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `PORT` | Port the app listens on and is published on (`127.0.0.1` only) |
| `OAUTH_AUTH_URL` / `OAUTH_TOKEN_URL` | Login server authorize and token endpoints |
| `OAUTH_CLIENT_ID` | Public OAuth client (no secret) |
| `OAUTH_SCOPE` | Requested scopes, incl. `offline_access` for the refresh token |
| `OAUTH_REDIRECT_URI` | Registered redirect URI; its port must equal `PORT` |
| `AGENT_BASE_URL` | Where the app reaches the agent (from inside its container) |
| `AGENT_CONTAINER` | Agent container to recreate |
| `AGENT_OLLAMA_URL` | Written to the agent's `ANTHROPIC_BASE_URL`; leave empty to keep the current value |
| `AGENT_ENV` | `env` sent in each `/chat` body |
| `AGENT_MAX_OUTPUT_TOKENS` | Written to the agent's `CLAUDE_CODE_MAX_OUTPUT_TOKENS`. Default `42000` (Claude Code's own default is 32000) |
| `AGENT_REPO_MIRROR` | Docker volume or host path with the repo mirror, mounted read-only at `/srv/repos` in the agent. Empty: no mirror |
| `OLLAMA_SSH_HOST` / `OLLAMA_SSH_PORT` | Ollama server SSH address |
| `OLLAMA_SSH_USER` / `OLLAMA_SSH_PASSWORD` | Your SSH login |
| `OLLAMA_SSH_HOSTKEY_SHA256` | Optional host key pin (`SHA256:…`); when set, the app refuses any other server |
| `PG_NETWORK` | Docker network the app joins to reach Postgres |
| `PGHOST` `PGPORT` `PGDATABASE` `PGUSER` `PGPASSWORD` | Postgres connection |

## Input file

JSON Lines: one JSON object per line. Blank lines are skipped.

```json
{"session": "05ef829c-…", "question": "are you able to check what happened to this poctrlno? 417749805", "answer": "This PoCtrlNo … REPLACED …"}
{"session": "05ef829c-…", "question": "and which vendor is it?", "answer": "vendor 0000544"}
{"question": "a standalone question"}
```

| Field | Required | Meaning |
|---|---|---|
| `question` | yes | Message sent to the agent |
| `answer` | no | Expected answer, stored as `expected_answer` for comparison |
| `session` | no | Lines with the same value form one conversation. Without it, the line is its own conversation |
| `needs` | no | What answering needs, as a list. `["mirror"]`: the repo mirror (plugin code, FDS, Layout Designer manual). `[]`: nothing extra. Without the field a keyword check guesses, and it misses most cases |

`hanuman-qa-2026-10-29.tagged.jsonl` is the 10-29 file with `needs` filled in
from the run 1793258147 report: 73 of its 232 questions need the mirror.

Extra fields (such as `askedAt`) are ignored. Unlike the n8n flow, sessions with
fewer than 3 messages are not skipped.

## Progress page

While a run is going, the page refreshes every 2 seconds and shows:

- **Progress**: state, model, answered/total, failures, token-limit answers and
  skipped messages. A grey line says when the repo mirror is missing and which
  tokens it needs.
  The red line under the bar only appears when the whole run stopped (for
  example the agent didn't become healthy). Errors of single answers stay on
  their message.
- **Current request**: session, message number, the agent session being
  continued, the question, and how long it has been waiting.
- **Last result**: ok / failed / token limit, latency, turns, tool calls, cost, reply, expected
  answer and error.
- **Sessions**: every session, with answered/ok/failed, average latency, tool
  calls and cost. Expand a session to see its messages, and expand a message to
  see its reply and expected answer.

A message whose answer passed Claude Code's output token maximum
(`CLAUDE_CODE_MAX_OUTPUT_TOKENS`, 42000 here) gets the status **⚠ token limit**
instead of failed. The run carries on with the next message, in a **fresh agent
session**: a resumed session almost always hits the limit again.

So that the follow-up keeps its context, its message starts with a **recap**:
every earlier question of the conversation with the agent's answer, each answer
cut at 800 characters ("(no answer)" for one that failed), then the new
question. The same happens when a conversation's first answer failed without a
session. Only that first message of the new session gets the recap; later ones
continue the new session. The message is marked **↻ recap**, its row has
`context_recap = true` and a new `sessionId`, and `prompt` keeps the original
question. A recap is shorter than the real history, so judge these answers with
that in mind.

Only one run can be active at a time. Progress is kept in memory, so restarting
the container clears the page. The rows already written to Postgres stay.

## Results page

`http://127.0.0.1:<PORT>/results` shows every stored run, newest first. You can
filter by:

- **Model**: the models found in the table.
- **From / To**: calendar days in your local time, both inclusive.
- **Min / max messages per session**: only sessions with that many messages in
  their run.

Each run shows its date, model, sessions, messages, ok % (of the messages that
were asked), token-limit count, skipped count, recapped count,
average latency, tool calls and cost. Expand a run to see its sessions, and a
session to see each question with reply, expected answer and error.

## Results

Rows go to `benchmark_results.rsults`. On startup the app adds the `model`,
`created_at` (insert time), `token_limit`, `skip_reason` and `context_recap` columns if they
don't exist yet.

The one-off migration `migrations/2026-10-30-created-at.sql` adds the same
columns and backfills the rows from before them. Run it once:

```bash
docker exec -i postgres psql -U n8n -d n8n -v ON_ERROR_STOP=1 < migrations/2026-10-30-created-at.sql
```

Example query:

```sql
SELECT model, run_id, created_at, "sessionId", ok, token_limit, latency_ms, turns, "toolCalls", prompt, reply, expected_answer
FROM benchmark_results.rsults
ORDER BY run_id DESC;
```

- `run_id` is the run's start time in Unix seconds, shared by every row of one run.
- `ok` is `true` when the agent returned a result and no error.
- `token_limit` is `true` when the answer passed the output token maximum.
- `context_recap` is `true` when the message was asked in a fresh session with
  the earlier turns recapped (see [Progress page](#progress-page)).
- `skip_reason` is empty for asked messages. For a skipped one it says why, and
  `ok` is `false` with an empty reply.

## Reports

In Claude Code, opened in this repository, run:

```text
/benchmark-report [run_id] [input.jsonl]
```

Without arguments it takes the most recent run and finds the matching input file
in `Benchmark tests local models`. It writes `reports/run-<run_id>.md`. In that
report every answer is categorized by question type and persona and scored 0–3
against the production reference. The scores are weighted by question type,
persona and what the agent could access. `reports/run-1793258147.md` is an
example.

The skill is in `.claude/skills/benchmark-report/`:
- `SKILL.md`: the steps.
- `rubric.md`: the judging rubric.
- `scripts/export-run.mjs`: exports the run from Postgres.
- `scripts/aggregate.mjs`: weights and tables.

Working files go to `reports/work/`, which is git-ignored. The appendix of a
report contains customer names and order numbers from real sessions.

## Development

```bash
npm install
npm test
```

`npm test` runs the unit tests with Node's test runner and writes coverage to
`lcov.info` for SonarQube.

| File | Role |
|---|---|
| `server.mjs` | HTTP server: page, OAuth callback, `/login`, `/api/status`, `/api/models`, `/api/run` |
| `oauth.mjs` | PKCE login, token exchange and refresh, token file |
| `ollama.mjs` | `ollama list` over SSH |
| `docker.mjs` | Minimal Docker Engine API client over the socket |
| `agent.mjs` | Model switch, `/chat` POST with 10-minute timeout, SSE parsing |
| `benchmark.mjs` | JSONL parsing, session grouping, run loop and progress state |
| `results.mjs` | Results page filters and grouping into runs and sessions |
| `db.mjs` | Postgres schema check, inserts and the results query |
| `public/index.html` | Benchmark page |
| `public/results.html` | Results page |
| `public/common.js`, `public/style.css` | Helpers and styles shared by both pages |
| `migrations/` | One-off SQL scripts, run by hand |

### SonarQube

Create a token in your SonarQube (My Account → Security) and store it in the
`SONAR_TOKEN` environment variable. Set `SONAR_HOST_URL` to the SonarQube URL as
seen from a container, then scan:

```bash
docker run --rm -e SONAR_HOST_URL -e SONAR_TOKEN -v "$PWD:/usr/src" sonarsource/sonar-scanner-cli
```

Run `npm test` first so the coverage report is current. Settings are in
`sonar-project.properties`.

## Security notes

- The app mounts `/var/run/docker.sock`, which gives it full control over Docker
  on the host. That's why the page is only bound to `127.0.0.1`.
- Tokens and passwords never appear in logs or in the browser. The refresh token
  is stored in `data/.tokens.json` with mode 0600.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Could not load models" | Wrong SSH user/password, or the server isn't reachable on `OLLAMA_SSH_PORT` |
| Run stops at "starting agent" | Docker socket not mounted, Enhanced Container Isolation blocks it, or the agent didn't pass `/health` within 60 s |
| Every answer fails with `HTTP 401` | Refresh token expired or revoked. Log in again |
| `could not prepare the results table` in the logs | Wrong Postgres credentials, or the app isn't on `PG_NETWORK` |
| `missing settings in .env: …` in the logs | Those keys are empty or absent in `.env` |
| "line N: not valid JSON" | That line of the input file isn't a single complete JSON object |
