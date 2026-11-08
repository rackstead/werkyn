# Retired 8-character Drive share links

Public Drive share links issued before 256-bit tokens used
`crypto.randomBytes(6).toString("base64url")`. That is 8 characters, 48 bits.
Those URLs no longer open. Owners create a new link when they still want to
share the file. This note is the break. The generator, collision retry and
password hashing for new links are unchanged and are described in
[drive-share-tokens.md](drive-share-tokens.md).

Wiki share tokens and workspace invites are a different contract and are
unchanged.

## Why these links are rejected instead of hashed

The tokens were stored as issued. Plain SHA-256 at rest would not retire them:
about 2^48 SHA-256 operations can recover every 8-character value from a leaked
dump. This change does not hash old or new Drive share tokens. An 8-character
value is no longer a credential, so a copy of it, including one already in a
database backup, does not grant access.

## Public behaviour

Presenting an 8-character token is the same as presenting a token that was
never issued. `GET /api/public/files/:token`,
`POST /api/public/files/:token/validate` and
`GET /api/public/files/:token/:fid/download` return 404
`Shared files not found`, with the same cache headers. That includes a correct
password, a disabled row and an expired row. The response is not the password
challenge, not 403, and not "this share link has expired", because those would
show that the token used to exist. The public page therefore shows the same
"Share not found" state as any other unknown link.

The check is the token shape, not a list of ids. It runs before the row is
read in `findPresentedFileShareLink`, which is the only public read of a
presented Drive share token. The app Prisma client applies the same rule to
every direct `FileShareLink` read, including `count`, `aggregate` and
`groupBy`, and to relation filters on `shareLink`, `fileShareLinks` and
`fileShareLinksCreated`. `NOT` is boolean: a filter that still requires the
8-character token misses, and a single negation does not. A read that does
not ask for that token is unchanged. Listings, updates and deletes by id
still see the row. Raw SQL is outside this client and is not a public route.

There is no schema migration and no backfill. Existing rows are left in place.
Inserting another 8-character token later does not make it work.

## Owner behaviour

The row is not deleted. The management list still returns it, with the same
token, and `retired: true`. The share dialog says the public link no longer
works, does not offer copy, open, enable, password or expiry controls, and
still lets the owner remove the link. Creating a link still calls
`createFileShareLink`: 32 CSPRNG bytes, 43 base64url characters, at most three
token-collision retries, and one password hash. `retired` is false on that
response. Turning the old row back on does not restore the old URL.

## Operators

Anyone who saved an 8-character `/share/files/…` URL has to receive a new link
from the file's owner. Passwords, expiry, disable and delete on 256-bit links
are unchanged. Product documentation on werkyn.com is a follow-up in that
repository, not part of this change.
