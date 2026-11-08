# Failed sign-out recovery

When a sign-out request fails (offline, a 5xx, the tab closed first), the
server session stays valid and the browser still holds its refresh cookie, so
a later page load could quietly restore it. The browser therefore records each
sign-out durably before sending it and, until the server has settled it,
completes it on the next page load (or sign-in), in any tab, before restoring
any session.

`POST /api/auth/logout/recover` is the server side: it lets a browser retry
ending one known sign-in session without changing its current cookie. Ordinary
logout with a current access token and refresh keep their existing behavior.

An expired, signature-verified access JWT may also select its own family for
`POST /api/auth/logout`. This branch requires the existing refresh cookie to
prove that exact family and checks the JWT's subject against its locked owner.
It returns 204 without setting or clearing a cookie, including when the cookie
is absent or belongs to a newer sign-in. It never grants API access, rotates a
token, or renews a lifetime. Forged, malformed, not-yet-valid, and sessionless
expired tokens remain refused. This lets a user finish an expired-token
sign-out even on a page origin not configured for background recovery, without
the unsafe refresh-then-logout fallback. The recovery route's Origin and
custom-header requirements below are unchanged.

## Request and credential boundary

Send `Content-Type: application/json`, `X-Werkyn-Session-Recovery: 1`, and exactly
`{ "sessionId": "<session UUID>" }` with the existing HttpOnly refresh cookie.
The UUID is the access token's `sid` and is only a target selector. Possession of
that UUID, an access JWT, or an API key does not authorize revocation. The cookie
must resolve to that same family through a current token or retained rotated
token record. The endpoint never issues an access or refresh token.

A mandatory, exact `Origin` must match the configured frontend origin or an
explicit configured CORS origin. Missing, null, or untrusted origins and missing,
incorrect, or duplicate recovery headers receive 403. Non-JSON requests receive
415; malformed JSON and invalid or extra body fields receive 400. Browser CORS
preflight must permit both the origin and custom header; the route also checks
the actual POST, because CORS response headers alone do not prevent writes.

## Results and cookie safety

Successful requests return only `{ "data": { "status": "..." } }`:

| Status       | Meaning                                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `revoked`    | The cookie proved the selected family and its revocation committed. No current token in that family remains.                  |
| `superseded` | The cookie resolves to a different family. Neither family is changed, and the different family is not locked.                 |
| `absent`     | The cookie or retained family evidence is missing or unrecognized. Revocation of a previous session has not been established. |

Every route outcome, including validation failures, 503, and unexpected 500,
omits `Set-Cookie`. The operation never sets, clears, or rotates a cookie, so a
delayed response cannot overwrite a later sign-in's cookie. Responses use
`Cache-Control: no-store`. A response lost after commit remains ambiguous to the
browser; retrying with retained matching proof is safe. If the old cookie or
retained evidence has been erased or replaced, `absent` or `superseded` does not
establish that the earlier session was revoked.

## Transactions, compatibility, and limits

The helper uses the existing READ COMMITTED transaction, 5-second acquisition
budget, 10-second transaction budget, and 8-second per-lock cap. Matching
recovery and refresh serialize on the same family row. Recovery behind rotation
deletes its successor; rotation behind recovery cannot mint one. Recognized
transaction or lock contention returns a fixed retryable 503 with no cookie
mutation. Other errors retain the existing error-handler policy, and a rolled
back revocation does not close sockets.

After commit, the handler closes that family's sockets in this server process
with the existing 4005 session-revoked code. This does not add cross-process
socket coordination or cancel requests already admitted by authentication.
Unrelated families and API keys retain their existing policies and lifetimes.
There is no account-wide revocation, schema change, global CORS change, or new
cookie policy. Ordinary logout with a current token remains cookie-centric and
retains its existing cookie clearing behavior even if revocation fails. The
expired-token branch is family-conditional and never changes cookies.

## Verification

The pre-change real HTTP/PostgreSQL baseline had one intended failure: the new
route returned 404 and its family remained live. Ordinary logout, refresh, and
different-header/current-cookie behavior passed as compatibility controls.

The permanent `pending-logout-recovery.test.mjs` suite covers these controls,
actual preflight and POST checks, wrong or missing proof, locked newer sessions
for the same and different accounts, retained rotated proof and erased family
evidence, database-trigger rollback followed by retry, observed PostgreSQL
waiters in both refresh/recovery orders, and real local socket/API-key behavior.
The busy test temporarily lowers the existing test-local lock cap to 250 ms;
it proves classification and rollback, not an elapsed eight-second wait.

## Browser: durable sign-out

`packages/frontend/src/lib/pending-sign-out.ts` keeps the records and
`packages/frontend/src/stores/auth-store.ts` uses them.

