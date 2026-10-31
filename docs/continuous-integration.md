# Continuous integration and image publication

Pull requests targeting `main`, including forks, run the `Tests and build` and
`Container build` checks with a read-only token. Validation installs the frozen
lockfile, validates/generates Prisma, applies all migrations to an ephemeral
PostgreSQL 16 service, runs the unit/frontend and PostgreSQL integration suites,
checks TypeScript, and builds production assets. The container check builds the
Dockerfile without logging into a registry or pushing an image. No application
database or deployment secret is required.

Validation and the container both use Node 22. The container pins the full Node
patch, Alpine version and multi-platform image digest; the container policy gate
checks that its Node major matches validation and that test-only `adm-zip` stays
out of the production dependency importer.

`pnpm test` first builds and tests the shared package, then validates the
workflow's event/permission policy, runs the backend unit suite, and runs the
frontend regression suite. All three test commands and the backend integration
command run directly in their workspace directories and fail if their scripts
are missing or fail.
`pnpm test:integration` builds the shared package before running
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
