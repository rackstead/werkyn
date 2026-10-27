# Email verification and the current account

When a verification response belongs to account A, the browser updates its current
user's verification flag only if that user is still account A. Redeeming A's link
while signed in as B, switching to B before the response arrives, and signing out
before completion leave the current authentication state unchanged.

The callback updates only `user.emailVerified` from the server response through an
atomic Zustand updater. It preserves the current profile, access token, workspace
memberships, hydration state and any pending refresh. It does not call `setAuth`
or broadcast an authentication event. A matching user-only state with no token
stays without a token; a signed-out user stays signed out. The current store has
no persistence middleware.

The hook regressions use React Query, the actual auth store and API client with a
controlled fetch response. They exercise a response delayed across an account
switch or logout, a different existing subject, anonymous redemption, a matching
subject with a newer profile/session, a user-only state, and the returned flag.

```bash
pnpm --dir packages/frontend exec vitest run src/features/auth/api.test.tsx
```

This change covers local verification-response state. Workspace admission,
approval, verification-email delivery, refresh coordination and general account
cache isolation retain their separate remediation gates.
