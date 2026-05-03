# Stripe Webhook Smoke Test (manual)

A one-shot procedure for verifying Stripe webhook handling against a
deployed environment. Run after any change that touches:

- `server/src/routes/billing.ts` (webhook handler)
- Stripe SDK or signature verification logic
- `STRIPE_WEBHOOK_SECRET` rotation
- Stripe API version bump

## Why this is manual, not E2E

The Stripe CLI's `trigger` command sends real signed webhooks to a real
endpoint. Automating this in CI requires a stripe test-mode account with
unique credentials per branch — the operational cost outweighs the catch
rate. A 5-minute manual smoke after billing changes is the better trade-off.

## Prerequisites

1. **Stripe CLI installed locally:**
   ```bash
   brew install stripe/stripe-cli/stripe
   stripe --version
   ```
2. **Stripe test-mode account** — log in with `stripe login`. You'll be
   redirected to the dashboard to authorize the CLI.
3. **Webhook endpoint URL** — `https://founderos.fly.dev/api/billing/webhook`
   (or your env's equivalent).
4. **Logged-in tail**: open a second terminal with:
   ```bash
   fly logs -a founderos | grep -i stripe
   ```

## The smoke

Trigger each event you want to verify lands and processes correctly:

```bash
# Successful checkout — exercises the happy path subscription create
stripe trigger checkout.session.completed \
  --add api_endpoint=https://founderos.fly.dev/api/billing/webhook

# Subscription updated — exercises the plan-change path
stripe trigger customer.subscription.updated \
  --add api_endpoint=https://founderos.fly.dev/api/billing/webhook

# Invoice paid — exercises post-trial billing
stripe trigger invoice.paid \
  --add api_endpoint=https://founderos.fly.dev/api/billing/webhook

# Failed payment — exercises the dunning path
stripe trigger invoice.payment_failed \
  --add api_endpoint=https://founderos.fly.dev/api/billing/webhook
```

For each event, in the `fly logs` tail look for:

| Signal | Meaning |
|---|---|
| `[stripe] webhook received: <event-type>` | handler entered |
| `[stripe] verified signature` | secret + signature working |
| `[stripe] processed <event-type> in <ms>` | handler completed |
| `[stripe] db row <table> upserted` | DB side-effect succeeded |

## Failure modes and fixes

### `signature verification failed`
- `STRIPE_WEBHOOK_SECRET` env var doesn't match what the live endpoint is
  configured with on the Stripe dashboard. Rotate and redeploy.

### `unknown event type` warning
- The handler doesn't have a case for this event type. Either it's
  unimportant (just log and ignore) or you need to add a case. Check the
  handler's switch statement.

### Handler exception
- Read the stack trace in fly logs. Common causes: schema drift after a
  migration didn't run on prod, missing FK row (e.g. customer not
  pre-created), or Anthropic API call inside the handler timing out
  (handlers should be fast — push slow work to a queue).

### No log line at all
- Either the webhook never reached the server, OR the server crashed
  before logging. Check Stripe dashboard's webhook attempt log for the
  request status code.

## After the smoke

1. **Verify DB state** — for each event, check the relevant row was
   created/updated:
   ```bash
   fly ssh console -a founderos -C 'psql $DATABASE_URL -c "SELECT id, status, updated_at FROM subscriptions ORDER BY updated_at DESC LIMIT 5"'
   ```
2. **Clean up test data** — Stripe test-mode events leave fake customer
   rows. They're isolated by test-mode flag but still pollute admin views.
   Delete via the Stripe dashboard or `stripe customers delete`.

## When to skip this smoke

Unit tests in `server/src/__tests__/billing-*.test.ts` cover signature
verification and individual event handler logic. If the change is
isolated to a single event handler and the unit test for that handler
passes, you can skip the full smoke. The smoke catches what unit tests
can't: webhook routing, env var loading, real Stripe payload shape, and
the prod DB pool being reachable from the handler.

Skip is NOT okay when:
- `STRIPE_WEBHOOK_SECRET` was rotated.
- A new event type was added (signature verification drifts silently).
- Stripe API version was bumped (event payload shape changes).
- The handler's DB driver or pool config changed.
