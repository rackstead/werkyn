# Drive thumbnail content signatures

Drive still stores an authorized upload's original bytes and declared MIME as
before. Thumbnail generation is optional: skipping or failing a thumbnail does
not turn a successfully stored original into a rejected upload.

The existing declared `image/` hint, declared-SVG exclusion and 32 MiB thumbnail
source cap apply before the original is read into memory. Larger images are
stored without a thumbnail. A PNG declared as an unrelated non-image type still
gets no thumbnail; an ordinary PNG declared JPEG can get one without rewriting
its stored MIME or filename.

Within that cap, thumbnail detection first checks fixed raster-family offsets
in the first 12 bytes: JPEG, PNG/APNG, GIF, TIFF/BigTIFF in either byte order,
RIFF/WebP and the AVIF/HEIF brands recognized by the pinned detector. ISO
candidates also require an ordinary 32-bit box size of at least 16 bytes that
fits the actual buffer and the existing source cap. Size-to-EOF, extended-size,
short and out-of-buffer forms omit the optional thumbnail while preserving the
original upload; this does not declare those size forms globally invalid in ISO
BMFF. Inputs that fail their family header check or required ISO envelope skip
the general detector, keeping the earlier document/archive entry paths out of this
upload operation. The existing
`file-type` detector then must report one of:

- JPEG, PNG, APNG, WebP, TIFF or GIF;
- AVIF, HEIF, HEIF sequence, HEIC or HEIC sequence.

Only then does the existing Sharp pipeline make a 400px-wide WebP at quality 80,
without enlargement. Unknown/disallowed signatures and detection/decoding errors
leave the thumbnail absent. An ordinary SVG document declared with a raster MIME
hint is stored without a thumbnail. These checks classify
signatures; they do not fully validate a file or guarantee native safety for all
malformed or polyglot inputs.

Existing format behavior stays in place, including alpha, the decoder's default
frame/image selection, the unrotated EXIF behavior and native pixel/channel defaults. AVIF bytes
declared HEIC remain eligible; the installed codec can still refuse actual
unsupported HEIF compression, leaving its original intact.

Destination authorization runs before storage and again in the existing locked
File transaction after thumbnail work. A rejected record transaction still
queues staged original/optional-thumbnail blobs for durable cleanup; storage
failures retain that work for retry, and a live committed File keeps its bytes.
No permission, schema, upload deadline, dependency, native-global setting or
transaction budget changes here. Avatar/wiki upload policy is separate.

The thumbnail integration suite checks benign dispatch boundaries with armed
ESM detector/transform spies, real ordinary raster/APNG output, HEIF/TIFF header
compatibility, source-size behavior, current authorization and staged cleanup
under actual PostgreSQL faults. Unsupported fixtures do not execute natively;
no external-reference or native vulnerability sample is needed. Historical
Sharp dependency/advisory/network measurements remain historical.

Transform CPU, aggregate memory/concurrency admission, cancellation and revised
pixel policy still require declared-hardware measurements and a separately
approved plan. Audit R19/P03 and broader release gates remain open.
