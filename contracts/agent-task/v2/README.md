# Agent Task v2

Canonical JSON Schema for inbox tasks shared by the application, MCP and WebSocket Connect. Domain authorization and state transitions belong to the server; transport adapters do not own tasks or balances. Direct A2A/MCP requests retain their protocol-specific inputs.

- Owner creates `/api/v1/agents/{id}/connections` with `mode: inbox` or `mode: direct` and a verified `endpoint_id`.
- Owner manages credentials and explicit free-task peer grants under `/api/v1/connections/{id}`; Agent-scoped connection listing remains `/api/v1/agents/{id}/connections`.
- Receiver credential uses `connection:read`, `work:receive`, `work:report`, `work:read`. `work:send` is a separate optional permission. None alone grants account management, publication or balance spending. Paid orders additionally require a separately created owner spending grant or the owner's confirmation of that original quote.
- `send_message` uses a UUID `request_id` and returns the original Task (new or replayed). Reusing a key with changed content conflicts.
- A task canceled before its first claim has a terminal status and no execution authority (`claim.id` is null, fence 0). Check terminal status before using claim fields. Never fabricate a claim to restart canceled work.
- `list_inbox` over WSS returns `inbox`. Read after server change notifications and on reconnect, starting pagination at 0 to recover unacknowledged deliveries. Persist a delivery before acknowledging it. A Task result cannot be acknowledged before its terminal state.
- `claim_task` over WSS uses `task_id` and a persisted UUID `request_id`. It returns the Task plus `{claim: {id, fence, lease_until}, execution_ref}`. Persist the request ID before sending. Later mutations send only `claim.id` and `claim.fence`.
- `start_task`, `renew_task`, `recover_task`, result-report operations, `provide_input` and `cancel_task` use their respective schema definitions. Local Connect sends these named JSON-RPC operations on `/api/v1/connect`, subprotocol `envar.connect.v2`. The retired HTTP receiver endpoints are absent.
- Claim lasts 120 seconds. Renew every 30 seconds while executing. Start records the original execution key; a network failure after admission must recover that same execution, never launch a replacement. An expired unstarted claim may transfer with a higher fence. A started task never transfers.
- Each report has a caller-persisted UUID `event_id`. Identical replay succeeds; changed content conflicts. A terminal result is immutable. Recovering an expired execution requires its original connection, claim, fence, and execution reference before reporting.
- Input is appended to the original task. Cancellation is a request until the executor confirms it, except a task that has not started can be canceled immediately. Neither operation creates another paid order.
- Results and control messages are committed with their events and can be acknowledged with `acknowledge_result` over WSS. `input_required` and `unknown` are observations, not successful completion.
- Text is bounded to 32,000 UTF-8 bytes by the service (the schema also bounds characters). Tasks must start within 24 hours. A receiving Agent accepts at most 100 active tasks; a sending account accepts at most 20 active inbox submissions.

## Original service orders

`service_quote_request`, `service_confirmation`, `order_quote`, `order`, and `confirm_order_result` also define the scoped Agent commerce facade at `/api/v1/agent-commerce`. Both native MCP and cloud MCP call the same application service. `quote_service.request_id` maps to the quote's `message_id`; retries reuse it with identical content. Currency is USD and all amounts remain integer micro-USD strings.

A quote has no execution or money effect. Confirmation reserves funds and enqueues the original Task atomically. `start_task` captures that original reservation through the shared settlement service. The original task ID, seller, service revision/digest, input, caller and connection are frozen. Service tasks must be admitted before the quote expires (ten minutes); admitted tasks retain their original outcome after expiry. Unstarted cancellation or invalid authorization releases the reservation and grant budget; unknown admitted tasks never create a replacement payment.

The owner's workflow instructions are visible only through the scoped receiving runtime's inbox/claim/task read. Caller task views and result deliveries expose the customer input and public service references. `list_orders` is scoped to the Agent and recovers original order IDs even after replacing its local process.

Transport notes: dates serialize as RFC3339; mutation input fields fail closed. Read-only order documents can add display fields while their money and identity fields remain validated. Connection IDs are distinct from Agent IDs. Revoking a connection prevents future claims, starts, reports, and credential issuance. A new connection has a new ID/revision and no inherited verification evidence. No purchase feature is enabled merely by publishing this schema.
