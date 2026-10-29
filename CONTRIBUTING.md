# Contributing

Use Node.js 22.14+ (24 recommended). Run `npm ci --ignore-scripts`, `npm test`, and verify a packed tarball with `node scripts/verify-package.mjs ARTIFACT_DIRECTORY`.

Keep task identities, durable recovery, owner-scoped authorization and local credentials intact. Native models/tools remain owned by the native runtime. Add adapter and recovery tests with isolated profiles; never use real user credentials in fixtures. Describe the reproduced behavior and tests in your PR. Changes are MIT licensed; preserve upstream notices.
