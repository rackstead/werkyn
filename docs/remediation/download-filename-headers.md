# Download filename headers

Permitted Unicode filenames now work in download headers. One formatter emits a
quoted ASCII `filename` fallback followed by UTF-8 `filename*`, following
[RFC 6266](https://www.rfc-editor.org/rfc/rfc6266.html#appendix-D) and
[RFC 8187](https://www.rfc-editor.org/rfc/rfc8187.html#section-3.2.1). The fallback
substitutes nonprinting/non-ASCII characters, quotes, backslashes and percent
characters to avoid ambiguous legacy parsing. The extended parameter preserves
the actual valid Unicode filename, including spaces, quotes and literal percent
sequences. Persisted names and file contents are unchanged. Isolated UTF-16
surrogates in legacy strings become UTF-8 replacement characters in the header.

Drive, archive, public-file, attachment and backup downloads use this formatter.
Callers retain their existing attachment/inline choice, MIME type, authorization,
storage and CSP/cache settings. Fixed static disposition and time-report filename
constants remain valid without formatting. Backup's ASCII workspace-slug filename
also retains compatibility with the existing frontend filename reader.

The prior raw Unicode fallback fails
[Node's header-value validation](https://nodejs.org/download/release/v22.16.0/docs/api/http.html#httpvalidateheadervaluename-value).
Regression tests establish that defect with caught validation assertions. Actual
loopback HTTP/PostgreSQL tests run after the fix and verify permitted uploads,
renames and downloads across all dynamic writers, exact bytes and UTF-8 names,
ordinary ASCII/quotes/spaces/percent names, inline image protection, Unicode ZIP
names and unchanged denied/missing-file errors.

```sh
pnpm --filter @pm/backend exec node --import tsx --test tests/content-disposition.test.mjs
TEST_DATABASE_URL=<migrated-disposable-url> pnpm --filter @pm/backend exec node --import tsx --test --test-concurrency=1 tests/integration/download-filename-headers.test.mjs
```

This is a response-header contract fix. Attachment source/target permissions,
public-share password policy and broader response-security changes have separate
remediations. Browser save-dialog compatibility is not established by HTTP tests.
