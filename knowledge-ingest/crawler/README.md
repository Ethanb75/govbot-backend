# knowledge-crawler

Fetches public documents from government websites and writes them as Markdown into `knowledge-base/`, where the `knowledge-ingest` service picks them up and indexes them into Qdrant. The crawler's only contract with ingest is "produce good `.md` files" - it knows nothing about chunking, embeddings or Qdrant.

```text
Internet → knowledge-crawler (1:00 AM) → ./knowledge-base → knowledge-ingest (3:00 AM) → Qdrant
```

## How it works

- Runs daily at 1:00 AM `America/New_York` under Supercronic (see `crontab`), two hours ahead of ingest.
- `src/index.ts` runs every registered source in turn, under one shared hard timeout (`CRAWL_TIMEOUT_MINUTES`, default 30).
- Each source scrapes its index page, downloads each document, converts it to Markdown and writes it under `knowledge-base/<jurisdiction>/<document-type>/`.
- PDFs use their text layer when they have one and fall back to OCR (`pdftoppm` + `tesseract`) when they don't. Most Georgia executive orders are scans.
- Each source keeps a state file at `crawler-state/<source-name>.json` so repeat runs skip unchanged documents (a conditional GET that gets a `304`, or a matching content hash).
- Files are written to a `.tmp` sibling and renamed into place, so ingest never reads a half-written document.
- Documents are never deleted when they disappear from a website. They are only flagged `currentlyListed: false` in state.

### Sources

| Name | Output | Notes |
| --- | --- | --- |
| `ga-executive-orders` | `georgia/executive-orders/<order>.md` | Governor's executive orders, one page per year |

### Running

```bash
# in docker (normal operation) - see ../compose.yml
docker compose up -d knowledge-crawler
docker compose logs knowledge-crawler

# locally - needs poppler-utils and tesseract installed
npm install
KNOWLEDGE_BASE_PATH=/tmp/kb CRAWLER_STATE_PATH=/tmp/crawler-state npm run dev

# backfill a past year (the cron job only crawls the current year)
npm run crawl -- --year 2025
```

The local defaults are `../knowledge-base` and `../crawler-state`, which are the real directories. Override them when experimenting.

| Env var | Default | |
| --- | --- | --- |
| `KNOWLEDGE_BASE_PATH` | `../knowledge-base` | Where Markdown is written (must be writable) |
| `CRAWLER_STATE_PATH` | `../crawler-state` | Per-source state files |
| `CRAWL_TIMEOUT_MINUTES` | `30` | Hard stop for the whole run, across all sources |

## Adding a new source

A source is a module in `src/sources/` that exports a `Source` (`src/types.ts`):

```ts
export interface Source {
    name: string;
    crawl: (context: CrawlContext) => Promise<CrawlResult>;
}
```

`src/sources/ga-executive-orders.ts` is the reference implementation. Copying it is usually the fastest start.

### 1. Create the module

```ts
// src/sources/ga-rules.ts
import { Source, CrawlContext, CrawlResult } from "../types.js";

const NAME = "ga-rules";                          // also the state file name
const OUTPUT_DIR = join("georgia", "rules");      // relative to the knowledge base

const crawl = async ({ knowledgeBasePath, statePath, year, signal }: CrawlContext): Promise<CrawlResult> => {
    // discover → fetch → convert → write → record state
};

export const gaRules: Source = { name: NAME, crawl };
```

The context gives you:

- `knowledgeBasePath`: root of the knowledge base. Write only beneath `join(knowledgeBasePath, OUTPUT_DIR)`.
- `statePath`: directory for your state file. Use ``join(statePath, `${NAME}.json`)`` and nothing else.
- `year`: the year to crawl (`--year`, or the current year). Ignore it if the source isn't organised by year.
- `signal`: aborts when the run hits its hard timeout. Pass it to every request and to `extractPdfText`.

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

Ingest keys its state on each file's path relative to the knowledge base, and uses the **parent directory name** as the document `type`. So:

- Name files after the document's official identifier (`09.24.26.03.md`), never after a title, date fetched, or position in a list. Renaming a file makes ingest delete its vectors and re-embed it as a new document.
- Only `.md` files are ingested. Anything else in the knowledge base is ignored.
- Keep ids filesystem-safe. Replace `/` and other path characters.

### 5. Write self-describing Markdown

Always use `writeFileAtomic` from `src/files.ts`, never `writeFileSync` directly. Start every document with YAML frontmatter so it can be filtered in Qdrant later. Follow the existing keys where they apply:

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
known, listing unchanged, file on disk?
  ├── yes → conditional GET → 304 → skip
  │                         → 200 → same hash → skip
  └── otherwise → download → extract → write Markdown → save state
```

Save state after **every** written document, not just at the end, so a timeout or crash doesn't redo finished work. Also check that the Markdown file still exists before skipping, so a deleted file gets regenerated.

### 7. Never delete, only flag

When a document disappears from the website, set `currentlyListed: false` in state and leave its Markdown file alone. Historical government material stays in the corpus unless someone deliberately purges it. If the source is crawled per year, only flag entries belonging to the year being crawled.

### 8. Handle failures per document

- Wrap each document in `try/catch`. On failure, log `[FAIL] <id> - <error>`, push the id to `result.failed`, and **restore the previous state entry** so it's retried next run.
- Throw from `crawl()` only for failures that affect the whole source (index page unreachable, zero listings). `index.ts` catches it, logs it, and moves on to the next source.
- Check `signal.aborted` at the top of the loop. After the loop, count any unreached documents as failed, so the run exits non-zero and the summary reflects it.
- Fetch one document at a time. These are small government servers, and the nightly window is hours long.

Log with the same tags as the existing source (`[NEW]`, `[UPDATE]`, `[SKIP]`, `[WARN]`, `[FAIL]`) so `docker compose logs` reads consistently.

### 9. Dependencies

- npm packages go in `crawler/package.json`. The crawler is a separate project from the ingest service.
- System binaries go in the runtime stage's `apk add` line in `Dockerfile`. If the source can't work without a binary, check for it in `healthCheck()` in `src/index.ts`, as `checkOcrTools` does.

### 10. Test it

```bash
npm run build
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
- [ ] Writes via `writeFileAtomic`, with frontmatter
- [ ] Markdown is deterministic: identical input gives identical bytes
- [ ] zod-validated state in `<statePath>/<name>.json`, saved after each document
- [ ] Unchanged documents are skipped, and missing files are regenerated
- [ ] Never deletes, only sets `currentlyListed: false`
- [ ] Per-document failures keep the previous state, and `signal` is respected
- [ ] New system dependencies are in the `Dockerfile` and checked in `healthCheck()`
- [ ] Second run reports everything unchanged
