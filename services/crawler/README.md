# knowledge-crawler

Fetches public documents from government websites and writes them as Markdown into the knowledge base (a local directory, or the knowledge base S3 bucket on AWS), where the ingest service picks them up and indexes them into the vectors database. The crawler knows nothing about chunking or embeddings. Its contract with ingest has two parts:

- **Markdown files.** It produces good `.md` files.
- **The metadata database.** For executive orders, it UPSERTs a metadata row into `executive_orders` and sets `qdrant_status = 'pending'` whenever it rewrites the order's Markdown. Ingest moves the row to `indexed` or `failed`. The crawler also writes one `ingest_runs` row per source per run. See [`agent-plans/plan/crawler-ingest-db.md`](../../agent-plans/plan/crawler-ingest-db.md).

```text
Internet → crawler (1:00 AM) → knowledge base (S3 / dir) → ingest (3:00 AM) → vectors DB
                    │                                               │
                    └──── executive_orders (pending) ───────────────┴──→ indexed / failed
```

## How it works

- Runs once per scheduled task: on AWS, EventBridge Scheduler starts it daily at 1:00 AM `America/New_York`, two hours ahead of ingest. The process exits when the crawl is done, non-zero if anything failed.
- `src/index.ts` runs every registered source in turn, under one shared hard timeout (`CRAWL_TIMEOUT_MINUTES`, default 30).
- Each source scrapes its index page, downloads each document, converts it to Markdown and writes it under `<jurisdiction>/<document-type>/` in the knowledge base.
- PDFs use their text layer when they have one and fall back to OCR (`pdftoppm` + `tesseract`) when they don't. Most Georgia executive orders are scans.
- Each source keeps a state file, `<source-name>.json` in the crawler state location, so repeat runs skip unchanged documents (a conditional GET that gets a `304`, or a matching content hash).
- All reads and writes go through the storage helper in `packages/shared`, so ingest never reads a half-written document: locally a file is written to a `.tmp` sibling and renamed into place, and an S3 object only appears once its upload completes.
- Documents are never deleted when they disappear from a website. They are only flagged `currentlyListed: false` in state, and in the row's `raw_metadata`.
- Database writes are fail-soft. If `GOVBOT_DATABASE_URL` is unset, the database is skipped entirely. If it's set but the database is unreachable, or a single write fails, the crawler logs `[DB-FAIL]`, keeps writing Markdown, and exits 1. Every run re-asserts every listed order, so the next run repairs anything that was missed.

### Sources

| Name | Output | Notes |
| --- | --- | --- |
| `ga-executive-orders` | `georgia/executive-orders/<order>.md` | Governor's executive orders, one page per year |

### Running

```bash
# locally - needs poppler-utils and tesseract installed, and packages/shared built
# (npm install && npm run build at the repo root)
KNOWLEDGE_BASE_PATH=/tmp/kb CRAWLER_STATE_PATH=/tmp/crawler-state npm run dev

# backfill a past year (the scheduled run only crawls the current year)
npm run crawl -- --year 2025

# write every order already in crawler state to the metadata database, without crawling.
# The rows land as pending; the next ingest run reconciles them to indexed without re-embedding.
npm run crawl -- --backfill-db
```

On AWS, run the same flags as a one-off crawler task (`aws ecs run-task` with a command override).

The local defaults are `../ingest/knowledge-base` and `../ingest/crawler-state`. In this repo, `../ingest/knowledge-base` holds only sample docs for local development, and crawler output written there is gitignored. Override the paths when experimenting.

| Env var | Default | |
| --- | --- | --- |
| `KNOWLEDGE_BASE_PATH` | `../ingest/knowledge-base` | Where Markdown is written: a directory, or `s3://<bucket>/knowledge-base` |
| `CRAWLER_STATE_PATH` | `../ingest/crawler-state` | Per-source state files: a directory, or `s3://<bucket>/crawler-state` |
| `CRAWL_TIMEOUT_MINUTES` | `30` | Hard stop for the whole run, across all sources |
| `GOVBOT_DATABASE_URL` | unset (database disabled) | `govbot_ingest` connection string for the metadata database |

