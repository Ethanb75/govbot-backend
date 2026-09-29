import { z } from "zod";

// Caps keep a single request from turning into a large OpenAI bill
export const MAX_MESSAGES = 20;
export const MAX_MESSAGE_LENGTH = 4000; // make sure FE know's about this length AND backend returns a good error message

export const MessageSchema = z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
});

export const SearchRequest = z.object({
    query: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
    history: z.array(MessageSchema).max(MAX_MESSAGES - 1).default([]),
});

export const ChatRequest = z.object({
    messages: z
        .array(MessageSchema)
        .min(1)
        .max(MAX_MESSAGES)
        .refine(messages => messages.at(-1)?.role === "user", "the last message must be from the user"),
    stream: z.boolean().default(false),
});

export const formatIssues = (error: z.ZodError) =>
    error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message }));
