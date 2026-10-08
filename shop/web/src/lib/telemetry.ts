import { trace } from "@opentelemetry/api";

// The OpenTelemetry Operator injects the Node.js SDK at start-up; this only adds the visitor
// to the span already in progress, so Grafana can find "my" requests by enduser.id.
export function tagUser(username: string | undefined) {
  if (username) trace.getActiveSpan()?.setAttribute("enduser.id", username);
}

// Deliberate faults for the canary demo (FAULT_ERROR_RATE percent, FAULT_LATENCY_MS); off by default.
export async function maybeFault(errorRate: number, latencyMs: number) {
  if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
  if (errorRate > 0 && Math.random() * 100 < errorRate) throw new Error("injected fault");
}
