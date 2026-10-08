"use server";

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { config } from "@/lib/config";
import { createOrder } from "@/lib/orders";
import { log } from "@/lib/log";
import { hit } from "@/lib/ratelimit";
import { maybeFault, tagUser } from "@/lib/telemetry";

export async function buy(formData: FormData) {
  const session = await getSession();
  if (!session) redirect("/auth/login?returnTo=/");
  tagUser(session.username);
  await maybeFault(config.faultErrorRate, config.faultLatencyMs);

  const limit = await hit("orders", session.sub, config.ordersPerMinute);
  if (!limit.allowed) {
    log.warn({ "enduser.id": session.username, count: limit.count }, "checkout rate limit hit");
    redirect(`/?limited=${limit.resetIn}`);
  }

  const productId = Number(formData.get("productId"));
  const quantity = Math.min(Math.max(Number(formData.get("quantity") ?? 1), 1), 10);
  const order = await createOrder(session, [{ productId, quantity }]);
  log.info({ "enduser.id": session.username, "order.id": order.id, total: order.total }, "order placed");
  redirect(`/orders/${order.id}`);
}

export type SpamState = { allowed: boolean; count: number; limit: number; resetIn: number } | null;

// The "try to spam it" button: the same per-user limiter the checkout uses, with a low limit.
export async function spam(): Promise<SpamState> {
  const session = await getSession();
  if (!session) redirect("/auth/login?returnTo=/rate-limit");
  tagUser(session.username);
  const result = await hit("spam", session.sub, config.spamPerMinute);
  if (!result.allowed) log.warn({ "enduser.id": session.username, count: result.count }, "spam button rate limit hit");
  return result;
}
