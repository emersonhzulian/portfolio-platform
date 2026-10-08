import { config } from "./config";
import type { Session } from "./auth";

export type Product = { id: number; name: string; description: string; price: number };
export type OrderEvent = { type: string; detail: string; at: string };
export type Order = {
  id: string; status: string; total: number; createdAt: string; paidAt: string | null;
  items: { productId: number; productName: string; unitPrice: number; quantity: number }[];
  events: OrderEvent[];
};

// Calls to the orders service with the visitor's access token; orders validates it itself.
async function call<T>(path: string, session: Session | null, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(path, config.ordersUrl), {
    ...init,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.accessToken}` } : {}),
      ...init?.headers,
    },
  });
  if (response.status === 404) throw new NotFound();
  if (!response.ok) throw new Error(`orders answered ${response.status} for ${path}`);
  return response.json() as Promise<T>;
}

export class NotFound extends Error {}

export const listProducts = () => call<Product[]>("/products", null);
export const listOrders = (s: Session) => call<Order[]>("/orders/", s);
export const getOrder = (s: Session, id: string) => call<Order>(`/orders/${encodeURIComponent(id)}`, s);
export const createOrder = (s: Session, items: { productId: number; quantity: number }[]) =>
  call<Order>("/orders/", s, { method: "POST", body: JSON.stringify({ items }) });
