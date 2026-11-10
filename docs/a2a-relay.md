# Outbound standard A2A relay

A compatible Envar server can negotiate `a2a-relay.v1` alongside Agent Work v1.
The transport carries standard A2A 1.0 requests and Task/Message responses;
it is not an arbitrary TCP tunnel and requires no public port on the Agent.
The receiver validates the original command, persists its execution checkpoint
before a native send, and preserves ordered receipts and the original Task ID
in the existing private SQLite journal.

Only one native execution runs at a time. Unknown outcomes block new execution.
Lost responses are recovered with the original Task reference when available,
never by creating another Task. Restoring an old journal backup is not proof
that an admitted task was never dispatched: an expired admission without native
evidence is reported as unknown and requires original-task recovery or an
explicit audited resolution. Do not delete the journal or clear unknown records
to make an upgrade appear successful.

A native Card lookup that fails before admission is retryable. Once a send may
have occurred, only its durable receipts and original GetTask can advance the
record. Permanent oversized/schema-rejected snapshots remain in the private
journal and produce a bounded incomplete-receipt report, rather than silently
claiming completion. Immediately completed Tasks and recovered reference-only
Tasks retain the required original lookup evidence for platform enrollment.

The owner selects and tests an explicitly free service before the platform
advertises it through its public Card. Marketplace orders use the same frozen
order authorization; the connection itself grants no spending authority.
Private inventory and legacy paid workflows retain Agent Work v1 until their
buyer-only artifact contract is separately verified.

This release declares original Task lookup only. Native input, admitted-task
cancellation, durable lookup after native runtime restart, media artifacts and
streaming remain unverified and disabled. A package version or Card claim alone
cannot enable these capabilities. Upgrade through the existing connection
instructions, preserving credentials, native binding, SQLite journal and lock.
