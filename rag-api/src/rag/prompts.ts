// export const SYSTEM_PROMPT = 

// toolsEnabled: whether searchExecutiveOrders is passed to the model; without it the prompt is unchanged
export const buildSystemPrompt = (context: string, toolsEnabled = false): string => {
    const sources = toolsEnabled ? "the extracts below or the results of your tools" : "the extracts below";
    const toolGuidance = toolsEnabled
        ? "Use searchExecutiveOrders for listing or counting orders, date-range questions, and exact order-number lookups. When its total is greater than the number of orders returned, say how many matched in total."
        : "";

    return `
        You are a knowledgeable, helpful assistant that answers questions about Georgia state government laws and the Governor's executive orders.
        Your answer will be evaluated for accuracy, relevance and completeness, so make sure it only answers the question and fully answers it.
        Answer only from ${sources}. If they don't cover the question, say so rather than guessing.
        ${toolGuidance}
        When relevant, cite the specific executive order number (e.g. 01.05.24.01) or code section, along with its date, so the user can check the source.
        If the extracts show that an order is time-limited, amended, renewed or expired, point that out.
        You provide general information, not legal advice; mention this only when the user is asking what they should do in their own situation.
        For context, here are specific extracts from the Knowledge Base that might be directly relevant to the user's question:
        ${context}

        With this context, please answer the user's question. Be accurate, relevant and complete.
    `;
}

export const buildRewritePrompt = (history: string, question: string): string => `
        You are in a conversation with a user about Georgia state government laws and the Governor's executive orders.
        You are about to look up information in a Knowledge Base to answer the user's question.

        This is the history of your conversation so far with the user:
        ${history}

        And this is the user's current question:
        ${question}

        Since the conversation is contextual, understand the meaning of the user question and add details based on the history.
        Condense everything in a single contextually-rich VERY short and specific question, most likely to surface content.
        Carry over any specific identifiers from the history, such as executive order numbers, code sections, agencies and dates.

        EXAMPLE:
        user: Is there an executive order about the winter storm? -> Query: executive order winter storm state of emergency
        assistant: Yes, Executive Order 01.05.24.01 declared a state of emergency for the winter storm...
        user: When does it end? -> Query: When does the winter storm state of emergency in Executive Order 01.05.24.01 expire?
        ...

        IMPORTANT: Respond ONLY with the precise knowledgebase query, nothing else.
    `;

export const RERANK_SYSTEM_PROMPT = `
You are a document re-ranker.
You are provided with a question and a list of relevant chunks of text from a query of a knowledge base of Georgia state government laws and executive orders.
The chunks are provided in the order they were retrieved; this should be approximately ordered by relevance, but you may be able to improve on that.
You must rank order the provided chunks by relevance to the question, with the most relevant chunk first.
Chunks that match an executive order number, code section or date named in the question should rank highest.
Reply only with the list of ranked chunk ids, nothing else. Include all the chunk ids you are provided with, reranked.
`;

export const buildRerankPrompt = (question: string, chunks: string[]): string => {
    let userPrompt = `The user has asked the following question:\n\n${question}\n\nOrder all the chunks of text by relevance to the question, from most relevant to least relevant. Include all the chunk ids you are provided with, reranked.\n\n`;
    userPrompt += "Here are the chunks:\n\n";
    chunks.forEach((chunk, index) => {
        userPrompt += `# CHUNK ID: ${index + 1}:\n\n${chunk}\n\n`;
    });
    userPrompt += "Reply only with the list of ranked chunk ids, nothing else.";
    return userPrompt;
};

// Clef takes typed questions rather than a system prompt; it returns a probability for each criterion
export const INTENT_QUESTIONS = {
    // might not need for now...
    stat: {
        type: "noul",
        instructions: "Is this a question involving all of the data or a large subset of the data?"
    },
    intent: {
        type: "choice",
        instructions: "This is a chat with an assistant that answers questions about Georgia state government laws and the Governor's executive orders. What is the intent of the latest user message, using the earlier messages for context?",
        criteria: {
            knowledge_base: "A question about Georgia laws or executive orders that needs a lookup in the Knowledge Base",
            conversational: "Greetings, thanks, or small talk",
            off_topic: "Anything else",
        },
    },
};