import { redis } from "./redis";

// Fixed one-minute window per visitor and action, counted in Redis so every replica shares it.
// This is the app's own, per-user limit; the gateway in front adds a per-IP one.
export async function hit(action: string, user: string, limit: number) {
  const window = Math.floor(Date.now() / 60_000);
  const key = `ratelimit:${action}:${user}:${window}`;
  const count = await redis().incr(key);
  if (count === 1) await redis().expire(key, 70);
  return { allowed: count <= limit, count, limit, resetIn: 60 - Math.floor((Date.now() / 1000) % 60) };
}
