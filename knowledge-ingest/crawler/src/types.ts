export interface CrawlContext {
    knowledgeBasePath: string;
    statePath: string;
    // Year to crawl for sources organised by year; defaults to the current year.
    year: number;
    // Fires when the whole crawl hits its hard timeout.
    signal: AbortSignal;
}

export interface CrawlResult {
    discovered: number;
    created: string[];
    updated: string[];
    unchanged: string[];
    failed: string[];
}

export interface Source {
    name: string;
    crawl: (context: CrawlContext) => Promise<CrawlResult>;
}
