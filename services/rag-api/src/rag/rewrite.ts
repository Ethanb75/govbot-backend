import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { config } from "../config.js";
import { buildRewritePrompt } from "./prompts.js";
import { Message } from "./types.js";

const formatHistory = (history: Message[]): string =>
    history.map(message => `${message.role}: ${message.content}`).join("\n");

// Turns a follow-up like "what role do they cover?" into a standalone knowledge base query
export const rewriteQuery = async (question: string, history: Message[]): Promise<string> => {
    // nothing to add context from, so the question already stands on its own
    if (history.length === 0) return question;

    const { text } = await generateText({
        model: openai(config.REWRITE_MODEL),
        prompt: buildRewritePrompt(formatHistory(history), question),
    });

    return text.trim() || question;
};
