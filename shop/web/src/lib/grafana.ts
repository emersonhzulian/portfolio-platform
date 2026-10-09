import { config } from "./config";

// Deep links into the public Grafana's Explore, pre-filled with a TraceQL query.
export function traceSearchUrl(traceql: string, from = "now-1h"): string {
  const panes = {
    a: {
      datasource: "tempo",
      queries: [{ refId: "A", datasource: { type: "tempo", uid: "tempo" }, queryType: "traceql", query: traceql, limit: 20 }],
      range: { from, to: "now" },
    },
  };
  return `${config.grafanaUrl}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(panes))}`;
}

export const orderTraceUrl = (orderId: string) => traceSearchUrl(`{ span.order.id = "${orderId}" }`, "now-6h");
// The shop dashboard, its `user` variable set: the visitor's traces and logs, next to the
// service-level panels they took part in.
export const userDashboardUrl = (username: string) =>
  `${config.grafanaUrl}/d/portfolio-shop?var-user=${encodeURIComponent(username)}&from=now-24h&to=now`;
