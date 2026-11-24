# Runtime diagnostics

`envar-connect doctor` and receiver startup report the installed Connector version,
the native runtime's version and separate recovery capabilities to the original
Envar connection. They do not invoke a model, create a task or grant permissions.
`doctor` now writes this bounded diagnostic report to Envar as well as printing it
locally. A real task/result test is still required to verify delivery.

The authenticated `report_runtime` operation runs over the same WSS connection
as task delivery (`/api/v1/connect`, subprotocol `envar.connect.v2`). It requires
`connection:read`, `work:receive` and `work:report` scopes. The `get_connection`
response exposes the saved report as `runtime`. No HTTP diagnostics fallback is
used. The report contains no native URL, credential, local profile path, prompt
or result; it cannot grant spending authority or enable concurrency.

```json
{
  "schema_version": 1,
  "connector_version": "<installed package version>",
  "adapter": "hermes",
  "runtime_version": "<version reported by the Agent Card, or unknown>",
  "version_source": "agent_card",
  "capabilities": {
    "task_lookup": true,
    "task_lookup_after_restart": false,
    "execution_key_lookup": false,
    "result_persistence": false,
    "input": false,
    "cancel": false,
    "max_concurrency": 1
  }
}
```

The Card version may describe its A2A implementation rather than the native CLI
release. Do not present it as a separately verified installation version. Missing
or invalid version text is reported as `unknown`.

The original `RuntimeReadiness.capabilities.recover` flag means that the adapter
can query a saved original Task reference. It does not imply that the gateway
preserves that Task after a restart. Optional `recovery` fields describe the
additional guarantees independently. Unspecified guarantees are false. Each adapter advertises only the guarantees it implements. CLI adapters persist
original execution results locally. A persisted terminal result does not by itself
prove recovery of an interrupted native execution.

Reports are sampled at receiver startup or an explicit `doctor` run, rather
than continuously refreshed. Authorization failures stop the receiver. Other
transport failures reconnect through WSS while retaining original task and
report identities; they never switch to HTTP.

CLI adapters use `version_source: "cli_version"`. Selected service profiles add
only `execution_profile.mode`, `digest` and `skill_count`; configuration bytes and
credentials remain local. See [service profiles](service-profiles.md).

When upgrading, stop the original receiver, preserve its private state directory,
install the reviewed package and restart against that same directory. Check
`doctor`, then verify the original pending task/result before starting new work.
Do not delete the journal, replace the Agent identity or replay an unknown native
request to make an upgrade appear successful. Roll back only to a version that
has passed journal/contract compatibility checks for the same state.
