# build from the repo root: docker buildx build -f services/crawler/Dockerfile .
FROM node:24-alpine AS build

WORKDIR /app

# every workspace manifest is copied so npm ci sees the lockfile in sync, but only this one is installed
COPY package*.json ./
COPY services/rag-api/package.json services/rag-api/
COPY services/crawler/package.json services/crawler/
COPY services/ingest/package.json services/ingest/
RUN npm ci --ignore-scripts -w services/crawler

COPY services/crawler/tsconfig.json services/crawler/
COPY services/crawler/src services/crawler/src
RUN npm run build -w services/crawler


FROM node:24-alpine

# supercronic runs the schedule as PID 1 and sends job output to the container logs;
# tzdata lets TZ pick the timezone the crontab is evaluated in;
# poppler-utils (pdftoppm) and tesseract OCR the scanned PDFs that have no text layer
RUN apk add --no-cache supercronic tzdata poppler-utils tesseract-ocr tesseract-ocr-data-eng

WORKDIR /app

COPY package*.json ./
COPY services/rag-api/package.json services/rag-api/
COPY services/crawler/package.json services/crawler/
COPY services/ingest/package.json services/ingest/
# npm ci -w still installs a workspace's devDependencies with --omit=dev, so drop them from the manifest first
RUN npm pkg delete devDependencies -w services/crawler \
    && npm ci --ignore-scripts --omit=dev -w services/crawler && npm cache clean --force

COPY --from=build /app/services/crawler/dist services/crawler/dist
COPY services/crawler/crontab services/crawler/crontab

WORKDIR /app/services/crawler

USER node

CMD ["supercronic", "/app/services/crawler/crontab"]
