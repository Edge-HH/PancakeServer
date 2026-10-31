using System.Reflection;
using Microsoft.EntityFrameworkCore;
using Pancake.Server.Contracts;
using Pancake.Server.Data;
using Pancake.Server.Services;

namespace Pancake.Server.Endpoints;

public static class PublicEndpoints
{
    private static DateTime StartedAt;

    public static void MapPublicEndpoints(this WebApplication app)
    {
        StartedAt = DateTime.UtcNow;
        app.MapGet("/api/health", (ClassSocketHub hub, SessionStore sessions) => Results.Ok(new
        {
            status = "ok",
            utc = DateTime.UtcNow,
            version = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3),
            startedAt = StartedAt,
            uptimeSeconds = (long)(DateTime.UtcNow - StartedAt).TotalSeconds,
            connections = hub.Total,
            sessions = sessions.ActiveSessionCount
        }));

        app.MapGet("/api/public/classes/{publicCode}/projects", async (string publicCode, PancakeDbContext db) =>
        {
            var classroom = await db.Classes.SingleOrDefaultAsync(x => x.PublicCode == publicCode.Trim().ToLower() && !x.Deleted);
            if (classroom is null) return Results.NotFound();
            var projects = await db.Projects.Where(x => x.ClassId == classroom.Id && !x.Deleted).OrderBy(x => x.Date).ThenBy(x => x.Name)
                .Select(x => new ProjectListItem(x.ProjectId, x.Name, x.Date, x.Revision, false, x.UpdatedAt, "")).ToListAsync();
            return Results.Ok(new { classroom = classroom.Name, projects });
        });

        app.MapGet("/api/public/classes/{publicCode}/projects/{projectId:guid}", async (string publicCode, Guid projectId, PancakeDbContext db) =>
        {
            var classroom = await db.Classes.SingleOrDefaultAsync(x => x.PublicCode == publicCode.Trim().ToLower() && !x.Deleted);
            if (classroom is null) return Results.NotFound();
            var project = await db.Projects.SingleOrDefaultAsync(x => x.ClassId == classroom.Id && x.ProjectId == projectId && !x.Deleted);
            return project is null ? Results.NotFound() : Results.Ok(ProjectEndpoints.ToDetail(project) with { UpdatedBy = "", Runs = PayloadEditor.EntryRuns(project.PayloadJson) });
        });

        // 浏览器无法给 WebSocket 设置请求头，令牌通过 access_token 查询参数传入。
        app.Map("/ws/classes/{classId:guid}", async (HttpContext context, Guid classId, ClassSocketHub hub, SessionStore sessions, PancakeDbContext db) =>
        {
            if (!context.WebSockets.IsWebSocketRequest) { context.Response.StatusCode = 400; return; }
            string token = context.Request.Query["access_token"].FirstOrDefault() ?? context.Request.Headers.Authorization.FirstOrDefault()?.Replace("Bearer ", "", StringComparison.OrdinalIgnoreCase) ?? "";
            Guid? deviceId = null, userId = null;
            bool allowed;
            if (sessions.TryGetSession("Bearer " + token, out var session)) { allowed = await Access.CanManageClass(session, classId, db); userId = session.UserId; }
            else { deviceId = (await Access.DeviceByToken(token, classId, db))?.Id; allowed = deviceId is not null; }
            if (!allowed) { context.Response.StatusCode = 401; return; }
            using var socket = await context.WebSockets.AcceptWebSocketAsync();
            await hub.HoldAsync(classId, socket, deviceId is null ? SocketKind.User : SocketKind.Device, deviceId, userId, context.RequestAborted);
        });

        app.Map("/ws/public/{publicCode}", async (HttpContext context, string publicCode, ClassSocketHub hub, PancakeDbContext db) =>
        {
            if (!context.WebSockets.IsWebSocketRequest) { context.Response.StatusCode = 400; return; }
            var classId = await db.Classes.Where(x => x.PublicCode == publicCode.Trim().ToLower() && !x.Deleted).Select(x => (Guid?)x.Id).SingleOrDefaultAsync();
            if (classId is null) { context.Response.StatusCode = 404; return; }
            using var socket = await context.WebSockets.AcceptWebSocketAsync();
            await hub.HoldAsync(classId.Value, socket, SocketKind.Public, null, null, context.RequestAborted);
        });
    }
}
