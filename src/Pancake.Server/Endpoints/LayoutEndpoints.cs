using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Pancake.Server.Contracts;
using Pancake.Server.Data;
using Pancake.Server.Services;
using Pancake.Shared;

namespace Pancake.Server.Endpoints;

/// <summary>
/// 班级设置（沿用“布局”的名字）：大屏的布局模式、组件位置、网格、字体、工具栏、背景、主题色系、提醒与输入习惯等，
/// 清单见 SettingsSchema。使用修订号做乐观并发：整体写入要求修订号一致，按键写入只在同一个键被别人改过时才冲突。
/// 每次写入保留快照便于回滚。
/// </summary>
public static class LayoutEndpoints
{
    private const int KeepRevisions = 30;
    private const int MaxLayoutBytes = 512 * 1024;

    public static void MapLayoutEndpoints(this WebApplication app)
    {
        app.MapGet("/api/settings-schema", () => Results.Ok(SettingsSchema.Describe()));

        app.MapGet("/api/classes/{classId:guid}/layout", async (HttpRequest http, Guid classId, PancakeDbContext db, SessionStore sessions) =>
        {
            if (await Access.Caller(http, classId, db, sessions) is null) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var classroom = await db.Classes.SingleOrDefaultAsync(x => x.Id == classId && !x.Deleted);
            if (classroom is null) return Results.NotFound();
            var layout = await db.Layouts.FindAsync(classId);
            return Results.Ok(ToSnapshot(layout, classroom));
        });

        // 整体写入：旧版大屏使用，要求修订号一致。
        app.MapPut("/api/classes/{classId:guid}/layout", async (HttpRequest http, Guid classId, LayoutWriteRequest request, PancakeDbContext db, SessionStore sessions, ClassSocketHub hub) =>
        {
            if (await Access.Caller(http, classId, db, sessions) is not { } caller) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var classroom = await db.Classes.SingleOrDefaultAsync(x => x.Id == classId && !x.Deleted);
            if (classroom is null) return Results.NotFound();
            if (DeviceLocked(caller, classroom) is { } locked) return locked;
            if ((request.PayloadJson ?? "").Length > MaxLayoutBytes) return Results.BadRequest("布局数据过大。");
            if (PayloadEditor.TryParse(request.PayloadJson) is not { } incoming) return Results.BadRequest("布局不是有效的 JSON 对象。");
            var layout = await db.Layouts.FindAsync(classId);
            long current = layout?.Revision ?? 0;
            if (current != request.ExpectedRevision)
                return Results.Conflict(new { error = "布局已被其他设备或网页修改。", server = ToSnapshot(layout, classroom) });
            JsonObject next = SettingsSchema.Sanitize(incoming);
            List<string> changed = SettingsSchema.ChangedKeys(Parse(layout?.PayloadJson), next);
            if (layout is not null && changed.Count == 0) return Results.Ok(ToSnapshot(layout, classroom));
            if (caller.Device is { } device) device.LastSyncAt = DateTime.UtcNow;
            layout = await Commit(db, hub, classId, layout, next, changed, caller.Actor, caller.Device?.Id);
            return Results.Ok(ToSnapshot(layout, classroom));
        });

        // 按键写入：设备和网页都用它。不同的键可以同时修改；同一个键在 BaseRevision 之后被别人改成别的值才返回 409。
        app.MapMethods("/api/classes/{classId:guid}/layout", ["PATCH"], async (HttpRequest http, Guid classId, LayoutPatchRequest request, PancakeDbContext db, SessionStore sessions, ClassSocketHub hub) =>
        {
            if (await Access.Caller(http, classId, db, sessions) is not { } caller) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var classroom = await db.Classes.SingleOrDefaultAsync(x => x.Id == classId && !x.Deleted);
            if (classroom is null) return Results.NotFound();
            if (DeviceLocked(caller, classroom) is { } locked) return locked;
            var layout = await db.Layouts.FindAsync(classId);
            JsonObject current = Parse(layout?.PayloadJson);
            JsonObject next = (JsonObject)current.DeepClone();
            JsonObject keyRevisions = Parse(layout?.KeyRevisionsJson);
            JsonObject set = new();
            foreach (var (key, element) in request.Set ?? [])
                set[key] = JsonNode.Parse(element.GetRawText());
            JsonObject clean = SettingsSchema.Sanitize(set);
            List<string> unset = (request.Unset ?? []).Where(k => SettingsSchema.IsSynced(k) && !clean.ContainsKey(k)).Distinct().ToList();
            if (clean.Count == 0 && unset.Count == 0 && set.Count > 0) return Results.BadRequest("没有可识别的设置。");

            List<string> conflicts = [];
            foreach (var (key, value) in clean)
                if (Revision(keyRevisions, key) > request.BaseRevision && !SettingsSchema.Same(current[key], value)) conflicts.Add(key);
            foreach (string key in unset)
                if (Revision(keyRevisions, key) > request.BaseRevision && current.ContainsKey(key)) conflicts.Add(key);
            if (conflicts.Count > 0)
                return Results.Json(new LayoutConflictResponse("这些设置刚被其他设备或网页修改。", conflicts, ToSnapshot(layout, classroom)), statusCode: StatusCodes.Status409Conflict);

            foreach (var (key, value) in clean) next[key] = value?.DeepClone();
            foreach (string key in unset) next.Remove(key);
            if (next.ToJsonString().Length > MaxLayoutBytes) return Results.BadRequest("布局数据过大。");
            List<string> changed = SettingsSchema.ChangedKeys(current, next);
            if (changed.Count == 0) return Results.Ok(ToSnapshot(layout, classroom));
            if (caller.Device is { } device) device.LastSyncAt = DateTime.UtcNow;
            layout = await Commit(db, hub, classId, layout, next, changed, caller.Actor, caller.Device?.Id);
            return Results.Ok(ToSnapshot(layout, classroom));
        });

        app.MapPut("/api/classes/{classId:guid}/layout/policy", async (HttpRequest http, Guid classId, LayoutPolicyRequest request, PancakeDbContext db, SessionStore sessions, ClassSocketHub hub) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageStaff(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            if (!LayoutPolicies.IsValid(request.Policy)) return Results.BadRequest("同步策略无效。");
            var classroom = await db.Classes.SingleOrDefaultAsync(x => x.Id == classId && !x.Deleted);
            if (classroom is null) return Results.NotFound();
            if (classroom.LayoutPolicy == request.Policy) return Results.NoContent();
            classroom.LayoutPolicy = request.Policy;
            Access.Audit(db, Access.Actor(session), "布局同步策略", PolicyLabel(request.Policy), classId);
            await db.SaveChangesAsync();
            var layout = await db.Layouts.FindAsync(classId);
            await hub.PublishAsync(new SyncEvent(classId, Guid.Empty, layout?.Revision ?? 0, SyncEventTypes.Layout), CancellationToken.None);
            return Results.NoContent();
        });

        app.MapGet("/api/classes/{classId:guid}/layout/history", async (HttpRequest http, Guid classId, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            return Results.Ok(await db.LayoutRevisions.Where(x => x.ClassId == classId).OrderByDescending(x => x.Revision)
                .Select(x => new LayoutRevisionItem(x.Revision, x.Author, x.CreatedAt, x.PayloadJson.Length)).ToListAsync());
        });

        app.MapGet("/api/classes/{classId:guid}/layout/history/{revision:long}", async (HttpRequest http, Guid classId, long revision, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var item = await db.LayoutRevisions.Where(x => x.ClassId == classId && x.Revision == revision).OrderByDescending(x => x.Id).FirstOrDefaultAsync();
            return item is null ? Results.NotFound() : Results.Ok(new { item.Revision, item.PayloadJson, item.Author, item.CreatedAt });
        });

        app.MapPost("/api/classes/{classId:guid}/layout/restore", async (HttpRequest http, Guid classId, LayoutRestoreRequest request, PancakeDbContext db, SessionStore sessions, ClassSocketHub hub) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var item = await db.LayoutRevisions.Where(x => x.ClassId == classId && x.Revision == request.Revision).OrderByDescending(x => x.Id).FirstOrDefaultAsync();
            if (item is null) return Results.NotFound("该历史版本已不存在。");
            var layout = await db.Layouts.FindAsync(classId);
            JsonObject restored = SettingsSchema.Sanitize(Parse(item.PayloadJson));
            Access.Audit(db, Access.Actor(session), "回滚布局", $"← 修订 {request.Revision}", classId);
            layout = await Commit(db, hub, classId, layout, restored, SettingsSchema.ChangedKeys(Parse(layout?.PayloadJson), restored), Access.Actor(session), null);
            return Results.Ok(new { layout.Revision });
        });

