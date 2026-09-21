# Desktop shared-token authentication

`js/auth.js` owns the per-origin secret and the shared transports. All REST
requests use its bearer-header fetch helper; both socket classes use its URL
builder. Redirects are refused. Failed handshakes probe `/agents` before the
existing reconnect code schedules another attempt. Token checks time out after
10 seconds. Opening the token dialog pauses HTTP traffic and socket reconnects;
saving reloads the page to restart consumers consistently. Rejected drafts never
replace the old stored token. Only network failures offer Save anyway.

The secret is stored only under `agentUi.serverToken`; it is not part of other
preferences, links, exports, or error messages. HTTP(S) pages ignore `?api=`.
The production CSP is same-origin only. A disk-development copy needs an
explicitly tailored CSP as well as backend CORS/Origin support (see README).

## HTML/XSS audit

- The two transcript `innerHTML` assignments consume only `toHtml` output.
  That parser does not support raw HTML: prose, code, table cells, and attribute
  values are HTML-escaped. Links allow only HTTP(S), mailto, fragments, and
  relative paths; `javascript:` and `data:` are not allowed.
- `toolformat.js` constructs markup from fixed tags/classes and HTML-escapes
  every tool-provided text value. Its diff kinds and command prompts are local
  constants, not server-supplied HTML.
- No other `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, or
  raw-HTML framework sinks were found. File download links use locally created
  Blob URLs. The token dialog uses DOM text nodes and an input value only.
- Inline styles remain necessary for dynamic layout; scripts do not need
  inline-script or eval CSP exceptions.

## Verification

Automated:

```sh
node test/run.js
node test/auth-tests.js
```

The isolated auth suite uses fake credentials, fetch, sockets, and DOM nodes.
It covers hostile `?api=`, REST headers and redirects, first-run request gating,
plain-text REST 401 handling, socket failure probes, file-tree socket auth,
query encoding, rejected saves, HTTP errors versus offline saves, draft edits,
and trimming on successful save. Existing Markdown tests cover HTML escaping
and dangerous link schemes.

Still required before shipping: real-browser checks against the authenticated
server, including restart/reconnect, rotation, storage failures, and the console
for CSP violations on **every screen**. Automated DOM mocks do not establish
browser CSP compatibility or UI appearance. Android is a separate repository
and is not implemented here.
