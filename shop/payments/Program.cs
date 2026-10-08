// payments: a simulated Pix provider. It records a payment as pending, approves it after a
// configurable delay and calls the merchant's webhook - the same shape as a real gateway,
// without moving any money.
using System.Diagnostics;
using Microsoft.EntityFrameworkCore;
using Payments;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<PaymentsDb>(o =>
    o.UseNpgsql(builder.Configuration.GetConnectionString("Payments")));
builder.Services.AddHttpClient("webhooks", c => c.Timeout = TimeSpan.FromSeconds(10));
builder.Services.AddHostedService<ApprovalWorker>();
builder.Services.AddSingleton<FaultInjection>();

var app = builder.Build();

await Schema.EnsureAsync(app.Services);

app.UseMiddleware<FaultInjection>();

app.MapGet("/livez", () => Results.Ok("ok"));
app.MapGet("/healthz", async (PaymentsDb db) =>
    await db.Database.CanConnectAsync() ? Results.Ok("ok") : Results.StatusCode(503));

app.MapPost("/payments", async (CreatePayment req, PaymentsDb db) =>
{
    if (req.Amount <= 0) return Results.BadRequest(new { error = "amount must be positive" });

    var payment = new Payment
    {
        Id = Guid.NewGuid(),
        OrderId = req.OrderId,
        Amount = req.Amount,
        CallbackUrl = req.CallbackUrl,
        Status = PaymentStatus.Pending,
        CreatedAt = DateTimeOffset.UtcNow,
        // The approval happens later, on whichever replica's worker picks it up; keeping the
        // caller's trace context lets that callback join the original checkout trace.
        TraceParent = Activity.Current?.Id,
    };
    db.Payments.Add(payment);
    await db.SaveChangesAsync();

    return Results.Created($"/payments/{payment.Id}", PaymentView.From(payment));
});

app.MapGet("/payments/{id:guid}", async (Guid id, PaymentsDb db) =>
    await db.Payments.FindAsync(id) is { } p ? Results.Ok(PaymentView.From(p)) : Results.NotFound());

app.Run();

public record CreatePayment(Guid OrderId, decimal Amount, string CallbackUrl);

public record PaymentView(Guid Id, Guid OrderId, decimal Amount, string Status, DateTimeOffset CreatedAt, DateTimeOffset? ApprovedAt)
{
    public static PaymentView From(Payment p) =>
        new(p.Id, p.OrderId, p.Amount, p.Status.ToString(), p.CreatedAt, p.ApprovedAt);
}
