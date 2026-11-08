# Privacy-preserving registration

Self-hosted hosts do not all have email delivery. Privacy-preserving
registration is therefore an instance setting and defaults to **off**.

An instance administrator reads and changes it at Admin → Authentication, or
with `GET` and `PATCH /api/admin/registration/config`
(`{ "privacyPreserving": true }`). The route requires an instance
administrator. A workspace admin or any other signed-in user receives 403.
The value is the singleton `RegistrationConfig` row, the same kind of
instance row as email and SSO settings. A missing row means off.

## Off (default)

Registration stays as it is today:

- A new address is signed in immediately (`201`, refresh cookie, access
  token). Email verification is not required before that session. A
  verification message is still sent when the account is not the first
  (bootstrap) account.
- An address that already has an account gets `409` with
  `Email already in use`. The password, sessions and memberships are
  unchanged.

## On

Turn this on only after email delivery works (Admin → Email, or `SMTP_HOST`).
Without delivery, a new account cannot receive the link it needs to sign in.

Both a new address and an existing address get the same `200` body and no
session cookie:

> If the address is available, a verification link has been sent. Verify your email before signing in.

The response is sent before the address is looked up. A repeat for an address
whose request is still running adds nothing. Each process accepts at most
6,000 of these requests a minute and then answers `429` with `Retry-After`
for every address alike. Shutdown waits for work still running, then logs
and abandons whatever is left.

- **New address.** The account is created unverified, with no session. The
  usual verification message is sent. An invite token is applied only for
  that new account, and the message links back to the invitation when it
  exists. The person signs in only after opening the link. The sign-in form
  does not say whether the password was right until then: a correct password
  on an unverified account gets the same `401 Invalid email or password` as
  a wrong one, and it does not clear sign-in backoff.
- **Existing address.** Nothing is written. The password is not changed, no
  session is created, and the account is not joined to a workspace from the
  request. No mail is sent, so submitting someone else's address does not
  generate a message to them.

A correct password for an unverified account, while the setting is on, queues
one verification message after the response if that account has not been sent
one in the last minute. That is how someone who registered before the setting
was enabled can still receive a link. The sign-in response itself is unchanged.

Sessions that already exist when the setting is turned on keep working until
they end. New password sign-ins do not, until the address is verified.

Password hashing, sign-in backoff and sign-out are unchanged. SSO-only mode
still refuses password registration with the same error for every address.
