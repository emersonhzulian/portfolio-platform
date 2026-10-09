# shop

A small shop built to run on this platform (`../gitops`), so a visitor can follow their own
purchase through every layer: login, checkout, payment webhook, Kafka event, and the single
trace that covers all of it in Grafana. Live at https://shop.emersonzulian.dev.

| Service | Stack | Does |
|---|---|---|
| `web/` | Node.js, Next.js 16 | Storefront + backend-for-frontend. OIDC login against authentik (code + PKCE, `openid-client`); sessions in Redis, so the browser only holds a random id; per-user rate limits in Redis |
| `orders/` | .NET 10, EF Core, PostgreSQL | Catalog and orders. Validates the visitor's access token itself; receives the payment webhook (HMAC-signed, idempotent); writes `order.paid` to a transactional outbox and publishes it to Kafka as a CloudEvent |
| `receipts/` | Node.js, `@confluentinc/kafka-javascript`, PDFKit | Consumes `order.paid`, writes the PDF receipt into the visitor's folder (downloaded through FileBrowser), publishes `receipt.ready`. Idempotent (the file is named after the order), retries then parks failures in `order.paid.dlq`. Carries the trace context across Kafka by hand (W3C headers): the agent doesn't instrument this client |
| `payments/` | .NET 10, EF Core, PostgreSQL | A simulated Pix provider: records a charge, approves it after a delay and calls the merchant's webhook. Safe with any number of replicas (`FOR UPDATE SKIP LOCKED`) |

Every service is auto-instrumented by the OpenTelemetry Operator (no SDK setup in the code). The
code only adds what auto-instrumentation can't know: the visitor (`enduser.id`), the order
(`order.id`), and the trace context carried across the asynchronous hops (the payment
approval and the outbox both resume the checkout's trace).

`FAULT_ERROR_RATE` (percent of requests answered 500) and `FAULT_LATENCY_MS` exist in every
service for one reason: a release that sets them is how the canary analysis is demonstrated
rolling itself back.

## Build

CI (`../.github/workflows/shop.yml`) builds a service when its folder changes and pushes
`ghcr.io/emersonhzulian/portfolio-platform/<service>:0.1.<run>`; Renovate then proposes that
tag to `../gitops/apps/shop`, and Argo CD rolls it out. Locally:
`docker build -t shop-<service>:dev <service>/`.
