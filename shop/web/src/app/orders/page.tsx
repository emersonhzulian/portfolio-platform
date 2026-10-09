import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { userDashboardUrl } from "@/lib/grafana";
import { listOrders } from "@/lib/orders";
import { tagUser } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export default async function MyOrders() {
  const session = await getSession();
  if (!session) redirect("/auth/login?returnTo=/orders");
  tagUser(session.username);
  const orders = await listOrders(session);

  return (
    <>
      <h1>My orders</h1>
      <p className="muted">
        Everything you did here is in the traces, tagged with your username.{" "}
        <a href={userDashboardUrl(session.username)} target="_blank" rel="noreferrer">See all of it in Grafana →</a>
      </p>
      {orders.length === 0 ? (
        <p>No orders yet. <Link href="/">Buy something</Link>.</p>
      ) : (
        <table>
          <thead><tr><th>When</th><th>Items</th><th>Total</th><th>Status</th></tr></thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td><Link href={`/orders/${o.id}`}>{new Date(o.createdAt).toLocaleString("en-GB")}</Link></td>
                <td>{o.items.map((i) => `${i.quantity}× ${i.productName}`).join(", ")}</td>
                <td>{brl.format(o.total)}</td>
                <td>{o.status === "Paid" ? "Paid" : "Awaiting payment"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
