# WebSocket release boundary

Install `@envarai/connect@2026.1125.3` together with the matching EnvarAI release.
This release intentionally has no legacy server negotiation or HTTP polling
fallback. An existing version-2 connection keeps its identity and credential.
Connect backs up and migrates its private SQLite journal in place before use;
stop the old receiver first. Version-1 connection configurations require new
owner-approved onboarding. Keep every original journal and its backup for recovery.

Removed: `envar-connect connector`, `connect --agent`, legacy CLI wrappers,
version-1 connection configuration, legacy device pairing and HTTP receiver
routes. Current service use, receiving and spending permissions remain separate.
The previously approved `work:read`, `work:send`, `work:receive` and
`work:report` OAuth scopes keep their exact values; v2 does not invent
`task:*` aliases or silently grant broader authority.

The transport is WSS JSON-RPC with `envar.connect.v2` as its WebSocket subprotocol.
This transport version is separate from native A2A 1.0 and the tagged native/CLI
execution references. An A2A task reference must not be fabricated for a CLI.

A runtime capability such as input, cancellation or restart lookup is available
only when its adapter actually implements it. WebSocket support does not enable
additional native runtime capabilities.

A control message for a task canceled before native admission may arrive without
a local execution record. Connect reads the original server task before clearing
that message. An unknown or still-running task stays unacknowledged, and Connect
does not start a replacement native execution or replay the control.

Use standalone Connect for current receiving; preserve original execution journals for recovery.
