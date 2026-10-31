# HTTP access tokens follow their sign-in session

The HTTP middleware used only the subject of a valid access JWT. A token
therefore continued to read protected data, change the profile and create
personal API keys after its refresh family ended. Database lookup failures
also became `401`, making an unavailable database look like invalid credentials.

Every HTTP authentication now checks the account and, when `sid` is present,
its family in one database statement. The family must exist, belong to that
account, have no `revokedAt`, and contain a current refresh token whose
`expiresAt` is later than the authorization check. Families have no independent
expiry column: their current token carries the sliding seven-day lifetime.

A missing, foreign, revoked, expired or tokenless family receives the same
generic `401 Invalid or expired token` before route authorization or protected
work. Logout affects its cookie's family; password login, password change and
reset end all older families of that account; refresh reuse ends its family.
Another account and newer sessions remain independent. A refused request
cannot change a profile, mint a key, or use stale logout/password-change work
to revoke a newer sign-in.

JWT signature and expiry failures, malformed subjects and malformed present
`sid` claims receive `401`. A token genuinely lacking `sid` retains the legacy
grace until its JWT expiry, at most 15 minutes after upgrading from a version
that issued such tokens. An explicit empty, null, numeric, array or object
claim never receives that grace. Access tokens must have a finite numeric
expiry; every application issuer already supplies it.

Operational failures during JWT account/family lookup or API-key verification
receive `503 Service Unavailable` with the fixed message
`Authentication is temporarily unavailable. Try again in a moment.` The server
logs `Authentication lookup failed` with a fixed lookup stage, failure category
and allowlisted Prisma/SQLSTATE codes, without the exception, messages, SQL,
connection details or credentials. Schema/query-shape faults and programming
errors receive a safe generic `500`, with bounded diagnostics, rather than a
retryable availability response. The failure ends no session and no protected
handler runs, so retrying after operational recovery remains possible.

Protected HTTP routes require a Bearer header. Query access JWTs cannot
authenticate; a supplied header remains authoritative when a query token is
present. Native PDF preview uses a separate short-lived file grant; see
[file-preview-grants.md](file-preview-grants.md). Durable `wk_` API keys also
require an Authorization header. API keys still have their own per-request
expiry/revocation checks and survive session logout and password changes or
resets. Public shares keep their separate unauthenticated grant policy.
WebSocket policy is unchanged; see [DAT-006](dat-006.md).

The middleware adds no row locks, transaction, schema change or validity cache.
Refresh rotation replaces the current token in one transaction, so an
authentication statement sees its valid predecessor or successor, never the
uncommitted delete/insert gap. Revocation sets the family flag and removes its
tokens atomically. A check after that commit is refused on every backend
instance reading the same primary database. Requests whose check already read
valid state before a concurrent revocation may finish; this does not cancel
work already authorized. Realtime termination across multiple processes
remains a separate release gate.

`tests/integration/http-session-validity.test.mjs` sends real TCP HTTP requests
to the application with PostgreSQL. Login, refresh, logout, password change,
forgot-password and reset use their actual routes; the reset token comes from
the message delivered to a loopback SMTP capture, never token storage. An
additional same-user session uses the existing OIDC session-creation primitive
and obtains its access JWT through the refresh route. Direct fixture changes
simulate elapsed time, removed rows, API-key expiry and unavailable relations;
session-ending behavior itself goes through the application APIs.

The 15 cases cover valid reads/writes, concurrent rotation/read rounds,
logout/login/change/reset/reuse revocation, unrelated/newer sessions, denied
profile and credential side effects, malformed/unknown/foreign families,
expired and removed current tokens, deleted accounts/families, legacy grace,
API keys, header-only authentication/ignored query credentials and public shares. Actual unavailable user,
family and API-key relations prove safe schema-fault `500` responses. A real
connection failure proves operational `503`; injected validation and TypeError
faults prove safe programming `500`. All refuse protected handler execution,
keep credentials out of logs and preserve recovery. The initial 14-case suite
had 11 failures on the preceding middleware. Its initial missing-table `503`
expectation was corrected to `500` when failure categories were distinguished;
the actual connection-failure check separately covers operational `503`.
The two count-query fixtures now obtain real session tokens through refresh;
their four query/count/order regression cases remain unchanged.

The benchmark smoke invokes the actual performance CLI against a bounded
fixture, using the documented signing/database variables without unrelated
cookie configuration. Its actor sessions are created before warmup/timing and
removed after success and failed requests without deleting unrelated sessions.
This proves tooling compatibility; the historical performance measurements in
`p02a.md` precede this authentication change and need a later broad remeasurement.
