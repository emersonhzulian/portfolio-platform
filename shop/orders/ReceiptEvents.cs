using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Confluent.Kafka;
using Microsoft.EntityFrameworkCore;

namespace Orders;

// Consumes receipt.ready (from the receipts service) and adds the last step to the order's
// timeline. Idempotent: a redelivered event finds the step already recorded.
//
// The .NET agent's Kafka instrumentation makes each `receive` span the root of a new trace,
// only *linked* to the producer (OpenTelemetry's messaging convention). To keep the purchase a
// single trace, the processing span below takes the traceparent from the message headers as
// its parent - the same thing the receipts service does on its side.
public class ReceiptEvents(IServiceScopeFactory scopes, IConfiguration config, ILogger<ReceiptEvents> log)
    : BackgroundService
{
    protected override Task ExecuteAsync(CancellationToken ct) => Task.Run(() => Consume(ct), ct);

    void Consume(CancellationToken ct)
    {
        using var consumer = new ConsumerBuilder<string, string>(new ConsumerConfig
        {
            BootstrapServers = config["Kafka:BootstrapServers"],
            GroupId = "orders",
            ClientId = "orders",
            AutoOffsetReset = AutoOffsetReset.Earliest,
            EnableAutoCommit = false,
        }).Build();
        consumer.Subscribe("receipt.ready");

        while (!ct.IsCancellationRequested)
        {
            try
            {
                var result = consumer.Consume(ct);
                if (result?.Message is null) continue;
                var traceParent = result.Message.Headers?.TryGetLastBytes("traceparent", out var raw) == true
                    ? Encoding.UTF8.GetString(raw) : null;
                using (var activity = OutboxPublisher.Source.StartActivity("receipt.ready process", ActivityKind.Consumer, traceParent))
                {
                    activity?.SetTag("messaging.system", "kafka");
                    activity?.SetTag("messaging.destination.name", result.Topic);
                    activity?.SetTag("order.id", result.Message.Key);
                    Record(result.Message.Value).GetAwaiter().GetResult();
                }
                consumer.Commit(result);
            }
            catch (OperationCanceledException) { break; }
            catch (Exception e)
            {
                // Not committed: the event comes back after a restart or rebalance.
                log.LogError(e, "Handling receipt.ready failed");
                Thread.Sleep(TimeSpan.FromSeconds(2));
            }
        }
        consumer.Close();
    }

    async Task Record(string payload)
    {
        using var doc = JsonDocument.Parse(payload);
        var data = doc.RootElement.GetProperty("data");
        var orderId = data.GetProperty("orderId").GetGuid();
        var file = data.GetProperty("file").GetString();

        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<OrdersDb>();
        if (await db.OrderEvents.AnyAsync(e => e.OrderId == orderId && e.Type == "receipt-ready")) return;
        if (!await db.Orders.AnyAsync(o => o.Id == orderId)) return; // an order reset away since
        db.OrderEvents.Add(new OrderEvent
        {
            OrderId = orderId, Type = "receipt-ready", At = DateTimeOffset.UtcNow,
            Detail = $"Receipt written ({Path.GetFileName(file)}), ready to download",
        });
        await db.SaveChangesAsync();
        log.LogInformation("Order {OrderId} receipt ready", orderId);
    }
}
