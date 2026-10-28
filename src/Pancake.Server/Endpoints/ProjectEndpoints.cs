using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Pancake.Server.Contracts;
using Pancake.Server.Data;
using Pancake.Server.Services;
using Pancake.Shared;

namespace Pancake.Server.Endpoints;

public static class ProjectEndpoints
{
    private const int KeepRevisions = 30;

    public static void MapProjectEndpoints(this WebApplication app)
    {
        app.MapGet("/api/classes/{classId:guid}/projects", async (HttpRequest http, Guid classId, PancakeDbContext db, SessionStore sessions) =>
        {
            if (await CanRead(http, classId, db, sessions) is { } denied) return denied;
            if (!await db.Classes.AnyAsync(x => x.Id == classId && !x.Deleted)) return Results.NotFound();
            var projects = await db.Projects.Where(x => x.ClassId == classId).OrderBy(x => x.Date).ThenBy(x => x.Name)
                .Select(x => new ProjectListItem(x.ProjectId, x.Name, x.Date, x.Revision, x.Deleted, x.UpdatedAt, x.UpdatedBy)).ToListAsync();
            return Results.Ok(projects);
        });

        app.MapGet("/api/classes/{classId:guid}/projects/{projectId:guid}", async (HttpRequest http, Guid classId, Guid projectId, PancakeDbContext db, SessionStore sessions) =>
        {
            if (await CanRead(http, classId, db, sessions) is { } denied) return denied;
            var project = await db.Projects.SingleOrDefaultAsync(x => x.ClassId == classId && x.ProjectId == projectId);
            if (project is null) return Results.NotFound();
            // 网页需要富文本片段；设备只用 PayloadJson，不附带，减少同步流量。
            return Results.Ok(Access.User(http, sessions, out _) ? ToDetail(project) with { Runs = PayloadEditor.EntryRuns(project.PayloadJson) } : ToDetail(project));
        });

        // 网页新建项目：默认沿用最近一个项目的科目、颜色和位置，作业内容留空。
        app.MapPost("/api/classes/{classId:guid}/projects", async (HttpRequest http, Guid classId, CreateProjectRequest request, PancakeDbContext db, ClassSocketHub hub, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            if (!await db.Classes.AnyAsync(x => x.Id == classId && !x.Deleted)) return Results.NotFound();
            string name = (request.Name ?? "").Trim();
            if (name.Length is < 1 or > 80) return Results.BadRequest("项目名称需为 1–80 个字符。");
            ServerProject? template = null;
            if (request.TemplateProjectId is { } templateId)
                template = await db.Projects.SingleOrDefaultAsync(x => x.ClassId == classId && x.ProjectId == templateId);
            else if (request.UseLatestTemplate)
                template = await db.Projects.Where(x => x.ClassId == classId && !x.Deleted)
                    .OrderByDescending(x => x.Date).ThenByDescending(x => x.UpdatedAt).FirstOrDefaultAsync();
            Guid id = Guid.NewGuid();
            var project = new ServerProject
            {
                ClassId = classId, ProjectId = id, Name = name, Date = request.Date,
                PayloadJson = PayloadEditor.CreatePayload(id, name, request.Date, template?.PayloadJson)
            };
            db.Projects.Add(project);
            Access.Audit(db, Access.Actor(session), "新建项目", $"{name}{(template is null ? "" : $"（沿用“{template.Name}”的科目）")}", classId);
            await Commit(db, hub, project, Access.Actor(session), SyncEventTypes.Updated);
            return Results.Created($"/api/classes/{classId}/projects/{id}", ToDetail(project));
        });

        app.MapPut("/api/classes/{classId:guid}/projects/{projectId:guid}", async (HttpRequest http, Guid classId, Guid projectId, ProjectWriteRequest request, PancakeDbContext db, ClassSocketHub hub, SessionStore sessions) =>
        {
            if (await Access.Caller(http, classId, db, sessions) is not { } caller) return Results.StatusCode(StatusCodes.Status403Forbidden);
            if (!await db.Classes.AnyAsync(x => x.Id == classId && !x.Deleted)) return Results.NotFound("班级不存在。");
            string name = (request.Name ?? "").Trim();
            if (name.Length is < 1 or > 200) return Results.BadRequest("项目名称需为 1–200 个字符。");
            bool keepPayload = request.Deleted && string.IsNullOrEmpty(request.PayloadJson);
            if (!keepPayload && PayloadEditor.TryParse(request.PayloadJson) is null) return Results.BadRequest("项目内容不是有效的 JSON 对象。");
            var project = await db.Projects.SingleOrDefaultAsync(x => x.ClassId == classId && x.ProjectId == projectId);
            bool created = project is null;
            if (project is null)
            {
                if (request.ExpectedRevision != 0) return Results.Conflict(new { error = "项目不存在，期望修订号必须为 0。" });
                if (keepPayload) return Results.NoContent();
                project = new ServerProject { ClassId = classId, ProjectId = projectId };
                db.Projects.Add(project);
            }
            else if (project.Revision != request.ExpectedRevision)
            {
                return Results.Conflict(new ConflictResponse("项目已被其他设备修改。", ToSnapshot(project), new ProjectSnapshot(projectId, name, request.Date, request.ExpectedRevision, request.Deleted, request.PayloadJson ?? "", DateTime.UtcNow)));
            }
            string payload = keepPayload ? project.PayloadJson : request.PayloadJson;
            // 内容完全一致时不生成新修订：设备自动保存很频繁，不能把历史挤满相同的快照。
            if (!created && project.Name == name && project.Date == request.Date && project.Deleted == request.Deleted && project.PayloadJson == payload)
            {
                await TouchDevice(db, caller);
                return Results.Ok(ToDetail(project));
            }
            bool nowDeleted = request.Deleted && !project.Deleted;
            project.Name = name; project.Date = request.Date; project.Deleted = request.Deleted; project.PayloadJson = payload;
            if (created) Access.Audit(db, caller.Actor, "新建项目", project.Name, classId);
            else if (nowDeleted) Access.Audit(db, caller.Actor, "删除项目", project.Name, classId);
            await TouchDevice(db, caller, save: false);
            await Commit(db, hub, project, caller.Actor, project.Deleted ? SyncEventTypes.Deleted : SyncEventTypes.Updated, caller.Device?.Id);
            return Results.Ok(ToDetail(project));
        });

        // 网页编辑作业：只改文字、科目和图片，磁贴位置与笔迹原样保留；科任老师只能改自己的科目。
        app.MapPut("/api/classes/{classId:guid}/projects/{projectId:guid}/content", async (HttpRequest http, Guid classId, Guid projectId, HomeworkEditRequest request, PancakeDbContext db, ClassSocketHub hub, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var project = await db.Projects.SingleOrDefaultAsync(x => x.ClassId == classId && x.ProjectId == projectId);
            if (project is null) return Results.NotFound();
            if (project.Deleted) return Results.BadRequest("项目已删除，请先恢复。");
            if (project.Revision != request.ExpectedRevision)
                return Results.Conflict(new { error = "项目刚刚被班级大屏或其他老师修改，请刷新后重新编辑。", revision = project.Revision });
            PayloadEditor.EditResult result;
            // 网页没指定字体、字号的文字按班级设置里的正文默认字体与字号写入。
            var classLayout = PayloadEditor.TryParse((await db.Layouts.FindAsync(classId))?.PayloadJson);
            string? defaultFamily = classLayout?["TileBodyFontFamily"] is JsonValue family && family.TryGetValue(out string? f) ? f : null;
            double? defaultSize = classLayout?["TileBodyFontSize"] is JsonValue size && size.TryGetValue(out double s) ? s : null;
            try { result = PayloadEditor.ApplyEdit(project.PayloadJson, request.Subjects ?? [], await Access.EditableSubjects(session, classId, db), defaultFamily, defaultSize); }
            catch (EditDeniedException ex) { return Results.Problem(ex.Message, statusCode: StatusCodes.Status403Forbidden); }
            catch (InvalidDataException ex) { return Results.BadRequest(ex.Message); }
            var known = await db.Assets.Where(x => x.ClassId == classId && result.AssetRefs.Contains(x.Sha256)).Select(x => x.Sha256).ToListAsync();
            if (result.AssetRefs.Except(known).Any()) return Results.BadRequest("有图片尚未上传完成，请重新添加。");
            if (result.ChangedSubjects.Count == 0) return Results.Ok(ToDetail(project) with { Runs = PayloadEditor.EntryRuns(project.PayloadJson) });
            project.PayloadJson = result.PayloadJson;
            Access.Audit(db, Access.Actor(session), "编辑作业", $"{project.Name}：{string.Join("、", result.ChangedSubjects.Take(8))}", classId);
            await Commit(db, hub, project, Access.Actor(session), SyncEventTypes.Updated);
            return Results.Ok(ToDetail(project) with { Runs = PayloadEditor.EntryRuns(project.PayloadJson) });
        });

        app.MapPatch("/api/classes/{classId:guid}/projects/{projectId:guid}", async (HttpRequest http, Guid classId, Guid projectId, ProjectPatchRequest request, PancakeDbContext db, ClassSocketHub hub, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var project = await db.Projects.SingleOrDefaultAsync(x => x.ClassId == classId && x.ProjectId == projectId);
            if (project is null) return Results.NotFound();
            if (request.Name is not null)
            {
                if (string.IsNullOrWhiteSpace(request.Name) || request.Name.Trim().Length > 80) return Results.BadRequest("项目名称需为 1–80 个字符。");
                project.Name = request.Name.Trim();
            }
            if (request.ClearDate) project.Date = null;
            else if (request.Date is not null) project.Date = request.Date;
            project.PayloadJson = PayloadEditor.SetMeta(project.PayloadJson, project.Name, project.Date);
            Access.Audit(db, Access.Actor(session), "修改项目信息", $"{project.Name} · {project.Date?.ToString("yyyy-MM-dd") ?? "无日期"}", classId);
            await Commit(db, hub, project, Access.Actor(session), SyncEventTypes.Updated);
            return Results.Ok(ToDetail(project));
        });

        app.MapDelete("/api/classes/{classId:guid}/projects/{projectId:guid}", async (HttpRequest http, Guid classId, Guid projectId, PancakeDbContext db, ClassSocketHub hub, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var project = await db.Projects.SingleOrDefaultAsync(x => x.ClassId == classId && x.ProjectId == projectId);
            if (project is null) return Results.NotFound();
            if (project.Deleted) return Results.NoContent();
            project.Deleted = true;
            Access.Audit(db, Access.Actor(session), "删除项目", project.Name, classId);
            await Commit(db, hub, project, Access.Actor(session), SyncEventTypes.Deleted);
            return Results.NoContent();
        });

        app.MapGet("/api/classes/{classId:guid}/projects/{projectId:guid}/history", async (HttpRequest http, Guid classId, Guid projectId, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var items = await db.ProjectRevisions.Where(x => x.ClassId == classId && x.ProjectId == projectId).OrderByDescending(x => x.Revision)
                .Select(x => new ProjectRevisionItem(x.Revision, x.Name, x.Date, x.Deleted, x.Author, x.CreatedAt, x.PayloadJson.Length)).ToListAsync();
            return Results.Ok(items);
        });

        app.MapGet("/api/classes/{classId:guid}/projects/{projectId:guid}/history/{revision:long}", async (HttpRequest http, Guid classId, Guid projectId, long revision, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var item = await db.ProjectRevisions.Where(x => x.ClassId == classId && x.ProjectId == projectId && x.Revision == revision).OrderByDescending(x => x.Id).FirstOrDefaultAsync();
            return item is null ? Results.NotFound() : Results.Ok(new ProjectDetail(projectId, item.Name, item.Date, item.Revision, item.Deleted, item.PayloadJson, item.CreatedAt, item.Author));
        });

        // 恢复会生成新的修订号，设备下次同步时会像普通更新一样拉取。
        app.MapPost("/api/classes/{classId:guid}/projects/{projectId:guid}/restore", async (HttpRequest http, Guid classId, Guid projectId, RestoreRequest request, PancakeDbContext db, ClassSocketHub hub, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var project = await db.Projects.SingleOrDefaultAsync(x => x.ClassId == classId && x.ProjectId == projectId);
            if (project is null) return Results.NotFound();
            string detail = project.Name;
            if (request.Revision is { } revision)
            {
                var old = await db.ProjectRevisions.Where(x => x.ClassId == classId && x.ProjectId == projectId && x.Revision == revision).OrderByDescending(x => x.Id).FirstOrDefaultAsync();
                if (old is null) return Results.NotFound("该历史版本已不存在。");
                project.Name = old.Name; project.Date = old.Date; project.PayloadJson = old.PayloadJson;
                detail = $"{old.Name} ← 修订 {revision}";
            }
            project.Deleted = false;
            Access.Audit(db, Access.Actor(session), request.Revision is null ? "恢复项目" : "回滚项目", detail, classId);
            await Commit(db, hub, project, Access.Actor(session), SyncEventTypes.Updated);
            return Results.Ok(ToDetail(project));
        });
    }

