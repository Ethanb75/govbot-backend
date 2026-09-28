I’d start with the **Governor’s 2026 Executive Orders feed**, not bills.

It’s probably the cleanest end-to-end test for the system you’re building because the page is simple, changes regularly even outside the legislative session, and every new item has an obvious identifier, date, description, and linked PDF. The current 2026 page, for example, lists recent orders like `09.17.26.01`, `09.16.26.01`, etc. ([Office of the Governor][1])

Your first crawler can be extremely small:

```text
GET executive-orders/2026
        ↓
extract rows
        ↓
{
  id: "09.17.26.01",
  date: "2026-09-17",
  title: "...",
  pdfUrl: "..."
}
        ↓
compare against database
        ↓
new ID?
   yes → download PDF
         hash PDF
         extract text
         store document
         create event
   no  → ignore
```

I'd poll it perhaps every **1–3 hours** while developing. There's no need for that frequency operationally, but it makes testing your scheduler, idempotency, error handling, hashes, and change detection easier.

A minimal schema could be:

```ts
interface SourceDocument {
  id: string;               // 09.17.26.01
  source: "ga_governor_executive_orders";

  title: string;
  publishedAt: Date;

  pageUrl: string;
  documentUrl: string;

  contentHash: string;
  text: string;

  firstSeenAt: Date;
  lastSeenAt: Date;
}
```

And your ingestion loop:

```ts
for (const order of scrapedOrders) {
  const existing = await db.document.findUnique({
    where: {
      source_id: {
        source: "ga_governor_executive_orders",
        id: order.id
      }
    }
  });

  if (!existing) {
    const pdf = await download(order.pdfUrl);
    const hash = sha256(pdf);

    const text = await extractPdfText(pdf);

    await save({
      ...order,
      contentHash: hash,
      text,
      firstSeenAt: new Date(),
      lastSeenAt: new Date()
    });
  }
}
```

There are three reasons I'd choose this **over signed legislation as your first test**.

First, signed legislation is easy to scrape—the governor publishes a simple yearly list of signed bills and PDFs ([Office of the Governor][2])—but Georgia's 2026 legislative session is already over. The General Assembly's final summary shows 357 bills went to the governor and 345 were signed, so that data stream is now relatively quiet. ([Georgia General Assembly][3])

Executive orders, by contrast, are still appearing in September. ([Office of the Governor][1]) That gives you a live source against which to test.

Second, executive orders have a very convenient natural primary key:

```text
09.17.26.01
09.16.26.01
09.16.26.02
09.16.26.03
```

That makes deduplication almost trivial.

Third, you still exercise almost your entire eventual architecture:

```text
             Georgia.gov
                 │
                 ▼
            Source crawler
                 │
           normalize metadata
                 │
          ┌──────┴───────┐
          ▼              ▼
     PostgreSQL       PDF storage
                           │
                           ▼
                      extract text
                           │
                           ▼
                        chunk
                           │
                           ▼
                       embeddings
                           │
                           ▼
                       vector DB
                           │
                           ▼
                     RAG assistant
```

You could then ask your prototype:

> What executive orders has Georgia issued recently?

or:

> Have there been any Georgia executive orders concerning transportation in the past month?

or:

> Summarize executive orders added in the last seven days.

Once that entire pipeline works, **my second source would be Georgia General Assembly legislation**. That's where the project gets substantially more interesting, because instead of detecting only new documents, you'll detect **state transitions**:

```text
HB 123
│
├─ introduced
├─ assigned to committee
├─ committee substitute published
├─ passed House
├─ sent to Senate
├─ Senate amendment
├─ passed Senate
├─ House agreed
├─ sent to governor
├─ signed
└─ effective
```

At that point you're no longer building a scraper; you're building a **temporal state model of Georgia law**.

So I'd sequence the project:

1. **Governor executive orders** → prove crawling, PDF ingestion, hashing, RAG and change detection.
2. **General Assembly bills** → prove lifecycle/event tracking.
3. **Governor signed/vetoed legislation** → cross-check final bill disposition. The governor provides separate signed/vetoed collections. ([Office of the Governor][2])
4. **Secretary of State administrative rules** → add regulatory changes.
5. **Individual agency proposed rules** → detect regulations before adoption.
6. **Georgia appellate courts** → add changes in legal interpretation.

If your eventual goal is **"tell me what changed since yesterday and whether it affects me,"** that progression lets you validate one architectural capability at a time instead of immediately wrestling with Georgia's entire legislative ecosystem.

[1]: https://gov.georgia.gov/executive-action/executive-orders/2026?utm_source=chatgpt.com "2026 | Governor Brian P. Kemp Office of the Governor"
[2]: https://gov.georgia.gov/executive-action/legislation/signed-legislation/2026?utm_source=chatgpt.com "2026 | Governor Brian P. Kemp Office of the Governor"
[3]: https://www.legis.ga.gov/api/document/docs/default-source/general-statutes/sumdoc2026_finalb6de4f3e-b2e8-49d5-bc38-34c4f39c2207.pdf?utm_source=chatgpt.com "GENERAL ASSEMBLY 2026 SESSION SUMMARY"
