import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as cheerio from "cheerio";
import { z } from "zod";

import { createContentHash, writeFileAtomic } from "../files.js";
import { fetchWithTimeout } from "../http.js";
import { extractPdfText, PdfText, TextExtraction } from "../pdf.js";
import { CrawlContext, CrawlResult, ExecutiveOrderRecord, Source } from "../types.js";

const NAME = "ga-executive-orders";
const JURISDICTION = "Georgia";
const OUTPUT_DIR = join("georgia", "executive-orders");

const sourceUrl = (year: number): string =>
    `https://gov.georgia.gov/executive-action/executive-orders/${year}`;

// Order ids are MM.DD.YY.NN, signed on MM/DD/20YY. null (with a warning) when that isn't a real
// date, so a strange id never blocks the row.
export const parseSigningDate = (id: string): string | null => {
    const [month, day, year] = id.split(".");
    const date = `20${year}-${month}-${day}`;

    const parsed = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
        console.warn(`[WARN] ${id} - no signing date in the order id`);
        return null;
    }
    return date;
};

// Inauguration dates; a governor holds office from `from` up to (not including) `to`, so orders
// signed on an inauguration day go to the incoming governor.
// TODO: Kemp's term ends January 2027 - give him a `to` and add his successor once the
// inauguration date is set.
const GOVERNORS: { name: string; from: string; to?: string }[] = [
    { name: "Sonny Perdue", from: "2003-01-13", to: "2011-01-10" },
    { name: "Nathan Deal", from: "2011-01-10", to: "2019-01-14" },
    { name: "Brian Kemp", from: "2019-01-14" },
];

// ISO dates compare correctly as strings.
export const governorOn = (date: string | null): string | null =>
    (date && GOVERNORS.find(({ from, to }) => date >= from && (!to || date < to))?.name) || null;

interface OrderMetadata {
    year: number;
    pdfUrl: string;
    description: string;
    lastModified?: string;
    currentlyListed: boolean;
}

const toRecord = (
    id: string,
    order: OrderMetadata,
    seenAt: string,
    { contentHash, textExtraction, markdownRewritten }: {
        contentHash: string | null;
        textExtraction?: TextExtraction;
        markdownRewritten: boolean;
    },
): ExecutiveOrderRecord => {
    const signingDate = parseSigningDate(id);

    return {
        source: NAME,
        sourceDocumentId: id,
        jurisdiction: JURISDICTION,
        eoNumber: id,
        title: order.description || null,
        issuedBy: governorOn(signingDate),
        signingDate,
        sourceUrl: sourceUrl(order.year),
        documentUrl: order.pdfUrl,
        contentHash,
        // undefined keys are dropped by JSON.stringify, so the stored value is kept
        rawMetadata: {
            currentlyListed: order.currentlyListed,
            lastModified: order.lastModified,
            textExtraction,
            year: order.year,
        },
        lastSeenAt: seenAt,
        markdownRewritten,
    };
};

interface ExecutiveOrderListing {
    id: string;
    description: string;
    pdfUrl: string;
}

const OrderState = z.object({
    year: z.number(),
    pdfUrl: z.string(),
    description: z.string(),
    contentHash: z.string(),
    // Last-Modified of the PDF, replayed as If-Modified-Since so unchanged orders cost a 304.
    lastModified: z.string().optional(),
    retrievedAt: z.string(),
    lastSeenAt: z.string(),
    currentlyListed: z.boolean(),
});
type OrderState = z.infer<typeof OrderState>;

const SourceState = z.object({
    documents: z.record(z.string(), OrderState).default({}),
});
type SourceState = z.infer<typeof SourceState>;

const stateFile = (statePath: string): string => join(statePath, `${NAME}.json`);

const loadState = (statePath: string): SourceState => {
    const file = stateFile(statePath);
    if (!existsSync(file)) return { documents: {} };

    return SourceState.parse(JSON.parse(readFileSync(file, "utf-8")));
};

