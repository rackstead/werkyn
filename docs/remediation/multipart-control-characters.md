# Multipart metadata security release

The production multipart plugin selects `@fastify/busboy` 3.2.2 to address
[GHSA-gxm5-99cw-xjw9](https://github.com/fastify/busboy/security/advisories/GHSA-gxm5-99cw-xjw9),
as documented in the maintainer's [security release](https://github.com/fastify/busboy/releases/tag/v3.2.2).
The upstream patch corrects unwanted control characters in parsed metadata.

The parent-specific override moves from 3.2.1 to 3.2.2 within the multipart
plugin's supported range. Generated lock scope must preserve importers and
unrelated resolutions. No framework, database schema, or API policy changes.

Tests resolve the production parser and require the patched release. Benign
plugin uploads preserve ordinary/encoded Unicode filenames, field names, MIME
types and bytes. Existing PostgreSQL/HTTP tests retain authorization, limits
and stored data. Run `pnpm test` and, with a designated migrated disposable DB,
`TEST_DATABASE_URL=<disposable-url> pnpm test:integration`.

Other advisories and broader storage, streaming and backup budgets remain open.
