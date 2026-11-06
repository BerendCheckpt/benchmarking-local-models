# The benchmark viewer: a static page served by Debian-based nginx (no Alpine).
# Built on the spark server itself by `npm run viewer:deploy`, so it is arm64 there.
# The page reads question files in the browser only; the reports it lists are
# mounted read-only at /usr/share/nginx/html/reports by docker-compose.yml.
FROM nginx:stable-bookworm

LABEL benchmark.role=viewer

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
