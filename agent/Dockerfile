# The agent image for local benchmark runs: cnu-claude-agent as checked out
# next to this repo (`upstream`, see docker-compose.yml), with the defaults this
# app's .env sets. The cnu-claude-agent repo itself stays untouched.
#
# The app copies the running agent's config when it switches models, so these
# only fill what a freshly created container would otherwise leave blank.
FROM upstream

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
