using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Pancake.Server.Contracts;
using Pancake.Server.Data;
using Pancake.Server.Services;
using Pancake.Shared;

namespace Pancake.Server.Endpoints;

/// <summary>
/// 考试模式：考试计划的增删改查、启停与目标班级批量设置，以及大屏拉取本班的考试安排。
/// 到点显示由大屏按时间表自行判断，服务端只负责保存与推送变化。
/// </summary>
public static class ExamEndpoints
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static void MapExamEndpoints(this WebApplication app)
    {
        // ---------------------------------------------------------------- 计划管理（网页）
        app.MapGet("/api/admin/exam-plans", async (HttpRequest http, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session)) return Results.Unauthorized();
            Dictionary<Guid, string> manageable = await BoardEndpoints.ManageableClasses(db, session);
            var plans = await db.ExamPlans.AsNoTracking().OrderByDescending(x => x.UpdatedAt).ToListAsync();
            var links = await db.ExamPlanClasses.AsNoTracking().ToListAsync();
            var classNames = await db.Classes.AsNoTracking().Where(x => !x.Deleted).ToDictionaryAsync(x => x.Id, x => x.Name);
            List<ExamPlanListItem> items = [];
            foreach (ExamPlan plan in plans)
            {
                List<Guid> classIds = links.Where(x => x.ExamPlanId == plan.Id).Select(x => x.ClassId).Where(classNames.ContainsKey).ToList();
                if (session.Role != PancakeRole.Administrator && !classIds.Any(manageable.ContainsKey)) continue;
                ExamSchedulePayload? schedule = ParseSchedule(plan.PayloadJson);
                List<DateOnly> dates = schedule is null ? [] : schedule.Days.Select(x => x.Date).OrderBy(x => x).ToList();
                int segmentCount = schedule is null ? 0 : schedule.Days.Sum(x => x.Segments.Count);
                items.Add(new ExamPlanListItem(plan.Id, plan.Name, plan.Enabled, plan.Revision, dates, segmentCount,
                    classIds, classIds.Select(id => classNames[id]).ToList(), plan.CreatedAt, plan.UpdatedAt, plan.UpdatedBy));
            }
            return Results.Ok(items);
        });

        app.MapGet("/api/admin/exam-plans/{id:guid}", async (HttpRequest http, Guid id, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session)) return Results.Unauthorized();
            ExamPlan? plan = await db.ExamPlans.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id);
            if (plan is null) return Results.NotFound();
            List<Guid> classIds = await db.ExamPlanClasses.Where(x => x.ExamPlanId == id).Select(x => x.ClassId).ToListAsync();
            if (!await CanReach(db, session, classIds)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            ExamSchedulePayload? schedule = ParseSchedule(plan.PayloadJson);
            if (schedule is null) return Results.Problem("考试计划内容无法解析。");
            return Results.Ok(ToDetail(plan, schedule, classIds));
        });

        app.MapPost("/api/admin/exam-plans", async (HttpRequest http, ExamPlanWriteRequest request, PancakeDbContext db, SessionStore sessions, ClassSocketHub hub) =>
        {
            if (!Access.User(http, sessions, out var session)) return Results.Unauthorized();
            if (Validate(request.Name, request.Schedule) is { } error) return Results.BadRequest(error);
            if (await CheckTargets(db, session, request.ClassIds) is { } denied) return denied;
            ExamSchedulePayload schedule = Normalize(request.Schedule);
            if (request.Enabled && await FindConflict(db, null, request.ClassIds, schedule.Days) is { } conflict)
                return Results.Conflict(new { error = conflict });
            DateTime now = DateTime.UtcNow;
            string actor = Access.Actor(session);
            ExamPlan plan = new()
            {
                Name = request.Name.Trim(), PayloadJson = JsonSerializer.Serialize(schedule, Json), Enabled = request.Enabled,
                Revision = 1, CreatedAt = now, UpdatedAt = now, CreatedBy = actor, UpdatedBy = actor
            };
            db.ExamPlans.Add(plan);
            foreach (Guid classId in request.ClassIds.Distinct()) db.ExamPlanClasses.Add(new ExamPlanClass { ExamPlanId = plan.Id, ClassId = classId });
            Access.Audit(db, actor, "新建考试计划", $"{plan.Name} → {request.ClassIds.Distinct().Count()} 个班级");
            await db.SaveChangesAsync();
            await PublishExamAsync(hub, request.ClassIds, plan.Revision);
            return Results.Ok(ToDetail(plan, schedule, request.ClassIds));
        });

        app.MapPut("/api/admin/exam-plans/{id:guid}", async (HttpRequest http, Guid id, ExamPlanWriteRequest request, PancakeDbContext db, SessionStore sessions, ClassSocketHub hub) =>
        {
            if (!Access.User(http, sessions, out var session)) return Results.Unauthorized();
            ExamPlan? plan = await db.ExamPlans.SingleOrDefaultAsync(x => x.Id == id);
            if (plan is null) return Results.NotFound();
            List<Guid> oldClassIds = await db.ExamPlanClasses.Where(x => x.ExamPlanId == id).Select(x => x.ClassId).ToListAsync();
            if (!await CanReach(db, session, oldClassIds)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            if (request.ExpectedRevision > 0 && request.ExpectedRevision != plan.Revision)
                return Results.Conflict(new { error = "考试计划已被其他人修改，请刷新后重试。" });
            if (Validate(request.Name, request.Schedule) is { } error) return Results.BadRequest(error);
            if (await CheckTargets(db, session, request.ClassIds) is { } denied) return denied;
            ExamSchedulePayload schedule = Normalize(request.Schedule);
            if (request.Enabled && await FindConflict(db, plan.Id, request.ClassIds, schedule.Days) is { } conflict)
                return Results.Conflict(new { error = conflict });
            plan.Name = request.Name.Trim();
            plan.PayloadJson = JsonSerializer.Serialize(schedule, Json);
            plan.Enabled = request.Enabled;
            plan.Revision++;
            plan.UpdatedAt = DateTime.UtcNow;
            plan.UpdatedBy = Access.Actor(session);
            // 差量维护关联行：已经删除但尚未 SaveChanges 的实体不能再用相同主键重新 Add。
            List<ExamPlanClass> existingLinks = await db.ExamPlanClasses.Where(x => x.ExamPlanId == id).ToListAsync();
            HashSet<Guid> targetIds = request.ClassIds.Distinct().ToHashSet();
            db.ExamPlanClasses.RemoveRange(existingLinks.Where(x => !targetIds.Contains(x.ClassId)));
            foreach (Guid classId in targetIds.Where(classId => existingLinks.All(x => x.ClassId != classId)))
                db.ExamPlanClasses.Add(new ExamPlanClass { ExamPlanId = id, ClassId = classId });
            Access.Audit(db, Access.Actor(session), "修改考试计划", plan.Name);
            await db.SaveChangesAsync();
            await PublishExamAsync(hub, oldClassIds.Concat(request.ClassIds), plan.Revision);
            return Results.Ok(ToDetail(plan, schedule, request.ClassIds));
        });

        app.MapPatch("/api/admin/exam-plans/{id:guid}/enabled", async (HttpRequest http, Guid id, ExamEnabledRequest request, PancakeDbContext db, SessionStore sessions, ClassSocketHub hub) =>
        {
            if (!Access.User(http, sessions, out var session)) return Results.Unauthorized();
            ExamPlan? plan = await db.ExamPlans.SingleOrDefaultAsync(x => x.Id == id);
            if (plan is null) return Results.NotFound();
            List<Guid> classIds = await db.ExamPlanClasses.Where(x => x.ExamPlanId == id).Select(x => x.ClassId).ToListAsync();
            if (!await CanReach(db, session, classIds)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            if (request.ExpectedRevision > 0 && request.ExpectedRevision != plan.Revision)
                return Results.Conflict(new { error = "考试计划已被其他人修改，请刷新后重试。" });
            ExamSchedulePayload? schedule = ParseSchedule(plan.PayloadJson);
            if (schedule is null) return Results.BadRequest("考试计划内容无法解析。");
            if (request.Enabled && await FindConflict(db, plan.Id, classIds, schedule.Days) is { } conflict)
                return Results.Conflict(new { error = conflict });
            plan.Enabled = request.Enabled;
            plan.Revision++;
            plan.UpdatedAt = DateTime.UtcNow;
            plan.UpdatedBy = Access.Actor(session);
            Access.Audit(db, Access.Actor(session), request.Enabled ? "启用考试计划" : "停用考试计划", plan.Name);
            await db.SaveChangesAsync();
            await PublishExamAsync(hub, classIds, plan.Revision);
            return Results.Ok(new { plan.Id, plan.Enabled, plan.Revision });
        });

        app.MapDelete("/api/admin/exam-plans/{id:guid}", async (HttpRequest http, Guid id, PancakeDbContext db, SessionStore sessions, ClassSocketHub hub) =>
        {
            if (!Access.User(http, sessions, out var session)) return Results.Unauthorized();
            ExamPlan? plan = await db.ExamPlans.SingleOrDefaultAsync(x => x.Id == id);
            if (plan is null) return Results.NotFound();
            List<Guid> classIds = await db.ExamPlanClasses.Where(x => x.ExamPlanId == id).Select(x => x.ClassId).ToListAsync();
            if (!await CanReach(db, session, classIds)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            db.ExamPlanClasses.RemoveRange(await db.ExamPlanClasses.Where(x => x.ExamPlanId == id).ToListAsync());
            db.ExamPlans.Remove(plan);
            Access.Audit(db, Access.Actor(session), "删除考试计划", plan.Name);
            await db.SaveChangesAsync();
            await PublishExamAsync(hub, classIds, 0);
            return Results.NoContent();
        });

        // ---------------------------------------------------------------- 考场名（按班级）
        app.MapGet("/api/admin/exam-rooms", async (HttpRequest http, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session)) return Results.Unauthorized();
            return Results.Ok(await ClassExamRooms(db, session));
        });

        app.MapPut("/api/admin/exam-rooms", async (HttpRequest http, ExamRoomWriteRequest request, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session)) return Results.Unauthorized();
            List<ExamRoomItem> items = (request.Items ?? []).ToList();
            if (items.Count == 0) return Results.BadRequest("没有需要保存的考场名。");
            if (items.Count > 500) return Results.BadRequest("一次最多设置 500 个班级。");
            Dictionary<Guid, string> manageable = await BoardEndpoints.ManageableClasses(db, session);
            List<Guid> ids = items.Select(x => x.ClassId).Distinct().ToList();
            if (ids.Any(id => !manageable.ContainsKey(id))) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var classes = await db.Classes.Where(x => ids.Contains(x.Id) && !x.Deleted).ToDictionaryAsync(x => x.Id);
            if (classes.Count != ids.Count) return Results.BadRequest("部分班级不存在或已删除。");
            foreach (ExamRoomItem item in items)
            {
                string room = (item.Room ?? "").Trim();
                if (room.Length > 40) return Results.BadRequest("考场名不能超过 40 个字符。");
                classes[item.ClassId].ExamRoom = room;
            }
            Access.Audit(db, Access.Actor(session), "设置考场名", $"{items.Count} 个班级");
            await db.SaveChangesAsync();
            return Results.Ok(await ClassExamRooms(db, session));
        });

        // ---------------------------------------------------------------- 大屏拉取
        app.MapGet("/api/classes/{classId:guid}/exam", async (HttpRequest http, Guid classId, PancakeDbContext db, SessionStore sessions) =>
        {
            if (await Access.Caller(http, classId, db, sessions) is null) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var classroom = await db.Classes.AsNoTracking().SingleOrDefaultAsync(x => x.Id == classId && !x.Deleted);
            if (classroom is null) return Results.NotFound();
            List<Guid> planIds = await db.ExamPlanClasses.AsNoTracking().Where(x => x.ClassId == classId).Select(x => x.ExamPlanId).ToListAsync();
            if (planIds.Count == 0) return Results.NoContent();
            var plans = await db.ExamPlans.AsNoTracking().Where(x => x.Enabled && planIds.Contains(x.Id)).ToListAsync();
            List<(ExamPlan Plan, ExamSchedulePayload Schedule)> candidates = [];
            foreach (ExamPlan plan in plans)
            {
                ExamSchedulePayload? schedule = ParseSchedule(plan.PayloadJson);
                if (schedule is { Days.Count: > 0 }) candidates.Add((plan, schedule));
            }
            DateOnly today = DateOnly.FromDateTime(DateTime.Now);
            // 同一班级同一天的启用计划由保存校验保证只有一个；这里按“今天有安排 → 最近未来日期”挑一份，
            // 跨天或计划切换时大屏会在下一次同步（≤3 分钟）自动换到新的计划。
            (ExamPlan Plan, ExamSchedulePayload Schedule) chosen = candidates.FirstOrDefault(x => x.Schedule.Days.Any(d => d.Date == today));
            if (chosen.Plan is null)
            {
                chosen = candidates.Where(x => x.Schedule.Days.Any(d => d.Date > today))
                    .OrderBy(x => x.Schedule.Days.Where(d => d.Date >= today).Min(d => d.Date)).FirstOrDefault();
            }
            if (chosen.Plan is null) return Results.NoContent();
            return Results.Ok(new ExamScheduleDto(chosen.Plan.Id, chosen.Plan.Name, chosen.Schedule.Days,
                chosen.Schedule.EnterMinutesBefore, DateTime.UtcNow, chosen.Schedule.ShowSeconds, classroom.ExamRoom));
        });
    }

    /// <summary>当前用户可管理班级的考场名，按分组顺序与班级名称排列。</summary>
    private static async Task<List<ClassExamRoomItem>> ClassExamRooms(PancakeDbContext db, UserSession session)
    {
        Dictionary<Guid, string> manageable = await BoardEndpoints.ManageableClasses(db, session);
        List<Guid> ids = manageable.Keys.ToList();
        var classes = await db.Classes.AsNoTracking()
            .Where(x => ids.Contains(x.Id) && !x.Deleted)
            .Select(x => new { x.Id, x.Name, x.GroupId, x.ExamRoom })
            .ToListAsync();
        var groups = await db.ClassGroups.AsNoTracking().ToDictionaryAsync(x => x.Id, x => x);
        return classes
            .OrderBy(x => x.GroupId is { } gid && groups.TryGetValue(gid, out var group) ? group.SortOrder : int.MaxValue)
            .ThenBy(x => x.Name, StringComparer.CurrentCulture)
            .Select(x => new ClassExamRoomItem(x.Id, x.Name, x.GroupId,
                x.GroupId is { } gid && groups.TryGetValue(gid, out var group) ? group.Name : null, x.ExamRoom))
            .ToList();
    }

    /// <summary>网页端可查看/修改该计划：管理员不受限，老师需要能管理至少一个目标班级。</summary>
    private static async Task<bool> CanReach(PancakeDbContext db, UserSession session, List<Guid> classIds)
    {
        if (session.Role == PancakeRole.Administrator) return true;
        if (classIds.Count == 0) return false;
        return await db.Memberships.AnyAsync(x => x.UserId == session.UserId && classIds.Contains(x.ClassId));
    }

    /// <summary>目标班级必须存在、未删除，并且当前用户全部可管理。</summary>
    private static async Task<IResult?> CheckTargets(PancakeDbContext db, UserSession session, List<Guid>? classIds)
    {
        List<Guid> ids = (classIds ?? []).Distinct().ToList();
        if (ids.Count == 0) return Results.BadRequest("请选择考试班级。");
        if (ids.Count > 500) return Results.BadRequest("一次最多设置 500 个班级。");
        int existing = await db.Classes.CountAsync(x => ids.Contains(x.Id) && !x.Deleted);
        if (existing != ids.Count) return Results.BadRequest("部分班级不存在或已删除。");
        Dictionary<Guid, string> manageable = await BoardEndpoints.ManageableClasses(db, session);
        if (ids.Any(id => !manageable.ContainsKey(id))) return Results.StatusCode(StatusCodes.Status403Forbidden);
        return null;
    }

    private static string? Validate(string? name, ExamSchedulePayload? schedule)
    {
        string title = (name ?? "").Trim();
        if (title.Length is 0 or > 60) return "计划名称需为 1–60 个字符。";
        if (schedule?.Days is null || schedule.Days.Count is 0 or > 60) return "考试时间表需要 1–60 天。";
        if (schedule.EnterMinutesBefore is < 0 or > 120) return "提前进入分钟数需在 0–120 之间。";
        if (schedule.Days.Select(x => x.Date).Distinct().Count() != schedule.Days.Count) return "考试日期不能重复。";
        foreach (ExamDayDto day in schedule.Days)
        {
            if (day.Segments is null || day.Segments.Count is 0 or > 50) return $"{day.Date:yyyy-MM-dd} 需要 1–50 个时间段。";
            foreach (ExamSegmentDto? segment in day.Segments)
            {
                if (segment is null) return "时间段不能为空。";
                if (segment.Kind is not (ExamSegmentKinds.Exam or ExamSegmentKinds.Break)) return "时间段类型无效。";
                if (segment.StartMinute is < 0 or > 1439 || segment.EndMinute is < 1 or > 1440 || segment.EndMinute <= segment.StartMinute)
                    return "时间段起止时间无效。";
                if (segment.Kind == ExamSegmentKinds.Exam && (string.IsNullOrWhiteSpace(segment.Subject) || segment.Subject.Trim().Length > 30))
                    return "考试科目需为 1–30 个字符。";
                if ((segment.Label ?? "").Trim().Length > 30) return "休息文案不能超过 30 个字符。";
            }
            if (!day.Segments.Any(x => x is not null && x.Kind == ExamSegmentKinds.Exam))
                return $"{day.Date:yyyy-MM-dd} 至少需要一场考试。";
            List<ExamSegmentDto> ordered = day.Segments.OrderBy(x => x.StartMinute).ToList();
            for (int index = 1; index < ordered.Count; index++)
                if (ordered[index].StartMinute < ordered[index - 1].EndMinute)
                    return $"{day.Date:yyyy-MM-dd} 的时间段有重叠。";
        }
        return null;
    }

    /// <summary>统一裁剪、排序并补齐休息文案；调用前必须已通过 Validate。</summary>
    private static ExamSchedulePayload Normalize(ExamSchedulePayload schedule) => new(
        schedule.Days.OrderBy(x => x.Date).Select(day => new ExamDayDto(day.Date,
            day.Segments.OrderBy(x => x.StartMinute).Select(segment => new ExamSegmentDto(
                segment.Kind,
                segment.Kind == ExamSegmentKinds.Exam ? segment.Subject.Trim() : "",
                segment.StartMinute, segment.EndMinute,
                segment.Kind == ExamSegmentKinds.Break
                    ? (string.IsNullOrWhiteSpace(segment.Label) ? "休息时间" : segment.Label.Trim())
                    : null)).ToList())).ToList(),
        schedule.EnterMinutesBefore, schedule.ShowSeconds);

    /// <summary>启用的计划之间，同一班级同一天不能重叠；返回给用户看的冲突说明。</summary>
    private static async Task<string?> FindConflict(PancakeDbContext db, Guid? selfId, List<Guid> classIds, List<ExamDayDto> days)
    {
        HashSet<DateOnly> dates = days.Select(x => x.Date).ToHashSet();
        var others = await db.ExamPlans.AsNoTracking().Where(x => x.Enabled && (selfId == null || x.Id != selfId)).ToListAsync();
        if (others.Count == 0) return null;
        List<Guid> otherIds = others.Select(x => x.Id).ToList();
        var links = await db.ExamPlanClasses.AsNoTracking()
            .Where(x => otherIds.Contains(x.ExamPlanId) && classIds.Contains(x.ClassId)).ToListAsync();
        if (links.Count == 0) return null;
        var names = await db.Classes.AsNoTracking().Where(x => classIds.Contains(x.Id)).ToDictionaryAsync(x => x.Id, x => x.Name);
        foreach (ExamPlan other in others)
        {
            ExamSchedulePayload? schedule = ParseSchedule(other.PayloadJson);
            if (schedule is null) continue;
            List<DateOnly> shared = schedule.Days.Where(x => dates.Contains(x.Date)).Select(x => x.Date).Distinct().OrderBy(x => x).ToList();
            if (shared.Count == 0) continue;
            Guid conflictClass = links.Where(x => x.ExamPlanId == other.Id).Select(x => x.ClassId).FirstOrDefault();
            string className = names.GetValueOrDefault(conflictClass, "所选班级");
            return $"“{className}”在 {string.Join("、", shared.Select(x => x.ToString("yyyy-MM-dd")))} 已有启用的考试计划“{other.Name}”。";
        }
        return null;
    }

    private static ExamSchedulePayload? ParseSchedule(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try { return JsonSerializer.Deserialize<ExamSchedulePayload>(json, Json); }
        catch (JsonException) { return null; }
    }

    private static ExamPlanDetail ToDetail(ExamPlan plan, ExamSchedulePayload schedule, IEnumerable<Guid> classIds) =>
        new(plan.Id, plan.Name, plan.Enabled, plan.Revision, schedule, classIds.Distinct().ToList(), plan.CreatedAt, plan.UpdatedAt, plan.UpdatedBy);

    private static Task PublishExamAsync(ClassSocketHub hub, IEnumerable<Guid> classIds, long revision) =>
        Task.WhenAll(classIds.Distinct().Select(classId =>
            hub.PublishAsync(new SyncEvent(classId, Guid.Empty, revision, SyncEventTypes.Exam), CancellationToken.None)));
}
