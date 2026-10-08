// Runtime configuration, read once from the environment (see the Deployment in
// gitops/apps/shop). Nothing here is baked into the image.
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export const config = {
  get appUrl() { return required("APP_URL"); },
  get oidcIssuer() { return required("OIDC_ISSUER"); },
  get oidcClientId() { return required("OIDC_CLIENT_ID"); },
  get oidcClientSecret() { return required("OIDC_CLIENT_SECRET"); },
  get ordersUrl() { return required("ORDERS_URL"); },
  get redisUrl() { return required("REDIS_URL"); },
  grafanaUrl: process.env.GRAFANA_URL ?? "https://grafana.emersonzulian.dev",
  ordersPerMinute: Number(process.env.RATE_LIMIT_ORDERS_PER_MINUTE ?? 10),
  spamPerMinute: Number(process.env.RATE_LIMIT_SPAM_PER_MINUTE ?? 5),
  faultErrorRate: Number(process.env.FAULT_ERROR_RATE ?? 0),
  faultLatencyMs: Number(process.env.FAULT_LATENCY_MS ?? 0),
};
