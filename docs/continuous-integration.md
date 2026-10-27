# Continuous integration and image publication

Pull requests targeting `main`, including forks, run the `Tests and build` and
`Container build` checks with a read-only token. Validation installs the frozen
lockfile, validates/generates Prisma, applies all migrations to an ephemeral
PostgreSQL 16 service, runs the unit/frontend and PostgreSQL integration suites,
checks TypeScript, and builds production assets. The container check builds the
Dockerfile without logging into a registry or pushing an image. No application
database or deployment secret is required.

`pnpm test` also validates the workflow's event/permission policy. It runs each
workspace's unit test script when present; the frontend regression suite is
always required. `pnpm test:integration` builds the shared package before running
the backend integration suite. Local integration runs require an explicit
`TEST_DATABASE_URL` pointing to a migrated disposable PostgreSQL database.

Image publication is disabled by default. An operator may explicitly authorize
automatic GHCR publication by setting the repository Actions variable
`ENABLE_IMAGE_PUBLICATION` to `true`. Once enabled, only a push to `main` whose
validation and container checks both pass may start the separate publication job.
Only that job receives `packages: write` and registry credentials. Unset the
variable or set it to `false` to stop future publication. Pull requests cannot
publish even when the variable is enabled. Publishing does not deploy an image.

The event-matrix regression evaluates the actual YAML condition for string-valued
fixtures; it is not a general Actions expression interpreter. Hosted run results
remain the authority for GitHub execution. The job dependency and permission
model follows the [GitHub workflow syntax documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
and [expression reference](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions).
