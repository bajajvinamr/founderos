# FounderOS Billing & Subscription System

This document describes the scaffolded Stripe billing integration for FounderOS.

## Overview

Wave 12C establishes the foundation for instance-wide subscription management with a $299/month pro plan. The implementation is a **stub scaffold** — database layer and service skeleton are in place, but Stripe API integration is incomplete (see "TODO Items" below).

## Architecture

### Database

Single-row `instance_subscription` table tracks instance-wide subscription state:

```sql
instance_subscription(
  id uuid,
  stripe_customer_id text,
  stripe_subscription_id text,
  plan text,       -- 'free' | 'pro'
  status text,      -- 'active' | 'inactive' | 'past_due' | 'canceled'
  current_period_end timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
```

### Services

- **`StripeClient`** (`server/src/services/stripe-client.ts`) — Low-level Stripe API wrapper
  - `createCheckoutSession()` — TODO: Not implemented
  - `retrieveSubscription()` — TODO: Not implemented
  - `constructWebhookEvent()` — TODO: Webhook verification stub

- **`SubscriptionService`** (`server/src/services/subscription.ts`) — Business logic
  - `getCurrentSubscription()` — Fetch current subscription from DB
  - `isSubscriptionActive()` — Boolean check for gating
  - `handleStripeWebhook(event)` — Process Stripe events; updates DB on subscription changes

### Routes

**`GET /api/billing/status`**

Returns current subscription status. Used by `BillingGate` component on page load.

```json
{
  "active": true,
  "plan": "free"
}
```

**Scaffold Note:** Currently returns `active: true` unconditionally so existing users aren't blocked.

**`POST /api/billing/checkout`** — Returns 501 (Not Implemented)

TODO: Generate Stripe Checkout Session and redirect user.

**`POST /api/billing/webhook`** — Returns 501 (Not Implemented)

TODO: Receive and verify Stripe webhook signature, parse event, update subscription in DB.

### UI Component

**`BillingGate`** (`ui/src/components/BillingGate.tsx`)

Wraps children and shows a subscription card if `status.active === false`. On mount, fetches `/api/billing/status` and:
- Shows children if subscription is active
- Shows "Subscribe to continue" card if inactive, with "Upgrade Now ($299/mo)" button
- Button redirects to `/api/billing/checkout` (currently 501)

Scaffold fallback: On fetch error, defaults to `active: true` so network issues don't gate users.

## Configuration

### Environment Variables

Set these in `.env.local` or your deployment platform:

| Variable | Example | Required | Notes |
|----------|---------|----------|-------|
| `STRIPE_SECRET_KEY` | `sk_test_abc123...` | No (optional) | Test or live secret key. If unset, Stripe integration is disabled and all checks pass. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_abc123...` | No | Endpoint signing secret from Stripe Dashboard → Webhooks. For webhook signature verification (not yet implemented). |
| `STRIPE_PRICE_ID_PRO` | `price_abc123...` | No | Product price ID for the $299/mo plan. Used in checkout session creation (not yet implemented). |
| `FOUNDEROS_BILLING_ENABLED` | `false` (default) | No | Feature toggle. Set to `true` to enable the `BillingGate` on protected routes. Currently recommended to leave `false` to avoid blocking existing users. |

### Disabling Billing (Recommended for Now)

To keep the scaffold in place without blocking existing users:

1. Leave `FOUNDEROS_BILLING_ENABLED=false` (default)
2. `BillingGate` will render children unconditionally for now
3. When Stripe integration is complete, flip the toggle to `true` and apply the gate to protected routes

## TODO Items

### Phase 1: Stripe API Integration

- [ ] Install `stripe` npm package if not already present
- [ ] Implement `StripeClient.createCheckoutSession()` to call `stripe.checkout.sessions.create()`
- [ ] Implement `StripeClient.retrieveSubscription()` to fetch subscription details
- [ ] Implement `StripeClient.constructWebhookEvent()` using `stripe.webhooks.constructEvent()` for signature verification

### Phase 2: Checkout Flow

- [ ] Wire `/api/billing/checkout` to accept a session POST, create Stripe session, return redirect URL
- [ ] Update `BillingGate` button to POST to checkout instead of GET redirect
- [ ] Test checkout → return to app flow

### Phase 3: Webhook Handler

- [ ] Verify Stripe webhook signature in `POST /api/billing/webhook`
- [ ] Test `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` events
- [ ] Update `currentPeriodEnd` on `subscription.updated` to trigger renewal emails

### Phase 4: UI Flow

- [ ] Connect `BillingGate` to actual instance subscription state from DB
- [ ] Add billing history page (invoice list, payment methods)
- [ ] Add subscription cancellation UI

### Phase 5: Monitoring & Compliance

- [ ] Add Stripe event logging and alerting (failed webhook deliveries, payment failures)
- [ ] Wire up dunning (past_due reminder emails)
- [ ] Add tax calculation if EU/UK customers present

## Stripe Dashboard Setup

1. **Create a Product:**
   - Name: `FounderOS Pro`
   - Price: $299/month (recurring)
   - Copy the **Price ID** (format: `price_xxx...`)

2. **Configure Webhook:**
   - Endpoint URL: `https://yourdomain.com/api/billing/webhook`
   - Events: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
   - Copy the **Signing Secret** (format: `whsec_xxx...`)

3. **Test Keys (Development):**
   - Use `sk_test_...` and `whsec_test_...` keys
   - Set in `.env.local` for local testing

4. **Live Keys (Production):**
   - Use `sk_live_...` and `whsec_live_...` keys
   - Set via platform secrets manager

## Testing

### Unit Tests

Subscription service has basic structure; add tests for:
- `getCurrentSubscription()` DB fetch
- `isSubscriptionActive()` status check
- `handleStripeWebhook()` event parsing

### Integration Tests

- Checkout session creation & redirect
- Webhook signature verification
- Database updates on subscription events

### Manual Testing (Local)

1. Start dev server: `pnpm dev`
2. Fetch status: `curl http://localhost:3000/api/billing/status`
3. Expect: `{ "active": true, "plan": "free" }`
4. Try checkout: `curl -X POST http://localhost:3000/api/billing/checkout`
5. Expect: `501 Not Implemented`

## References

- Stripe API Docs: https://stripe.com/docs/api
- Stripe Checkout Session: https://stripe.com/docs/api/checkout/sessions/create
- Stripe Webhooks: https://stripe.com/docs/webhooks/configure
- Stripe npm Package: https://github.com/stripe/stripe-node
