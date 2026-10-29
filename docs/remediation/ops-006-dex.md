# Embedded Dex lifecycle, database TLS and proxy

A missing or non-executable `DEX_BINARY_PATH` used to crash the whole server with an
unhandled child-process `error` event as soon as SSO was enabled. The failure is now
logged, the proxy answers `/dex` with 503, and the start is retried with a backoff that
doubles from 2 s up to 60 s. Start, settings-save restarts and shutdown run one at a
time, so racing saves cannot leave two Dex processes or apply an older configuration.
A stop cancels the restarts requested before it, so a stop during a restart leaves Dex
stopped, and a `start` after the stop starts Dex again. Stopping sends SIGTERM, then
SIGKILL after 5 s, and waits up to 2 s more for the exit before another Dex starts (if it
still has not exited, an error is logged and the queue moves on).

Dex's PostgreSQL TLS mode now follows `sslmode` in `DATABASE_URL`, so Dex requires TLS
whenever Werkyn is told to:

| `sslmode` in `DATABASE_URL` | Werkyn (Prisma 6.19) | Dex `ssl.mode` |
| --- | --- | --- |
| none, `disable`, `allow`, `prefer` | plaintext for `disable`, otherwise `prefer` | `disable` (the bundled Compose database has no TLS) |
| `require` | TLS required, certificate not checked | `require` |
| `require` with `sslaccept=strict` | TLS required, certificate verified | `verify-full` |
| `verify-ca`, `verify-full`, `REQUIRE` | `prefer`: Prisma only knows lowercase `disable`, `prefer` and `require` | the same mode, so only Dex requires TLS |
| anything else | `prefer` | Dex is not started and the error is logged |

Dex's driver cannot fall back between TLS and plaintext, so modes that let Werkyn fall
back to plaintext (`prefer`, or no `sslmode`, which Prisma treats as `prefer`) keep Dex on
plaintext.

To require verified TLS for both Werkyn and Dex, use

```
sslmode=require&sslaccept=strict&sslcert=/path/to/ca.pem
```

Prisma then requires TLS and checks the server certificate against `ca.pem`, and Dex gets
`verify-full` with the same file as its `caFile`. Without a CA file, both check against
the system's trusted CAs. A `verify-ca` or `verify-full` mode only makes Dex
verify: Prisma treats it as `prefer` and connects in plaintext to a server without TLS.
`sslmode=require` on its own requires TLS on both connections but checks no certificate.

Dex is stricter than Werkyn in two cases, and both fail closed:

- A CA file with plain `sslmode=require`: Prisma does not check the certificate unless
  `sslaccept=strict` is set, but Dex's driver treats `require` with a CA file as
  `verify-ca`. A CA file that does not match the server stops Dex while Werkyn connects.
- `verify-*` and uppercase modes, as in the table.

The certificate to trust is `sslrootcert` or, in Prisma's format, `sslcert`; it becomes
Dex's `caFile`. Prisma itself ignores `sslrootcert`. A libpq client certificate given as
`sslcert` with `sslkey` becomes Dex's `certFile` and `keyFile`. Prisma's PKCS12
`sslidentity` cannot be used by Dex and stops it from starting with a logged error.
Relative paths resolve against `packages/backend/prisma`, as they do for Prisma.

Each of `sslmode`, `sslaccept`, `sslcert`, `sslrootcert`, `sslkey` and `sslidentity` may
appear only once. Prisma uses the last of repeated values, and Dex used to take the
first, so `sslmode=disable&sslmode=require` gave Werkyn TLS but left Dex in plaintext.
Prisma does not document how it reads repeated parameters. Dex therefore does not start
with such a URL, and logs `DATABASE_URL gives "sslmode" more than once`. Remove the
duplicate to start it. This applies only with `DEX_STORAGE_TYPE=postgres`; SQLite storage
does not read `DATABASE_URL`.

The generated `dex-config.yaml` contains the Dex client secret and, with PostgreSQL
storage, the database password. It is written to a new owner-only (0600) file and renamed
into place, so a previously world-readable file is replaced as well.

The `/dex` proxy forwards request bodies of any media type byte for byte, within the
normal body limit, so Dex's HTML login forms work. It does not forward `Authorization`
or the hop-by-hop headers `Keep-Alive`, `Upgrade`, `TE`, `Proxy-Connection` and `Expect`.
The upstream client used to refuse `Keep-Alive`, `Upgrade` and `Expect`, which turned
such requests into a 502. Node has already answered `Expect: 100-continue` before the
body is forwarded. A request target that is not a path (an absolute URL such as
`http://host/dex/auth`) and malformed percent-escapes return 400. A Dex that refuses or
resets the connection returns 502 instead of 500.

Run `pnpm --filter @pm/backend test` for the regressions in `tests/dex-manager.test.mjs`
(using a stand-in Dex binary), `tests/dex-config.test.mjs` and `tests/dex-proxy.test.mjs`
(using a stand-in Dex server).
