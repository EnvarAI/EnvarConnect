# Stable releases

Versions use `YEAR.MONTHDAY.SEQUENCE` in Asia/Shanghai, matching EnvarPay. Run `npm run version:date` when package or image contents change; commit package.json and package-lock.json together.

Pushes to main that change runtime/package/container files run `publish-npm.yml`. The workflow tests Node 22 and 24, packs once per Node version, installs the actual tarball offline with an empty cache, and builds/runs containers on amd64 and arm64. After those checks it publishes `ghcr.io/envarai/connect:VERSION`, verifies its source/version labels, publishes the tested Node 24 tarball to npm with provenance, verifies version and integrity, updates image latest, and attaches the tarball to GitHub release `vVERSION`.

A retry reuses the same npm artifact and source commit. Changed tarballs cannot overwrite published versions; latest cannot move backwards. Rerun failed jobs on the original run. Workflow-only changes do not publish automatically.

## One-time npm setup

Configure the npm Trusted Publisher for `@envarai/connect`: GitHub owner `EnvarAI`, repository `EnvarConnect`, workflow `publish-npm.yml`, environment `npm`. The GitHub environment is restricted to main. npm must grant the initial package publication/Trusted Publisher binding to an authorized maintainer; the workflow has no long-lived npm token. Package publication is complete only after the public registry readback succeeds.

## Contracts

`contracts/agent-work/v1/schema.json` is the source. Run `node scripts/generate-work-contract.mjs` after editing it. Commit generated types. Publish compatible contracts before updating EnvarAI's pinned copy; incompatible v1 changes require a new contract version. Runtime code never downloads a schema.
