# Local service profiles

Codex and Claude Code default to isolated text execution. To expose selected
local skills, tools and MCP servers, choose a dedicated owner-only profile:

```sh
envar-connect onboard --runtime codex --receive \
  --workspace /srv/envar/jobs --service-profile /srv/envar/codex-profile \
  --approve-local-configuration --install-receiver --json
```

The profile directory must be mode 0700. Codex uses its native `config.toml`;
Claude Code uses `settings.json` and optional `mcp.json`. Put approved skills in
`skills/<name>/SKILL.md`, local MCP/tool scripts in `tools/`, and optional project
instructions in `AGENTS.md` or `CLAUDE.md`. Symlinks are rejected; the selected
configuration is bounded to 512 files / 8 MiB. Other files, including native
login caches and conversation history, are not copied into task workspaces.
Codex-managed `skills/.system` is excluded from the seller fingerprint and job
copy; built-in runtime skills remain governed by native configuration.

Each task gets a separate workspace with copies of the approved skills, tool
scripts and instructions. Codex sees `.agents/skills`; Claude sees
`.claude/skills`. The dedicated profile remains the native configuration/login
home. The process HOME is the dedicated profile’s `home/` directory, so implicit personal-home configuration is not imported. Configure tool credentials through explicit environment references. Native permission rules and system/organization policies still apply. Connect never adds a permission
bypass flag or grants platform spending from a local profile. Configure only
the headless tools the service is intended to use; unexpected approval requests
must fail or be handled through the runtime's normal owner controls.

MCP script arguments may be relative to the task workspace, such as
`tools/calculator.mjs`. Configuration and skill/tool bytes are fingerprinted.
They are checked again before admission and dispatch. Environment references
`${NAME}` and Codex's declared MCP `env_vars` are retained in the receiver's
private environment snapshot. No configuration contents, credentials or local
paths are sent to Envar; diagnostics contain only the digest and skill count.

Service revisions bind the reported profile digest. Changing the profile
invalidates the old publication and requires a new service revision and actual
result test. A queued task cannot capture payment under a different profile.
Already saved execution receipts remain readable and are never rerun merely
because configuration changed. The fingerprint is a configuration binding,
not an attestation of the implementation of an external MCP service.

The model/provider remains the one selected in the native profile. A profile
with only its model settings is not evidence that a skill or MCP tool ran:
validate the selected skill and its actual tool result before publishing.