const saveState = (statePath: string, state: SourceState): void => {
    mkdirSync(statePath, { recursive: true });
    writeFileAtomic(stateFile(statePath), `${JSON.stringify(state, null, 2)}\n`);
};

const collapseWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

// The index page is a single (unpaginated) table: an order id linking to its PDF, then a description.
const parseListings = (html: string, pageUrl: string): ExecutiveOrderListing[] => {
    const $ = cheerio.load(html);
    const listings: ExecutiveOrderListing[] = [];

    $("tbody tr").each((_, row) => {
        const link = $(row).find("a[href*='/download']").first();
        const href = link.attr("href");
        const id = collapseWhitespace(link.attr("data-text") ?? link.text());

        if (!href || !/^\d{2}\.\d{2}\.\d{2}\.\d{2,}$/.test(id)) return;

        listings.push({
            id,
            description: collapseWhitespace($(row).find("td.views-field-field-document-description").text()),
            pdfUrl: new URL(href, pageUrl).toString(),
        });
    });

    return listings;
};

const toMarkdown = (
    listing: ExecutiveOrderListing,
    pageUrl: string,
    retrievedAt: string,
    { text, extraction }: PdfText,
): string => `---
jurisdiction: ${JURISDICTION}
branch: executive
document_type: executive_order
order_number: "${listing.id}"
source: Georgia Office of the Governor
source_url: ${pageUrl}
document_url: ${listing.pdfUrl}
retrieved_at: ${retrievedAt}
text_extraction: ${extraction}
---

# Executive Order ${listing.id}

## Description

${listing.description || "_No description provided._"}

## Executive Order

${text || "_No text could be extracted from the PDF._"}
`;

