# Private uploaded media

Uploaded avatars and wiki media keep their canonical stored URLs. Authenticated
rendering fetches the bytes from the configured API and owns temporary object
URLs; it does not persist credentials or rewrite page content. Remote URLs do
not receive the API bearer token.

A public wiki share can read only media referenced by an image, audio, video or
file block in that current page, including nested blocks, in the same workspace.
Text, captions, another page and historical versions do not grant access. A
protected share also requires its existing current password grant. Disabled
shares, removed references and expired or superseded grants refuse subsequent
requests. Bytes already received or downloaded cannot be recalled.

The three legacy public upload namespaces return HTTP 410. Existing private
workspace upload reads retain their bearer check, ranges and response isolation.
The new media API sniffs a bounded byte prefix: supported raster/audio/video
content with a matching extension can render; other content downloads as an
octet-stream attachment. The editor's uploaded-file download button uses an
anchor download, never a same-origin object-URL navigation for active content.

Each editor limits retained binary bytes and pending reservations to 64 MiB, with
at most two concurrent requests and existing 5 MiB avatar/25 MiB wiki object bounds.
Refused media displays an error and keeps its stored reference. This accounting
does not bound decoded browser media memory. Removal and unmount abort requests
and revoke owned URLs. An account change invalidates the editor's media owner
and hides its old media until the page is reopened, without remounting or saving
the editor document. Avatars share one bounded owner per current identity, so
repeated instances reuse one request and Blob. A live avatar's lease cannot be
revoked by another instance unmounting. After the last lease, an idle URL may
remain for at most 30 seconds for virtualization; a different reference may
evict idle entries sooner. Identity changes revoke the pool immediately.

Loading has separate finite limits: queue wait 120 seconds, active transfer
300 seconds, and inactivity 20 seconds between response/chunk progress. These
limits can visibly refuse slow media without changing the stored reference.
Legacy avatars and failed remote avatars show initials; legacy editor media
shows an unavailable message instead of requesting a retired public route.

The final UUID-and-extension filename is opaque. A literal percent spelling in
that leaf is retained; query encoding is decoded once by the API parser, with
no second decoding into a slash, backslash or different filename. Structural
path components still require their exact canonical spelling.