The environment is validated with zod at startup (`src/config.ts`). With an `s3://` location, region and credentials come from the usual AWS environment (the task role on Fargate, your profile locally).

## Adding a new source

A source is a module in `src/sources/` that exports a `Source` (`src/types.ts`):

```ts
export interface Source {
    name: string;
    crawl: (context: CrawlContext) => Promise<CrawlResult>;
    // optional: `--backfill-db` support, writing every order in state to the database
    backfill?: (context: CrawlContext & { db: CrawlerDb }) => Promise<number>;
}
```

`src/sources/ga-executive-orders.ts` is the reference implementation. Copying it is usually the fastest start.

### 1. Create the module

```ts
// src/sources/ga-rules.ts
import { Source, CrawlContext, CrawlResult } from "../types.js";

const NAME = "ga-rules";                          // also the state file name
const OUTPUT_DIR = "georgia/rules";               // knowledge base key prefix, always '/'-separated

const crawl = async ({ knowledgeBase, state, year, signal }: CrawlContext): Promise<CrawlResult> => {
    // discover → fetch → convert → write → record state
};

export const gaRules: Source = { name: NAME, crawl };
```

The context gives you:

- `knowledgeBase`: the knowledge base `Storage` (`packages/shared`). Write only keys beneath `` `${OUTPUT_DIR}/` ``.
- `state`: the crawler state `Storage`. Use the key `` `${NAME}.json` `` and nothing else.
- `year`: the year to crawl (`--year`, or the current year). Ignore it if the source isn't organised by year.
- `signal`: aborts when the run hits its hard timeout. Pass it to every request and to `extractPdfText`.
- `db`: the metadata database, or `undefined` when it's disabled or unreachable. Only sources that produce executive orders use it. Its methods never throw. They log `[DB-FAIL]` and count the failure themselves, so don't add the id to `result.failed`, which means "Markdown not written".

### 2. Register it

Add it to `SOURCES` in `src/index.ts`:

```ts
const SOURCES: Source[] = [gaExecutiveOrders, gaRules];
```

Sources run sequentially in that order and share one timeout. A slow source early in the list eats into the time left for the ones after it.

### 3. Discover documents

Fetch the index page with `fetchWithTimeout(url, signal)` from `src/http.ts`. It sets the crawler's User-Agent, applies a 60s per-request timeout, and throws on any non-2xx status except `304`. Parse the HTML with `cheerio`.

- Resolve relative links with `new URL(href, pageUrl)`.
- Validate what you scrape, such as an id regex. Skip rows that don't match instead of writing garbage.
- If discovery finds **zero** documents, throw. That almost always means the site's layout changed, and a loud failure beats a silent empty crawl.
- Check whether the listing is paginated. The executive orders page isn't, but many sites are.

### 4. Choose stable file names

Ingest keys each document on its knowledge base key (its path relative to the root), and uses the **parent folder name** as the document `type`. So:

- Name files after the document's official identifier (`09.24.26.03.md`), never after a title, date fetched, or position in a list. Renaming a file makes ingest delete its vectors and re-embed it as a new document.
- Only `.md` files are ingested. Anything else in the knowledge base is ignored.
- Keep ids filesystem-safe. Replace `/` and other path characters.

### 5. Write self-describing Markdown

Always write through `knowledgeBase.write(key, markdown)`, never `node:fs` directly, so the same code works against a directory and S3. Start every document with YAML frontmatter so it can be filtered on later. Follow the existing keys where they apply:

```markdown
---
jurisdiction: Georgia
branch: executive            # executive | legislative | judicial
document_type: executive_order
order_number: "09.24.26.03"  # the source's own identifier - quote it
source: Georgia Office of the Governor
source_url: https://...      # the index page it was found on
document_url: https://...    # the document itself
retrieved_at: 2026-09-27T05:00:10.000Z
text_extraction: ocr         # text_layer | ocr | none, for PDF-derived text
---

# <Human readable title>

## Description

<summary from the listing, if any>

## <Document body heading>

<document text>
```

Quote any value that YAML could misread, such as ids with dots, colons, or leading zeros.

