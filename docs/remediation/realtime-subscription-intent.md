# Realtime subscription intent

Project, workspace and channel subscriptions keep only the latest pending
intention for that connection and resource. Unsubscribe retires an older
pending subscribe, so a late authorization result cannot restore its held
subscription or emit presence. A newer pending request retains its own token
when an older request settles; cleanup discards the connection's pending tokens.

Authorization still uses the existing checks and accessVersion reread. An older
request that was authorized retains its true result even if its held-state
commit is now a no-op; this does not introduce an authorization-denied ACK.
Existing denial and removed-connection outcomes, wire ACK shapes, client
reference counts and authentication/session policy remain in place.

The ordinary service tests use small fake sockets and stubbed Prisma rows.
They prove final public marker/presence state and authorized-result preservation,
not real transport scheduling or external-client ACK compatibility. Existing
websocket/revocation integration and independent HIGH gates remain required.
