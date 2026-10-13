# build from the repo root: docker buildx build -f services/rag-api/Dockerfile .
FROM node:24-alpine AS build

WORKDIR /app

# every workspace manifest is copied so npm ci sees the lockfile in sync, but only this one is installed
COPY package*.json ./
COPY services/rag-api/package.json services/rag-api/
COPY services/crawler/package.json services/crawler/
COPY services/ingest/package.json services/ingest/
RUN npm ci --ignore-scripts -w services/rag-api

COPY services/rag-api/tsconfig.json services/rag-api/
COPY services/rag-api/src services/rag-api/src
RUN npm run build -w services/rag-api


FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
COPY services/rag-api/package.json services/rag-api/
COPY services/crawler/package.json services/crawler/
COPY services/ingest/package.json services/ingest/
# npm ci -w still installs a workspace's devDependencies with --omit=dev, so drop them from the manifest first
RUN npm pkg delete devDependencies -w services/rag-api \
    && npm ci --ignore-scripts --omit=dev -w services/rag-api && npm cache clean --force

COPY --from=build /app/services/rag-api/dist services/rag-api/dist

WORKDIR /app/services/rag-api

USER node

EXPOSE 8090

CMD ["node", "dist/server.js"]
