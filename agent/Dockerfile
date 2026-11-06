# The benchmark-only agent: the production cnu-claude-agent image plus the
# defaults this app needs. The cnu-claude-agent repo itself stays untouched.
#
# AGENT_BASE is the production image, pinned to a QA release. The release
# workflow reads this line; bump the tag to benchmark a newer agent. A local
# build passes AGENT_BASE=cnu-claude-agent:local (see docker-compose.yml).
#
# The app copies the running agent's config when it switches models, so these
# only fill what a freshly created container would otherwise leave blank.
ARG AGENT_BASE=ghcr.io/checkpt-als/checknet-united/claude-agent:2026.11.4.62-qa
FROM ${AGENT_BASE}

# poppler-utils gives pdftoppm, which Claude Code's Read needs to turn PDF pages
# into images. A model behind Ollama sees a PDF only that way: Ollama drops a
# PDF sent whole (run 1793868727).
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/*
USER node

# The app recreates only a container with this label, so on a server that also
# runs the production agent it can never touch that one.
LABEL benchmark.role=agent

ARG AGENT_ENV=qa
ARG AGENT_OLLAMA_URL=
ARG AGENT_MAX_OUTPUT_TOKENS=42000
# How long before the deadline the agent stops calling tools and writes its
# answer. Claude needs 30 s; a local model has to read the whole conversation
# again first, so it gets more.
ARG AGENT_WRAP_UP_SECONDS=120

ENV CNU_DEFAULT_ENV=${AGENT_ENV} \
    ANTHROPIC_BASE_URL=${AGENT_OLLAMA_URL} \
    CLAUDE_CODE_MAX_OUTPUT_TOKENS=${AGENT_MAX_OUTPUT_TOKENS} \
    CHAT_WRAP_UP_SECONDS=${AGENT_WRAP_UP_SECONDS} \
    CNU_REPO_MIRROR=/srv/repos
