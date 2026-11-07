# Build and verify a runtime adapter

Start with the existing interfaces, rather than inventing another task protocol:

| Code | Responsibility |
| --- | --- |
| `src/adapters/types.ts` | RuntimeAdapter, capabilities, observation and original execution reference |
| `src/adapters/a2a-runtime.ts` | Existing Hermes/OpenClaw A2A implementation |
| `src/adapters/native-a2a.ts` | Native Card and endpoint validation, SendMessage/GetTask transport |
| `src/connector/loop.ts` | Claim, admission, heartbeat, dispatch, pending reports and recovery |
| `src/connector/state.ts` | Durable journal and original runtime binding |
| `contracts/agent-work/v1/schema.json` | Public work/report contract |

## Adapter contract

- `probe()` reports the runtime and capabilities it can actually demonstrate.
- `start(work, executionKey)` receives the original work ID after durable admission.
  Call the native operation once. Do not retry an uncertain POST.
- `observe(reference)` only reads the original Task/session handle. The reference
  must bind the original runtime and must contain no credential.
- `provideInput` and `cancel` must distinguish a request from a confirmed native
  action. An unsupported capability is not a successful cancellation.
- `close()` releases the adapter's client resources; the runtime lifecycle belongs
  to its operator.

Do not reuse display names as authorization, move model/provider credentials
into the platform, or create a substitute execution when the original is unknown.

## Work locally without a production account

```sh
npm ci --ignore-scripts
npm test
# Focused iteration:
node --test test/connector-adapters.test.mjs test/connector-loop.test.mjs
```

These tests run actual local transports and journals against isolated fixtures.
They require no Envar account or model payment. They are protocol tests, not a
claim that a public WorkService server or a real model ran.

Use the current fixtures in those files as the reference for a new adapter.
An implementation should show:

1. One native dispatch for an admitted original task.
2. Restart reads the same saved handle and replays the same pending event.
3. A lost send response remains unknown, without another SendMessage.
4. A changed Card/origin/reference cannot redirect the native credential.
5. Result delivery persists before acknowledgement.
6. Unsupported input/cancel is reported honestly.

For a real native integration, use an isolated profile you own and document its
exact version. Keep keys, prompts, private files and personal profiles out of the
PR. Include sanitized original IDs and observed state transitions, not secrets.

## First contributions

The maintained task briefs are in [contribution tasks](contribution-tasks.md).
Discuss a new runtime or incompatible schema change before building it. Contract
tests can be reviewed publicly; access to production credentials is not needed.
