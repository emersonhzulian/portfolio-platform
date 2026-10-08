import Redis from "ioredis";
import { config } from "./config";

// One connection per server process, reused across requests (and across hot reloads in dev).
// Commands issued while it (re)connects wait briefly instead of failing; two retries at most.
const globalForRedis = globalThis as unknown as { redis?: Redis };

export function redis(): Redis {
  globalForRedis.redis ??= new Redis(config.redisUrl, { maxRetriesPerRequest: 2, connectTimeout: 2_000 });
  return globalForRedis.redis;
}
