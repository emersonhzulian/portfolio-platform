import { redis } from "@/lib/redis";

export const dynamic = "force-dynamic";

// Ready when Redis answers: without it nobody can log in or check out.
export async function GET() {
  try {
    await redis().ping();
    return new Response("ok");
  } catch {
    return new Response("redis unavailable", { status: 503 });
  }
}
