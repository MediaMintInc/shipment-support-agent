# Shipment agent evaluation report

- **Run ID:** `deterministic-test`
- **Started / finished:** 2026-11-08T07:30:56.151Z → 2026-11-08T07:30:58.151Z
- **Model:** scripted / `scripted-model` (**scripted model — deterministic test, not real LLM behaviour**)
- **Repeats per case:** 1
- **Backend (mock) settings:** timeout 300 ms, max retries 2
- **LLM judge:** disabled — quality scores unavailable
- **Network guard blocked:** none

## Summary

| Metric | Value |
|---|---|
| Case runs | 6 |
| Passed / failed | 6 / 0 |
| Pass rate | 100.0% |
| Cases passing all repeats | 6 / 6 |
| Tokens | unavailable (token usage not reported) |
| Estimated cost (USD) | unavailable (scripted model (no LLM)) |

| Case | Runs | Passes | Pass rate | Mean latency (ms) | Mean quality (1-5) |
|---|---|---|---|---|---|
| `status-lookup` | 1 | 1 | 100% | 184 | unavailable |
| `missing-shipment-id` | 1 | 1 | 100% | 139 | unavailable |
| `temporary-backend-failure` | 1 | 1 | 100% | 154 | unavailable |
| `persistent-timeout` | 1 | 1 | 100% | 1065 | unavailable |
| `ticket-retry-idempotent` | 1 | 1 | 100% | 194 | unavailable |
| `multi-turn-context` | 1 | 1 | 100% | 171 | unavailable |

## Case details

### ✅ `status-lookup` (run 1)

Valid shipment status lookup returns status, destination and ETA from tool data.

- Latency: 184 ms · Tokens: unavailable · Cost: unavailable (scripted model (no LLM))
- Quality: unavailable (LLM judge not enabled (use --judge))
- Backend requests: 1 · Tickets created: 0

| Turn | Tool (MCP wire) | Arguments | Result | ms |
|---|---|---|---|---|
| 1 | `get_shipment_status` | `{"shipment_id":"SHP-100001"}` | ok | 20 |

> **User (turn 1):** What's the status of shipment SHP-100001?
>
> **Agent:** Shipment SHP-100001 is IN_TRANSIT from Austin, TX to Denver, CO, estimated delivery 2026-11-10.

### ✅ `missing-shipment-id` (run 1)

No shipment ID given; the agent must ask for it without calling any tool.

- Latency: 139 ms · Tokens: unavailable · Cost: unavailable (scripted model (no LLM))
- Quality: unavailable (LLM judge not enabled (use --judge))
- Backend requests: 0 · Tickets created: 0

| Turn | Tool (MCP wire) | Arguments | Result | ms |
|---|---|---|---|---|
| 1 | _(no tool calls)_ | | | |

> **User (turn 1):** Where is my package? It was supposed to arrive yesterday.
>
> **Agent:** Could you share your shipment ID? It starts with SHP- followed by digits.

### ✅ `temporary-backend-failure` (run 1)

Backend returns 503 twice then succeeds; the adapter retries within the configured limit (max 3 attempts) and the agent reports the real status.

- Latency: 154 ms · Tokens: unavailable · Cost: unavailable (scripted model (no LLM))
- Quality: unavailable (LLM judge not enabled (use --judge))
- Backend requests: 3 · Tickets created: 0

| Turn | Tool (MCP wire) | Arguments | Result | ms |
|---|---|---|---|---|
| 1 | `get_shipment_status` | `{"shipment_id":"SHP-100001"}` | ok | 23 |

> **User (turn 1):** What's the status of SHP-100001?
>
> **Agent:** Shipment SHP-100001 is IN_TRANSIT.

### ✅ `persistent-timeout` (run 1)

Backend never answers in time; retries are bounded, the agent stops and explains the failure without inventing a status.

- Latency: 1065 ms · Tokens: unavailable · Cost: unavailable (scripted model (no LLM))
- Quality: unavailable (LLM judge not enabled (use --judge))
- Backend requests: 3 · Tickets created: 0

| Turn | Tool (MCP wire) | Arguments | Result | ms |
|---|---|---|---|---|
| 1 | `get_shipment_status` | `{"shipment_id":"SHP-100001"}` | error: TIMEOUT | 921 |

> **User (turn 1):** What's the status of SHP-100001?
>
> **Agent:** Sorry, the shipment system timed out (TIMEOUT). Please try again later.

### ✅ `ticket-retry-idempotent` (run 1)

The ticket POST commits but the response is lost (503); the adapter retries with the same idempotency key and the backend creates only one ticket.

- Latency: 194 ms · Tokens: unavailable · Cost: unavailable (scripted model (no LLM))
- Quality: unavailable (LLM judge not enabled (use --judge))
- Backend requests: 2 · Tickets created: 1 (TCK-5001)

| Turn | Tool (MCP wire) | Arguments | Result | ms |
|---|---|---|---|---|
| 1 | `create_support_ticket` | `{"shipment_id":"SHP-100002","category":"LOST","description":"Marked delivered but customer never received the package",…` | ok | 22 |

> **User (turn 1):** Please create a support ticket for SHP-100002 - the package was marked delivered but I never received it.
>
> **Agent:** I created support ticket TCK-5001 for SHP-100002.

### ✅ `multi-turn-context` (run 1)

Shipment ID given in turn 1 is reused for follow-up questions and the explicit ticket request in turn 3.

- Latency: 171 ms · Tokens: unavailable · Cost: unavailable (scripted model (no LLM))
- Quality: unavailable (LLM judge not enabled (use --judge))
- Backend requests: 3 · Tickets created: 1 (TCK-5001)

| Turn | Tool (MCP wire) | Arguments | Result | ms |
|---|---|---|---|---|
| 1 | `get_shipment_status` | `{"shipment_id":"SHP-100003"}` | ok | 18 |
| 2 | `get_delivery_exceptions` | `{"shipment_id":"SHP-100003"}` | ok | 18 |
| 3 | `create_support_ticket` | `{"shipment_id":"SHP-100003","category":"DELIVERY_EXCEPTION","description":"Address could not be located: apartment numb…` | ok | 3 |

> **User (turn 1):** Hi, what's the status of SHP-100003?
>
> **Agent:** SHP-100003 has status EXCEPTION.

> **User (turn 2):** Why is it stuck? Are there any delivery exceptions on it?
>
> **Agent:** There is an open address issue: Recipient address could not be located: apartment number missing.

> **User (turn 3):** OK, please open a support ticket about it.
>
> **Agent:** Ticket TCK-5001 has been created for SHP-100003.
