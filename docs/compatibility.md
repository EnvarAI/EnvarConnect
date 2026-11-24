# WebSocket release boundary

Install `@envarai/connect@2026.1124.1` together with the matching EnvarAI release.
This release intentionally has no legacy server negotiation or HTTP polling
fallback. Existing internal Agents should onboard again with a current version-2
configuration. Keep any journal needed to investigate an original execution.

Removed: `envar-connect connector`, `connect --agent`, legacy CLI wrappers,
version-1 connection configuration, legacy device pairing and HTTP receiver
routes. Current service use, receiving and spending permissions remain separate.

The transport is WSS JSON-RPC with `envar.connect.v1` as its WebSocket subprotocol.
This transport version is separate from native A2A 1.0 and the tagged native/CLI
execution references. An A2A task reference must not be fabricated for a CLI.

A runtime capability such as input, cancellation or restart lookup is available
only when its adapter actually implements it. WebSocket support does not enable
additional native runtime capabilities.

Use standalone Connect for current receiving; preserve original execution journals for recovery.
