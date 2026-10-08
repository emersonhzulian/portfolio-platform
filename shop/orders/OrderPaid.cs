using System.Text.Json;

namespace Orders;

// The order.paid event, as a CloudEvents 1.0 JSON envelope: consumers get a stable id (for
// de-duplication - delivery is at-least-once), a type and the order itself.
public static class OrderPaid
{
    public static string ToCloudEvent(Order order) => JsonSerializer.Serialize(new
    {
        specversion = "1.0",
        type = "dev.emersonzulian.shop.order.paid",
        source = "/orders",
        id = Guid.NewGuid(),
        time = order.PaidAt,
        datacontenttype = "application/json",
        subject = order.Id,
        data = new
        {
            orderId = order.Id,
            userId = order.UserId,
            userName = order.UserName,
            total = order.Total,
            paidAt = order.PaidAt,
            items = order.Items.Select(i => new { i.ProductName, i.UnitPrice, i.Quantity }),
        },
    }, JsonSerializerOptions.Web);
}
