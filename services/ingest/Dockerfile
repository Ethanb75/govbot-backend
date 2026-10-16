# build from the repo root: docker buildx build -f services/ingest/Dockerfile .
FROM node:24-alpine AS build

WORKDIR /app

# every workspace manifest is copied so npm ci sees the lockfile in sync, but only this service
# and packages/shared are installed
COPY package*.json ./
COPY packages/shared/package.json packages/shared/
COPY services/rag-api/package.json services/rag-api/
COPY services/crawler/package.json services/crawler/
COPY services/ingest/package.json services/ingest/
RUN npm ci --ignore-scripts -w packages/shared -w services/ingest

COPY packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src packages/shared/src
COPY services/ingest/tsconfig.json services/ingest/
COPY services/ingest/src services/ingest/src
# shared first: the service compiles against its type declarations
RUN npm run build -w packages/shared && npm run build -w services/ingest


FROM node:24-alpine

# trust the RDS CA, so the database URLs can use sslmode=verify-full (RDS forces TLS)
RUN wget -qO /etc/ssl/certs/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem

WORKDIR /app

COPY package*.json ./
COPY packages/shared/package.json packages/shared/
COPY services/rag-api/package.json services/rag-api/
COPY services/crawler/package.json services/crawler/
COPY services/ingest/package.json services/ingest/
# npm ci -w still installs a workspace's devDependencies with --omit=dev, so drop them from the manifests first
RUN npm pkg delete devDependencies -w packages/shared -w services/ingest \
    && npm ci --ignore-scripts --omit=dev -w packages/shared -w services/ingest && npm cache clean --force

COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/services/ingest/dist services/ingest/dist

WORKDIR /app/services/ingest

USER node

# one run per scheduled ECS task (EventBridge Scheduler); the exit code is the run's result
CMD ["node", "dist/index.js"]
