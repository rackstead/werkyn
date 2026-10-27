# Avatar ZIP detection security release

The avatar upload handler buffers at most 5 MiB and passes the bytes to
`fileTypeFromBuffer` before checking its image allowlist, so every workspace
member can reach the detector's ZIP probing with any upload that starts with a
ZIP local file header. In `file-type` 20.0.0 through 21.3.1, known-size inputs
(buffers, blobs and files) inflated the probed `[Content_Types].xml` and
`mimetype` entries without an output limit. A ZIP of a few KiB could make one
detection allocate megabytes, and a 5 MiB upload could expand by roughly three
orders of magnitude (GHSA-j47w-4g3g-c36v, CVE-2026-32630). The backend now
requires `file-type` >=21.3.2 within 21.x; the lock resolves 21.3.2.

The [upstream 21.3.2 release](https://github.com/sindresorhus/file-type/releases/tag/v21.3.2)
applies the existing 1 MiB stream limit to known-size inputs, bounds
data-descriptor reads and ZIP entry counts, and bounds recursive BOM/ID3
detection. Its dependencies and Node engine are unchanged. Application
authorization, size limits, detected extension, allowed image formats and
storage behavior are unchanged.

Ordinary DOCX, XLSX, PPTX, ODT and plain ZIP files keep their detected types,
whether written with local-header sizes or with data descriptors. Avatar uploads
still reject them without storing anything, and wiki uploads still store them
byte for byte with their own extension. A probed text entry of up to 1 MiB is
still read. Above that, detection now reports a generic `application/zip`
instead of the document type; the avatar allowlist rejects both, and wiki
uploads do not use detection.

`tests/file-type-security.test.mjs` checks the installed minimum version, image
and ZIP-based document detection, the 1 MiB boundary and that a small ZIP whose
content-types entry inflates to 8 MiB is no longer fully inflated. The bounded
fixtures stay under 16 KiB compressed and at most 8 MiB inflated.
`tests/integration/upload-zip-detection.test.mjs` exercises the real upload
route. Run `pnpm test`, and run the upload tests on a migrated disposable
database with `TEST_DATABASE_URL=<disposable-url> pnpm --filter @pm/backend exec
node --import tsx --test tests/integration/upload-zip-detection.test.mjs`.

Later 21.3.x hardening releases, other dependency advisories, native image
decoding, aggregate resource budgets and broader C01 release gates remain
separate.
