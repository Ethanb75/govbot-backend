# build from the repo root: docker buildx build -f services/ingest/Dockerfile .
FROM node:24-alpine AS build

WORKDIR /app

# every workspace manifest is copied so npm ci sees the lockfile in sync, but only this one is installed
COPY package*.json ./
COPY services/rag-api/package.json services/rag-api/
COPY services/crawler/package.json services/crawler/
COPY services/ingest/package.json services/ingest/
RUN npm ci --ignore-scripts -w services/ingest

COPY services/ingest/tsconfig.json services/ingest/
COPY services/ingest/src services/ingest/src
RUN npm run build -w services/ingest


FROM node:24-alpine

# supercronic runs the schedule as PID 1 and sends job output to the container logs;
# tzdata lets TZ pick the timezone the crontab is evaluated in
RUN apk add --no-cache supercronic tzdata

WORKDIR /app

COPY package*.json ./
COPY services/rag-api/package.json services/rag-api/
COPY services/crawler/package.json services/crawler/
COPY services/ingest/package.json services/ingest/
# npm ci -w still installs a workspace's devDependencies with --omit=dev, so drop them from the manifest first
RUN npm pkg delete devDependencies -w services/ingest \
    && npm ci --ignore-scripts --omit=dev -w services/ingest && npm cache clean --force

COPY --from=build /app/services/ingest/dist services/ingest/dist
COPY services/ingest/crontab services/ingest/crontab

WORKDIR /app/services/ingest

USER node

CMD ["supercronic", "/app/services/ingest/crontab"]
