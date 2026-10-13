import { tool } from "ai";
import { z } from "zod";
import { getPool } from "../../../db.js";

// One fixed, parameterized statement - the model only fills in values, never SQL.
// COUNT(*) OVER () gives the full match count even when LIMIT cuts the rows, so "how many" questions work too.
// Only indexed orders are returned, so GovBot never claims an order it can't search.
// Dates are cast to text so they come back as YYYY-MM-DD instead of local-time Date objects.
const SEARCH_SQL = `
    SELECT eo_number, title, issued_by, signing_date::text AS signing_date, document_url,
           (COUNT(*) OVER ())::int AS total
    FROM executive_orders
    WHERE qdrant_status = 'indexed'
      AND ($1::text IS NULL OR eo_number = $1)
      AND ($2::text IS NULL OR title ILIKE '%' || $2 || '%')
      AND ($3::date IS NULL OR signing_date >= $3)
      AND ($4::date IS NULL OR signing_date <= $4)
    ORDER BY signing_date DESC NULLS LAST
    LIMIT $5
`;

type OrderRow = {
    eo_number: string;
    title: string | null;
    issued_by: string | null;
    signing_date: string | null;
    document_url: string | null;
    total: number;
};

// so a title search for "50%" or "covid_19" matches those characters literally
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, char => `\\${char}`);

export const searchExecutiveOrders = tool({
    description:
        "Search the database of Georgia Governor's executive orders by order number, title text, or signing date range. " +
        "Use it to list orders, count orders (the result's total is the full match count), find orders signed in a date range, " +
        "or look up an exact order number. Results are newest first.",
    inputSchema: z.object({
        eoNumber: z.string().optional().describe("Exact executive order number, e.g. 01.05.24.01"),
        titleContains: z.string().optional().describe("Case-insensitive text the order's title must contain"),
        signedAfter: z.iso.date().optional().describe("Earliest signing date, inclusive, YYYY-MM-DD"),
        signedBefore: z.iso.date().optional().describe("Latest signing date, inclusive, YYYY-MM-DD"),
        limit: z.number().int().min(1).max(25).default(10).describe("Maximum number of orders to return"),
    }),
    execute: async ({ eoNumber, titleContains, signedAfter, signedBefore, limit }) => {
        try {
            const { rows } = await getPool().query<OrderRow>(SEARCH_SQL, [
                eoNumber ?? null,
                titleContains ? escapeLike(titleContains) : null,
                signedAfter ?? null,
                signedBefore ?? null,
                limit,
            ]);

            return {
                total: rows[0]?.total ?? 0,
                orders: rows.map(({ total, ...order }) => order),
            };
        } catch (err) {
            // fail soft: the model says the lookup failed instead of the whole chat erroring
            console.error("searchExecutiveOrders failed: ", err);
            return { error: "executive order database unavailable" };
        }
    },
});
