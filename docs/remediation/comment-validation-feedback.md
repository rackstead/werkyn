# Comment validation feedback

Comment creation and editing display a body-validation reason from a structured
400 `ApiError`, for example when text exceeds the existing 10,000-character
server limit. The toast labels the reason `Comment:`. Only a nonblank string
message on an own `body` detail is used; malformed or unrelated details and
other errors retain the operation's generic failure message. Raw server,
network and native error messages are not used as fallbacks.

Each failed operation produces one hook toast. Request bodies, mentions,
control-character normalization, strict server validation, cache invalidation
and success callbacks are unchanged. A rejected create keeps its draft; a
rejected edit keeps the editor and typed text. Content is cleared or the
editor closes only after a successful response.

The ordinary regression cases cover both body-validation messages, safe
fallbacks, unchanged successful payloads and cache behavior, and real comment
callers retaining an ordinary overlength draft after rejection. These are
component and mocked-transport checks, not browser or production-data proof.
