# Header-only access tokens and scoped native PDF previews

Protected HTTP routes now require an `Authorization: Bearer ...` header.
An access JWT in `?token=` cannot authenticate a read or mutation. A supplied
header is still used when an unrelated query token is present. Personal API
keys retain their independent header-only policy, and public file/wiki shares,
account links, OIDC callbacks and WebSocket first-message authentication keep
their separate contracts.

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

The frontend owns each grant in the open preview's component state. File,
workspace, account or access-token changes abort old requests and discard their
results; closing the preview removes its timers and listeners. API requests use
the existing identity guards and bounded authentication replay. The preview
renews thirty seconds before expiry. When the source access token is the bound,
it uses the existing shared session-refresh coordinator once and adopts a
changed token; an unchanged/failed refresh stops with visible retry instead of
a renewal loop. A delayed renewal unloads expired content, and reopening or
retrying requests a new grant. The iframe sends no referrer.

Renewal changes the native iframe URL and can reload the PDF or reset its
position. A custom viewer that preserves reading position and efficient byte
ranges is separate work. Responses already authorized before a concurrent
revocation or expiry may finish, and decoded bytes already shown by the browser
are not remotely erased. A leaked preview URL remains a short-lived read bearer
for that particular file; proxies should avoid retaining its query values.
Known application log fields redact it through the existing token policy.
Historical logs, browser/provider behavior, external collectors, custom API-base
hosting and broad browser/runtime release validation remain separate gates.

`file-preview-grants.test.mjs` exercises real TCP HTTP, PostgreSQL and a raw
WebSocket connection with synthetic local fixtures. It checks generic query
read/write refusal, separate credential purposes, strict claims, current
session/file authority, legacy/API-key compatibility, streaming/HEAD, inherited
Range200 behavior and safe missing-content responses. Authentication unit tests
compare the shared predicate and safe failure diagnostics. Frontend tests cover
resource/identity/close cancellation, API bases, expiry/renewal, source-bound
refresh, no-loop/error/retry behavior and the iframe's no-referrer attribute.

A local Chromium141/Playwright1.56.1 Vite development harness also exercised
the actual component/hook/API with real TCP/PostgreSQL. It observed the iframe's
scoped URL, exact streamed PDF bytes/headers and close cancellation. A genuine
eight-second source JWT expired while its real refresh was held: the iframe
unloaded, its expired grant received401, and preview renewal plus an ordinary
API401 shared exactly one cookie refresh before adopting the new access token.
An account switch removed the old iframe and the other account's file request
was refused. No observed URL contained an ordinary access JWT. This is a source
component/network/lifecycle proof, not the production bundle or full router.
The cached headless shell reports `pdfViewerEnabled=false`, and its screenshot
shows the blank native-viewer area; visual PDF rendering is not claimed.
