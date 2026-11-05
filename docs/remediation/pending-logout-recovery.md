# Failed sign-out recovery

When a sign-out request fails (offline, a 5xx, the tab closed first), the
server session stays valid and the browser still holds its refresh cookie, so
a later page load could quietly restore it. The browser therefore records each
sign-out durably before sending it and, until the server has settled it,
completes it on the next page load (or sign-in), in any tab, before restoring
any session.

`POST /api/auth/logout/recover` is the server side: it lets a browser retry
ending one known sign-in session without changing its current cookie. Ordinary
logout and refresh keep their existing behavior.

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

## Browser: durable sign-out

`packages/frontend/src/lib/pending-sign-out.ts` keeps the records and
`packages/frontend/src/stores/auth-store.ts` uses them.

**Record.** Before the sign-out request is sent, the browser writes a
localStorage entry keyed by the API's absolute base URL and the session id
(the access token's `sid`, its refresh family). The value is only the account
id and the time. No token is stored; the id is a selector, as above.

**Completion.** A page load, and a sign-in before it replaces the cookie,
first completes every record of this API, with `keepalive`:

| Recovery result                | Record    | Session restored by this load?          |
| ------------------------------ | --------- | --------------------------------------- |
| `revoked`                      | removed   | No: the cookie's session was just ended |
| `superseded`                   | removed   | Yes, the newer session the cookie holds |
| `absent`                       | removed   | Only if a refresh then succeeds         |
| 503/429                        | kept      | Retried within 10 s, else no            |
| Network failure or deadline    | kept      | No; the next load tries again           |
| Any other answer (403/404/5xx) | see below | see below                               |

When the server refuses the request itself (an untrusted Origin, a server
without the route), the browser asks through the cookie's own session: a
refresh tells which session the cookie holds. Only if that is a recorded
session is it signed out with ordinary logout; a 401 means the cookie holds no
session. Records of other sessions are removed, since the cookie no longer
belongs to them. These cookie-setting requests are announced like any other
sign-out, so a sign-in in another tab waits for them.

**The rule that protects a newer sign-in.** A record is removed only when the
server has settled it: revoked, `superseded` or `absent` from recovery, a 204
or a 401 from ordinary sign-out and refresh, or a refresh showing that the
cookie holds a different session. It is never compared by account or by time.
Every sign-in starts a new family, and the recorded family is revoked only
when the cookie the browser sends at that moment proves it, so a stale record
cannot end a sign-in made after it, in this tab or another, even by the same
account. The sign-out request itself also compares session ids before
revoking with a renewed token.

**Cross-tab.** Records are shared by every tab of the origin. A tab that
reloads after another tab's failed sign-out completes it first. A tab that
missed the sign-out announcement and still holds the session ends it at its
next refresh instead of renewing it. Completion in several tabs at once is
safe: each request is settled with `revoked` or `absent`, and none sets a
cookie. When a sign-in races a completion, the completion carried either the
old cookie (and revoked only the old session) or the new one (and is told
`superseded`); the recovery route never touches the cookie, so it cannot
overwrite the new one.

**Bounds.** At most eight records per API are kept, oldest dropped first:
signing out again needs a new sign-in, which replaces the cookie, so older
records can no longer match it. A record expires eight days after it was
written (the seven-day refresh-token lifetime plus a day). No tab renews a
recorded session, and the cookie-based fallback renews the record whenever it
renews the cookie, so an expired record names a session that can no longer be
used from this browser.

**Limits.** Without localStorage (blocked, or quota exhausted) nothing is
durable and a failed sign-out behaves as before. While a record cannot be
settled, page loads stay signed out until the server is reachable or the user
signs in again. `superseded` and `absent` do not revoke the old family on the
server; it stays valid until it expires, but this browser no longer holds a
cookie for it. Tabs still running an earlier build ignore records. OIDC
completion, invitation redirects and the cookie rules above are unchanged.
