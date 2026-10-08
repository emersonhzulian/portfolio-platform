// orders: the shop's backend. Catalog, orders, the payment webhook and the order.paid event.
// Visitors are authenticated by authentik (the web app forwards their access token); the
// user is recorded on the request's span as enduser.id, so Grafana can show "my" traces.
using System.Diagnostics;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Orders;

var builder = WebApplication.CreateBuilder(args);
var cfg = builder.Configuration;

builder.Services.AddDbContext<OrdersDb>(o => o.UseNpgsql(cfg.GetConnectionString("Orders")));
builder.Services.AddHttpClient("payments", c =>
{
    c.BaseAddress = new Uri(cfg["Payments:BaseUrl"] ?? throw new InvalidOperationException("Payments:BaseUrl is required"));
    c.Timeout = TimeSpan.FromSeconds(10);
});
builder.Services.AddHostedService<OutboxPublisher>();
builder.Services.AddSingleton<FaultInjection>();

// Tokens are issued by authentik for the public URL (Auth:Issuer); signing keys are fetched
// in-cluster (Auth:MetadataAddress) so validation never leaves the namespace.
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(o =>
{
    var metadata = cfg["Auth:MetadataAddress"];
    o.MapInboundClaims = false;
    o.Authority = cfg["Auth:Issuer"];
    if (!string.IsNullOrEmpty(metadata))
    {
        o.MetadataAddress = metadata;
        o.RequireHttpsMetadata = metadata.StartsWith("https://", StringComparison.Ordinal);
    }
    o.TokenValidationParameters.ValidIssuer = cfg["Auth:Issuer"];
    o.TokenValidationParameters.ValidAudience = cfg["Auth:Audience"];
    o.TokenValidationParameters.NameClaimType = "preferred_username";
});
builder.Services.AddAuthorization();

var app = builder.Build();
await Schema.EnsureAsync(app.Services);

app.UseMiddleware<FaultInjection>();
app.UseAuthentication();
// Tag the server span with the visitor, before anything else runs.
app.Use(async (ctx, next) =>
{
    if (ctx.User.Identity?.IsAuthenticated == true)
        Activity.Current?.SetTag("enduser.id", ctx.User.Identity.Name);
    await next(ctx);
});
app.UseAuthorization();

app.MapGet("/livez", () => Results.Ok("ok"));
app.MapGet("/healthz", async (OrdersDb db) =>
    await db.Database.CanConnectAsync() ? Results.Ok("ok") : Results.StatusCode(503));

app.MapGet("/products", async (OrdersDb db) =>
    await db.Products.OrderBy(p => p.Id).ToListAsync());

var orders = app.MapGroup("/orders").RequireAuthorization();

orders.MapPost("/", async (CreateOrder req, ClaimsPrincipal user, OrdersDb db, IHttpClientFactory http,
    ILogger<Program> log, CancellationToken ct) =>
{
    if (req.Items is not { Count: > 0 and <= 10 } || req.Items.Any(i => i.Quantity is < 1 or > 10))
        return Results.BadRequest(new { error = "1 to 10 lines, quantity 1 to 10 each" });

    var ids = req.Items.Select(i => i.ProductId).ToList();
    var products = await db.Products.Where(p => ids.Contains(p.Id)).ToDictionaryAsync(p => p.Id, ct);
    if (products.Count != ids.Distinct().Count()) return Results.BadRequest(new { error = "unknown product" });

    var now = DateTimeOffset.UtcNow;
    var order = new Order
    {
        Id = Guid.NewGuid(),
        UserId = user.FindFirstValue("sub")!,
        UserName = user.Identity!.Name ?? "unknown",
        Status = OrderStatus.AwaitingPayment,
        CreatedAt = now,
        Items = req.Items.Select(i => new OrderItem
        {
            ProductId = i.ProductId, ProductName = products[i.ProductId].Name,
            UnitPrice = products[i.ProductId].Price, Quantity = i.Quantity,
        }).ToList(),
    };
    order.Total = order.Items.Sum(i => i.UnitPrice * i.Quantity);
    order.Events.Add(Event("created", $"Order placed by {order.UserName}", now));
    db.Orders.Add(order);
    await db.SaveChangesAsync(ct);
    Activity.Current?.SetTag("order.id", order.Id.ToString());

    var response = await http.CreateClient("payments").PostAsJsonAsync("/payments", new
    {
        orderId = order.Id, amount = order.Total, callbackUrl = cfg["Orders:CallbackUrl"],
    }, ct);
    if (!response.IsSuccessStatusCode)
    {
        log.LogWarning("Payment request for order {OrderId} failed with {Status}", order.Id, (int)response.StatusCode);
        order.Events.Add(Event("payment-failed", "The payment provider didn't accept the request", DateTimeOffset.UtcNow));
        await db.SaveChangesAsync(ct);
        return Results.Problem("The payment provider is unavailable, try again.", statusCode: 502);
    }
    var payment = await response.Content.ReadFromJsonAsync<PaymentCreated>(ct);
    order.PaymentId = payment!.Id;
    order.Events.Add(Event("payment-requested", "Pix charge created, waiting for the bank", DateTimeOffset.UtcNow));
    await db.SaveChangesAsync(ct);
    log.LogInformation("Order {OrderId} placed by {User}, total {Total}", order.Id, order.UserName, order.Total);

    return Results.Created($"/orders/{order.Id}", OrderView.From(order));
});

