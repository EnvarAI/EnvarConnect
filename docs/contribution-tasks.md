# Contribution tasks

These are scoped contribution briefs, not promises that every runtime is
supported. Open an issue describing the brief and your proposed work before
starting a large change; maintainers can confirm whether someone is already
working on it.

| Brief | Reproduce / inspect | Files | Acceptance |
| --- | --- | --- | --- |
| C1 — Document one additional native version | Use an isolated profile with the [native guide](native-connector.md); record installation, probe, then an explicitly authorized free task separately. | `docs/native-connector.md`, `docs/compatibility.md` | Exact OS/Node/runtime versions, sanitized failure or real result; no “all versions supported” claim. A model call is optional and its own operator's responsibility. |
| C2 — Multi-byte result boundary coverage | The adapter limits text by UTF-8 bytes and rejects empty completion. Add a case straddling that limit with multi-byte text. | `src/adapters/a2a-runtime.ts`, `test/connector-adapters.test.mjs` | The oversized original result fails clearly without a second native send; valid boundary text is preserved. |
| C3 — Actionable missing-runtime diagnostics | Reproduce missing executable, ambiguous OpenClaw profile or missing Linux flock in an isolated setup. Improve only a demonstrated unclear error. | `src/adapters/configure-native.ts`, `src/connector/state.ts`, `test/connector-setup.test.mjs` | The error identifies the operator action; it does not select another profile, remove an active lock, or print a credential. |
| C4 — Consumer compatibility recipe | Build a small consumer using the public EnvarWorkClient/RuntimeAdapter contracts against a local test fixture. | `src/index.ts`, `src/adapters/types.ts`, `contracts/agent-work/v1/` | Document inputs, exact IDs and replay behavior; distinguish fixture execution from native acceptance, and use no cloud secret. |

Every PR should state the problem, before/after behavior, tests, and compatibility
impact. Run `npm test`; focused file tests help iteration but do not replace the
normal CI discovery command.

## Maintenance and feedback

GitHub Issues is the public support and design entry. Maintainers aim to give
an initial response within two business days and a substantive review or an
explicit next step within five business days. This is a best-effort maintenance
target, not a service-level agreement; availability and scope should be stated
on the issue when a response takes longer.

Issues are triaged as reproducible bug, documentation, compatible enhancement,
design discussion, or outside current scope. A decision to defer is useful when
it includes the reason and the supported alternative. Security reports follow
[SECURITY.md](../SECURITY.md), not a public issue with credentials.

Current focus: reproducible setup, compatibility, original-operation recovery,
and useful adapters. Hosted models, implicit spending permissions and automatic
resubmission of unknown work are outside this Connector's responsibility.
