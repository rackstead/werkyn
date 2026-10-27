# Avatar file detection security release

The avatar upload handler detects bytes with `fileTypeFromBuffer` before checking
its image allowlist. That later check does not protect the detector itself. The
backend now requires `file-type` >=21.3.1 within21.x; the lock resolves21.3.1.

The [upstream21.3.1 release](https://github.com/sindresorhus/file-type/releases/tag/v21.3.1)
fixes GHSA-5v7r-6r5c-r473. Application authorization, size limits, detected extension,
allowed image formats, storage behavior and the Node engine remain unchanged.

Repository tests check the installed minimum version, harmless tiny PNG/JPEG/GIF/
WebP detection and ordinary text/SVG rejection. Existing upload HTTP/database tests
cover authority and storage paths. No crash or denial-of-service input is executed.
Run `pnpm test`; run upload tests on a migrated disposable database with
`TEST_DATABASE_URL=<disposable-url> pnpm --filter @pm/backend exec node --import tsx
--test tests/integration/upload-authorization.test.mjs`.

The separate known-size ZIP probing issue is fixed by the 21.3.2 update described
in [file-type-zip-security.md](file-type-zip-security.md).
Other dependency advisories, native image decoding, aggregate resource budgets,
container modernization and broader C01 release gates remain separate.