orders.MapGet("/", async (ClaimsPrincipal user, OrdersDb db) =>
{
    var sub = user.FindFirstValue("sub");
    var mine = await db.Orders.Where(o => o.UserId == sub).OrderByDescending(o => o.CreatedAt).Take(20)
        .Include(o => o.Items).Include(o => o.Events).AsSplitQuery().ToListAsync();
    return mine.Select(OrderView.From);
});

orders.MapGet("/{id:guid}", async (Guid id, ClaimsPrincipal user, OrdersDb db) =>
{
    var order = await db.Orders.Include(o => o.Items).Include(o => o.Events).AsSplitQuery()
        .FirstOrDefaultAsync(o => o.Id == id);
    // Someone else's order is as good as missing.
    return order is not null && order.UserId == user.FindFirstValue("sub")
        ? Results.Ok(OrderView.From(order)) : Results.NotFound();
});

// Called by the payment provider (payments), not by visitors: authenticated by the HMAC
// signature over the body, and idempotent - a redelivered webhook changes nothing.
app.MapPost("/payments/callback", async (HttpRequest request, OrdersDb db, ILogger<Program> log) =>
{
    using var reader = new StreamReader(request.Body);
    var body = await reader.ReadToEndAsync();
    var secret = Encoding.UTF8.GetBytes(cfg["Orders:WebhookSecret"]!);
    var expected = Convert.ToHexStringLower(HMACSHA256.HashData(secret, Encoding.UTF8.GetBytes(body)));
    if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(expected),
            Encoding.ASCII.GetBytes(request.Headers["X-Signature"].ToString())))
        return Results.Unauthorized();

    var callback = JsonSerializer.Deserialize<PaymentCallback>(body, JsonSerializerOptions.Web)!;
    var order = await db.Orders.Include(o => o.Items).FirstOrDefaultAsync(o => o.Id == callback.OrderId);
    if (order is null) return Results.NotFound();
    Activity.Current?.SetTag("order.id", order.Id.ToString());
    Activity.Current?.SetTag("enduser.id", order.UserName);
    if (order.Status == OrderStatus.Paid || callback.Status != "Approved") return Results.NoContent();

    var now = DateTimeOffset.UtcNow;
    order.Status = OrderStatus.Paid;
    order.PaidAt = now;
    db.OrderEvents.Add(Event("paid", "Payment confirmed by the provider", now, order.Id));
    db.Outbox.Add(new OutboxMessage
    {
        Topic = "order.paid",
        Key = order.Id.ToString(),
        Payload = OrderPaid.ToCloudEvent(order),
        TraceParent = Activity.Current?.Id,
        CreatedAt = now,
    });
    await db.SaveChangesAsync(); // order state and outbox row in one transaction
    log.LogInformation("Order {OrderId} paid", order.Id);
    return Results.NoContent();
});

app.Run();

static OrderEvent Event(string type, string detail, DateTimeOffset at, Guid orderId = default) =>
    new() { Type = type, Detail = detail, At = at, OrderId = orderId };

public record CreateOrder(List<CreateOrderItem> Items);
public record CreateOrderItem(int ProductId, int Quantity);
public record PaymentCreated(Guid Id, string Status);
public record PaymentCallback(Guid PaymentId, Guid OrderId, string Status, DateTimeOffset? ApprovedAt);

public record OrderView(Guid Id, string Status, decimal Total, DateTimeOffset CreatedAt, DateTimeOffset? PaidAt,
    IEnumerable<object> Items, IEnumerable<object> Events)
{
    public static OrderView From(Order o) => new(o.Id, o.Status.ToString(), o.Total, o.CreatedAt, o.PaidAt,
        o.Items.Select(i => (object)new { i.ProductId, i.ProductName, i.UnitPrice, i.Quantity }),
        o.Events.OrderBy(e => e.At).Select(e => (object)new { e.Type, e.Detail, e.At }));
}
