# Embedded Dex lifecycle, database TLS and proxy

A missing or non-executable `DEX_BINARY_PATH` used to crash the whole server with an
unhandled child-process `error` event as soon as SSO was enabled. The failure is now
logged, the proxy answers `/dex` with 503, and the start is retried with a backoff that
doubles from 2 s up to 60 s. Start, settings-save restarts and shutdown run one at a
time, so racing saves cannot leave two Dex processes or apply an older configuration,
and a stop during a restart leaves Dex stopped. Stopping sends SIGTERM, then SIGKILL
after 5 s, and waits for the exit before another Dex starts.

Dex's PostgreSQL TLS mode now follows `sslmode` in `DATABASE_URL`, so Dex requires TLS
whenever Werkyn is told to:

| `sslmode` in `DATABASE_URL` | Dex `ssl.mode` |
| --- | --- |
| none, `disable`, `allow`, `prefer` | `disable` (the bundled Compose database has no TLS) |
| `require` | `require` (`verify-full` with Prisma's `sslaccept=strict`) |
| `verify-ca`, `verify-full` | the same mode |
| anything else | Dex is not started and the error is logged |

Dex's driver cannot fall back between TLS and plaintext, so modes that let Werkyn fall
back to plaintext (`prefer`, or no `sslmode`, which Prisma treats as `prefer`) keep Dex on
plaintext. To require TLS for a remote database, add `sslmode=require` (or a `verify-*`
mode) to `DATABASE_URL`. The certificate to trust is `sslrootcert` or, in Prisma's
format, `sslcert`; it becomes Dex's `caFile`. A libpq client certificate given as
`sslcert` with `sslkey` becomes Dex's `certFile` and `keyFile`. Prisma's PKCS12
`sslidentity` cannot be used by Dex and stops it from starting with a logged error.
Relative paths resolve against `packages/backend/prisma`, as they do for Prisma.

The generated `dex-config.yaml` contains the Dex client secret and, with PostgreSQL
storage, the database password. It is written to a new owner-only (0600) file and renamed
into place, so a previously world-readable file is replaced as well.

The `/dex` proxy forwards request bodies of any media type byte for byte, within the
normal body limit, so Dex's HTML login forms work. Malformed percent-escapes in the
request target return 400, and a Dex that refuses or resets the connection returns 502
instead of 500.

Run `pnpm --filter @pm/backend test` for the regressions in `tests/dex-manager.test.mjs`
(using a stand-in Dex binary), `tests/dex-config.test.mjs` and `tests/dex-proxy.test.mjs`
(using a stand-in Dex server).