**Keep the output deterministic.** Ingest re-embeds a document whenever its bytes change. Don't put anything volatile, like the current time or a "last checked" date, into the Markdown unless the document itself changed. `retrieved_at` is only set when the file is actually rewritten.

For PDFs, `extractPdfText(pdf, signal)` from `src/pdf.ts` returns `{ text, extraction }`. It tries the text layer first and falls back to OCR. Log a warning when `extraction` is `"none"`.

### 6. Track state and stay idempotent

Define the state shape with `zod` so a corrupt or outdated file fails loudly on load. At minimum, store per document:

- a `contentHash` of the raw download (`createContentHash` in `src/files.ts`)
- `lastModified` / `ETag` if the server sends them, to replay as `If-Modified-Since` / `If-None-Match`
- anything scraped from the listing that ends up in the Markdown (description, URL). If it changes, the file must be rewritten even when the document body didn't.
- `lastSeenAt` and `currentlyListed`

For each discovered document:

```text
known, listing unchanged, file in the knowledge base?
  ├── yes → conditional GET → 304 → skip
  │                         → 200 → same hash → skip
  └── otherwise → download → extract → write Markdown → save state
```

Save state after **every** written document, not just at the end, so a timeout or crash doesn't redo finished work. Also check that the Markdown file still exists (`knowledgeBase.exists`) before skipping, so a deleted file gets regenerated.

### 7. Never delete, only flag

When a document disappears from the website, set `currentlyListed: false` in state and leave its Markdown file alone. Historical government material stays in the corpus unless someone deliberately purges it. If the source is crawled per year, only flag entries belonging to the year being crawled.

### 8. Handle failures per document

- Wrap each document in `try/catch`. On failure, log `[FAIL] <id> - <error>`, push the id to `result.failed`, and **restore the previous state entry** so it's retried next run.
- Throw from `crawl()` only for failures that affect the whole source (index page unreachable, zero listings). `index.ts` catches it, logs it, and moves on to the next source.
- Check `signal.aborted` at the top of the loop. After the loop, count any unreached documents as failed, so the run exits non-zero and the summary reflects it.
- Fetch one document at a time. These are small government servers, and the nightly window is hours long.

Log with the same tags as the existing source (`[NEW]`, `[UPDATE]`, `[SKIP]`, `[WARN]`, `[FAIL]`) so the logs read consistently.

### 9. Dependencies

- npm packages go in `services/crawler/package.json` (`npm install <pkg> -w services/crawler` from the repo root). The crawler is its own workspace, separate from the ingest service.
- System binaries go in the runtime stage's `apk add` line in `Dockerfile`. If the source can't work without a binary, check for it in `healthCheck()` in `src/index.ts`, as `checkOcrTools` does.

### 10. Test it

```bash
npm run build   # at the repo root, so packages/shared is built too
KNOWLEDGE_BASE_PATH=/tmp/kb CRAWLER_STATE_PATH=/tmp/crawler-state npm run dev
```

Then:

1. Open a few generated `.md` files and check the frontmatter and text quality, especially OCR output.
2. Run it a second time. Everything should report as unchanged, with no files rewritten.
3. Delete one generated `.md` and run again. Only that document should be regenerated.
4. Add a row to the table in [Sources](#sources) above.

### Checklist

- [ ] `src/sources/<name>.ts` exports a `Source`, registered in `SOURCES`
- [ ] Throws when discovery finds nothing
- [ ] File names come from stable official identifiers
- [ ] Writes via `knowledgeBase.write`, with frontmatter
- [ ] Markdown is deterministic: identical input gives identical bytes
- [ ] zod-validated state in `<name>.json` in `state`, saved after each document
- [ ] Unchanged documents are skipped, and missing files are regenerated
- [ ] Never deletes, only sets `currentlyListed: false`
- [ ] Per-document failures keep the previous state, and `signal` is respected
- [ ] New system dependencies are in the `Dockerfile` and checked in `healthCheck()`
- [ ] If the source produces executive orders, it UPSERTs them via `context.db` in every branch (new, changed, unchanged, failed) and implements `backfill`
- [ ] Second run reports everything unchanged
