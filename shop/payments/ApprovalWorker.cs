using System.Diagnostics;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;

namespace Payments;

// Approves pending payments once they're old enough and delivers the webhook. Runs on every
// replica: rows are claimed with FOR UPDATE SKIP LOCKED, so two replicas never process the
// same payment, and a pod killed mid-way just leaves the row for the next tick.
public class ApprovalWorker(IServiceScopeFactory scopes, IHttpClientFactory http, IConfiguration config,
    ILogger<ApprovalWorker> log) : BackgroundService
{
    public static readonly ActivitySource Source = new("Payments");
    const int MaxAttempts = 20;

    readonly TimeSpan _delay = TimeSpan.FromSeconds(config.GetValue("Payments:ApprovalDelaySeconds", 10));
    readonly byte[] _secret = Encoding.UTF8.GetBytes(config["Payments:WebhookSecret"]
        ?? throw new InvalidOperationException("Payments:WebhookSecret is required"));

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await ApproveDueAsync(ct);
                await DeliverCallbacksAsync(ct);
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                log.LogError(e, "Approval tick failed");
            }
            await Task.Delay(TimeSpan.FromSeconds(2), ct);
        }
    }

    async Task ApproveDueAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<PaymentsDb>();
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var cutoff = DateTimeOffset.UtcNow - _delay;
        var due = await db.Payments.FromSqlInterpolated($"""
            SELECT * FROM payments
            WHERE "Status" = 'Pending' AND "CreatedAt" < {cutoff}
            ORDER BY "CreatedAt" LIMIT 20
            FOR UPDATE SKIP LOCKED
            """).ToListAsync(ct);
        foreach (var p in due)
        {
            p.Status = PaymentStatus.Approved;
            p.ApprovedAt = DateTimeOffset.UtcNow;
            log.LogInformation("Payment {PaymentId} for order {OrderId} approved", p.Id, p.OrderId);
        }
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
    }

    async Task DeliverCallbacksAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<PaymentsDb>();
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var pending = await db.Payments.FromSqlInterpolated($"""
            SELECT * FROM payments
            WHERE "Status" = 'Approved' AND "CallbackDeliveredAt" IS NULL AND "CallbackAttempts" < {MaxAttempts}
            ORDER BY "ApprovedAt" LIMIT 20
            FOR UPDATE SKIP LOCKED
            """).ToListAsync(ct);

        foreach (var p in pending)
        {
            // Continue the trace of the request that created the payment.
            using var activity = Source.StartActivity("payment.webhook", ActivityKind.Internal, p.TraceParent);
            activity?.SetTag("payment.id", p.Id.ToString());
            activity?.SetTag("order.id", p.OrderId.ToString());

            p.CallbackAttempts++;
            try
            {
                var body = JsonSerializer.Serialize(new
                {
                    paymentId = p.Id, orderId = p.OrderId, status = p.Status.ToString(), approvedAt = p.ApprovedAt,
                });
                using var request = new HttpRequestMessage(HttpMethod.Post, p.CallbackUrl)
                {
                    Content = new StringContent(body, Encoding.UTF8, "application/json"),
                };
                // Like a real gateway: the merchant checks this before trusting the callback.
                request.Headers.Add("X-Signature", Convert.ToHexStringLower(HMACSHA256.HashData(_secret, Encoding.UTF8.GetBytes(body))));
                using var response = await http.CreateClient("webhooks").SendAsync(request, ct);
                response.EnsureSuccessStatusCode();
                p.CallbackDeliveredAt = DateTimeOffset.UtcNow;
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                activity?.SetStatus(ActivityStatusCode.Error, e.Message);
                log.LogWarning(e, "Webhook for payment {PaymentId} failed (attempt {Attempt})", p.Id, p.CallbackAttempts);
            }
        }
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
    }
}
