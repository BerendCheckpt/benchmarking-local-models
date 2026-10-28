FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY *.mjs ./
COPY public ./public

# /data holds the refresh token and is bind-mounted by compose.
RUN mkdir -p /data && chown node:node /data
ENV DATA_DIR=/data PORT=4202
USER node

EXPOSE 4202
CMD ["node", "server.mjs"]
