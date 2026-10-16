// /api/* behavior, viewer request: rag-api serves /health/ready and /v1/rag/chat at its root, so
// drop the /api prefix the site uses (what nginx's trailing-slash proxy_pass did on the homelab).
// The query string is separate (request.querystring) and passes through untouched.
function handler(event) {
    var request = event.request;

    // the behavior's path pattern guarantees the uri starts with "/api/"
    request.uri = request.uri.substring('/api'.length);

    return request;
}