        // 把本班布局复制到其他班级：适合统一全年级大屏的样式。
        app.MapPost("/api/classes/{classId:guid}/layout/copy", async (HttpRequest http, Guid classId, CopyLayoutRequest request, PancakeDbContext db, SessionStore sessions, ClassSocketHub hub) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var source = await db.Layouts.FindAsync(classId);
            if (source is null || source.Revision == 0) return Results.BadRequest("本班还没有布局，请先让大屏同步一次。");
            var targets = (request.ClassIds ?? []).Where(x => x != classId).Distinct().ToList();
            if (targets.Count == 0) return Results.BadRequest("请选择目标班级。");
            var refs = PayloadEditor.AllAssetRefs(source.PayloadJson).ToList();
            JsonObject payload = Parse(source.PayloadJson);
            List<string> names = [];
            foreach (Guid target in targets)
            {
                if (!await Access.CanManageClass(session, target, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
                var classroom = await db.Classes.SingleOrDefaultAsync(x => x.Id == target && !x.Deleted);
                if (classroom is null) continue;
                await AssetEndpoints.ShareAsync(db, classId, target, refs, Access.Actor(session));
                var existing = await db.Layouts.FindAsync(target);
                await Commit(db, hub, target, existing, payload, SettingsSchema.ChangedKeys(Parse(existing?.PayloadJson), payload), Access.Actor(session), null);
                names.Add(classroom.Name);
            }
            var sourceName = await db.Classes.Where(x => x.Id == classId).Select(x => x.Name).SingleAsync();
            Access.Audit(db, Access.Actor(session), "复制布局", $"{sourceName} → {string.Join("、", names)}", classId);
            await db.SaveChangesAsync();
            return Results.Ok(new { copied = names.Count });
        });
    }

