# Public share password grants

Wiki and Drive share passwords are enforced by the server. A protected public GET
returns a locked response without page content, file names, file IDs or creator
metadata until the visitor verifies the password. Unprotected links continue to
work without verification. Existing share tokens and passwords remain valid.

The public endpoints are:

- `GET /api/public/wiki/:token`
- `POST /api/public/wiki/:token/validate`
- `GET /api/public/files/:token`
- `POST /api/public/files/:token/validate`
- `GET /api/public/files/:token/:fid/download`

Successful verification sets a host-only, HttpOnly cookie containing a signed
grant. Its lifetime is at most 30 minutes and cannot exceed a Drive link's
expiration. The signature binds the share kind, database identity and credential
revision. Public content and download requests check the current enabled,
password, revision and applicable expiration state. A cookie from another share
or the other share kind grants no access.

Password, enabled and expiration updates advance `updatedAt` monotonically using
a database compare-and-swap. Concurrent updates retry with a fresh revision; five
conflicts return HTTP 409 and leave the requested changes unapplied. Password
verification that observes a revision change while checking the password also
returns 409 without issuing a cookie. Removing a password intentionally makes the
link public; adding one requires verification. Disabling and re-enabling a link
does not restore an old grant. Deletion and recreation create a different share
identity. An already authorized response or previously downloaded content cannot
be revoked retroactively.

Authenticated share-management responses expose `hasPassword` instead of
`passwordHash`. Their existing workspace, current-role, creator/administrator and
source-access rules still apply. The frontend uses the server's `authorized`
response, refetches after verification and discards public query data when the
route unmounts.

## Hosting and cookie paths

The grant cookie deliberately omits the `Path` attribute. Browsers derive its path
from the external verification request. A POST to
`/edge/api/public/files/T/validate` therefore stores the cookie at
`/edge/api/public/files/T`, covering the metadata and nested download requests.
This supports a configured `VITE_API_BASE_URL` and reverse-proxy prefix rewriting
without trusting forwarded path headers or sending all share grants on every API
request. Keep the verification endpoint directly beneath the share path. The
signature and current database state establish authorization; cookie paths alone
do not.

Requests use the existing `credentials: include` client contract. `COOKIE_SECURE`
and `COOKIE_SAMESITE` retain their existing behavior. Cross-site hosting still
requires compatible HTTPS, SameSite and explicit credentialed CORS settings and
is subject to browser third-party cookie policy. No proxy-trust setting changes
are part of this fix.

Public success and error responses use `Cache-Control: private, no-store` and
`Pragma: no-cache`. Each password-validation route allows ten requests per minute
per client IP. Its route-specific limiter replaces the plugin's global bucket;
the two limits do not run together. A reverse proxy can aggregate clients at its
IP under the existing transport configuration.

Wiki embedded media retains its existing storage authorization. A public page
grant does not confer workspace membership or widen static-file access. Public
Wiki media delivery requires separate asset-scoped work.

## Regression checks

Run the normal unit, integration, type and build gates. The focused suites are
`packages/backend/tests/integration/public-share-passwords.test.mjs` and
`packages/frontend/src/routes/-public-sharing.test.tsx`. They retain the original
A06 regression family and add actual PostgreSQL row-lock contention, fixed-clock
revision changes, retry exhaustion, verification overlap, token-switch and
refetch-failure cases.

The PostgreSQL concurrency fixture has an explicit connection budget. Its
application pool defaults to four actor connections, or retains an explicitly
supplied `connection_limit=4` or `connection_limit=5` in `TEST_DATABASE_URL`.
Other explicit pool sizes are rejected for this fixture. A separate Prisma pool
has two control connections: one holds the row lock and the other observes
`pg_stat_activity`. Thus the default fixture uses at most six connections; the
five-connection application case uses at most seven. The test prints the requested
and effective budgets. It does not run with five total connections or silently
raise a supplied application limit. All four Drive UPDATEs must be observed
waiting on real PostgreSQL locks before release. The existing five-second wait
bound and ten-second held-transaction timeout are unchanged. Cleanup releases the
holder and awaits both its transaction and every actor, including rejected-lock
paths, before disconnecting the pools and removing fixtures. The Wiki fixture
deliberately rolls back its control holder while Drive commits, covering both
outcomes without changing the blocked-writer or credential assertions.

The opt-in browser fixture uses an installed Playwright package and Chromium,
plus OpenSSL for a disposable self-signed HTTPS certificate. The isolated browser
allows that local certificate and disables back/forward document caching; it does
not alter application transport settings. Set
`TEST_DATABASE_URL` to a migrated disposable loopback database whose name starts
with `werkyn_audit_`. Set `PLAYWRIGHT_MODULE` to the installed package name or
absolute module path, then run from the backend package:

```sh
node --import tsx tests/browser/public-share-passwords.mjs
```

The fixture caches its production frontend builds by source and API base. An
already built default frontend can be supplied with
`PUBLIC_SHARE_BROWSER_DEFAULT_DIST` to avoid rebuilding it. It runs the actual
frontend client and public pages at default HTTP
`/api` and HTTPS with a rewritten `/edge/werkyn/v1` prefix. It checks browser-stored
cookie paths, actual request headers, matching downloads, independent visitors,
reload, revalidation, rotation, disable/expiry, unprotected links and cookie-header
isolation after visiting several shares. It creates only uniquely named owned
fixtures and removes its database rows and local storage afterward. It does not
contact external identity, mail or storage services. Download headers are observed
at the backend when Chromium diverts a download before Playwright exposes its
request event. Navigation uses the existing browser router, with explicit reload
checks in both hosting modes.
