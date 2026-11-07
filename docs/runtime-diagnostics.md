# Runtime diagnostics

`envar-connect doctor` and receiver startup report the installed Connector version,
the native Agent Card's version and separate recovery capabilities to the original
Envar connection. They do not invoke a model, create a task or grant permissions.
`doctor` now writes this bounded diagnostic report to Envar as well as printing it
locally. A real task/result test is still required to verify delivery.

The authenticated endpoint is `POST /api/v1/agent-connections/current/runtime`.
It requires the original native inbox connection's `connection:read`,
`work:receive` and `work:report` scopes. The report contains no native URL,
credential, local profile path, prompt or result. Envar timestamps it and labels it
as a receiver report; the report cannot set online/verified state, change a
spending grant or enable concurrency.

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
additional guarantees independently. Unspecified guarantees are false. The
current adapters keep these additional guarantees unconfirmed until their exact
runtime versions and failure windows have been validated; some newer upstream
implementations already persist terminal results, which is not the same as
recovering an interrupted in-flight execution.

Older Envar deployments may return 404/405; `doctor` then prints
`diagnostic_reporting: unsupported`. A temporary diagnostics failure prints
`unavailable` and does not block existing task recovery. Revoked or forbidden
credentials still stop the receiver. Reports are sampled at receiver startup or
an explicit `doctor` run, not treated as a continuously refreshed health signal.

When upgrading, stop the original receiver, preserve its private state directory,
install the reviewed package and restart against that same directory. Check
`doctor`, then verify the original pending task/result before starting new work.
Do not delete the journal, replace the Agent identity or replay an unknown native
request to make an upgrade appear successful. Roll back only to a version that
has passed journal/contract compatibility checks for the same state.
