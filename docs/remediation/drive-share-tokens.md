# Drive share-link tokens

Public Drive share links (`/share/files/:token`, `/api/public/files/:token`)
are bearer secrets: anyone holding the URL reaches the link's files, subject to
the link's password, enabled state and expiry. This note covers how new tokens
are generated and stored, and what happens to links issued before the change.
Wiki share tokens (`randomUUID`, 122 random bits) are a separate contract and
are unchanged.

## Before

- `createFileShareLink` used `crypto.randomBytes(6).toString("base64url")`:
  8 characters from the 64-character base64url alphabet, so 6 bytes = 48 bits.
- The token was stored as issued (plaintext) in `FileShareLink.token`, a `text`
  column with the unique index `FileShareLink_token_key` (plus a redundant
  non-unique `FileShareLink_token_idx`). Every public read looks the link up by
  equality on that column.
- One insert per request. A duplicate token surfaced as Prisma `P2002` and the
  global handler answered `409 A record with these values already exists`, so a
  collision failed the request instead of drawing a new token.

## New tokens

- New links use `crypto.randomBytes(32).toString("base64url")`: 43 characters,
  256 bits from the CSPRNG. The alphabet is still `A-Z a-z 0-9 - _` with no
  padding, so the token needs no URL encoding and the frontend route
  `/share/files/$token`, copy/open URLs, download URLs and the grant cookie name
  (a SHA-256 digest of the token) work unchanged. Nothing in the frontend
  depended on the 8-character length, so it has no change.
- Insertion is tried at most three times. Only a `P2002` on `FileShareLink`
  whose target is exactly the token column (`["token"]`, or the constraint name
  `FileShareLink_token_key`) draws a new token. Every other error propagates
  unchanged on the first attempt, including the other unique constraint on this
  write (a duplicate `fileId` in the request violates
  `FileShareLinkFile(shareLinkId, fileId)` and keeps its existing generic 409),
  foreign-key, access and password-hashing errors.
- After three token collisions the request fails with
  `409 Could not create a unique share link; please try again` and the server
  logs `file_share_link_token_exhausted`. With 256-bit draws this only happens
  if the random source is broken.
- An optional password is hashed once, before the first attempt; retries reuse
  that hash instead of repeating the Argon2id work.
- Each attempt is one nested Prisma create of the link and its
  `FileShareLinkFile` rows. Prisma runs it as a single transaction, so a failed
  attempt (collision or otherwise) leaves neither a link nor join rows.

## Storage decision: tokens stay as issued

New tokens are stored as issued in the same column; there is no schema change
or migration. Reasons:

- The share dialog lists a file's existing links and lets the creator, and
  workspace administrators, copy or open each link's URL at any time. That needs
  the token. Hashing it would make a link's URL unrecoverable once the creation
  response is gone (a show-once flow, as used for password-reset links), which
  is a product change rather than an entropy fix. Workspace invites and wiki
  shares use the same redisplayable, stored-as-issued model.
- The token lookup is a database index equality on the presented value. No
  application code compares a stored token with a presented one, so there is no
  token comparison to make constant-time. The secrets that are compared in
  application code keep their existing constant-time checks: share passwords use
  Argon2id/bcrypt verification and password grants use an HMAC compared with
  `timingSafeEqual`.

Consequence: anyone who can read the database, including its backups, can use
every live Drive link (and still needs the password of a protected link).
Protect database dumps like other credentials, and disable or delete a link to
revoke it. Hashing share tokens at rest for Drive, wiki and invites together,
with a show-once UI, a migration and a dual lookup for existing links, would be
a separate product decision.

## Existing links

The entropy change above did not rotate or invalidate links that already
existed. A later change does. Eight-character tokens no longer grant access;
the rows stay so owners can see and remove them, and new links are still the
256-bit tokens described here. See
[legacy-share-tokens.md](legacy-share-tokens.md). Running older code against a
database that already holds 43-character tokens still works, because that
lookup treats the token as an opaque string. The current application does not
treat an 8-character token as one.

## Tests

`packages/backend/tests/integration/drive-share-tokens.test.mjs` runs against
real PostgreSQL through the HTTP routes (Fastify inject):

1. Twelve links created over HTTP each get a 43-character token that decodes to
   exactly 32 bytes, re-encodes canonically, needs no URL encoding and equals the
   single 32-byte CSPRNG draw made for it; the stored row holds the same value
   and the response has no password hash.
2. A forced first draw equal to an existing link's token (rows with both an
   8-character and a 43-character token exist) hits the real unique index; the
   request retries once with a fresh draw and returns 201, the password is
   hashed once, existing rows are unchanged and the new link has exactly its
   two files. The 8-character row does not open. The 43-character row does.
3. Three forced collisions return the controlled 409 after exactly three draws
   and one password hash, with no link or join rows written.
4. A duplicate `fileId` (the other unique constraint) is not retried: one draw,
   the existing 409, nothing written.
5. Links with 8-character tokens used to resolve, with the same password,
   grant, disable and delete behaviour as a new link. That case now expects
   them to miss like an unknown token. See
   [legacy-share-tokens.md](legacy-share-tokens.md).
6. Newly created unprotected and protected links pass the same public access,
   password grant and revocation sequence.

Before the 256-bit change, cases 1, 2, 3 and 6 failed (8-character tokens; a
real collision returned 409 instead of retrying; one attempt with the generic
message) and case 4 passed as a control. Case 5 fails on that older behaviour
as well, because an 8-character token must not open. Retrying any unique
conflict fails case 4; hashing the password per attempt fails cases 2 and 3.

The entropy check is by construction (the token is the full 32-byte draw), not
a statistical test of the random source. Collisions are forced by substituting
the CSPRNG output with an existing row's bytes so that PostgreSQL raises a
genuine unique violation; nothing fabricates a Prisma error.
