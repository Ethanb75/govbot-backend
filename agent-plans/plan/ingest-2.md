Your current setup fits this nicely. The existing `knowledge-ingest` service runs **daily at 3:00 AM ET** via Supercronic, reads `./knowledge-base` as read-only, and currently ingests only `.md` documents. :chatgpt-content-reference{index="1"}

For the first version, I’d make the pipeline:

```text
1:00 AM
Georgia Executive Order crawler
        │
        ▼
Governor's 2026 Executive Orders page
        │
        ├── discover orders
        ├── download linked PDFs
        ├── extract PDF text
        ├── normalize to Markdown
        └── write knowledge-base/georgia/executive-orders/*.md
                              │
                              ▼
                         3:00 AM
                     knowledge-ingest
                              │
                              ├── chunk
                              ├── embed
                              └── Qdrant
```

The official Governor's page is a particularly good first target because it's essentially a table of order IDs, descriptions, and PDF links. Right now, for example, it exposes `09.24.26.01`, `09.24.26.02`, `09.24.26.03`, etc., each pointing to the underlying PDF. :chatgpt-content-reference{index="2"}

### Implementation plan

1. **Add a sibling crawler service to the existing Compose stack.** I would call it `knowledge-crawler` rather than `georgia-crawler`, because eventually you'll add multiple sources to it.

   ```yaml
   services:
     knowledge-ingest:
       # existing config...

     knowledge-crawler:
       build:
         context: ./crawler
       restart: unless-stopped

       environment:
         - TZ=America/New_York
         - KNOWLEDGE_BASE_PATH=/data/knowledge-base
         - CRAWLER_STATE_PATH=/data/state
         - DOTENV_CONFIG_QUIET=true

       volumes:
         - ./knowledge-base:/data/knowledge-base
         - ./crawler-state:/data/state
   ```

   The important difference is permissions:

   ```text
   crawler
   knowledge-base → read/write

   ingest
   knowledge-base → read-only
   ```

2. **Give the crawler its own small TypeScript project.**

   I'd structure the repo roughly like:

   ```text
   knowledge-ingest/
   ├── compose.yml
   │
   ├── knowledge-base/
   │   └── georgia/
   │       └── executive-orders/
   │
   ├── app-state/
   │
   ├── crawler-state/
   │
   ├── crawler/
   │   ├── Dockerfile
   │   ├── crontab
   │   ├── package.json
   │   └── src/
   │       ├── index.ts
   │       ├── sources/
   │       │   └── ga-executive-orders.ts
   │       └── pdf.ts
   │
   └── src/
       └── ...existing ingest code
   ```

   I prefer putting the source implementation under:

   ```text
   sources/ga-executive-orders.ts
   ```

   instead of hardcoding it into `index.ts`. Later you can add:

   ```text
   sources/
   ├── ga-executive-orders.ts
   ├── ga-legislation.ts
   ├── ga-rules.ts
   └── ga-courts.ts
   ```

3. **Schedule the crawler for 1:00 AM.**

   Your crawler's Supercronic file can simply be:

   ```cron
   # Georgia government crawler
   0 1 * * * node /app/dist/index.js
   ```

   Existing ingestion remains:

   ```cron
   0 3 * * * node /app/dist/index.js
   ```

   That gives crawling a two-hour window before ingestion starts.

   I would also put a hard timeout around each crawl, perhaps 30 minutes. The jobs should normally take nowhere near that long, but a government site hanging indefinitely shouldn't cause the crawler to still be running at 3:00 AM.

4. **Have the first source scraper only understand the Governor's executive-order page.**

   Configuration:

   ```ts
   const SOURCE_URL =
     "https://gov.georgia.gov/executive-action/executive-orders/2026";
   ```

   The page currently exposes the executive-order identifier, description, file size, and PDF link. :chatgpt-content-reference{index="3"}

   Conceptually:

   ```ts
   interface ExecutiveOrderListing {
     id: string;
     description: string;
     pdfUrl: string;
   }
   ```

   For example:

   ```ts
   {
     id: "09.24.26.03",
     description:
       "Suspending Mr. Marcello Banes from office as Chairman of the Newton County Board of Commissioners",
     pdfUrl: "https://..."
   }
   ```

   That description is what the official page currently associates with that order. :chatgpt-content-reference{index="4"}

5. **Download each PDF and turn it into Markdown.**

   Since your current ingestion service intentionally discovers only `.md` files, I wouldn't modify that part yet. :chatgpt-content-reference{index="5"}

   Instead:

   ```text
   executive-order PDF
          │
          ▼
      PDF → text
          │
          ▼
      Markdown file
   ```

   Produce:

   ```text
   knowledge-base/
   └── georgia/
       └── executive-orders/
           ├── 09.24.26.01.md
           ├── 09.24.26.02.md
           └── 09.24.26.03.md
   ```

   I'd make each document self-describing:

   ```markdown
   ---
   jurisdiction: Georgia
   branch: executive
   document_type: executive_order
   order_number: 09.24.26.03
   source: Georgia Office of the Governor
   source_url: https://gov.georgia.gov/...
   document_url: https://gov.georgia.gov/...
   retrieved_at: 2026-09-27T01:00:10-04:00
   ---

   # Executive Order 09.24.26.03

   ## Description

   Suspending Mr. Marcello Banes from office as Chairman of the
   Newton County Board of Commissioners

   ## Executive Order

   <text extracted from PDF>
   ```

   That metadata will become extremely useful for filtering Qdrant later.

