# Moving from EnvarPay Connector

EnvarConnect is extracted from the MIT EnvarPay Connector at `2a9e03ebfd0beb9a167ad57473ead56ec5dd9bf5`. It retains the v1 protocol and SQLite journal layout.

1. Keep the original state directory and its owner-only permissions. Stop the old receiver before starting the new one; do not remove its journal or binding files.
2. Install the reviewed `@envarai/connect` version. `envar-connect run --agent ID` reads the existing `~/.envarpay/connectors/ID` binding. A custom installation uses the original `--directory PATH`.
3. Run `envar-connect connect` with the same Agent/framework/profile to update the native MCP entry. It preserves the active connection and native peer credential. Restart the existing native gateway when requested, then start one receiver.
4. Read the original task/order after restart. Reuse persisted request IDs; never buy again to recover a delayed result.

Rollback uses the prior EnvarPay package against the same state directory, after stopping the new receiver. Both implementations understand the same journal. Rerun its original connect command if its native MCP command needs restoring. Connection permissions and spending grants are unchanged.
