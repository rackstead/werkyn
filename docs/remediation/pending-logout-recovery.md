# Conditional sign-out recovery prerequisite

`POST /api/auth/logout/recover` lets a browser retry ending one known sign-in
session without changing its current cookie. Ordinary logout and refresh keep
their existing behavior. This endpoint is a server prerequisite for durable
failed-logout recovery; no browser persistence, hydration, cross-tab ordering,
or SSO completion behavior changes here. Audit R07 remains open.

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
cookie policy. Ordinary logout remains cookie-centric and retains its existing
cookie clearing behavior even if revocation fails.

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

Future client integration must separately establish durable explicit sign-out
intent, safe adoption ordering for new same-account and different-account
sessions, and SSO completion ordering. This endpoint alone does not guarantee
sign-out after reload or across tabs.
