// how well is the llm using the chunks?
// answer correctness - measure against a known verified answer
// answer relevency - does the model address my question? does fail to understand?
// citation accuracy - for specific questions, supported cited claims / all cited claims
// - For especially important claims, you might require every citation to be validated. (critical questions)
//

import { writeFileSync } from "node:fs";
import path from "node:path";
import { generateText, Output } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import testsJSON from "./tests.json" with { type: "json" };
import { config } from "../../src/config.js";
import { dbEnabled, getPool } from "../../src/db.js";
import { streamAnswer } from "../../src/rag/answer.js";
import { RetrievedChunk } from "../../src/rag/types.js";

const AnswerTest = z.object({
  id: z.string(),
  question: z.string().min(1),
  category: z.string(),
  importance: z.string(),
  difficulty: z.string(),
  expected_answer: z.string().optional(),
  expected_facts: z.array(z.string()).optional(),
  // EO numbers (MM.DD.YY.NN) the answer step should have had in its sources
  expected_documents: z.array(z.string()).optional(),
  // EO numbers the answer should cite
  expected_citations: z.array(z.string()).optional(),
});
export type AnswerTest = z.infer<typeof AnswerTest>;

// each metric is only set when the test has the expectation it needs
type Metrics = {
  documentRecall?: number;
  citationRecall?: number;
  citationPrecision?: number;
  citationGrounding?: number;
  factCoverage?: number;
  correctness?: number;
  relevance?: number;
};

const EO_NUMBER = /\b\d{2}\.\d{2}\.\d{2}\.\d{2}\b/g;

// EO numbers the answer mentions, deduplicated
const citedOrders = (answer: string): string[] => [...new Set(answer.match(EO_NUMBER) ?? [])];

// the crawler writes georgia/executive-orders/<eo_number>.md, so the basename is the EO number
const sourceOrders = (sources: RetrievedChunk[]): Set<string> =>
  new Set(sources.map(chunk => path.basename(chunk.metadata.source, ".md")));

// fraction of `expected` found in `actual`; 0 when there's nothing to find
const fractionFound = (expected: string[], actual: Set<string>): number =>
  expected.length > 0 ? expected.filter(item => actual.has(item)).length / expected.length : 0;

const average = (values: number[]): number =>
  values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;

const JudgeSchema = z.object({
  relevance: z.number().int().min(1).max(5).describe(
    "1-5: does the answer address the question that was asked, and stay on it?"
  ),
  correctness: z.number().int().min(1).max(5).nullable().describe(
    "1-5: how well the answer agrees with the reference answer. null when no reference answer is given"
  ),
  factsPresent: z.array(z.boolean()).describe(
    "One entry per expected fact, in the order given: true if the answer states that fact. Empty when no facts are given"
  ),
  reasoning: z.string().describe("A short explanation of the scores"),
});
type Judgement = z.infer<typeof JudgeSchema>;

const JUDGE_SYSTEM_PROMPT = `
You are grading answers from a question answering assistant for Georgia state government laws and the Governor's executive orders.
Grade strictly and only on what the answer says; do not reward length or confident tone.
Relevance: 5 = directly answers the question and stays on it, 1 = ignores or misunderstands the question.
Correctness (only when a reference answer is given): 5 = agrees with the reference on every key point, 1 = contradicts it or is missing the answer.
Expected facts: a fact counts as present if the answer states it, even in different words.
`;

const buildJudgePrompt = (test: AnswerTest, answer: string): string => {
  let prompt = `Question:\n${test.question}\n\nAnswer to grade:\n${answer}\n\n`;

  if (test.expected_answer) {
    prompt += `Reference answer:\n${test.expected_answer}\n\n`;
  } else {
    prompt += "No reference answer is given, so correctness must be null.\n\n";
  }

  if (test.expected_facts?.length) {
    prompt += "Expected facts:\n";
    test.expected_facts.forEach((fact, index) => {
      prompt += `${index + 1}. ${fact}\n`;
    });
  } else {
    prompt += "No expected facts are given, so factsPresent must be empty.\n";
  }

  return prompt;
};

const judgeAnswer = async (test: AnswerTest, answer: string): Promise<Judgement> => {
  const { output } = await generateText({
    model: openai(config.JUDGE_MODEL),
    output: Output.object({ schema: JudgeSchema }),
    system: JUDGE_SYSTEM_PROMPT,
    prompt: buildJudgePrompt(test, answer),
  });

  return output;
};

