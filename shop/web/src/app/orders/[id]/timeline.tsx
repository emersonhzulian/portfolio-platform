"use client";

import { useEffect, useState } from "react";
import type { Order } from "@/lib/orders";

// The steps an order goes through; the ones still ahead are shown greyed out.
const STEPS: { type: string; label: string }[] = [
  { type: "created", label: "Order placed (web → orders)" },
  { type: "payment-requested", label: "Pix charge created (orders → payments)" },
  { type: "paid", label: "Payment confirmed (payments → orders webhook)" },
  { type: "event-published", label: "order.paid published to Kafka (outbox)" },
  { type: "receipt-ready", label: "Receipt written (Kafka → receipts → receipt.ready)" },
];

const FILES_URL = "https://files.emersonzulian.dev";

export function Timeline({ initial }: { initial: Order }) {
  const [order, setOrder] = useState(initial);
  const done = new Set(order.events.map((e) => e.type));
  const finished = STEPS.every((s) => done.has(s.type));

  // Poll until every step has happened; the payment is approved after a few seconds.
  useEffect(() => {
    if (finished) return;
    const timer = setInterval(async () => {
      const response = await fetch(`/api/orders/${order.id}`, { cache: "no-store" });
      if (response.ok) setOrder(await response.json());
    }, 2000);
    return () => clearInterval(timer);
  }, [finished, order.id]);

  return (
    <ol className="timeline">
      {STEPS.map((step) => {
        const event = order.events.find((e) => e.type === step.type);
        return (
          <li key={step.type} className={event ? "" : "waiting"}>
            <strong>{step.label}</strong>
            <br />
            <span className="muted">
              {event ? `${new Date(event.at).toLocaleTimeString("en-GB")} · ${event.detail}` : "waiting…"}
            </span>
            {event && step.type === "receipt-ready" && (
              <>
                {" "}
                <a href={FILES_URL} target="_blank" rel="noreferrer">Download it from FileBrowser →</a>
              </>
            )}
          </li>
        );
      })}
      {order.events.filter((e) => e.type === "payment-failed").map((e) => (
        <li key={e.at} className="error">{e.detail}</li>
      ))}
    </ol>
  );
}
