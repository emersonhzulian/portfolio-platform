import { buy } from "./actions";
import { getSession } from "@/lib/auth";
import { listProducts } from "@/lib/orders";
import { maybeFault, tagUser } from "@/lib/telemetry";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export default async function Catalog({ searchParams }: { searchParams: Promise<{ limited?: string; login?: string }> }) {
  const [session, products, params] = await Promise.all([getSession(), listProducts(), searchParams]);
  tagUser(session?.username);
  await maybeFault(config.faultErrorRate, config.faultLatencyMs);

  return (
    <>
      <h1>Things for people who run clusters</h1>
      <p className="muted">
        Buy something and follow it: the payment is confirmed by a webhook, the order is announced on Kafka, and
        every step lands in one trace you can open in Grafana.
      </p>
      {params.limited && (
        <p className="notice error">Easy there: that&apos;s the per-user limit. Try again in {params.limited}s.</p>
      )}
      {params.login === "failed" && <p className="notice error">Login didn&apos;t complete. Try again?</p>}
      {!session && <p className="notice">Log in or create an account (username + password, no e-mail) to buy.</p>}
      <div className="grid">
        {products.map((p) => (
          <form key={p.id} action={buy} className="card">
            <strong>{p.name}</strong>
            <p>{p.description}</p>
            <input type="hidden" name="productId" value={p.id} />
            <span className="price">{brl.format(p.price)}</span>{" "}
            <select name="quantity" defaultValue="1" aria-label="Quantity">
              {[1, 2, 3].map((q) => <option key={q} value={q}>{q}</option>)}
            </select>{" "}
            <button type="submit">Buy with Pix</button>
          </form>
        ))}
      </div>
    </>
  );
}
