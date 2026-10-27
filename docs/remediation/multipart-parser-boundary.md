# Multipart parser security release

The production multipart plugin now resolves `@fastify/busboy` 3.2.1 instead
of 3.2.0. The maintainer's [security release](https://github.com/fastify/busboy/releases/tag/v3.2.1)
fixes [GHSA-xjh9-v7x6-24jw](https://github.com/fastify/busboy/security/advisories/GHSA-xjh9-v7x6-24jw)
and [GHSA-x8mw-p69m-v3mx](https://github.com/fastify/busboy/security/advisories/GHSA-x8mw-p69m-v3mx),
which affect malformed multipart parsing. Earlier local audit evidence established
the affected resolution and its failure behavior.

`@fastify/multipart` 9.4.0 supports `@fastify/busboy` ^3.0.0. A parent-specific
pnpm override selects this compatible security patch; its generated lockfile
changes only that resolution and dependency edge. Importers and unrelated package
versions remain unchanged. The original prepared branch is preserved separately.

All multipart consumers use this plugin: generic avatar/wiki uploads, Drive
uploads, and backup upload/preview/import. Authentication precedes parsing in
these routes. The component advisory alone does not establish an anonymous
application authorization failure.

Regression tests resolve the actual production plugin's parser, enforce the
patched supported release, and retain Unicode fields across fragmented valid
multipart input at the smallest and largest RFC boundary lengths. Actual
Fastify/PostgreSQL compatibility tests retain legitimate avatar/wiki bytes,
configured size limits, denied-request storage bytes, authentication, and
subsequent successful uploads.

Run `pnpm test` and, after migrating a designated disposable PostgreSQL database,
`TEST_DATABASE_URL=<disposable-url> pnpm test:integration`.

The separate [GHSA-gxm5-99cw-xjw9](https://github.com/fastify/busboy/security/advisories/GHSA-gxm5-99cw-xjw9)
requires 3.2.2 or later and remains an immediate follow-up patch. Its override
must move or be removed when that fix lands. Other dependency advisories,
multipart resource budgets, active-content serving, and backup correctness
remain open in their own remediation packages.
