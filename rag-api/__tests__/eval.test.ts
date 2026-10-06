// import tests
import { writeFileSync } from "node:fs";
import path from "node:path";
import testsJSON from "./tests.json";
import { fetchContext } from "../src/rag/answer";
import { RetrievedChunk } from "../src/rag/types.js";
// when does eval run?? maybe use husky to run evals before commit?
// maybe use gh hook to run on every pr

/*
TODO:
- setup retrieval and answer evals
- manual for now, have it write a dated file with results
- setup a file for FE. let's display the most recent results. FE will look for this markdown file and render it
- setup pre-hook commit (husky maybe?) only runs tests when certain files are updated (no need to rerun on every commit)
*/

export type TestQuestion = {
  question: string,
  keywords: string[],
  referenceAnswer: string,
  // category: "direct_fact" | "spanning" | "temporal"
  category: string
}

// Calculate mean reciprocal rank for a single keyword (case-insensitive).
// MRR = average inverse rank of first hit; it would be 1 if the first chunk ALWAYS had the relevant context
const calculateMrr = (keyword: string, retrievedDocs: RetrievedChunk[]): number => {
  const keywordLower = keyword.toLowerCase();

  for (const [index, doc] of retrievedDocs.entries()) {
    if (doc.pageContent.toLowerCase().includes(keywordLower)) {
      return 1 / (index + 1);
    }
  }

  return 0;
}

// Calculate Discounted Cumulative Gain.
const calculateDcg = (relevances: number[], k: number): number => {
  let dcg = 0;

  for (let i = 0; i < Math.min(k, relevances.length); i++) {
    dcg += relevances[i] / Math.log2(i + 2); // i+2 because rank starts at 1
  }

  return dcg;
}

// Calculate nDCG for a single keyword (binary relevance, case-insensitive).
// nDCG = look at all the relevant chunks and measure if the relevant chunks get ranked higher
const calculateNDCG = (keyword: string, retrievedDocs: RetrievedChunk[], k: number = 10): number => {
  const keywordLower = keyword.toLowerCase();

  // Binary relevance: 1 if keyword found, 0 otherwise
  const relevances = retrievedDocs
    .slice(0, k)
    .map(doc => doc.pageContent.toLowerCase().includes(keywordLower) ? 1 : 0);

  const dcg = calculateDcg(relevances, k);

  // Ideal DCG (best case: keyword in first position)
  const idealRelevances = [...relevances].sort((a, b) => b - a);
  const idcg = calculateDcg(idealRelevances, k);

  return idcg > 0 ? dcg / idcg : 0;
}

const evaluateChunkRetrieval = async (test: TestQuestion) => {
  const { chunks } = await fetchContext(test.question, []);
  const mrrScores = test.keywords.map(keyword => calculateMrr(keyword, chunks));

  const avgMrr = mrrScores.length > 0 ? mrrScores.reduce((a, b) => a + b, 0) / mrrScores.length : 0;
  
  // # Calculate nDCG (average across all keywords)
  const ndcgScores = test.keywords.map(keyword => calculateNDCG(keyword, chunks))
  const avgNDCG = ndcgScores.length > 0 ? ndcgScores.reduce((a, b) => a + b, 0) / ndcgScores.length : 0;

  // # Calculate keyword coverage
  const keywordsFound = mrrScores.reduce((a, b) => {
    if(b > 0) return a + 1;

    return a + 0;
  }, 0)
  
  const totalKeywords = test.keywords.length;
  const keywordCoverage = totalKeywords ? (keywordsFound / totalKeywords * 100) : 0

  return {
    mrr: avgMrr,
    ncdg: avgNDCG,
    totalKeywords,
    keywordsFound,
    keywordCoverage
  }
}

const evaluate = async () => {
  // load all tests
  const tests: TestQuestion[] = testsJSON?.tests || [];
  // check test format with zod. report if schema is messed up (maybe warn and continue)
  const shouldSave = process.argv.includes('--save');
  const results = [];

  for (const test of tests || []) {
    const {mrr, ncdg, totalKeywords, keywordCoverage} = await evaluateChunkRetrieval(test);
    console.log('MRR', mrr);
    console.log('NCDG', ncdg);
    console.log('totalKeywords', totalKeywords);
    console.log('keywordCoverage', keywordCoverage);

    results.push({ question: test.question, mrr, ncdg, totalKeywords, keywordCoverage });
  }

  if (shouldSave) {
    // TODO - compare and report diffs
    writeFileSync(path.join(import.meta.dirname, 'current-results.json'), JSON.stringify(results, null, 2));
  }
}

await evaluate();