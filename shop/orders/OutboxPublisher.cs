using System.Diagnostics;
using Confluent.Kafka;
using Microsoft.EntityFrameworkCore;

namespace Orders;

// Publishes outbox rows to Kafka. Runs on every replica; rows are claimed with FOR UPDATE
// SKIP LOCKED. Delivery is at-least-once: a crash after producing but before committing
// publishes that event again, which consumers absorb by de-duplicating on the event id.
public class OutboxPublisher(IServiceScopeFactory scopes, IConfiguration config, ILogger<OutboxPublisher> log)
    : BackgroundService
{
    public static readonly ActivitySource Source = new("Orders");

    readonly IProducer<string, string> _producer = new ProducerBuilder<string, string>(new ProducerConfig
    {
        BootstrapServers = config["Kafka:BootstrapServers"] ?? throw new InvalidOperationException("Kafka:BootstrapServers is required"),
        ClientId = "orders",
        Acks = Acks.All,
        EnableIdempotence = true,
        MessageTimeoutMs = 10_000,
    }).Build();

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await PublishBatchAsync(ct);
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                log.LogError(e, "Outbox publish tick failed");
            }
            await Task.Delay(TimeSpan.FromSeconds(1), ct);
        }
    }

    async Task PublishBatchAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<OrdersDb>();
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var batch = await db.Outbox.FromSqlRaw("""
            SELECT * FROM outbox WHERE "PublishedAt" IS NULL
            ORDER BY "Id" LIMIT 20 FOR UPDATE SKIP LOCKED
            """).ToListAsync(ct);

        foreach (var message in batch)
        {
            // Back in the checkout's trace: the Kafka producer span (and the consumer's after
            // it) hang under the payment that triggered this event.
            using var activity = Source.StartActivity("outbox.publish", ActivityKind.Internal, message.TraceParent);
            activity?.SetTag("messaging.destination.name", message.Topic);
            activity?.SetTag("order.id", message.Key);
            message.Attempts++;
            try
            {
                await _producer.ProduceAsync(message.Topic, new Message<string, string> { Key = message.Key, Value = message.Payload }, ct);
                message.PublishedAt = DateTimeOffset.UtcNow;
                if (Guid.TryParse(message.Key, out var orderId))
                    db.OrderEvents.Add(new OrderEvent
                    {
                        OrderId = orderId, Type = "event-published", At = message.PublishedAt.Value,
                        Detail = $"order.paid published to Kafka (topic {message.Topic})",
                    });
            }
            catch (ProduceException<string, string> e)
            {
                activity?.SetStatus(ActivityStatusCode.Error, e.Error.Reason);
                log.LogWarning(e, "Publishing outbox message {Id} failed (attempt {Attempt})", message.Id, message.Attempts);
            }
        }
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
    }

    public override void Dispose()
    {
        _producer.Flush(TimeSpan.FromSeconds(5));
        _producer.Dispose();
        base.Dispose();
    }
}
