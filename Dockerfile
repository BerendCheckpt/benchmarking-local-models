FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY *.mjs ./
COPY public ./public

# /data holds the refresh token and is bind-mounted by compose.
RUN mkdir -p /data && chown node:node /data
# PORT comes from .env through compose.
ENV DATA_DIR=/data
USER node

CMD ["node", "server.mjs"]
