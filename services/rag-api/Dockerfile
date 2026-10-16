# build from the repo root: docker buildx build -f services/rag-api/Dockerfile .
FROM node:24-alpine AS build

WORKDIR /app

# every workspace manifest is copied so npm ci sees the lockfile in sync, but only this service
# and packages/shared are installed
COPY package*.json ./
COPY packages/shared/package.json packages/shared/
COPY services/rag-api/package.json services/rag-api/
COPY services/crawler/package.json services/crawler/
COPY services/ingest/package.json services/ingest/
RUN npm ci --ignore-scripts -w packages/shared -w services/rag-api

COPY packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src packages/shared/src
COPY services/rag-api/tsconfig.json services/rag-api/
COPY services/rag-api/src services/rag-api/src
# shared first: the service compiles against its type declarations
RUN npm run build -w packages/shared && npm run build -w services/rag-api


FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
COPY packages/shared/package.json packages/shared/
COPY services/rag-api/package.json services/rag-api/
COPY services/crawler/package.json services/crawler/
COPY services/ingest/package.json services/ingest/
# npm ci -w still installs a workspace's devDependencies with --omit=dev, so drop them from the manifests first
RUN npm pkg delete devDependencies -w packages/shared -w services/rag-api \
    && npm ci --ignore-scripts --omit=dev -w packages/shared -w services/rag-api && npm cache clean --force

COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/services/rag-api/dist services/rag-api/dist

WORKDIR /app/services/rag-api

USER node

EXPOSE 8090

CMD ["node", "dist/server.js"]
