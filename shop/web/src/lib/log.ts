import pino from "pino";

// Structured logs. The OpenTelemetry Operator's Node.js agent instruments pino: every record
// is sent over OTLP to Loki with the trace and span ids of the request that wrote it (the node
// log shipper skips instrumented pods' stdout, so console.log would never reach Loki).
export const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
