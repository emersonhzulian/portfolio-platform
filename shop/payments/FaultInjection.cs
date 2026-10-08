namespace Payments;

// Deliberate faults for demonstrating the canary analysis: FAULT_ERROR_RATE (percent of
// requests answered 500) and FAULT_LATENCY_MS (added to every request). Both default to off;
// a "bad release" is a commit that sets them. Health endpoints are never affected.
public class FaultInjection(IConfiguration config) : IMiddleware
{
    readonly int _errorRate = config.GetValue("FAULT_ERROR_RATE", 0);
    readonly int _latencyMs = config.GetValue("FAULT_LATENCY_MS", 0);

    public async Task InvokeAsync(HttpContext context, RequestDelegate next)
    {
        var path = context.Request.Path;
        if (path.StartsWithSegments("/healthz") || path.StartsWithSegments("/livez"))
        {
            await next(context);
            return;
        }
        if (_latencyMs > 0) await Task.Delay(_latencyMs);
        if (_errorRate > 0 && Random.Shared.Next(100) < _errorRate)
        {
            context.Response.StatusCode = StatusCodes.Status500InternalServerError;
            await context.Response.WriteAsync("injected fault");
            return;
        }
        await next(context);
    }
}
