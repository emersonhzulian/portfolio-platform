using Microsoft.EntityFrameworkCore;

namespace Payments;

public enum PaymentStatus { Pending, Approved }

public class Payment
{
    public Guid Id { get; set; }
    public Guid OrderId { get; set; }
    public decimal Amount { get; set; }
    public required string CallbackUrl { get; set; }
    public PaymentStatus Status { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? ApprovedAt { get; set; }
    public int CallbackAttempts { get; set; }
    public DateTimeOffset? CallbackDeliveredAt { get; set; }
    public string? TraceParent { get; set; }
}

public class PaymentsDb(DbContextOptions<PaymentsDb> options) : DbContext(options)
{
    public DbSet<Payment> Payments => Set<Payment>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<Payment>(e =>
        {
            e.ToTable("payments");
            e.Property(p => p.Status).HasConversion<string>();
            e.Property(p => p.Amount).HasPrecision(12, 2);
            e.HasIndex(p => new { p.Status, p.CreatedAt });
        });
    }
}

public static class Schema
{
    // Every replica starts this; the advisory lock makes the first one create the tables
    // and the others wait instead of racing it. On a fresh deploy the database (or the
    // cluster) may not exist yet: wait for it with backoff instead of crashing the pod.
    public static async Task EnsureAsync(IServiceProvider services, CancellationToken ct = default)
    {
        var log = services.GetRequiredService<ILoggerFactory>().CreateLogger(typeof(Schema));
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                await CreateAsync(services, ct);
                return;
            }
            catch (Exception e) when (attempt < 30 && e is Npgsql.NpgsqlException or InvalidOperationException)
            {
                var delay = TimeSpan.FromSeconds(Math.Min(2 * attempt, 10));
                log.LogWarning("Database not ready ({Reason}); retrying in {Delay}s (attempt {Attempt})",
                    e.GetBaseException().Message, delay.TotalSeconds, attempt);
                await Task.Delay(delay, ct);
            }
        }
    }

    static async Task CreateAsync(IServiceProvider services, CancellationToken ct)
    {
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<PaymentsDb>();
        await db.Database.OpenConnectionAsync(ct);
        try
        {
            await db.Database.ExecuteSqlRawAsync("SELECT pg_advisory_lock(4242)", ct);
            await db.Database.EnsureCreatedAsync(ct);
        }
        finally
        {
            await db.Database.ExecuteSqlRawAsync("SELECT pg_advisory_unlock(4242)", ct);
            await db.Database.CloseConnectionAsync();
        }
    }
}
