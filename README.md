<p align="center">
<img width="300" src="https://github.com/user-attachments/assets/1d9af671-7838-45ee-a810-54a30e605c30" />
</p>

<p align="center">
Open-source project management and collaboration for teams. Kanban boards, team workspaces, calendar views, and a command palette, all self-hosted with Docker Compose. No SaaS fees, no vendor lock-in, just your data on your infrastructure.
</p>

<p align="center">
<img width="700" alt="werkyn-list_dark" src="https://github.com/user-attachments/assets/42b05fd6-aaff-4400-9acb-41bf535963bb" />
</p>

⚠️ **This project is a development preview.** Expect breaking changes before a stable release.

🌎 Our [Live Demo](https://demo.werkyn.com/) is online! Check it out!

📚 Read the [Werkyn Documentation](https://www.werkyn.com/docs) for more information and features.


## Getting Started
For local testing and development. Expect breaking changes before a stable release. There may be security flaws in the current state. Do not use in production. This will require **Docker** and **Docker Compose**.

### Setup

1. Clone the repository:
```bash
git clone https://github.com/werkyn/werkyn.git
cd werkyn
```

2. Create your local environment file and generate three separate secrets:
```bash
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
```
Put the three generated values in `.env` as `JWT_SECRET`, `COOKIE_SECRET`, and
`POSTGRES_PASSWORD`. Keep the database password hexadecimal, as it is embedded in
the database URL. The environment file is ignored by git. For a remote HTTPS
installation, also set `COOKIE_SECURE=true`, `FRONTEND_URL`, and `CORS_ORIGIN`.
Configure outgoing email under Admin > Email, or with the `SMTP_*` variables.
Without SMTP, the server does not send verification or password-reset email and logs
an error. Only `NODE_ENV=development` falls back to the Ethereal test inbox.

3. Start the application:
```bash
docker compose up --build
```

This builds the app image, starts PostgreSQL, runs database migrations, and launches the server.

- **App**: `http://localhost:3000`

The server validates its environment at startup and exits with a message naming
each invalid variable. See `docs/remediation/ops-009.md` for the accepted formats.
`GET /api/live` reports liveness. `GET /api/ready` reports readiness: the database is
reachable and all migrations are applied. `GET /api/health` still reports whether
the database is reachable.

The container runs the migrations, the server and Dex as the unprivileged user
`werkyn` (uid 10001). Older images ran as root; on upgrade, the Compose file's
one-off `werkyn-permissions` service gives the root-owned files in the storage and
Dex volumes to that user before the app starts. See `docs/remediation/ops-004.md`
for `docker run`, host directories and other setups.

The storage folder (`STORAGE_DIR`, `/app/storage` in Compose) may itself be a
symbolic link, a volume or a mount point; to move storage to another disk, point
`STORAGE_DIR` or that link at the new disk, or mount the disk there, and restart.
The server resolves it once at startup and logs the real path. Below it, no
symbolic link is ever followed: reads through one answer `403`, writes through
one are refused, and deleting a file whose path is a link removes only the link.
So do not link a workspace folder or file to somewhere else: mount the other
disk at that path instead. Before upgrading an installation whose storage may hold
links, list them in the running (older) container, which does not change anything:

```bash
docker compose exec werkyn find -H /app/storage \( -type l -o -type p -o -type s -o -type b -o -type c \) -exec ls -ld {} +
```

Replace each with what it points to. From this version on, the read-only
`packages/backend/dist/scripts/storage-link-report.js` lists them too; see
[docs/remediation/r33-storage-symlinks.md](docs/remediation/r33-storage-symlinks.md).

When upgrading an existing installation, back up the database and storage first.
Set new JWT and cookie secrets to invalidate credentials signed with the published
sample secrets. Changing `POSTGRES_PASSWORD` in `.env` does not change the password
inside an existing PostgreSQL volume: rotate that role's password in PostgreSQL
and update `.env` together. Keep the volume; deleting it deletes your data.

The account-link migration `20261031120000_hash_account_link_tokens` requires a
coordinated upgrade: stop every older server and worker, back up PostgreSQL,
then start the matching new version (container startup applies migrations).
Do not start the new version while older instances still use the database.
The migration preserves outstanding links but removes raw token columns;
rolling back application code alone cannot restore compatibility. See the
[upgrade and rollback guidance](docs/remediation/sec-026.md).

The search-index migration `20261105180000_search_trigram_indexes` installs the
PostgreSQL extension `pg_trgm` (a contrib module) and trigram indexes for text
search. On PostgreSQL 13 and later the database owner can install it, and the
bundled Compose database needs nothing. If Werkyn's database role may not
create extensions (PostgreSQL 12 or older, or a managed service that requires
allow-listing, such as Azure's `azure.extensions`), have an administrator run
`CREATE EXTENSION IF NOT EXISTS pg_trgm;` in the Werkyn database before
upgrading. The migration is one transaction, so writes to tasks wait until it
commits, and writes to chat messages, files and wiki pages from their index
build on (5.5 s and 3.5 s for 100,000 tasks and 200,000 messages); reads do
not wait. On a database whose default collation uses ICU (or the builtin
provider), where pg_trgm cannot match `ILIKE`'s case folding, the migration
creates neither the extension nor the indexes, search works as before, and the
server logs a warning at startup; check with `SELECT datlocprovider FROM
pg_database WHERE datname = current_database();` (`c` is libc). A dump of a
libc database restored into an ICU or builtin database keeps the indexes:
drop them after the restore with the schema-qualified `DROP INDEX` statements
the server prints at startup (for the default schema: `DROP INDEX
"public"."Task_title_trgm_idx", "public"."Task_description_trgm_idx",
"public"."ChatMessage_content_trgm_idx", "public"."WikiPage_title_trgm_idx",
"public"."File_name_trgm_idx";`; use `DATABASE_URL`'s `schema` instead of
`public` if it sets one). Until then the server's searches avoid them; it
notices the drop within a minute, without a restart. See
[P02c](docs/remediation/p02c.md), including how to recover a failed migration
and how to build the indexes beforehand without blocking writes.

## Features

### Project Management

**Kanban Boards** - Visual task management with customizable status columns

<img width="1000" alt="werkyn-kanban" src="https://github.com/user-attachments/assets/fdb2332a-ec57-414e-af82-dfc80ba76645" />

- **List View** - Table view with sorting, filtering, and bulk operations
- **Calendar View** - Timeline and calendar integration for scheduling
- **Task Properties** - Rich task details including:
  - Priorities (Urgent, High, Medium, Low)
  - Assignees and labels
  - Due dates and start dates
  - Subtasks and dependencies
  - Comments with @mentions
  - File attachments
  - Custom fields (text, number, date, select)
- **Task Templates** - Reusable task templates for common workflows
- **Recurring Tasks** - Automatically create tasks on schedules
- **Real-time Updates** - WebSocket-powered live collaboration

### Wiki & Documentation

<img width="1000" alt="werkyn_wiki" src="https://github.com/user-attachments/assets/c949ec7b-758b-4c3d-844b-ae693eb0370e" />

- **Notion-like Editor** - Rich text editing with BlockNote
- **Spaces & Pages** - Organized wiki structure
- **Team Documentation** - Collaborative knowledge base

### File Management

<img width="1000" alt="werkyn-drive" src="https://github.com/user-attachments/assets/16185112-393a-48d7-97b4-cf5af73360bd" />

- **Personal Files** - Private file storage per user
- **Team Shares** - Shared folders and team collaboration
- **File Uploads** - Direct file attachments to tasks

### Workspace Features
- **Multi-workspace Support** - Organize projects by workspace
- **Team Collaboration** - Member management and permissions
- **Command Palette** - Quick navigation and actions (cmdk)
- **Dark Mode** - Modern UI with theme support

## Project Structure

This is a pnpm monorepo with three packages:

```
werkyn/
├── packages/
│   ├── shared/      # Zod schemas, TypeScript types, and constants
│   ├── backend/     # Fastify HTTP/WebSocket server with Prisma
│   └── frontend/    # React SPA with Vite
├── package.json     # Root workspace configuration
└── tsconfig.base.json
```

### Architecture
- **Backend modules** follow routes → controller → service layering
- **Authorization** resolves workspace context from route params
- **Real-time events** broadcast via WebSocket subscriptions
- **Frontend features** organized into feature folders with `api.ts`, `components/`, and `hooks/`

## Tech Stack

### Frontend
- **React 19** - Latest React with modern features
- **Vite** - Fast build tool and dev server
- **TanStack Router** - Type-safe file-based routing
- **TanStack Query** - Server state management
- **Zustand** - Client state management
- **Tailwind CSS v4** - Utility-first styling
- **Mantine UI** - Component library
- **BlockNote** - Rich text editor
- **FullCalendar** - Calendar component
- **dnd-kit** - Drag and drop functionality

### Backend
- **Node.js** - Runtime environment
- **Fastify 5** - Fast web framework
- **Prisma** - Type-safe ORM
- **PostgreSQL** - Database
- **WebSocket** - Real-time communication
- **JWT** - Authentication
- **Zod** - Schema validation

### Infrastructure
- **pnpm Workspaces** - Monorepo package management
- **TypeScript** - Type safety across the stack
- **Docker Compose** - Single-command containerized deployment


## Local Development

For contributors who want to run outside of Docker:

### Prerequisites
- **Node.js** 22.12+ (`>=22.12.0`); use the latest patch of a supported LTS release. The container and CI use Node 22.
- **pnpm** >= 9.0.0
- **Docker** (for PostgreSQL)

### Setup

1. Start the infrastructure services:
```bash
docker compose up postgres
```

2. Install dependencies:
```bash
pnpm install
```

3. Set up environment variables:
```bash
cd packages/backend
cp .env.example .env
# Edit .env with your database connection and other settings.
# Match DATABASE_URL's password to POSTGRES_PASSWORD in the root .env.
```

4. Set up the database:
```bash
cd packages/backend
pnpm db:generate
pnpm db:migrate
pnpm db:seed  # Optional: seed with sample data
```
The seed creates sample accounts with a published password. It refuses to run with
`NODE_ENV=production` or against a database that already has other accounts or
workspaces. `SEED_FORCE=true` replaces only previously seeded data.

Local runtime files use `STORAGE_DIR` (default `./storage`, relative to the backend
process). Running the backend from `packages/backend` writes to
`packages/backend/storage/`; new files there are excluded from Git and Docker
build context. Existing files already tracked in Git stay tracked and are
preserved for separate provenance review.

5. Start development servers:
```bash
# From the root directory
pnpm dev
```

This will start both the backend and frontend in development mode:
- Backend: `http://localhost:3000`
- Frontend: `http://localhost:5173`

### Available Scripts

**Root level:**
- `pnpm dev` - Start both backend and frontend in development mode
- `pnpm build` - Build all packages
- `pnpm lint` - Lint all packages
- `pnpm format` - Format code with Prettier
- `pnpm format:check` - Check code formatting

**Backend (`packages/backend`):**
- `pnpm dev` - Start development server with hot reload
- `pnpm build` - Build for production
- `pnpm start` - Start production server
- `pnpm db:migrate` - Run database migrations
- `pnpm db:generate` - Generate Prisma client
- `pnpm db:seed` - Seed an empty development database with sample data
- `pnpm db:studio` - Open Prisma Studio

**Frontend (`packages/frontend`):**
- `pnpm dev` - Start Vite dev server
- `pnpm build` - Build for production
- `pnpm preview` - Preview production build

## API keys

Open **Settings → API keys** to create a named personal key for scripts, bots, and
integrations. Choose 1, 7, 30, 90, or 365 days, or **Never expires**. The default is
30 days. Copy the key when it is created; it cannot be displayed again. The list
shows its prefix, expiration, last use, and revocation status.

Protected HTTP routes require an Authorization header for both access JWTs and
personal API keys; URL query credentials do not authenticate them. Native PDF
previews use short-lived, file-scoped grants instead of full access JWTs. See
[PDF preview authorization](docs/remediation/file-preview-grants.md).

Send the key in the Authorization header:

```bash
curl -H "Authorization: Bearer $WERKYN_API_KEY" \
  https://your-werkyn.example/api/users/me
```

Keys have their owner's current permissions across all their workspaces; they
are not separately scoped identities or service accounts. Existing workspace
membership, role, and task ownership checks still apply. Expired or revoked keys
are rejected on the next request. Keys are stored only as SHA-256 hashes and
cannot be supplied in URL query parameters. Existing JWT login and refresh-cookie
authentication continues to work. API keys currently support HTTP API access;
WebSocket authentication continues to require a JWT.

API key management requires a JWT user session; API keys cannot manage keys:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/api-keys` | List your keys' metadata |
| POST | `/api/api-keys` | Create a key; returns its plaintext value once |
| DELETE | `/api/api-keys/:id` | Revoke one of your keys |

Creation accepts `{"name":"CI pipeline","expiresInDays":30}`. `expiresInDays`
accepts whole numbers from 1 to 365, defaults to 30, and accepts `null` to opt out
of expiration.

### Concurrent edits to wiki pages and task descriptions

Wiki JSON content accepts up to 123 nested objects/arrays; comment selections
accept up to 121 so they fit the backup envelope. Unsupported JSON gets a 400
with field details before a write. See the [wiki JSON contract](docs/remediation/wiki-json-contract.md)
for supported values, null/omitted fields and historical versions.

Wiki pages carry a `revision` and tasks a `descriptionRevision`. Each advances
with every stored change: a page's title, content or icon (a version restore
included), or a task's description. To avoid overwriting a change you have not
seen, send the revision you last read with your edit:

```bash
curl -X PATCH -H "Authorization: Bearer $WERKYN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"Runbook","expectedRevision":7}' \
  https://your-werkyn.example/api/wiki/pages/$PAGE_ID
```

`PATCH /api/tasks/:id` accepts `{"description":"<p>...</p>","expectedDescriptionRevision":3}`
in the same way; the field is ignored when `description` is absent, and other
task fields never change `descriptionRevision`. When the stored revision is
different, nothing is written and the response is `409` with
`"code":"REVISION_CONFLICT"` and `"current":{"revision":8,"updatedAt":"..."}`.
Read the item again and decide what to send. Every wiki PATCH requires a valid
`expectedRevision`; task PATCH requires `expectedDescriptionRevision` when
`description` is supplied, including a null or empty clear. Missing or invalid
required revisions return 400. Task updates that omit `description` still need
no description revision. Bundled editors retain unsaved drafts when their base
is unavailable rather than guessing the latest server revision.

Historical wiki restores require a revision: send
`{"expectedRevision":7}` to `POST /api/wiki/versions/:vid/restore`, using the
current page revision you reviewed. Missing or invalid revisions return 400;
a stale revision returns the same 409 conflict without changing the page or
adding a version. The History panel flushes pending saves before opening and
keeps that acknowledged revision fixed. On conflict, close History, review the
refreshed page, and reopen History to deliberately choose a version again.
See [historical restore revisions](docs/remediation/wiki-history-restore.md).

While a user holds a wiki page's edit lock (taken by **Start Editing**; it
lapses two minutes after its last renewal), a save or version restore by anyone
else is refused with `409`, `"code":"EDIT_LOCKED"` and `current.lockedBy`,
after a valid revision is provided. A page nobody is editing accepts writes
without a lock.

### Paged lists and response limits

List endpoints that used to return every row now return a bounded page and say
when more follows. A request without paging parameters gets the first page:

| Endpoint | Default and maximum | More rows |
| --- | --- | --- |
| `GET /api/workspaces/:wid/my-tasks` | 100, `limit` up to 200 | pass `nextCursor` as `cursor` until it is `null` |
| `GET /api/chat/:wid/channels/:channelId/members` | 100, `limit` up to 200 | pass `nextCursor` as `cursor` until it is `null` |
| `GET /api/chat/:wid/channels` | each channel's first 10 members | `_count.members` is the full count; DMs are complete |
| `GET /api/workspaces/:wid/time/reports` | 20 entries per group (`entryLimit` 0–500), 5,000 per response | a group with `hasMoreEntries` continues at `GET .../time/reports/entries` with the report's filters, `groupKey` and `cursor` = `nextEntryCursor` (omit it when `null`) |
| `GET /api/workspaces/:wid/activity` | unchanged pages | `pagination.hasMore`; `pagination.total` counts up to 1,000 rows and sets `totalCapped` above that |

Report totals still cover every matching entry, and the CSV export still lists
them all. `my-tasks` also accepts `dueAfter`, `dueBefore`, `completed` and
`sort=dueDate`. Cursor
lists that sort by a value several rows can share (bookmarks, wiki versions,
shared-with-me, task comments, the drive listing, channel members) break ties by
ID, so pages neither repeat nor skip rows. See
[P02b](docs/remediation/p02b.md).

### Testing API keys

Run the settings tests with `pnpm --filter @pm/frontend test`. The backend
integration tests exercise the full application against a disposable PostgreSQL
database, including key creation, hashing, expiration, revocation, authorization,
and existing login/refresh behavior. They require an explicit test database URL:

```bash
export TEST_DATABASE_URL=postgresql://user:password@localhost:5432/werkyn_test
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @pm/backend exec prisma migrate deploy
pnpm --filter @pm/backend db:generate
pnpm --filter @pm/shared build
pnpm --filter @pm/backend test:integration
```

The migration adds the `ApiKey` table. Apply migrations when upgrading, as the
Docker entrypoint does automatically.

### Testing first-account creation

The integration suite includes overlapping local/local, local/OIDC and OIDC/OIDC
account creation against an empty disposable database. It checks committed users,
provider records, rollback/retry behavior and verification mail through a local
stub that never connects to SMTP or Ethereal. The fixtures refuse to run if any
users already exist and delete only their UUID-scoped accounts afterward.

Only local registration is eligible for automatic instance-admin assignment, and
only when it creates the first account. OIDC accounts remain ordinary, including
on an empty installation. Existing accounts prevent later automatic bootstrap;
deliberate administrator promotion remains available. Account/provider creation is
atomic; invite admission, verification/session token creation and refresh-family
concurrency have separate transaction boundaries.

After a committed account is observed, ordinary local registration uses a
transaction without the bootstrap predicate, so concurrent signups do not contend
for bootstrap. OIDC identity/linking transactions retain serializable isolation.
The application has no account-deletion endpoint; do not run destructive seeds or
manual deletion of all users concurrently with registration.

## Workspace invitations and admission

Registration with an invite token and accepting an invite while signed in use
the same admission check. It reads the account's current email and verification
state, the live invitation and the workspace settings, and returns one of:

- `joined`: the membership was created with the invitation's role (an existing
  member keeps their role and the invitation is not used again);
- `verification_required`: the invitation is limited to an email address, or the
  workspace limits allowed email domains, and the address is not yet verified;
- `approval_pending`: the workspace requires admin approval and a join request
  is waiting for review;
- `denied`: the invitation is missing, revoked, expired or used up, invites are
  disabled, the email or domain does not match, or the workspace is full.

`POST /api/invites/:token/accept` answers `200` when joined, `202` while
verification or approval is pending, and `403`/`404`/`410` when denied.
`GET /api/invites/:token/admission` reports the same state for the signed-in
account without writing anything: `not_pending` when approval is required and
there is no membership and no pending request (for example, after a request was
declined), or `ready` when approval is not required and the account can join.
`POST /api/auth/register` always keeps the new account and reports the result in
`data.admission`; a verification email sent because of an invitation links back
to that invitation. Open invitations without an email or domain restriction still
admit unverified accounts. The workspace's default role setting does not change
the role granted by an invitation.

When **Require admin approval** is enabled, invitations create join requests
instead of memberships. Workspace admins review them under Admin, Invites, Join
requests (`GET /api/workspaces/:wid/admission-requests`, then
`POST .../admission-requests/:requestId/approve` or `.../reject`). Approval checks the approver, invitation, applicant and
settings again at decision time and does not reserve a seat or invitation use
in advance. A request stays bound to the invitation it was made through; asking
again through a different invitation replaces it with a new request, so a
decision on the request an admin reviewed never applies to another invitation's
role. Revoking an invitation cancels its pending requests. Checking a
request's status never creates or revives it; a declined person sees that the
request is no longer pending and may explicitly ask again while the invitation
remains valid. Revoke the invitation to stop that.

Admission, workspace settings changes, invitation creation/revocation, member
role changes and removals lock the workspace row (`SELECT ... FOR NO KEY UPDATE`)
before reading admission state, so member limits and invitation use limits hold
under concurrent requests. Allowed email domains are stored lowercase without a
leading `@`; blank entries are rejected. The migration
`20261027140000_add_workspace_admission_requests` adds the join request table;
existing data is unchanged. See
[docs/remediation/sec-007.md](docs/remediation/sec-007.md) for details and tests.

## Sessions

Each sign-in is a refresh-token family. Refresh rotates the `refresh_token`
cookie atomically. Logout ends that family; password login, password change and
password reset end all of the account's families, including a rotation in
progress, and a sign-in that overlaps a password change or reset is revoked by
it or waits for it to finish. Two tabs refreshing the same cookie at once get
one new token and one `409`, after which the second tab uses the first tab's
result. A rotated token presented 30 seconds or more after its rotation revokes
its family. Access tokens name their family (`sid`). Ending a family closes the
realtime sockets opened with its access tokens (close code `4005`), and
WebSocket authentication refuses tokens of an ended family or without `sid`;
see [docs/remediation/dat-006.md](docs/remediation/dat-006.md). Every HTTP use of
a session-bound access token checks that its family belongs to the account,
is unrevoked and has an unexpired current refresh token. Ended sessions receive
`401` before protected work; operational authentication lookup failures receive a safe
`503`. Older tokens without `sid` retain their JWT expiry grace, at most
15 minutes after upgrading from a version that issued them. Personal API keys
stay valid until revoked or expired. See
[HTTP session validity](docs/remediation/http-session-validity.md). The
migration `20261029090000_add_refresh_token_families` adds the family table and
backfills families for existing sessions, so users stay signed in. See
[docs/remediation/sec-011.md](docs/remediation/sec-011.md).

A password-reset link works once: when the same link is submitted several
times at once, one request changes the password and ends the sessions, and the
others get `410` and change nothing. An email-verification link is likewise
consumed by exactly one request. Only SHA-256 digests of these account links
are stored; outstanding links survive the coordinated upgrade described in
[docs/remediation/sec-026.md](docs/remediation/sec-026.md).

A password change writes the new password only if the current password it
verified is still the account's password when the change commits. A change
whose current password was replaced meanwhile by a password reset or another
change gets `400 Current password is incorrect` and changes nothing. A
successful password change or reset also invalidates the account's earlier
unused reset links. A skipped deletion that might roll back, or a concurrently
inserted link observed during invalidation, makes the password operation return
its retryable busy 503 without changing anything. See
[docs/remediation/sec-027.md](docs/remediation/sec-027.md).

## Sign-in protection

The sign-in route allows 10 requests per minute from one client IP address. Each
email address also has a failed sign-in count, kept in the database, so it holds
across server processes. After 5 consecutive failures for an email address, the
next attempt must wait 2 seconds. The wait doubles with each further failure, up to
60 seconds. During a wait, sign-in answers `429 Too Many Requests` with a
`Retry-After` header and checks no password; the sign-in form counts the wait
down. A successful sign-in clears the count, and so does an hour without
attempts.

**Trusted browsers.** A successful password sign-in marks the browser with an
HttpOnly `login_device` cookie, sent only to the sign-in route, valid for 30 days
and bound to that email address. Later sign-ins from that browser for that address
use the browser's own failure count, with the same waits, instead of the address's
shared one. Someone who keeps sending wrong passwords for the address therefore
cannot hold off a browser that has signed in before. The cookie grants no access by
itself: the password is still checked. Signing out keeps it. A password change
or reset, clearing the browser's cookies, or rotating `COOKIE_SECRET` ends it.

**What an attacker can still do.** Waits are first come, first served when they
end. Someone who sends a wrong password for an address each time its wait ends
can keep a browser that has never signed in to that address from signing in with
a password, for as long as they keep going. That covers a new device, a cleared
browser, or the first sign-in after 30 days. They get one guess per wait (about one
a minute). Existing sessions, trusted browsers and SSO sign-in are not affected.
There is no lockout in the stored state: once the sending stops, the next wait
ends and the correct password signs in.

Email addresses with and without an account are counted and answered alike when no
`login_device` cookie is sent, which is always the case for someone probing other
people's addresses. Unknown addresses and accounts without a password (SSO only)
do the same Argon2id work as a wrong password. Password-reset requests are
answered before the account lookup or mail delivery runs. So neither answers nor
timing tell whether an account exists. An account gets at most one new reset link
per `PASSWORD_RESET_COOLDOWN_SECONDS`. Further requests get the same answer and add
nothing. As a memory guard, each server process starts at most
`PASSWORD_RESET_REQUESTS_PER_MINUTE` reset requests, counted by request alone;
past that, every reset request is answered `429` with `Retry-After` until the minute
ends. At the default of 6,000, reaching it takes about 600 client IP addresses at
the route limit. The count table has a fixed maximum size
and stores no addresses, so requests for many made-up addresses cannot grow it
without limit. See
[docs/remediation/r31-login-backoff.md](docs/remediation/r31-login-backoff.md).

The server reads these optional settings at startup. An empty value keeps the
default:

| Variable | Default | Range | Meaning |
| --- | --- | --- | --- |
| `LOGIN_BACKOFF_THRESHOLD` | `5` | 1–100 | Consecutive failures before the first wait |
| `LOGIN_BACKOFF_BASE_SECONDS` | `2` | 1–900 | First wait; doubles per further failure |
| `LOGIN_BACKOFF_MAX_SECONDS` | `60` | 1–900 | Longest wait (at least the base) |
| `LOGIN_BACKOFF_RESET_SECONDS` | `3600` | 60–604800 | Quiet time after which failures are forgotten (at least the longest wait) |
| `LOGIN_BACKOFF_SLOTS` | `65536` | 256–16777216 | Rows for email addresses; trusted browsers use as many again |
| `PASSWORD_RESET_COOLDOWN_SECONDS` | `60` | 0–3600 | Shortest time between two reset links for one account (0: no cooldown; at most the link's 1-hour lifetime) |
| `PASSWORD_RESET_REQUESTS_PER_MINUTE` | `6000` | 60–1000000 | Reset requests one server process starts per minute before answering `429` |

With Docker Compose, add them under the `werkyn` service's `environment`, for
example `LOGIN_BACKOFF_MAX_SECONDS: 30`. The table holds at most twice
`LOGIN_BACKOFF_SLOTS` rows (about 100 bytes each). Addresses share a row when their
keyed hashes collide. At the default size, the chance that a given account shares
its row with another is about 0.15% with 100 accounts, 1.5% with 1,000 and 14% with
10,000. Raise the setting for large installations. The hash key is derived from
`JWT_SECRET`, so rotating that secret also forgets every count.

The migration `20261105150000_bounded_login_backoff` replaces the
`LoginAttempt` table with `LoginThrottle`. Recent failure counts and any
remaining lockouts are dropped. Stop older servers before applying it, as for
other migrations: they still use `LoginAttempt` and would fail sign-ins. Rolling
back to an earlier version after this migration also breaks password sign-in until
the old table is recreated; see the upgrade notes in
[docs/remediation/r31-login-backoff.md](docs/remediation/r31-login-backoff.md).

## Backups and restores

Workspace admins export and restore content under **Admin → Backup**. A backup
is a selective content export of the projects, chat channels and wiki spaces you
pick, not a copy of the installation: accounts, settings, Drive files and
attachments are left out (see
[what a backup contains](docs/remediation/b03-backup-transport.md#what-a-backup-contains)).
To be able to recover the whole installation, back up PostgreSQL and the storage
volume.

### Limits per server

Each server process applies these limits. Only the minimum upload rate is
configurable.

| Limit | Value | When it is exceeded |
| --- | --- | --- |
| Backup requests (export, preview, restore) at once, per workspace | 1 | `429` with `Retry-After: 30` |
| Backup requests at once, per server process | 3 | `503` with `Retry-After: 30` |
| Uploaded backup file | 1,088 MiB, or `MAX_FILE_SIZE` if smaller | `413` |
| Archive content | 1 GiB, 10,000 entries, `backup.json` at most 24 MiB | `400`, for exports and uploads alike |
| Export time, image copy included | 10 minutes | `409`, the export can be retried |
| Upload or download that moves no bytes | 60 seconds | the connection is closed |
| Upload slower than the minimum rate (below) | 16 KiB/s on average over 60 s, from 30 s after it starts | `408` |

A backup request takes its slot before it reads anything and keeps it until it
has answered; an export keeps it until its download has been handed over in
full. Requests over a limit are refused at once rather than queued, and the
backup page asks the admin to try again shortly. The admitted requests take turns, one at a
time per process, for the memory-heavy step: building an export, or reading,
checking and restoring `backup.json`. A request can therefore wait behind up to
two others before its own work starts.

Werkyn assumes one server process per storage directory. A process that starts
removes the staged backup files in `STORAGE_DIR/.tmp/backup`, including any that
another process is still using. If you run several processes anyway, each one
has its own three slots, and the one-per-workspace limit does not span them.
Each slot can stage a file of up to 1,088 MiB in `STORAGE_DIR/.tmp/backup`, so
keep about 3.5 GiB free on the storage volume. Give the server a heap of at
least 384 MiB ([SEC-028](docs/remediation/sec-028.md)).

### Minimum upload rate

From the moment a preview or restore is admitted until its file has been
received, its upload must keep to a minimum average rate, so a client that sends a byte now
and then cannot hold a backup slot. A slower upload is answered `408 Request
Timeout`, its partial file is removed and its slot is freed at once. The server
reads these optional settings at startup; an empty value keeps the default:

| Variable | Default | Range | Meaning |
| --- | --- | --- | --- |
| `BACKUP_UPLOAD_MIN_BYTES_PER_SECOND` | `16384` | 1–1073741824 | Lowest average rate, in bytes per second |
| `BACKUP_UPLOAD_RATE_WINDOW_SECONDS` | `60` | 1–3600 | Time the average is taken over; pauses shorter than this are absorbed |
| `BACKUP_UPLOAD_RATE_GRACE_SECONDS` | `30` | 1–3600 | Time after the upload starts before the rate is checked |

With Docker Compose, add them under the `werkyn` service's `environment`. The
default, 16 KiB/s (about 130 kbit/s), is below any working broadband or mobile
uplink. An upload that keeps exactly to the minimum still holds its slot until
it ends: up to about 19 hours for a 1,088 MiB file at the default. Raise the
minimum to shorten that, or let your reverse proxy receive whole uploads first
(below). Exports have no minimum download rate. See
[R42](docs/remediation/r42-backup-limits.md).

The backup page in the web app waits at most 60 seconds for a preview and 120
seconds for a restore, upload included. For larger files on slower links, send
the file to the API, for example with a personal API key:

```bash
curl -H "Authorization: Bearer $WERKYN_API_KEY" -F "file=@backup.zip" \
  https://your-werkyn.example/api/workspaces/$WORKSPACE_ID/backup/preview
```

Use `.../backup/restore` to restore it.

### Large workspaces and the 10-minute export limit

An export is built while its request waits, and must finish within 10 minutes,
copying images included. The time spent waiting for its turn does not count.
An export that takes longer stops, removes its partial file and answers "The
export took longer than allowed". For a large workspace:

- export a few projects, channels or wiki spaces at a time, and restore the
  archives one after another;
- clear **Include files** to leave embedded wiki images out, and leave out
  activity logs;
- export when the server is quiet, since exports and restores take turns.

An export over the archive limits is refused with a `400` and must be split the
same way. There are no background export or restore jobs.

### Previews and restores briefly block the server

Preview and restore read and check `backup.json` synchronously. While they do,
that server process answers no other request. At the limits (24 MiB, 1,100,000
tokens, 150,000 objects) this takes up to about 0.6 s; the largest export
measured, 16.6 MiB, takes about 0.15 s. A crafted file whose pages are full of
image paths can take up to about 8 s to map those paths
([backup restore](docs/remediation/backup-restore.md)). Run restores of large
files when the server is quiet, and split content that comes near the limits
into several exports.

### Reverse proxy settings

Backup routes (`/api/workspaces/<id>/backup/...`) need different proxy settings
from the rest of the API:

- **Body size.** Allow at least 1,100 MiB on these routes (and `MAX_FILE_SIZE`
  on Drive uploads).
- **Waiting for the answer.** A backup request may send nothing back for up to
  about 30 minutes: up to two 10-minute exports ahead of it, then its own. A
  proxy that gives up earlier answers `504` while the server carries on.
- **Receiving whole uploads first.** A proxy that reads the whole upload before
  passing it on (nginx by default, Traefik's buffering middleware) takes slow
  clients off the server's backup slots: the slot is taken only once the
  upload is complete. The proxy needs disk space for it.
- **Minimum rates.** nginx and Traefik have no minimum transfer rate; Caddy
  2.11.8 and later do, per route. Werkyn's own minimum applies behind any proxy.
- **Whole-request deadlines** (Traefik's `readTimeout`, 60 s by default in
  Traefik 3; Caddy's `read_body`) end any upload that takes longer. Set them to
  the longest upload you accept.

**nginx.** In the `server` block that proxies Werkyn (here on port 3000):

```nginx
location ~ ^/api/workspaces/[^/]+/backup/ {
    proxy_pass http://127.0.0.1:3000;
    client_max_body_size 1100m;
    # The default: nginx stores the whole upload (in client_body_temp_path)
    # before passing it on, so a slow client never holds a backup slot.
    proxy_request_buffering on;
    client_body_timeout 60s;         # a client that sends nothing for 60 s gets 408
    proxy_read_timeout 35m;          # the answer may take up to about 30 minutes
    proxy_send_timeout 60s;
    # Take a whole export (up to about 1.1 GiB) from Werkyn at once, so a slow
    # download does not hold its backup slot.
    proxy_buffering on;
    proxy_max_temp_file_size 2048m;
    send_timeout 60s;
}
```

nginx's timeouts apply between two reads or writes, not to the whole transfer,
and it has no minimum rate setting.

**Caddy** 2.11.8 or later:

```caddy
werkyn.example.com {
	@backup path_regexp ^/api/workspaces/[^/]+/backup/
	request_body @backup {
		max_size 1100MiB
	}
	# Abort uploads that stall for 60 s or average under 16 KiB/s.
	timeouts @backup {
		read_timeout 60s 16384
	}
	reverse_proxy 127.0.0.1:3000
}
```

Caddy streams uploads to Werkyn as they arrive, and by default sets no time
limit on waiting for Werkyn's answer. Do not set the global `read_body` or
`write` timeouts, which limit the whole upload or download, below your largest
transfer. `write_timeout 60s 16384` in the same `timeouts` block would also end
export downloads that average under 16 KiB/s, which frees their slot.

**Traefik** 3, assuming an HTTPS entry point `websecure` that already serves
Werkyn. The entry point's `readTimeout` limits how long the whole request,
upload included, may take (60 s by default), so raise it:

```yaml
# Static configuration
entryPoints:
  websecure:
    address: ":443"
    transport:
      respondingTimeouts:
        readTimeout: 1h
```

```yaml
# Dynamic configuration (file provider)
http:
  routers:
    werkyn-backup:
      rule: "Host(`werkyn.example.com`) && PathRegexp(`^/api/workspaces/[^/]+/backup/`)"
      entryPoints: [websecure]
      tls: {}   # or the same TLS options (certResolver) as your main Werkyn router
      service: werkyn
      middlewares: [werkyn-backup-buffer]
  services:
    werkyn:   # or your existing Werkyn service
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:3000"
  middlewares:
    werkyn-backup-buffer:
      buffering:
        maxRequestBodyBytes: 1153433600   # 1,100 MiB
        maxResponseBodyBytes: 0           # unlimited, so exports are not refused
```

The buffering middleware reads the whole upload, on disk above 1 MiB, before
passing it on. Traefik waits for Werkyn's answer without a time limit by
default (`responseHeaderTimeout: 0s`). It has no minimum rate setting; its
`readTimeout` caps the time any upload may take instead.

## Contributing

Contributions are welcome! This project is in active development. Please check back soon for contribution guidelines and code of conduct.

## License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**. See the [LICENSE](LICENSE) file for details.

The AGPL-3.0 license ensures that:
- You can use, modify, and distribute the software
- If you modify the software and run it as a network service, you must make the source code available to users
- All modifications must be released under the same license

## Links

- **Live Demo**: [demo.werkyn.com](https://demo.werkyn.com/)
- **Issues**: [GitHub Issues](https://github.com/yourusername/werkyn/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yourusername/werkyn/discussions)

