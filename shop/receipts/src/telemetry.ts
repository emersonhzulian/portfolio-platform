import { context, propagation, SpanKind, SpanStatusCode, trace, type Context } from "@opentelemetry/api";

// The OpenTelemetry Operator injects the Node.js SDK at start-up (HTTP, pino, ...), but it has
// no instrumentation for @confluentinc/kafka-javascript. So the trace context crossing Kafka
// is carried here by hand: W3C traceparent/tracestate in the message headers, extracted on
// consume and injected on produce. That is what keeps one checkout a single trace across
// the asynchronous hops.
export const tracer = trace.getTracer("receipts");

type Headers = Record<string, Buffer | string | (Buffer | string)[] | undefined>;

const getter = {
  keys: (carrier: Headers) => Object.keys(carrier),
  get: (carrier: Headers, key: string) => {
    const value = carrier[key];
    const first = Array.isArray(value) ? value[0] : value;
    return first === undefined ? undefined : first.toString();
  },
};

export function contextFromHeaders(headers: Headers | undefined): Context {
  return propagation.extract(context.active(), headers ?? {}, getter);
}

export function headersFromContext(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

export async function consumerSpan<T>(name: string, parent: Context, attributes: Record<string, string | number>,
  fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { kind: SpanKind.CONSUMER, attributes }, parent, async (span) => {
    try {
      return await fn();
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
      throw e;
    } finally {
      span.end();
    }
  });
}
