type CheckoutWakeInput = {
  // Mirrors the Actor.type union in types/express.d.ts. "runner" was added
  // in BYO-101 (ADR-011); the helper's logic only branches on "agent" vs
  // anything-else, so widening is a no-op behaviorally.
  actorType: "board" | "agent" | "runner" | "none";
  actorAgentId: string | null;
  checkoutAgentId: string;
  checkoutRunId: string | null;
};

export function shouldWakeAssigneeOnCheckout(input: CheckoutWakeInput): boolean {
  if (input.actorType !== "agent") return true;
  if (!input.actorAgentId) return true;
  if (input.actorAgentId !== input.checkoutAgentId) return true;
  if (!input.checkoutRunId) return true;
  return false;
}
