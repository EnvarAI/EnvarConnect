# Versions and compatibility

Install the release documented by this checkout:

```sh
npm install --global --ignore-scripts @envarai/connect@2026.1114.1
envar-connect --version
```

The version above comes from package.json. `npm run version:date` updates it and
the other current installation examples; the normal test suite rejects stale
commands. Historical migration examples keep their original versions.

## Which version controls what?

| Component | Source of truth | Upgrade behavior |
| --- | --- | --- |
| Standalone Connector | This package's package.json / npm release | Upgrade the package, preserve the original directory, and restart its receiver and native MCP process as instructed. |
| Envar's browser-generated command | The deployed server/web release's fixed package and SHA-512 manifest | The website may deliberately pin a reviewed version. It is not automatically npm latest. |
| Legacy `envarpay connector` | The Connect dependency bundled in that installed Pay package | Updating standalone Connect does not replace the version inside Pay. Use standalone Connect for a new native connection. |
| Agent Work protocol | [v1 schema](../contracts/agent-work/v1/schema.json) | Package calendar versions do not change the protocol version. Incompatible changes require a new protocol version. |
| Native runtime | The existing Hermes/OpenClaw installation | Installing Connect does not upgrade the runtime, change its model, or grant tool permissions. |

Keep only one receiver for a journal. The website and Pay dependency should be
promoted only after that consumer's contract and installation checks pass.
A newer package release alone does not establish that an existing receiver was
upgraded or that every supported runtime was retested.

## Runtime scope

Node.js 22.14+ is required; Node 24 is recommended. CI runs the minimum 22.14.0
and current Node 22/24 lines. Linux process locks require util-linux `flock`;
the managed container includes it. Preserve the journal on a filesystem that
supports the locks.

The last recorded native setup baseline is Hermes 2026.9.24 and OpenClaw
2026.10.4. The local adapter tests cover the protocol and recovery boundaries;
they do not call a model or prove acceptance on every later native version.
Report your exact native version with any compatibility issue.

Both native adapters currently observe original Tasks, but do not advertise
input continuation or confirmed cancellation. A gateway restart may lose its
in-memory Task. Keep that operation unknown and inspect it; never create a
replacement simply because observation timed out.

## Another Envar origin

The Connector accepts an explicitly selected HTTPS origin:

```sh
envar-connect connect --origin https://your-envar.example --agent AGENT_UUID --framework hermes
```

The origin must implement the same enrollment and Agent Work contract. This
package does not contain that server. Loopback HTTP is a deliberate development
option, not a way to send credentials to arbitrary HTTP hosts. The original
journal binds the origin, connection, Agent and native adapter; do not edit those
fields to reuse another connection's task or spending authority.

Read [native setup](native-connector.md), [migration](migration.md), and
[adapter development](adapter-development.md) before changing an installation.
