# Contributing

Use Node.js 22.14+ (24 recommended). Run `npm ci --ignore-scripts`, `npm test`, and verify a packed tarball with `node scripts/verify-package.mjs ARTIFACT_DIRECTORY`.

Keep task identities, durable recovery, owner-scoped authorization and local credentials intact. Native models/tools remain owned by the native runtime. Add adapter and recovery tests with isolated profiles; never use real user credentials in fixtures. Describe the reproduced behavior and tests in your PR. Changes are MIT licensed; preserve upstream notices.

Start with the [code map and adapter contract](docs/adapter-development.md), then pick a [scoped contribution brief](docs/contribution-tasks.md). Include a reproduction, file locations, expected original-task behavior and acceptance commands. Public tests use isolated fixtures and need no production account.

Package and website versions have separate release owners; see [compatibility](docs/compatibility.md). The normal test suite checks current install examples against package.json.
