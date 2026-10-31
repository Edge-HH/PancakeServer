using Microsoft.EntityFrameworkCore;
using Pancake.Server.Data;
using Pancake.Server.Services;
using Pancake.Shared;

namespace Pancake.Server.Endpoints;

/// <summary>
/// 项目编辑占用：大屏进入编辑模式、网页开始修改时占用，另一端看到“本地修改中”或“云端修改中”，只能查看。
/// 申请即续期，双方每 15 秒心跳一次；网页可以请求占用中的大屏保存并退出编辑，大屏没有响应时可以强制接管。
/// </summary>
public static class EditLockEndpoints
{
    public static void MapEditLockEndpoints(this WebApplication app)
    {
        app.MapGet("/api/classes/{classId:guid}/edit-locks", async (HttpRequest http, Guid classId, PancakeDbContext db, SessionStore sessions, EditLockService locks) =>
        {
            if (await Access.Caller(http, classId, db, sessions) is null) return Results.StatusCode(StatusCodes.Status403Forbidden);
            return Results.Ok(locks.List(classId));
        });

        app.MapPut("/api/classes/{classId:guid}/projects/{projectId:guid}/edit-lock", async (HttpRequest http, Guid classId, Guid projectId, EditLockRequest? request, PancakeDbContext db, SessionStore sessions, EditLockService locks, ClassSocketHub hub) =>
        {
            if (await Access.Caller(http, classId, db, sessions) is not { } caller) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var project = await db.Projects.AsNoTracking().SingleOrDefaultAsync(x => x.ClassId == classId && x.ProjectId == projectId);
            // 大屏可能在项目第一次上传之前就进入编辑，设备申请时项目不存在也照常占用。
            if (caller.Device is null && (project is null || project.Deleted)) return project is null ? Results.NotFound() : Results.BadRequest("项目已删除，请先恢复。");
            if (Holder(caller, request?.ClientId) is not { } holder) return Results.BadRequest("缺少页面标识。");
            var result = locks.Acquire(classId, projectId, holder, request?.Force == true);
            if (result.Outcome == EditLockService.Outcome.Denied) return Results.Json(result.Current, statusCode: StatusCodes.Status423Locked);
            if (result.Outcome != EditLockService.Outcome.Renewed) await hub.PublishToUsersAsync(Changed(classId, projectId, result.Current), CancellationToken.None);
            if (result.Previous?.DeviceId is { } previous)
            {
                // 被接管的大屏照常保存并退出编辑；它随后的上传会被占用拦下，等网页保存后按冲突合并或另存副本，不会丢失。
                await hub.SendToDeviceAsync(new SyncEvent(classId, projectId, project?.Revision ?? 0, SyncEventTypes.Command, previous, DeviceCommands.EndEdit, holder.Name), previous, CancellationToken.None);
                Access.Audit(db, caller.Actor, "接管大屏编辑", $"{project?.Name}（{result.Previous.Name}）", classId);
                await db.SaveChangesAsync();
            }
            return Results.Ok(result.Current);
        });

        app.MapDelete("/api/classes/{classId:guid}/projects/{projectId:guid}/edit-lock", async (HttpRequest http, Guid classId, Guid projectId, string? clientId, PancakeDbContext db, SessionStore sessions, EditLockService locks, ClassSocketHub hub) =>
        {
            if (await Access.Caller(http, classId, db, sessions) is not { } caller) return Results.StatusCode(StatusCodes.Status403Forbidden);
            if (Holder(caller, clientId) is { } holder && locks.Release(classId, projectId, holder))
                await hub.PublishToUsersAsync(Changed(classId, projectId, null), CancellationToken.None);
            return Results.NoContent();
        });

        // 网页上的“结束并保存大屏修改”：通知占用中的大屏保存、上传并退出编辑，大屏随后释放占用。
        app.MapPost("/api/classes/{classId:guid}/projects/{projectId:guid}/edit-lock/end", async (HttpRequest http, Guid classId, Guid projectId, PancakeDbContext db, SessionStore sessions, EditLockService locks, ClassSocketHub hub) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var current = locks.Find(classId, projectId);
            if (current?.DeviceId is not { } deviceId) return Results.Ok(new { delivered = false, free = current is null });
            var project = await db.Projects.AsNoTracking().SingleOrDefaultAsync(x => x.ClassId == classId && x.ProjectId == projectId);
            bool delivered = await hub.SendToDeviceAsync(new SyncEvent(classId, projectId, project?.Revision ?? 0, SyncEventTypes.Command, deviceId, DeviceCommands.EndEdit, session.DisplayName), deviceId, CancellationToken.None);
            Access.Audit(db, Access.Actor(session), "请求大屏结束编辑", $"{project?.Name}（{current.Name}）{(delivered ? "" : "（大屏离线）")}", classId);
            await db.SaveChangesAsync();
            return Results.Ok(new { delivered, free = false });
        });
    }

    /// <summary>editing 通知：Lock 为空表示已释放。</summary>
    public static SyncEvent Changed(Guid classId, Guid projectId, EditLockInfo? current) =>
        new(classId, projectId, 0, SyncEventTypes.Editing, Lock: current);

    private static EditLockService.Holder? Holder(ClassCaller caller, string? clientId)
    {
        if (caller.Device is { } device) return EditLockService.Holder.Device(device);
        string id = (clientId ?? "").Trim();
        return id.Length is < 1 or > 64 ? null : EditLockService.Holder.User(caller.Session!, id);
    }
}
