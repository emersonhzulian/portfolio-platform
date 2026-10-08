import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { orderTraceUrl } from "@/lib/grafana";
import { getOrder, NotFound } from "@/lib/orders";
import { tagUser } from "@/lib/telemetry";
import { Timeline } from "./timeline";

export const dynamic = "force-dynamic";

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  if (!session) redirect(`/auth/login?returnTo=/orders/${encodeURIComponent(id)}`);
  tagUser(session.username);
  const order = await getOrder(session, id).catch((e) => { if (e instanceof NotFound) notFound(); throw e; });

  return (
    <>
      <h1>Order {order.id.slice(0, 8)}</h1>
      <p className="muted">
        {order.items.map((i) => `${i.quantity}× ${i.productName}`).join(", ")} · {brl.format(order.total)}
      </p>
      <div className="card">
        <Timeline initial={order} />
      </div>
      <p>
        <a className="button" href={orderTraceUrl(order.id)} target="_blank" rel="noreferrer">
          Open this order&apos;s trace in Grafana
        </a>{" "}
        <span className="muted">— the web request, the payment, its webhook and the Kafka event, in one trace.</span>
      </p>
    </>
  );
}
