# Cookie-safe SSO completion prerequisite

An opt-in OIDC attempt can retain proof that its callback actually succeeded and
obtain the normal session response without a second cookie rotation. This is a
server prerequisite for durable failed-sign-out recovery. The frontend's current
hydration, SSO buttons and completion page are not changed here; R07 remains open.

## Request and proof

Start with the existing `GET /api/auth/oidc/login` parameters plus optional
`client_attempt=<UUID>`. The UUID only correlates an explicit client action. It
is not a credential or proof that a provider sign-in succeeded.

For opt-in requests, the existing signed HttpOnly per-state cookie first carries
a pending phase. Only a successful callback, after the existing browser binding,
single-use state, PKCE, nonce and ID-token signature checks, can replace it with
a signed completed phase bound to that state, attempt and issued session family.
The callback's normal refresh cookie and redirect URL retain their behavior.
There is no URL proof, new cryptographic format, key, schema or persistence table.

Pending state retains its 600-second lifetime, host-only scope, HttpOnly/Secure
settings, SameSite=Lax and `/api/auth/oidc` path. Completed proof uses the same
cookie slot/path, expires after 60 seconds, remains signed/HttpOnly/host-only,
and uses the configured refresh-cookie SameSite mode and Secure setting.
Completed proof is never accepted as pending state or as a bearer access token.
A callback presenting completed proof rejects replay without deleting its marker.
For valid opt-in pending proof, only a callback that uniquely claimed its state
can clear it on failure/cancel; a losing callback or request missing a code sends
no deletion. Rejected pending proof may expire naturally. The legacy, null,
invalid or unowned credential path retains its immediate named-cookie clear;
older responses from that path are outside the marker-preservation guarantee.
No failure creates success proof.

Then send `POST /api/auth/oidc/complete-session` with credentials included,
`Content-Type: application/json`, `X-Werkyn-OIDC-Completion: 1`, and exactly
`{ "attemptId": "<UUID>" }`. The actual Origin must exactly match the configured
frontend origin or an explicit CORS origin. Browsers must pass preflight too.
No JWT, API key or attempt UUID replaces the signed completed cookie AND the
current active refresh cookie for that exact unrevoked family.

Retained rotated-token records can authorize targeted sign-out recovery, but
cannot mint access here. Missing, expired, retired, mismatched or ambiguous proof
returns a fixed 409 with no session response. Origin/header denial is 403,
non-JSON 415, invalid strict body/malformed JSON 400. Other failures retain the
existing error-handler policy and never become authenticated success.

## Response and consistency

Success returns only the ordinary refresh response shape:
`{ "data": { "user": ..., "accessToken": ..., "workspaces": ... } }`.
The user contains exactly id, email, displayName, avatarUrl, jobTitle, phone,
timezone and emailVerified from the current database row. Memberships use the
existing workspace helper. JWT subject, email and sid come from the matched
token/family/user; no password, provider record or profile from the cookie is
authority. The existing composite ownership constraint and explicit ID checks
bind all three records.

The endpoint reads the active unexpired token of the exact proved family before
selecting profile/memberships. It never locks a family row, writes database state,
creates a refresh session, rotates a token, revokes a family or renews refresh
expiry. It rechecks both marker and token expiry after awaited reads before
signing the access JWT. Existing 15-minute access and 7-day refresh policies stay
unchanged. A concurrent later revocation remains authoritative on subsequent
HTTP/WS use; this does not cancel already-admitted work.

EVERY completion POST outcome omits `Set-Cookie`: no set, clear or rotation on
success, validation, 409 or database failure. Guarded responses use no-store.
Proof is not cleared/consumed by the POST; repeats within its short lifetime
recheck current active credentials and do not extend refresh lifetime. A delayed
completion response cannot overwrite a newer cookie.

## Jar limits and legacy behavior

The new POST and opt-in initiation count raw correctly named per-state slots
before signature/JSON work. More than five, duplicate attempt-cookie names or
duplicate refresh credentials fail closed; they do not select an arbitrary
subset. Correctly named junk consumes that raw budget. Unrelated cookies are
not selected or deleted.

Opt-in initiation also reserves its newly issued slot before creating state.
With five raw candidates it can remove an owned expired completed marker or the
oldest verified owned live slot; invalid/unowned cookies cannot supply room.
A full five-unowned jar is rejected before state creation or any cookie mutation.
Mixed ownership leaves at most five raw slots per initiation request after its
new cookie is issued. The completion POST retains its strict five-slot admission
bound.

Legacy initiation without client_attempt retains validated-owned jar accounting:
signed raw64 bindings and valid pending/completed phases share the five-attempt
budget. Owned expired completed slots can be removed, then oldest excess owned
slots are pruned before adding a new attempt. Invalid signatures, malformed
names or state/name mismatches do not count as owned and are not deleted.
Pending authorization still uses database expiry/claiming. For both opt-in and
legacy flow, concurrent or delayed headers can exceed the jar target; the new
POST rejects excess raw slots rather than selecting a subset. Unavailable proof
remains unknown.

Without opt-in, legacy raw64/PKCE/callback/redirect behavior remains. No frontend
behavior or normal login, refresh, logout, API-key, connector or global CORS
policy changes. In particular, this endpoint does not reorder ordinary password
login's session-replacement transactions.

## Evidence and remaining client work

The unchanged-source baseline used real HTTP/PostgreSQL and an RSA-signed
loopback IdP. Two intended failures showed ignored opt-in correlation/cleared
callback proof and the missing cookie-safe POST. Five controls preserved legacy
PKCE/state/provider verification, replay and jar behavior. The same seven
assertions pass after implementation, with backend type checking passing.
Another 22 proof, credential, expiry and concurrency checks pass. A callback-race
correction adds five distinct cases: a real concurrent state-claim loser,
missing-code response ordering, and three uniquely claimed provider failures.
Those five plus the affected cancellation control pass. A separate independent
before found two raw-jar headroom failures with five passing controls. Eight new
headroom cases and the affected legacy control pass after correction, giving 42
distinct cases promoted into the permanent suite; 26 existing OIDC state/identity
checks also pass. The missing-code fixture applies actual HTTP response cookies
in a chosen jar order; it does not measure transport delay. The expiry-during-await fixture uses a controlled signed short
remaining deadline and real clock, not an elapsed 60-second claim. Read-fault
responses use injected delegate failures over actual HTTP. Cookie attributes
over loopback do not establish deployed HTTPS or browser acceptance under every
proxy/cross-site configuration.

The client must separately persist nonbearer action/intent metadata, capture
sign-in order before waits, handle completion before ordinary hydration, and
reject successes overtaken by a later logout without adopting a UI session.
A path or SSO-start marker alone is insufficient. Lost cookie, expired marker,
lost client action metadata or unavailable storage can leave a remote outcome
unknown. Ordinary callback/login/refresh still have existing cookie-writing
behavior; this protocol cannot restore a newer cookie overwritten by an older
ordinary response or promise universal browser-header ordering.
