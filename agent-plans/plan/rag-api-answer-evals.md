# Plan: answer quality evals for rag-api (`__tests__/answers/quality.test.ts`)

## Context
The rag-api test suite was split into `__tests__/retrieval/` (chunk retrieval metrics: MRR, nDCG, recall@k, precision@k) and a new `__tests__/answers/` folder. Retrieval evals only tell us whether the right chunks came back. They don't tell us whether the model used those chunks well. `answers/tests.json` defines 4 cases with optional expectations (`expected_answer`, `expected_facts`, `expected_documents`, `expected_citations`). `quality.test.ts` holds only the goals as comments: correctness, relevance and citation accuracy. The goal is a runner in the same style as `retrieval/retrieval.test.ts` that generates real answers through the production pipeline and scores them.

## Approach

### 1. Runner: `rag-api/__tests__/answers/quality.test.ts`
Keep the existing goal comments at the top. Follow the same structure as `retrieval/retrieval.test.ts`: a typed test, metric helpers, `evaluateAnswer(test)`, then `evaluate()` with a `--save` flag.

- **Test type + validation.** Use a zod schema for the `tests.json` entries: `id`, `question`, `category`, `importance`, `difficulty`, and optional `expected_answer`, `expected_facts[]`, `expected_documents[]`, `expected_citations[]`. Invalid entries print a warning and are skipped (this covers the retrieval runner's "check test format with zod" TODO). `tests.json` is a bare array, so import it as `import testsJSON from "./tests.json"`.
- **Generate the answer.** Call `streamAnswer(question, [])` from `src/rag/answer.ts`, drain `textStream` into a string, then read `chunks` and `toolChunks`. This is the same pattern as the non-stream branch in `src/routes/rag-chat.ts`, so the evals cover the real path: rewrite, retrieve, rerank, tools and the answer model. Sources = `[...chunks, ...toolChunks]`.
- **EO number helpers.**
  - `citedOrders(answer)`: regex `/\b\d{2}\.\d{2}\.\d{2}\.\d{2}\b/g`, deduplicated.
  - `sourceOrders(sources)`: the basename of `chunk.metadata.source` without `.md`. The crawler writes `georgia/executive-orders/<eo_number>.md` (see `knowledge-ingest/crawler/src/sources/ga-executive-orders.ts:215`).

### 2. Metrics (each one is computed only when its expectation field exists)
| Metric | Source field | How |
|---|---|---|
| `documentRecall` | `expected_documents` | expected EO numbers found in `sourceOrders` ÷ expected. Did the answer step actually *have* the doc, including tool lookups? |
| `citationRecall` | `expected_citations` | expected ∩ cited ÷ expected |
| `citationPrecision` | `expected_citations` | cited ∩ expected ÷ cited (0 cited → 0) |
| `citationGrounding` | all tests | cited orders that appear in `sourceOrders` ÷ cited. Approximates "supported cited claims ÷ all cited claims" and catches orders the model made up |
| `factCoverage` | `expected_facts` | a fact counts as covered if it appears literally (case-insensitive) in the answer **or** the judge marks it present. Short facts like `"25"` get help from the judge |
| `correctness` (1–5) | `expected_answer` | LLM judge compares the answer to the reference |
| `relevance` (1–5) | all tests | LLM judge: does the answer address the question, and does it stay on it? |

### 3. LLM judge
- `judgeAnswer(test, answer)` makes one `generateText` call with `Output.object({ schema })`, the same pattern as `src/rag/rerank.ts`.
  - Schema: `{ relevance: 1-5, correctness: 1-5 | null, factsPresent: boolean[], reasoning: string }`.
  - The prompt includes the question, the answer, and the reference answer and expected facts when they exist.
- Judge prompt text goes in the test file as a `buildJudgePrompt` const. It stays out of `src/rag/prompts.ts` because it isn't runtime code.
- Add `JUDGE_MODEL: z.string().default("gpt-5.4-mini")` to `src/config.ts`, with a comment that only the answer evals use it. The judge should be stronger than the `gpt-4.1-nano` answer model.

### 4. Output
- Per test, log the id, question, answer (truncated), every metric that applies and the judge's reasoning.
- At the end, print averages for each metric, overall and grouped by `category`.
- With `--save`, write `results` to `__tests__/answers/current-results.json`, the same as the retrieval runner. The diff-vs-previous TODO stays a TODO.
- This is report-only, with no exit-code failure, which matches the retrieval runner.

### 5. `rag-api/package.json` scripts
`"test"` still points at the deleted `__tests__/eval.test.ts`. Replace it with:
- `"test:retrieval": "tsx __tests__/retrieval/retrieval.test.ts"`
- `"test:answers": "tsx __tests__/answers/quality.test.ts"`

## Test data notes (flag to user, don't edit without asking)
- `eval-001`: expected answer is "January 23, 2025", but EO numbers are `MM.DD.YY.NN`, so `07.14.26.02` implies July 14, 2026. The reference is probably wrong.
- `eval-003` asks "how many". It could add `"expected_answer": "4"` so correctness is scored too, not just citations.
- Count questions (eval-003) rely on `searchExecutiveOrders`, which is only enabled when `GOVBOT_DATABASE_URL` is set (`dbEnabled()`). Without it, scores for those questions reflect the KB-only path.

## Out of scope / follow-ups
- Claim-by-claim verification against source text for `importance: "critical"` tests: a judge pass over the cited chunk text that fails if any claim is unsupported. No critical tests exist yet.
- Diffing against previous results, the FE results page, and husky hooks (existing TODOs).

## Critical files
- `rag-api/__tests__/answers/quality.test.ts` (new runner)
- `rag-api/src/config.ts` (`JUDGE_MODEL`)
- `rag-api/package.json` (scripts)
- Reused: `streamAnswer` (`src/rag/answer.ts`), `RetrievedChunk` (`src/rag/types.ts`), the `generateText` + `Output.object` pattern (`src/rag/rerank.ts`)

## Verification
1. `cd rag-api && npx tsc --noEmit -p .`. Note that tsconfig only includes `src/`, so also type-check the test with `npx tsc --noEmit --module nodenext --moduleResolution nodenext --strict --skipLibCheck --resolveJsonModule __tests__/answers/quality.test.ts`.
2. `npm run test:answers`. This needs `.env` with the OpenAI key and Qdrant URL, the same as the retrieval evals. Check that each of the 4 tests prints only the metrics that apply to it, and that eval-003/004 show citation recall and precision.
3. `npm run test:answers -- --save` and confirm `current-results.json` is populated.
4. `npm run test:retrieval` still runs.
