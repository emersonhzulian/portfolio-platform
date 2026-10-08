import { getSession } from "@/lib/auth";
import { getOrder, NotFound } from "@/lib/orders";
import { tagUser } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

// Polled by the order page's timeline while the payment and event are in flight.
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "not logged in" }, { status: 401 });
  tagUser(session.username);
  try {
    return Response.json(await getOrder(session, (await params).id));
  } catch (e) {
    if (e instanceof NotFound) return Response.json({ error: "not found" }, { status: 404 });
    throw e;
  }
}
