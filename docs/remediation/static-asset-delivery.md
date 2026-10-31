# Frontend static delivery and API request quotas

Production frontend documents and build assets no longer spend the API's
100-request-per-minute IP bucket. The exemption applies only to canonical
GET/HEAD requests matched by the frontend file route. Known API, authentication,
Dex, storage and upload routes retain their existing global or route-specific
limits. A query parameter containing an asset path does not change the route's
policy. Missing reserved server paths remain errors rather than SPA documents.

Existing successful frontend assets in `assets/` whose names follow Vite's
`name-[hash:8].ext` output convention receive
`Cache-Control: public, max-age=31536000, immutable`. The same policy applies to
HEAD, range and conditional 304 responses. This recognizes packaged Vite output
names; the server does not cryptographically recompute a filename's hash and no
manifest is introduced. Deployment must preserve this naming contract and change
the filename whenever compiled bytes change.

HTML, including `index.html`, directory index documents and SPA fallback
responses, and unhashed public files receive
`Cache-Control: public, max-age=0, must-revalidate`. Thus a browser checks the
current document instead of retaining references to a previous deployment's
chunks. Missing asset paths, including missing JavaScript chunks, return a JSON
404 with `Cache-Control: no-store` instead of an HTML success. Noncanonical
targets do not gain the quota exemption or immutable caching.

The upload roots retain their existing authentication/tenant checks and
untrusted-content policy: private/no-store, sandbox CSP, nosniff, and attachment
disposition for active content. Private downloads, shares, API authentication and
their endpoint-specific limits are outside the frontend exception.

The focused production-mode regression fixture creates public build files in an
isolated temporary root and serves them through the real application over TCP.
It checks public requests beyond the API quota, an untouched 100-request API
bucket and its 429, authentication route limits, cache distinctions, HEAD/range/
304 behavior, missing assets, malformed/reserved paths, and workspace upload
membership and response policy. Run it against a migrated disposable database:

```sh
TEST_DATABASE_URL=<disposable-url> pnpm --filter @pm/backend exec node --import tsx --test tests/integration/frontend-static-delivery.test.mjs
```

The seven new cases produced six expected failures before this change: the
101st frontend request received 429, fingerprinted assets had zero cache age,
missing chunks and reserved-path variants returned the SPA document, and the
requested cache policy was absent. The private-upload control already passed.
After the change all seven pass; together with the existing static path,
workspace upload-root and untrusted-content suites, 26 focused cases pass.
Backend typechecking, including performance scripts, also passes.

This change does not add compression, minimum transfer rates, proxy admission,
or cross-process rate-limit state. Those remain separate operational choices.
