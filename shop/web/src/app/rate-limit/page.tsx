import { SpamButton } from "./spam";

export default function RateLimits() {
  return (
    <>
      <h1>Rate limits, in two layers</h1>
      <p>
        <strong>At the edge:</strong> the gateway (Envoy) limits requests per visitor IP, read from Cloudflare&apos;s{" "}
        <code>CF-Connecting-IP</code>. The counters live in Redis, so every Envoy replica shares one budget.
      </p>
      <p>
        <strong>In the app:</strong> this shop limits each logged-in user, also in Redis. Checkout allows 10 orders a
        minute; the button below allows 5 clicks a minute. Go on, spam it.
      </p>
      <SpamButton />
    </>
  );
}