**Record.** Before the sign-out request is sent, the browser writes a
localStorage entry keyed by the API's absolute base URL and the session id
(the access token's `sid`, its refresh family). The value is only the account
id and the time. No token is stored; the id is a selector, as above.

**Completion.** A page load, and a sign-in before it replaces the cookie,
first completes every record of this API, with `keepalive`:

| Recovery result                     | Record  | Session restored by this load?          |
| ----------------------------------- | ------- | --------------------------------------- |
| `revoked`                           | removed | No: the cookie's session was just ended |
| `superseded`                        | removed | Yes, the newer session the cookie holds |
| `absent`                            | removed | Only if a refresh then succeeds         |
| 503/429                             | kept    | Retried within 10 s, else no            |
| Network failure, deadline           | kept    | No; a later load tries again            |
| Refused or failed (403/404/5xx/...) | kept    | No; a later load tries again            |

Nothing that sets or clears the cookie is sent to settle a record. A refresh
followed by ordinary logout could identify the recorded session and then, if a
sign-in landed in between (for example a single sign-on callback, which no
tab can coordinate with), replace or revoke the newer session instead.

A password sign-in or registration replaces the cookie. When its response is
applied, it removes the records that existed when its request was sent: this
browser can no longer complete them or restore those sessions, so they must
not hold back the new one. A record written after the request was sent is
kept, because it may name the session the cookie holds by then (another tab
signed in and out again before this response was applied).

**The rule that protects a newer sign-in.** A record is removed only on
evidence that this browser can no longer restore its session: `revoked`,
`superseded` or `absent` from recovery; a 204 from the ordinary sign-out
request; or a sign-in, sent after the record was written, whose response
replaced the cookie. It is never compared
by account or by time. Every sign-in starts a new family, and the recorded
family is revoked only when the cookie the browser sends at that moment
proves it, so a stale record cannot end a sign-in made after it, in this tab or
another, even by the same account. When the access token has already expired,
the logout route uses its verified session selector and the matching cookie as
described above. A 503 or 429 from that logout is retried with the same delays
as recovery. A newer announced sign-in or the sign-out deadline stops those
retries before another logout is sent. The record stays until a 204 or recovery
settles it. A client talking to an older server that answers 401 still tries
conditional recovery; only a token without a session id, from an earlier
server, takes the older refresh-then-logout path.

**Cross-tab.** Records are shared by every tab of the origin. A tab that
reloads after another tab's failed sign-out completes it first. A tab that
missed the sign-out announcement and still holds the session ends it at its
next refresh. A late sign-in can leave a different family in memory than the
one the cookie proves; a refresh response naming a recorded family is also
refused before it is applied or announced. A broadcast cannot adopt a recorded
family either. A rotation may already have happened before its returned
family is known, so the record continues blocking that family until it is
settled. Completion in several tabs at once is
safe: each request is settled with `revoked` or `absent`, and none sets a
cookie. When a sign-in races a completion, the completion carried either the
old cookie (and revoked only the old session) or the new one (and is told
`superseded`); the recovery route never touches the cookie, so it cannot
overwrite the new one.

**Bounds.** At most eight records per API are kept, oldest dropped first:
while a record is pending no session is restored, so a later record follows a
new sign-in, which replaced the cookie, and older records can no longer match
it. A client-clock jump never expires a record: the browser clock cannot prove
that the server's cookie or family expired. Server settlement or a proven
replacing sign-in retires it instead, and the eight-record cap bounds storage.

**Single sign-on.** New SSO redirects include an opaque `client_attempt` UUID
and keep this tab's pre-redirect record snapshot in sessionStorage, scoped to
the API base. The existing OIDC callback stores a signed, HttpOnly completion
proof binding that attempt to its newly created family. The completion page
uses `POST /api/auth/oidc/complete-session`, not ordinary refresh, to obtain a
session for that proof and the current cookie. Only a successful proof retires
the snapshotted old records; a record of the new family made while sign-in was
in flight is kept and prevents adoption. The operation does not rotate or
change cookies, and failed proof never falls back to ordinary restoration.
This gives SSO-only installations a fresh-sign-in escape when old recovery is
unavailable. The server controls proof expiry (60 seconds); there is no local
wall-clock expiry. A later different family or sign-out prevents a delayed
completion from replacing it, and neither retires the snapshotted records. If
another tab already adopted the exact proven family, completion keeps that
tab's newer token and retires only the snapshot. A failed or invalid proof does
not restore anything, retire records, or fall back to ordinary refresh. It
discards the stale attempt, and the completion page can keep a session
hydration already restored when that session itself has no pending sign-out.

**Limits.** Without localStorage (blocked, or quota exhausted) nothing is
durable and a failed sign-out behaves as before. While a record cannot be
settled (the server is unreachable, or refuses recovery, for example when the
page's origin is not `FRONTEND_URL` or in `CORS_ORIGIN`), ordinary page loads
restore nothing. A password sign-in or valid new SSO completion can replace it,
as can recovery succeeding. Configure `FRONTEND_URL` and `CORS_ORIGIN` for the
actual frontend origin on every installation, including HTTP LAN installs;
the OIDC proof endpoint retains its trusted-Origin check. If sessionStorage is
unavailable, SSO uses the legacy completion path, which still fails closed
while an old record cannot settle. `superseded`, `absent` and a replacing
sign-in do not revoke the old family on the server (a password sign-in of the
same account ends that account's other sessions anyway). It stays valid until
it expires, but this browser no longer holds a cookie for it. Tabs still
running an earlier build ignore records. Legacy OIDC callbacks and invitation
redirects retain their prior behavior.
