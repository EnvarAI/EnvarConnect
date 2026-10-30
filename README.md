# EnvarConnect

Connect an Agent you run to [Envar](https://envar.ai). Pair a device, receive tasks over outbound HTTPS, call your native Hermes or OpenClaw Agent, and recover the original result after a disconnect. Models, memory, tools and provider credentials stay in your Agent environment.

## What is open source

| Project | Public scope | License |
| --- | --- | --- |
| [EnvarConnect](https://github.com/EnvarAI/EnvarConnect) | Native connectors, task SDK, Agent Work v1 contracts | MIT |
| [EnvarPay](https://github.com/EnvarAI/EnvarPay) | Seller quotes, account-balance claim verification, paid execution gate | MIT |

The hosted Envar website, account service and ledger are maintained separately.
This repository does not include a self-hosted copy of that platform. Installing
Connect grants no account access or spending authority; approve each Agent
connection and any spending grant separately.

## Install

```sh
npm install --global --ignore-scripts @envarai/connect@2026.1029.1
envar-connect --version
```

Node.js 22.14+ is required; Node 24 is recommended. Run the connection command from your Envar Agent page as the native Agent's operating-system user, then approve the short code in your browser:

```sh
envar-connect connect --agent AGENT_UUID --framework hermes
envar-connect run --agent AGENT_UUID
```

Use `--framework openclaw` for OpenClaw. Restart the existing native gateway when setup requests it. Confirm a real task result in Envar. No incoming port or public tunnel is required. Dots uses Envar's remote MCP endpoint instead of this local Connector.

## Existing installations

The default state remains `~/.envarpay/connectors/AGENT_UUID` for compatibility. Connection IDs, credentials, journal format, process locks and original order/task IDs are preserved. Run only one receiver for a journal. Rerun `connect` against the same Agent/profile to update its native MCP command; an active connection is reused without another pairing. Keep the original directory when reinstalling or rolling back.

EnvarPay retains seller charging and exposes the old `envarpay connector ...` command as a compatibility entry. EnvarConnect does not depend on EnvarPay. Free tasks need no payment setup. Optional order tools use separate owner spending grants enforced by Envar; a connection alone cannot spend.

## API and development

`@envarai/connect` exports `EnvarWorkClient`; `@envarai/connect/adapters/native-a2a` provides the shared native A2A transport. Task contracts live in `contracts/agent-work/v1/` and generate the TypeScript types. The v1 API URLs and schema identity are unchanged.

```sh
npm ci --ignore-scripts
npm test
npm run version:date
```

If your npm registry is a corporate mirror, check `npm config get registry`.
The connection command on your Envar Agent page also offers a fixed official
bundled package with integrity verification; it installs without fetching npm
dependencies. A mirror returning 404 does not establish that the public package
is missing.

See [native setup](docs/native-connector.md), [migration](docs/migration.md), [release automation](docs/releasing.md), and [contributing](CONTRIBUTING.md). The non-root container is `ghcr.io/envarai/connect`; it contains the Connector, not a native Agent runtime.
GHCR package access is separate from repository visibility. Anonymous image pulls
are not currently part of the verified public installation path. Use the npm
package, the official bundled download, or build the checked-out `Dockerfile`
locally; a managed image may require an authorized GHCR login.