// runs the same path as the non-stream branch of /v1/rag/chat: rewrite, retrieve, rerank, tools, answer
const generateAnswer = async (question: string) => {
  const { chunks, toolChunks, textStream } = await streamAnswer(question, []);

  let answer = "";
  for await (const text of textStream) answer += text;

  // toolChunks is complete now that the stream is drained
  return { answer, sources: [...chunks, ...toolChunks] };
};

const evaluateAnswer = async (test: AnswerTest) => {
  const { answer, sources } = await generateAnswer(test.question);
  const judgement = await judgeAnswer(test, answer);

  const cited = citedOrders(answer);
  const available = sourceOrders(sources);
  const metrics: Metrics = {};

  // did the answer step actually have the doc, including tool lookups?
  if (test.expected_documents) {
    metrics.documentRecall = fractionFound(test.expected_documents, available);
  }

  if (test.expected_citations) {
    const expected = new Set(test.expected_citations);
    metrics.citationRecall = fractionFound(test.expected_citations, new Set(cited));
    metrics.citationPrecision = fractionFound(cited, expected);
  }

  // cited orders that were in the sources; catches orders the model made up
  // (orders found only through searchExecutiveOrders aren't chunks, so they count as ungrounded)
  if (cited.length > 0) {
    metrics.citationGrounding = fractionFound(cited, available);
  }

  // literal match first, the judge helps with facts phrased differently
  if (test.expected_facts) {
    const answerLower = answer.toLowerCase();
    const covered = test.expected_facts.filter(
      (fact, index) => answerLower.includes(fact.toLowerCase()) || judgement.factsPresent[index] === true
    );
    metrics.factCoverage = test.expected_facts.length > 0 ? covered.length / test.expected_facts.length : 0;
  }

  if (test.expected_answer && judgement.correctness !== null) {
    metrics.correctness = judgement.correctness;
  }

  metrics.relevance = judgement.relevance;

  return { answer, cited, metrics, reasoning: judgement.reasoning };
};

// averages each metric over the results that have it
const averageMetrics = (metricsList: Metrics[]): Metrics => {
  const keys = [...new Set(metricsList.flatMap(metrics => Object.keys(metrics)))] as (keyof Metrics)[];

  return Object.fromEntries(
    keys.map(key => [key, average(metricsList.flatMap(metrics => metrics[key] ?? []))])
  );
};

const loadTests = (): AnswerTest[] => {
  const tests: AnswerTest[] = [];

  for (const [index, entry] of testsJSON.entries()) {
    const parsed = AnswerTest.safeParse(entry);
    if (!parsed.success) {
      const fields = parsed.error.issues.map(issue => issue.path.join(".")).join(", ");
      console.warn(`skipping test ${index} (invalid: ${fields})`);
      continue;
    }
    tests.push(parsed.data);
  }

  return tests;
};

const evaluate = async () => {
  const tests = loadTests();
  const shouldSave = process.argv.includes('--save');
  const results = [];
  // kept alongside results (same order as tests) for the averages
  const metricsList: Metrics[] = [];

  if (!dbEnabled()) {
    console.warn("GOVBOT_DATABASE_URL is not set: searchExecutiveOrders is off, so count/list questions only use the knowledge base");
  }

  for (const test of tests) {
    const { answer, cited, metrics, reasoning } = await evaluateAnswer(test);

    console.log(`\n=== ${test.id} (${test.category}) ===`);
    console.log('question', test.question);
    console.log('answer', answer.length > 500 ? `${answer.slice(0, 500)}...` : answer);
    console.log('cited', cited);
    for (const [key, value] of Object.entries(metrics)) console.log(key, value);
    console.log('reasoning', reasoning);

    metricsList.push(metrics);
    results.push({ id: test.id, question: test.question, category: test.category, answer, cited, ...metrics, reasoning });
  }

  console.log('\n=== averages: overall ===');
  console.log(averageMetrics(metricsList));

  const categories = [...new Set(tests.map(test => test.category))];
  for (const category of categories) {
    console.log(`=== averages: ${category} ===`);
    console.log(averageMetrics(metricsList.filter((_, index) => tests[index].category === category)));
  }

  if (shouldSave) {
    // TODO - compare and report diffs
    writeFileSync(path.join(import.meta.dirname, 'current-results.json'), JSON.stringify(results, null, 2));
  }

  // the pool would otherwise keep the process alive until its idle clients time out
  if (dbEnabled()) await getPool().end();
}

await evaluate();