    private static async Task<IResult?> CanRead(HttpRequest http, Guid classId, PancakeDbContext db, SessionStore sessions)
    {
        if (Access.User(http, sessions, out var session))
            return await Access.CanManageClass(session, classId, db) ? null : Results.StatusCode(StatusCodes.Status403Forbidden);
        return await Access.Device(http, classId, db) is null ? Results.Unauthorized() : null;
    }

    /// <summary>设备成功写入后记录同步时间，网页设备列表据此显示“最近同步”。</summary>
    private static async Task TouchDevice(PancakeDbContext db, ClassCaller caller, bool save = true)
    {
        if (caller.Device is not { } device) return;
        device.LastSyncAt = DateTime.UtcNow;
        if (save) await db.SaveChangesAsync();
    }

    private static async Task Commit(PancakeDbContext db, ClassSocketHub hub, ServerProject project, string actor, string type, Guid? sourceDevice = null)
    {
        project.Revision++; project.UpdatedAt = DateTime.UtcNow; project.UpdatedBy = actor;
        db.ProjectRevisions.Add(new ProjectRevision
        {
            ClassId = project.ClassId, ProjectId = project.ProjectId, Revision = project.Revision, Name = project.Name,
            Date = project.Date, Deleted = project.Deleted, PayloadJson = project.PayloadJson, Author = actor, CreatedAt = project.UpdatedAt
        });
        await db.SaveChangesAsync();
        var stale = await db.ProjectRevisions.Where(x => x.ClassId == project.ClassId && x.ProjectId == project.ProjectId)
            .OrderByDescending(x => x.Revision).Skip(KeepRevisions).ToListAsync();
        if (stale.Count > 0) { db.ProjectRevisions.RemoveRange(stale); await db.SaveChangesAsync(); }
        await hub.PublishAsync(new SyncEvent(project.ClassId, project.ProjectId, project.Revision, type, SourceDeviceId: sourceDevice), CancellationToken.None);
    }

    public static ProjectSnapshot ToSnapshot(ServerProject p) => new(p.ProjectId, p.Name, p.Date, p.Revision, p.Deleted, p.PayloadJson, p.UpdatedAt);
    public static ProjectDetail ToDetail(ServerProject p) => new(p.ProjectId, p.Name, p.Date, p.Revision, p.Deleted, p.PayloadJson, p.UpdatedAt, p.UpdatedBy);
}
