// receipts: turns order.paid events into PDF receipts in the visitor's folder (which they then
// download from FileBrowser), and announces each one as receipt.ready.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { KafkaJS } from "@confluentinc/kafka-javascript";
import { trace } from "@opentelemetry/api";
import pino from "pino";
import { writeReceipt, type OrderPaid } from "./receipt.js";
import { consumerSpan, contextFromHeaders, headersFromContext } from "./telemetry.js";

// pino is instrumented by the injected agent: records reach Loki with the trace and span ids.
const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

const brokers = (process.env.KAFKA_BOOTSTRAP_SERVERS ?? "localhost:9092").split(",");
const root = process.env.RECEIPTS_ROOT ?? "/receipts";
const IN = "order.paid", OUT = "receipt.ready", DLQ = "order.paid.dlq";
const ATTEMPTS = 3;

const kafka = new KafkaJS.Kafka({ kafkaJS: { brokers, clientId: "receipts" } });
const producer = kafka.producer({ kafkaJS: { idempotent: true } });
const consumer = kafka.consumer({ kafkaJS: { groupId: "receipts", fromBeginning: true } });
let ready = false;

async function handle(order: OrderPaid, eventId: string) {
  const { file, created } = await writeReceipt(root, order);
  const span = trace.getActiveSpan();
  span?.setAttribute("receipt.created", created);
  if (!created) {
    log.info({ "order.id": order.orderId, "event.id": eventId }, "receipt already written, skipping (redelivered event)");
    return;
  }
  log.info({ "order.id": order.orderId, "enduser.id": order.userName, file }, "receipt written");
  await producer.send({
    topic: OUT,
    messages: [{
      key: order.orderId,
      value: JSON.stringify({
        specversion: "1.0", type: "dev.emersonzulian.shop.receipt.ready", source: "/receipts",
        id: randomUUID(), time: new Date().toISOString(), subject: order.orderId,
        data: { orderId: order.orderId, userName: order.userName, file: file.slice(root.length) },
      }),
      // The next hop (orders) continues this trace.
      headers: headersFromContext(),
    }],
  });
}

async function main() {
  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({ topics: [IN] });
  ready = true;
  log.info({ brokers, topic: IN }, "consuming");

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const parent = contextFromHeaders(message.headers as never);
      const raw = message.value?.toString() ?? "";
      let event: { id: string; data: OrderPaid };
      try {
        event = JSON.parse(raw);
      } catch {
        log.error({ topic, partition, offset: message.offset }, "not a JSON CloudEvent, sending to the DLQ");
        await producer.send({ topic: DLQ, messages: [{ key: message.key, value: raw, headers: { error: "unparseable" } }] });
        return;
      }
      const order = event.data;
      await consumerSpan(`${IN} process`, parent, {
        "messaging.system": "kafka",
        "messaging.operation.type": "process",
        "messaging.destination.name": topic,
        "messaging.kafka.message.offset": Number(message.offset),
        "messaging.message.id": event.id,
        "order.id": order.orderId,
        "enduser.id": order.userName,
      }, async () => {
        for (let attempt = 1; ; attempt++) {
          try {
            await handle(order, event.id);
            return;
          } catch (e) {
            if (attempt >= ATTEMPTS) {
              // Park it instead of blocking the partition; the DLQ keeps the original event.
              log.error({ err: e, "order.id": order.orderId, attempt }, "receipt failed, sending the event to the DLQ");
              await producer.send({
                topic: DLQ,
                messages: [{ key: message.key, value: raw, headers: { ...headersFromContext(), error: String(e) } }],
              });
              return;
            }
            log.warn({ err: e, "order.id": order.orderId, attempt }, "receipt failed, retrying");
            await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          }
        }
      });
    },
  });
}

// Ready once connected and subscribed; Kafka itself handles partition reassignment.
createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(ready ? 200 : 503).end(ready ? "ok" : "starting"); return; }
  if (req.url === "/livez") { res.writeHead(200).end("ok"); return; }
  res.writeHead(404).end();
}).listen(Number(process.env.PORT ?? 8080));

async function shutdown() {
  ready = false;
  await consumer.disconnect().catch(() => {});
  await producer.disconnect().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch((e) => {
  log.fatal({ err: e }, "receipts failed to start");
  process.exit(1);
});
