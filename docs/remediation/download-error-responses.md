# JSON errors after download setup

Early stream failures must select JSON before sending an error object. The handler
now resets the media type and clears Content-Disposition from Fastify pending and
Node staged headers while writable. Cache/CSP/nosniff, status/details/retry behavior
and successful download bytes/headers are preserved.

Before-fix proof captures the real handler safely: one ordinary JSON case passes,
seven binary-type cases fail. The after-fix HTTP group requires that captured JSON
contract first, so older code stops before opening a missing stream. Captured
contracts also check raw-only staged headers, committed-header protection, exact
error/detail/retry bodies and production redaction/logging. Guarded Fastify tests
cover isolated file/inline/archive failures, health and successful bytes.
The initial staged-filename failure log is retained; pending removal alone failed.

Missing blobs retain500; B02 durable repair remains separate. Partial streams retain
Fastify abort behavior; production error redaction is unchanged. Run:

```sh
pnpm --filter @pm/backend exec node --import tsx --test tests/error-response-headers.test.mjs
```
