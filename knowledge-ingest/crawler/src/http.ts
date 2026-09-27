const USER_AGENT = "knowledge-crawler/1.0";
const REQUEST_TIMEOUT_MS = 60_000;

// fetch with our user agent and a per-request timeout, still cancelled by the crawl-wide signal.
export const fetchWithTimeout = async (
    url: string,
    signal: AbortSignal,
    headers: Record<string, string> = {},
): Promise<Response> => {
    const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, ...headers },
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });

    if (!response.ok && response.status !== 304) {
        throw new Error(`GET ${url} returned ${response.status} ${response.statusText}`);
    }

    return response;
};