6. **Make the crawler idempotent from day one.**

   Don't blindly download and rewrite every PDF on every crawl.

   Give it state similar to your ingestion service:

   ```json
   {
     "documents": {
       "09.24.26.03": {
         "pdfUrl": "https://...",
         "contentHash": "a413c...",
         "lastSeenAt": "2026-09-27T05:00:03.000Z"
       }
     }
   }
   ```

   On every run:

   ```text
   scrape index page

   for each order
       ↓
   known order?
       │
       ├── no  → download → hash → extract → write Markdown
       │
       └── yes → optionally HEAD/download → compare hash
                                      │
                                      ├── same → skip
                                      └── changed → replace Markdown
   ```

   This mirrors a pattern you already use successfully in ingestion: your current ingester SHA-256 hashes document contents and skips documents whose hash hasn't changed. :chatgpt-content-reference{index="6"}

7. **Write Markdown atomically.**

   This is worth doing even with the two-hour scheduling gap.

   Don't do:

   ```ts
   writeFileSync("09.24.26.03.md", content);
   ```

   Do approximately:

   ```ts
   writeFileSync("09.24.26.03.md.tmp", content);
   renameSync(
     "09.24.26.03.md.tmp",
     "09.24.26.03.md"
   );
   ```

   Your ingest process recursively discovers `.md` files. :chatgpt-content-reference{index="7"} So while the crawler is writing:

   ```text
   09.24.26.03.md.tmp
   ```

   ingestion won't consider it a document.

   Only a completely written file becomes:

   ```text
   09.24.26.03.md
   ```

   That removes most of the risk even if the jobs eventually overlap.

8. **Don't delete orders just because they disappear from the website.**

   This differs from your knowledge-ingest behavior.

   Your current ingester treats a missing local Markdown document as an orphan and removes its Qdrant chunks. :chatgpt-content-reference{index="8"} That's appropriate for your local knowledge base.

   The crawler should **not** interpret:

   ```text
   was on government website yesterday
   not on government website today
   ```

   as:

   ```text
   DELETE historical executive order
   ```

   For government data I'd make acquisition append-oriented.

   Instead record:

   ```ts
   {
     lastSeenAt,
     currentlyListed
   }
   ```

   Historical legal material should generally remain in your corpus unless you deliberately purge it.

### One design change I'd make now

I wouldn't make the year literal in the crawler:

```ts
const url = ".../executive-orders/2026";
```

Instead:

```ts
const year = new Date().getFullYear();

const url =
  `https://gov.georgia.gov/executive-action/executive-orders/${year}`;
```

The governor's Executive Orders section is organized into year-specific collections, including 2026, 2025, 2024, etc. :chatgpt-content-reference{index="9"}

Eventually you'll probably want a bootstrap mode:

```bash
npm run crawl -- --year 2026
npm run crawl -- --year 2025
npm run crawl -- --year 2024
```

while the cron job only crawls the current year.

### First-version success criteria

I would deliberately keep V1 this small:

```text
docker compose up -d
        │
        ├── crawler wakes at 1 AM
        │
        ├── downloads executive orders
        │
        ├── creates *.md
        │
        ├── exits back to scheduler
        │
        ├── ingest wakes at 3 AM
        │
        ├── discovers new *.md
        │
        └── indexes them into Qdrant
```

Then verify with:

```bash
docker compose logs knowledge-crawler
```

and:

```bash
docker compose logs knowledge-ingest
```

You should see something like:

```text
[crawler]
Orders discovered: 150
New:               150
Changed:              0
Unchanged:            0
Failed:               0
```

Then on the next crawl:

```text
Orders discovered: 150
New:                   0
Changed:               0
Unchanged:           150
Failed:                0
```

And the following ingest run should mostly report `[SKIP]` for already-indexed documents because your existing content-hash logic handles unchanged Markdown already. :chatgpt-content-reference{index="10"}

**So I would leave `knowledge-ingest` essentially untouched.** Add a producer in front of it:

```text
Internet
   ↓
knowledge-crawler       ← NEW
   ↓
./knowledge-base
   ↓
knowledge-ingest        ← EXISTING
   ↓
Qdrant
```

That separation is nice because **the crawler's only contract with the ingestion system is "produce good Markdown files."** When we add bills, regulations, courts, etc., none of those scrapers need to know anything about embeddings or Qdrant.