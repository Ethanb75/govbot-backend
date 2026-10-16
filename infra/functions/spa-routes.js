// Default behavior (S3), viewer request: serve the app shell for client-side routes. Paths whose
// last segment has a file extension (assets) pass through, so a missing asset is still an error
// rather than index.html. Done here, not with custom error responses, because those apply to the
// whole distribution and would also replace the API's own 404s.
function handler(event) {
    var request = event.request;
    var lastSegment = request.uri.split('/').pop();

    if (lastSegment.indexOf('.') === -1) {
        request.uri = '/index.html';
    }

    return request;
}
