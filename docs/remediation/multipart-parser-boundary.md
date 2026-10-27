# Multipart parser boundary CPU loop

The multipart plugin resolves `@fastify/busboy` 3.2.1 instead of 3.2.0. This is
the minimum upstream security release fixing
[GHSA-xjh9-v7x6-24jw](https://github.com/fastify/busboy/security/advisories/GHSA-xjh9-v7x6-24jw).
A fragmented 252-byte boundary could make the parser's search skip distance wrap
to zero and block the Node.js event loop. The
[upstream fix](https://github.com/fastify/busboy/commit/632a237e7fb6b3b7a30e0de8fab2ee72ca5bf722)
widened the search table so its maximum distance remains representable.

`@fastify/multipart` 9.4.0 declares `@fastify/busboy` ^3.0.0, so 3.2.1 satisfies
its supported range. A parent-specific pnpm override selects this exact patch;
the generated lockfile changes only that parser resolution and dependency edge.
The repository uses pnpm 9.15.0. Its attempted named indirect update left the old
parser selected and refreshed unrelated peers, so that generated attempt was
reverted before generating this scoped override lockfile. No framework/plugin
major, direct application dependency, or unrelated package was upgraded.

All application multipart consumers share this plugin: generic avatar/wiki
uploads, Drive uploads, and backup upload/preview/import. These application routes
authenticate the caller before handlers consume multipart data; the
component advisory's generic unauthenticated impact should not be interpreted as
a demonstrated unauthenticated bypass of those application guards.

The regression resolves the production plugin's actual parser and sends the
upstream fragmented-prefix trigger in a separate process capped at 64MiB heap,
with a two-second external deadline and SIGKILL. Version 3.2.0 hits the deadline;
3.2.1 completes. The inseparable same-release
[prototype-header fix](https://github.com/fastify/busboy/security/advisories/GHSA-x8mw-p69m-v3mx)
also has a bounded child-process regression. Neither malformed input runs inside
the main test runner's event loop. Real PostgreSQL/HTTP compatibility tests retain
valid avatar/wiki bytes, exact configured limits, oversized 413 responses,
unauthenticated 401 responses, unchanged stored data on denial, and subsequent
server responsiveness.

Run `pnpm test` and, after migrating an explicitly selected disposable PostgreSQL
database, `TEST_DATABASE_URL=<disposable-url> pnpm test:integration`.

Fresh audits remove the two 3.2.1 advisories. Other dependency advisories remain
open. In particular,
[GHSA-gxm5-99cw-xjw9](https://github.com/advisories/GHSA-gxm5-99cw-xjw9)
still affects 3.2.1 and requires a separate tested patch upgrade; the exact override
must move or be removed as that remediation lands. This staged change does not
accept that residual risk or complete the dependency audit. Broader multipart
resource budgets, upload authorization and backup correctness have separate fixes.
