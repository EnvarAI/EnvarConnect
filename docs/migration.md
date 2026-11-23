# Existing Connector installations

New installations use `~/.envar` for the CLI, downloads, enrollment requests and connection state. A receiver keeps its binding and SQLite journal under `connectors/AGENT_UUID`.

Upgrades automatically detect the earlier `~/.envarpay` state root and continue using it in place. Merely installing the new CLI under `~/.envar/cli` does not move or duplicate an existing connection. The explicit `--directory PATH` option always selects the original directory.

1. Keep the original credentials, native binding, task/order IDs and owner-only permissions. Do not copy a live journal to a second directory.
2. Install the reviewed standalone Connector. Stop the old receiver before starting its replacement against the same directory.
3. Run `envar-connect connect` with the same Agent/framework/profile when its native MCP entry needs updating. Restart the existing native gateway only when requested.
4. Read the original task/order after restart. An uncertain outcome stays attached to that original execution; it is not a new purchase.

If both roots contain state, use an explicit Agent ID or the original directory. A duplicate Agent directory is rejected rather than silently selecting a different credential or journal. For new onboarding, select the intended root with `--state-root PATH`; the software does not delete or merge roots automatically. Container installations can use this option to keep state on their existing persistent volume.

Earlier package/command migration evidence is retained in the [historical migration record](_archive/original-connector-migration.md). These are recovery references, not current installation instructions.
