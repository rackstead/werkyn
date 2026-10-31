# Header-only access tokens and scoped native PDF previews

Protected HTTP routes now require an `Authorization: Bearer ...` header.
An access JWT in `?token=` cannot authenticate a read or mutation. A supplied
header is still used when an unrelated query token is present. Personal API
keys retain their independent header-only policy, and public file/wiki shares,
account links, OIDC callbacks and WebSocket first-message authentication keep
their separate contracts.

Roll out the matching frontend and backend together. Already-open older tabs
that put access JWTs in PDF URLs need an application reload, and custom HTTP
clients using query credentials must migrate to the Authorization header.
There is no generic query-token compatibility fallback.

The native PDF iframe previously put the full access JWT in its URL. It now
requests a grant through the authenticated API:

- `POST /api/workspaces/:wid/files/:fid/preview-grant` requires a browser access
  JWT and current workspace/file read permission. It returns a grant and its
  expiry with `private, no-store` and `Referrer-Policy: no-referrer`. Personal
  API keys continue using the normal header-authenticated download route;
  they do not mint browser preview grants.
- Only `GET` and `HEAD /api/workspaces/:wid/files/:fid/preview?token=...` accept
  that grant. It names one file, workspace and account/session. A versioned,
  domain-separated signing key and strict algorithm, issuer, audience,
  purpose and claim checks keep it separate from access JWTs. A preview grant
  cannot authenticate generic HTTP or WebSocket requests, including when
  supplied as a Bearer token. The preview route refuses ordinary access JWTs.
- A grant lasts at most five minutes and never beyond its issuing access
  JWT's expiry. A genuinely absent session claim retains only that source
  token's existing legacy expiry grace. Malformed present session claims do
  not get the grace.
- Each read checks the current account and live owned session, current
  workspace membership/role and existing file/team/group/share access before
  opening storage. Ending a session, revoking a share/group/membership,
  demoting an administrator or trashing/deleting the file therefore refuses
  later reads. The shared account/session predicate and bounded safe
  operational/programming failure diagnostics match ordinary HTTP auth.

Only non-folder PDF content can use this route. Its response retains inline
filename handling, the sandbox content policy, `nosniff`, private/no-store
caching and no-referrer policy. File bytes stream from storage; the application
and frontend do not create an eager whole-PDF Buffer or Blob. The existing
storage/download implementation does not implement byte ranges: requests with
`Range` still receive its whole-file `200` stream. This change adds no `206`,
range-resume, storage API or buffering redesign.

The frontend owns one usable grant URL for the open file, workspace and identity.
Resource/account changes and closing the preview abort old requests and discard
late results. An already displayed whole-file200 response stays in the native
viewer through grant expiry, focus changes and same-user access-token rotation;
it is not periodically downloaded again or removed by a background renewal.
Reload preview deliberately requests a new grant, and failed acquisition shows
Retry preview. The iframe sends no referrer.

Before exposing a new URL, the client requires at least thirty seconds of
remaining grant lifetime. Slow acquisition or a short source token uses the
existing shared session-refresh coordinator once and requires a changed token;
a concurrent ordinary API refresh can supply that token instead. One replacement
grant must then have enough lifetime, or visible retry stops the attempt without
a loop. Existing identity guards and bounded API authentication replay remain.
Reported iframe errors show retry. Cross-origin/native-viewer HTTP status cannot
be inferred reliably, so Reload preview stays available for a blank or failed
viewer even when its browser does not report an iframe error.

Expiry, session ending and current file authority still refuse every later
server read; keeping an already received document does not extend the grant.
Responses authorized before concurrent revocation/expiry may finish, and decoded
bytes already shown by a browser are not remotely erased. Explicit reload may
reset reading position. Efficient byte ranges/custom viewers remain separate.
A leaked preview URL is a short-lived bearer for that one file; proxies should
avoid retaining its query values. Known application log fields redact it through
the existing token policy. Historical retention, provider/browser behavior,
custom API-base hosting and broad runtime release validation remain open.

`file-preview-grants.test.mjs` exercises real TCP HTTP, PostgreSQL and a raw
WebSocket connection with synthetic local fixtures. It checks generic query
read/write refusal, separate credential purposes, strict claims, current
session/file authority, legacy/API-key compatibility, streaming/HEAD, inherited
Range200 behavior and safe missing-content responses. Authentication unit tests
compare the shared predicate and safe failure diagnostics. Frontend tests cover
resource/identity/close cancellation, API bases, stable loaded documents across
expiry/token rotation, guarded initial acquisition, no-loop/error/retry behavior
and the iframe's no-referrer attribute.

A local Chromium141/Playwright1.56.1 Vite development harness exercises the
actual component/hook/API over real TCP/PostgreSQL. The corrected lifecycle
kept the same iframe URL and request count during same-user token rotation;
closing aborted held acquisition, and switching accounts removed the old
iframe. Explicit reload received a genuine eight-second source-bound grant,
kept that short URL out of the iframe, and shared exactly one real cookie
refresh with an ordinary API401 before adopting a fresh token. A separate read
of the expired grant received401. Exact PDF bytes/headers and absence of ordinary
access JWTs in observed URLs were verified. This is source-component/network
proof, not production-bundle/full-router or native visual rendering validation:
the cached headless shell reports `pdfViewerEnabled=false`. Dispatched DOM error
tests establish listener wiring/cleanup only; cross-origin HTTP error detection
is not inferred from them.
