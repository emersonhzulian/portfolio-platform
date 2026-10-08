using Microsoft.EntityFrameworkCore;

namespace Orders;

public enum OrderStatus { AwaitingPayment, Paid }

public class Product
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public required string Description { get; set; }
    public decimal Price { get; set; }
}

public class Order
{
    public Guid Id { get; set; }
    public required string UserId { get; set; }
    public required string UserName { get; set; }
    public OrderStatus Status { get; set; }
    public decimal Total { get; set; }
    public Guid? PaymentId { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? PaidAt { get; set; }
    public List<OrderItem> Items { get; set; } = [];
    public List<OrderEvent> Events { get; set; } = [];
}

// Name and price are copied at purchase time: a later catalog change doesn't rewrite history.
public class OrderItem
{
    public int Id { get; set; }
    public Guid OrderId { get; set; }
    public int ProductId { get; set; }
    public required string ProductName { get; set; }
    public decimal UnitPrice { get; set; }
    public int Quantity { get; set; }
}

// The order's timeline, shown to the visitor: what happened, where, when.
public class OrderEvent
{
    public int Id { get; set; }
    public Guid OrderId { get; set; }
    public required string Type { get; set; }
    public required string Detail { get; set; }
    public DateTimeOffset At { get; set; }
}

// Transactional outbox: written in the same transaction as the state change it announces, and
// published to Kafka afterwards by OutboxPublisher. No event is lost if the pod dies in between.
public class OutboxMessage
{
    public long Id { get; set; }
    public required string Topic { get; set; }
    public required string Key { get; set; }
    public required string Payload { get; set; }
    public string? TraceParent { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? PublishedAt { get; set; }
    public int Attempts { get; set; }
}

public class OrdersDb(DbContextOptions<OrdersDb> options) : DbContext(options)
{
    public DbSet<Product> Products => Set<Product>();
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<OrderEvent> OrderEvents => Set<OrderEvent>();
    public DbSet<OutboxMessage> Outbox => Set<OutboxMessage>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<Product>(e =>
        {
            e.ToTable("products");
            e.Property(p => p.Id).ValueGeneratedNever();
            e.Property(p => p.Price).HasPrecision(10, 2);
            e.HasData(Catalog.Products);
        });
        b.Entity<Order>(e =>
        {
            e.ToTable("orders");
            e.Property(o => o.Status).HasConversion<string>();
            e.Property(o => o.Total).HasPrecision(12, 2);
            e.HasIndex(o => new { o.UserId, o.CreatedAt });
        });
        b.Entity<OrderItem>(e =>
        {
            e.ToTable("order_items");
            e.Property(i => i.UnitPrice).HasPrecision(10, 2);
        });
        b.Entity<OrderEvent>().ToTable("order_events");
        b.Entity<OutboxMessage>(e =>
        {
            e.ToTable("outbox");
            e.HasIndex(m => m.PublishedAt);
        });
    }
}

public static class Catalog
{
    public static readonly Product[] Products =
    [
        new() { Id = 1, Name = "Control-plane coffee", Description = "Single-origin beans, three replicas of flavour.", Price = 39.90m },
        new() { Id = 2, Name = "Pod disruption mug", Description = "Holds at least one coffee at all times.", Price = 59.00m },
        new() { Id = 3, Name = "GitOps hoodie", Description = "Declarative warmth. Reconciled every morning.", Price = 189.00m },
        new() { Id = 4, Name = "Trace-ID sticker pack", Description = "Eight stickers, each with a unique span.", Price = 14.50m },
        new() { Id = 5, Name = "Homelab rack shelf", Description = "Fits one Talos node and one cat.", Price = 249.00m },
        new() { Id = 6, Name = "Chaos monkey plush", Description = "Kills a pod every hour. Hugs, too.", Price = 79.90m },
    ];
}

public static class Schema
{
    // Every replica starts this; the advisory lock makes the first one create the tables
    // (with the catalog seed) and the others wait instead of racing it.
    public static async Task EnsureAsync(IServiceProvider services)
    {
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<OrdersDb>();
        await db.Database.OpenConnectionAsync();
        try
        {
            await db.Database.ExecuteSqlRawAsync("SELECT pg_advisory_lock(4243)");
            await db.Database.EnsureCreatedAsync();
        }
        finally
        {
            await db.Database.ExecuteSqlRawAsync("SELECT pg_advisory_unlock(4243)");
            await db.Database.CloseConnectionAsync();
        }
    }
}
