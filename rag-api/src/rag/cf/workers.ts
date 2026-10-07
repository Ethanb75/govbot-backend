import { config } from "../../config.js";
import { INTENT_QUESTIONS } from "../prompts.js";
import { Message } from "../types.js";

export const workersAiEnabled = (): boolean =>
    !!(config.CLOUDFLARE_WORKER_API_KEY && config.CLOUDFLARE_WORKER_ACCOUNT_ID);

// Calls a Workers AI model over the REST API and returns the raw response envelope ({ result, success, errors, messages })
export const callWorkersAi = async (model: string, body: unknown, abortSignal?: AbortSignal): Promise<unknown> => {
    const url = `https://api.cloudflare.com/client/v4/accounts/${config.CLOUDFLARE_WORKER_ACCOUNT_ID}/ai/run/${model}`;
    const res = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${config.CLOUDFLARE_WORKER_API_KEY}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: abortSignal,
    });

    if (!res.ok) {
        throw new Error(`Workers AI ${model} failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
};

// Asks Clef whether the message needs the knowledge base, is small talk, or is off topic.
// Clef is a decision model: it scores typed questions against a state (here, the chat log) instead of chatting
export const detectImmediateIntent = async (question: string, history?: Message[], abortSignal?: AbortSignal) => {
    try {
        return await callWorkersAi(config.INTENT_MODEL, {
            model: "clef",
            // state: [...history, { role: "user", content: question }],
            // for now, trying just the current question
            state: [{ role: "user", content: question }],
            questions: INTENT_QUESTIONS,
        }, abortSignal);
    } catch (err) {
        console.error('failed to call workers api: ', err);
    }
}