const crawl = async ({ knowledgeBasePath, statePath, year, signal, db }: CrawlContext): Promise<CrawlResult> => {
    const pageUrl = sourceUrl(year);
    const outputDir = join(knowledgeBasePath, OUTPUT_DIR);

    console.log(`Source: ${pageUrl}`);

    const page = await fetchWithTimeout(pageUrl, signal);
    const listings = parseListings(await page.text(), pageUrl);

    if (listings.length === 0) {
        throw new Error(`no executive orders found on ${pageUrl} - has the page layout changed?`);
    }

    const state = loadState(statePath);
    const seenAt = new Date().toISOString();

    const result: CrawlResult = { discovered: listings.length, created: [], updated: [], unchanged: [], failed: [] };

    // Orders are never deleted when they drop off the site - historical orders stay in the
    // corpus. They are only flagged as no longer listed.
    const listedIds = new Set(listings.map(listing => listing.id));
    const unlistedIds: string[] = [];
    for (const [id, order] of Object.entries(state.documents)) {
        if (order.year === year && !listedIds.has(id)) {
            order.currentlyListed = false;
            unlistedIds.push(id);
        }
    }
    await db?.markUnlisted(NAME, unlistedIds);

    // One order at a time keeps us polite to the state's web server.
    for (const listing of listings) {
        if (signal.aborted) break;

        const { id } = listing;
        const previous: OrderState | undefined = state.documents[id];
        const markdownPath = join(outputDir, `${id}.md`);

        // Every listed order is re-asserted on every run, which keeps last_seen_at current and
        // repairs any write a previous run missed.
        const order = { year, pdfUrl: listing.pdfUrl, description: listing.description, currentlyListed: true };
        const upsert = async (
            lastModified: string | undefined,
            extras: Parameters<typeof toRecord>[3],
        ): Promise<void> => {
            await db?.upsertExecutiveOrder(toRecord(id, { ...order, lastModified }, seenAt, extras));
        };

        // Only a PDF change can be detected with a conditional GET; a new description or URL,
        // or a markdown file that went missing, all need the PDF text to rewrite the document.
        const onlyPdfCanChange =
            previous !== undefined &&
            previous.pdfUrl === listing.pdfUrl &&
            previous.description === listing.description &&
            existsSync(markdownPath);

        try {
            const headers: Record<string, string> =
                onlyPdfCanChange && previous.lastModified ? { "If-Modified-Since": previous.lastModified } : {};
            const response = await fetchWithTimeout(listing.pdfUrl, signal, headers);

            if (response.status === 304 && previous) {
                console.log(`[SKIP] ${id} - not modified`);
                state.documents[id] = { ...previous, lastSeenAt: seenAt, currentlyListed: true };
                result.unchanged.push(id);
                await upsert(previous.lastModified, { contentHash: previous.contentHash, markdownRewritten: false });
                continue;
            }

            const pdf = new Uint8Array(await response.arrayBuffer());
            const contentHash = createContentHash(pdf);
            const lastModified = response.headers.get("last-modified") ?? undefined;

            if (onlyPdfCanChange && previous.contentHash === contentHash) {
                console.log(`[SKIP] ${id} - unchanged`);
                state.documents[id] = { ...previous, lastModified, lastSeenAt: seenAt, currentlyListed: true };
                result.unchanged.push(id);
                await upsert(lastModified, { contentHash, markdownRewritten: false });
                continue;
            }

            const pdfText = await extractPdfText(pdf, signal);
            if (pdfText.extraction === "none") {
                console.warn(`[WARN] ${id} - no text layer and OCR found nothing, writing description only`);
            }

            const retrievedAt = new Date().toISOString();
            writeFileAtomic(markdownPath, toMarkdown(listing, pageUrl, retrievedAt, pdfText));

            state.documents[id] = {
                year,
                pdfUrl: listing.pdfUrl,
                description: listing.description,
                contentHash,
                lastModified,
                retrievedAt,
                lastSeenAt: seenAt,
                currentlyListed: true,
            };
            saveState(statePath, state);
            await upsert(lastModified, { contentHash, textExtraction: pdfText.extraction, markdownRewritten: true });

            if (previous) {
                console.log(`[UPDATE] ${id} (${pdfText.extraction})`);
                result.updated.push(id);
            } else {
                console.log(`[NEW] ${id} (${pdfText.extraction})`);
                result.created.push(id);
            }
        } catch (error) {
            // Keep the previous entry so the order is simply retried next run.
            console.error(`[FAIL] ${id} - ${error}`);
            if (previous) state.documents[id] = { ...previous, lastSeenAt: seenAt, currentlyListed: true };
            result.failed.push(id);
            // A new order still gets a pending row, recording that it was discovered. A null hash
            // keeps the stored one.
            await upsert(previous?.lastModified, { contentHash: null, markdownRewritten: false });
        }
    }

    saveState(statePath, state);

    if (signal.aborted) {
        const reached = new Set([...result.created, ...result.updated, ...result.unchanged, ...result.failed]);
        const skipped = listings.filter(listing => !reached.has(listing.id)).map(listing => listing.id);
        console.error(`[ABORT] crawl timed out with ${skipped.length} orders left unchecked`);
        result.failed.push(...skipped);
    }

    return result;
};

// text_extraction from a written order's frontmatter (see toMarkdown).
const readTextExtraction = (markdownPath: string): TextExtraction | undefined => {
    if (!existsSync(markdownPath)) return undefined;

    const value = /^text_extraction: (\S+)$/m.exec(readFileSync(markdownPath, "utf-8"))?.[1];
    return value === "text_layer" || value === "ocr" || value === "none" ? value : undefined;
};

// Rows land as 'pending' (or keep their status); the next ingest run finds each file unchanged
// and reconciles it to 'indexed' without re-embedding.
const backfill: NonNullable<Source["backfill"]> = async ({ knowledgeBasePath, statePath, db }) => {
    const state = loadState(statePath);
    const outputDir = join(knowledgeBasePath, OUTPUT_DIR);

    for (const [id, order] of Object.entries(state.documents)) {
        await db.upsertExecutiveOrder(
            toRecord(id, order, order.lastSeenAt, {
                contentHash: order.contentHash,
                textExtraction: readTextExtraction(join(outputDir, `${id}.md`)),
                markdownRewritten: false,
            }),
        );
    }

    return Object.keys(state.documents).length;
};

export const gaExecutiveOrders: Source = { name: NAME, crawl, backfill };
