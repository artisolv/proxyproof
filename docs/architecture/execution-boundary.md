# Execution boundary

The UI and the MCP connector are **not** security boundaries. The boundary is `server/src/executor/gate.ts`. It is the only module that imports the PayPal client, and an architecture test enforces this.

## What the executor checks before any side effect

`POST /api/v1/workspaces/:ws/transactions/:id/execute { permit }`

These checks run in order, and any failure refuses the call with a code:

| # | Check | Code on failure |
|---|---|---|
| 1 | A permit is present | `PERMIT_MISSING` |
| 2 | The permit is a JWS signed by ProxyProof's key, with `typ: execution-permit+jwt`, audience `proxyproof-executor`, and is not expired (5 min) | `PERMIT_INVALID` / `PERMIT_EXPIRED` |
| 3 | `sub` is this transaction | `PERMIT_WRONG_TRANSACTION` |
| 4 | `act` is `create_checkout` | `PERMIT_WRONG_ACTION` |
| 5 | `terms_hash` is the transaction's *current* terms hash | `TERMS_CHANGED` |
| 6 | The current decision is ALLOW | `DECISION_*` |
| 7 | The decision receipt hash in the permit matches the stored receipt | `DECISION_CHANGED` |
| 8 | The permit has not been used before | `PERMIT_ALREADY_USED` |
| 9 | Both sides are re-verified on **live** state (revocation, expiry, keys, status service) and still return ALLOW | `LIVE_RECHECK_FAILED` |
| 10 | PayPal is configured, and the sandbox quota is not exceeded | `RAIL_NOT_CONFIGURED` / `SANDBOX_QUOTA` |
| 11 | There is no other live payment attempt for this transaction | `DUPLICATE_PAYMENT` |

**Check 8** is an atomic `UPDATE … WHERE used_at IS NULL`.

**Check 11** is enforced by a unique index on the transaction for attempts that have not failed. PayPal also receives an idempotency key (`PayPal-Request-Id`).

**After these checks:**
- The executor calls Orders v2 `create`.
- It records the order, and the payment state becomes `AWAITING_BUYER_APPROVAL`.
- The buyer approves on PayPal. No agent can.

## Capture

`POST /api/transactions/:id/capture` runs only from the dashboard session, after the buyer's redirect.

1. The terms hash must still equal the hash on the attempt.
2. Both sides are re-verified on live state.
3. Only then is PayPal's capture called.
4. The status is read back through the authenticated `GET order` call.

`COMPLETED` is set only when PayPal reports a capture with status `COMPLETED`. Verified webhooks (`PAYPAL_WEBHOOK_ID`) only prompt that lookup; unverified webhooks change nothing.

## Rail calls need a gate pass

`executor/paypal.ts` refuses `createOrder` and `captureOrder` without a `GatePass`. That object is created only inside `gate.ts` (a `WeakSet` of issued passes), so no other module can call the rail even by mistake.

## What this boundary does not cover

ProxyProof enforces protected actions that are **routed through it**.
- If an external agent also has its own payment credentials, or a browser session with a merchant, or other unrestricted tools, ProxyProof cannot block those.
- Scenario 12 tests direct calls to ProxyProof's own executor. It does not prove control over an agent's other tools.
