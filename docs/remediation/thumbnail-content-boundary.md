# Drive thumbnail content signatures

Drive still stores an authorized upload's original bytes and declared MIME as
before. Thumbnail generation is optional: skipping or failing a thumbnail does
not turn a successfully stored original into a rejected upload.

The existing declared `image/` hint, declared-SVG exclusion and 32 MiB thumbnail
source cap apply before the original is read into memory. Larger images are
stored without a thumbnail. A PNG declared as an unrelated non-image type still
gets no thumbnail; an ordinary PNG declared JPEG can get one without rewriting
its stored MIME or filename.

Within that cap, thumbnail detection first checks fixed signatures at fixed
offsets: JPEG, PNG/APNG (signature followed by its IHDR chunk), GIF87a/GIF89a,
RIFF/WebP with a VP8, VP8L or VP8X chunk, and ISO files whose major brand is
`avif`. ISO candidates also require an ordinary 32-bit box size of at
least 16 bytes that fits the actual buffer and the existing source cap.
Size-to-EOF, extended-size, short and out-of-buffer forms omit the optional
thumbnail while preserving the original upload; this does not declare those
size forms globally invalid in ISO BMFF. Inputs that fail their signature check
or required ISO envelope skip the general detector, keeping the earlier
document/archive entry paths out of this upload operation. The existing
`file-type` detector must then report the same family (JPEG; PNG or APNG; WebP;
GIF; AVIF), and libvips must read the same format from the header.

TIFF/BigTIFF and the HEIC, HEIF (`mif1`/`msf1`), HEVC and AVIF sequence
(`avis`) brands were accepted here until R19 and are now stored without a
thumbnail: the bundled libheif has no HEVC decoder, libvips does not load
`avis`, and TIFF is outside the decoder allowlist. AVIF bytes declared
HEIC remain eligible. Unknown/disallowed signatures and detection/decoding
errors leave the thumbnail absent. An ordinary SVG document declared with a
raster MIME hint is stored without a thumbnail. These checks classify
signatures; they do not fully validate a file.

`r19.md` describes the decoder allowlist that libvips enforces for the whole
process, the explicit decoder options, the per-transform memory estimate and
the transform admission queue. The output is unchanged: a 400px-wide WebP at
quality 80 without enlargement, alpha kept and EXIF orientation unapplied, from
the first frame or primary image.

Destination authorization runs before storage and again in the existing locked
File transaction after thumbnail work. A rejected record transaction still
queues staged original/optional-thumbnail blobs for durable cleanup; storage
failures retain that work for retry, and a live committed File keeps its bytes.
No permission, schema, upload deadline, dependency or transaction budget
changes here. Avatar/wiki upload policy is separate.

The thumbnail integration suite checks benign dispatch boundaries with armed
ESM detector/header/transform spies, real ordinary raster/APNG output, AVIF
versus HEIF/TIFF header dispatch, source-size behavior, current authorization
and staged cleanup under actual PostgreSQL faults. Unsupported fixtures do not
execute natively; no external-reference or native vulnerability sample is
needed. Historical Sharp dependency/advisory/network measurements remain
historical.