    public static string PolicyLabel(string policy) => policy switch
    {
        LayoutPolicies.Managed => "网页统一下发",
        LayoutPolicies.Off => "不同步布局",
        _ => "设备与网页双向同步"
    };

    /// <summary>统一管理或关闭同步时，设备不能写入班级设置。</summary>
    private static IResult? DeviceLocked(ClassCaller caller, Classroom classroom) =>
        caller.Device is not null && classroom.LayoutPolicy != LayoutPolicies.Shared
            ? Results.Problem(classroom.LayoutPolicy == LayoutPolicies.Managed ? "本班布局由网页统一下发，设备不能上传。" : "本班已关闭布局同步。", statusCode: StatusCodes.Status423Locked)
            : null;

    private static JsonObject Parse(string? json) => PayloadEditor.TryParse(json) ?? new JsonObject();

    private static long Revision(JsonObject keyRevisions, string key) =>
        keyRevisions[key] is JsonValue v && v.TryGetValue(out long revision) ? revision : 0;

    private static LayoutSnapshot ToSnapshot(ClassLayout? layout, Classroom classroom) =>
        new(layout?.Revision ?? 0, classroom.LayoutPolicy, layout?.PayloadJson ?? "{}", layout?.UpdatedAt, layout?.UpdatedBy ?? "");

    private static async Task<ClassLayout> Commit(PancakeDbContext db, ClassSocketHub hub, Guid classId, ClassLayout? layout, JsonObject payload, List<string> changedKeys, string actor, Guid? sourceDevice)
    {
        if (layout is null) { layout = new ClassLayout { ClassId = classId }; db.Layouts.Add(layout); }
        layout.Revision++;
        layout.PayloadJson = payload.ToJsonString(PayloadEditor.Compact);
        layout.UpdatedAt = DateTime.UtcNow; layout.UpdatedBy = actor;
        JsonObject keyRevisions = Parse(layout.KeyRevisionsJson);
        foreach (string key in changedKeys) keyRevisions[key] = layout.Revision;
        layout.KeyRevisionsJson = keyRevisions.ToJsonString();
        db.LayoutRevisions.Add(new LayoutRevision { ClassId = classId, Revision = layout.Revision, PayloadJson = layout.PayloadJson, Author = actor, CreatedAt = layout.UpdatedAt });
        await db.SaveChangesAsync();
        var stale = await db.LayoutRevisions.Where(x => x.ClassId == classId).OrderByDescending(x => x.Revision).Skip(KeepRevisions).ToListAsync();
        if (stale.Count > 0) { db.LayoutRevisions.RemoveRange(stale); await db.SaveChangesAsync(); }
        await hub.PublishAsync(new SyncEvent(classId, Guid.Empty, layout.Revision, SyncEventTypes.Layout, SourceDeviceId: sourceDevice, Keys: changedKeys), CancellationToken.None);
        return layout;
    }
}
