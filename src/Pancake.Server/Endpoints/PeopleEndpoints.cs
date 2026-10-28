using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Pancake.Server.Contracts;
using Pancake.Server.Data;
using Pancake.Server.Services;
using Pancake.Shared;

namespace Pancake.Server.Endpoints;

/// <summary>人员分配：老师的班级职务与负责科目、学生名单和值日安排。</summary>
public static class PeopleEndpoints
{
    public static void MapPeopleEndpoints(this WebApplication app)
    {
        // ---------------------------------------------------------------- 老师职务与科目
        app.MapGet("/api/classes/{classId:guid}/staff", async (HttpRequest http, Guid classId, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            return Results.Ok(await StaffOf(db, classId));
        });

        app.MapPut("/api/classes/{classId:guid}/staff/{userId:guid}", async (HttpRequest http, Guid classId, Guid userId, StaffUpdateRequest request, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageStaff(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            if (!StaffDuties.IsValid(request.Duty)) return Results.BadRequest("职务无效。");
            var membership = await db.Memberships.FindAsync(userId, classId);
            if (membership is null) return Results.NotFound("该老师不在本班。");
            List<string> subjects = (request.Subjects ?? []).Select(x => (x ?? "").Trim()).Where(x => x.Length is > 0 and <= 40).Distinct(StringComparer.OrdinalIgnoreCase).Take(30).ToList();
            // 每班只有一位班主任：任命新班主任时原班主任改为科任老师。
            if (request.Duty == StaffDuties.HeadTeacher)
                foreach (var other in await db.Memberships.Where(x => x.ClassId == classId && x.UserId != userId && x.Duty == StaffDuties.HeadTeacher).ToListAsync())
                    other.Duty = StaffDuties.SubjectTeacher;
            membership.Duty = request.Duty;
            membership.SubjectsJson = JsonSerializer.Serialize(subjects);
            var user = await db.Users.FindAsync(userId);
            Access.Audit(db, Access.Actor(session), "分配职务", $"{user?.DisplayName}：{DutyLabel(request.Duty)}{(subjects.Count > 0 ? " · " + string.Join("、", subjects) : "")}", classId);
            await db.SaveChangesAsync();
            return Results.Ok(await StaffOf(db, classId));
        });

        // 本班出现过的科目名称，供分配科目时选择。
        app.MapGet("/api/classes/{classId:guid}/subjects", async (HttpRequest http, Guid classId, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var payloads = await db.Projects.Where(x => x.ClassId == classId && !x.Deleted).OrderByDescending(x => x.UpdatedAt).Take(20).Select(x => x.PayloadJson).ToListAsync();
            HashSet<string> names = new(StringComparer.OrdinalIgnoreCase);
            foreach (string payload in payloads)
                if (PayloadEditor.TryParse(payload)?["Subjects"] is System.Text.Json.Nodes.JsonArray subjects)
                    foreach (var subject in subjects)
                        if (subject?["Name"]?.GetValue<string>()?.Trim() is { Length: > 0 } name) names.Add(name);
            foreach (var m in await db.Memberships.Where(x => x.ClassId == classId).Select(x => x.SubjectsJson).ToListAsync())
                foreach (string s in Access.ParseSubjects(m)) names.Add(s);
            return Results.Ok(names.Order(StringComparer.Ordinal).ToList());
        });

        // 当前登录老师在各班的职务和科目，概览页“我的分工”使用。
        app.MapGet("/api/me/assignments", async (HttpRequest http, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session)) return Results.Unauthorized();
            var rows = await (from m in db.Memberships
                              join c in db.Classes on m.ClassId equals c.Id
                              where m.UserId == session.UserId && !c.Deleted
                              orderby c.Name
                              select new { classId = c.Id, className = c.Name, m.Duty, m.SubjectsJson }).ToListAsync();
            return Results.Ok(rows.Select(x => new { x.classId, x.className, duty = x.Duty, subjects = Access.ParseSubjects(x.SubjectsJson) }));
        });

        // ---------------------------------------------------------------- 学生名单
        app.MapGet("/api/classes/{classId:guid}/students", async (HttpRequest http, Guid classId, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            return Results.Ok(await StudentsOf(db, classId));
        });

        app.MapPost("/api/classes/{classId:guid}/students", async (HttpRequest http, Guid classId, StudentWriteRequest request, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session) || !await CanManageRoster(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            if (Validate(request) is { } error) return Results.BadRequest(error);
            if (await db.Students.CountAsync(x => x.ClassId == classId) >= 300) return Results.BadRequest("每班最多 300 名学生。");
            int order = await db.Students.Where(x => x.ClassId == classId).Select(x => (int?)x.SortOrder).MaxAsync() ?? 0;
            var student = new Student { ClassId = classId, SortOrder = order + 1 };
            Apply(student, request);
            db.Students.Add(student);
            Access.Audit(db, Access.Actor(session), "添加学生", student.Name, classId);
            await db.SaveChangesAsync();
            return Results.Ok(ToItem(student));
        });

        app.MapPatch("/api/classes/{classId:guid}/students/{studentId:guid}", async (HttpRequest http, Guid classId, Guid studentId, StudentWriteRequest request, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session) || !await CanManageRoster(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            if (Validate(request) is { } error) return Results.BadRequest(error);
            var student = await db.Students.SingleOrDefaultAsync(x => x.Id == studentId && x.ClassId == classId);
            if (student is null) return Results.NotFound();
            Apply(student, request);
            await db.SaveChangesAsync();
            return Results.Ok(ToItem(student));
        });

        app.MapDelete("/api/classes/{classId:guid}/students/{studentId:guid}", async (HttpRequest http, Guid classId, Guid studentId, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session) || !await CanManageRoster(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var student = await db.Students.SingleOrDefaultAsync(x => x.Id == studentId && x.ClassId == classId);
            if (student is null) return Results.NotFound();
            db.Students.Remove(student);
            Access.Audit(db, Access.Actor(session), "移除学生", student.Name, classId);
            await db.SaveChangesAsync();
            return Results.NoContent();
        });

        app.MapPost("/api/classes/{classId:guid}/students/import", async (HttpRequest http, Guid classId, StudentImportRequest request, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session) || !await CanManageRoster(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var parsed = ParseRoster(request.Text ?? "");
            if (parsed.Count == 0) return Results.BadRequest("没有识别到学生，请每行填写一名学生。");
            if (parsed.Count > 300) return Results.BadRequest("一次最多导入 300 名学生。");
            var existing = await db.Students.Where(x => x.ClassId == classId).ToListAsync();
            if (request.ReplaceAll) { db.Students.RemoveRange(existing); existing = []; }
            int order = existing.Select(x => x.SortOrder).DefaultIfEmpty(0).Max();
            int added = 0, updated = 0;
            foreach (var (number, name, group) in parsed)
            {
                // 同名或同学号的学生更新小组信息，不重复添加。
                var match = existing.FirstOrDefault(x => (number.Length > 0 && x.Number == number) || x.Name == name);
                if (match is not null) { match.Name = name; if (number.Length > 0) match.Number = number; if (group.Length > 0) match.Group = group; updated++; continue; }
                var student = new Student { ClassId = classId, Name = name, Number = number, Group = group, SortOrder = ++order };
                db.Students.Add(student); existing.Add(student); added++;
            }
            if (existing.Count > 300) return Results.BadRequest("每班最多 300 名学生。");
            Access.Audit(db, Access.Actor(session), "导入学生", $"新增 {added} 人，更新 {updated} 人{(request.ReplaceAll ? "（替换原名单）" : "")}", classId);
            await db.SaveChangesAsync();
            return Results.Ok(new { added, updated, students = await StudentsOf(db, classId) });
        });

        app.MapPut("/api/classes/{classId:guid}/students/order", async (HttpRequest http, Guid classId, StudentOrderRequest request, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session) || !await CanManageRoster(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var students = await db.Students.Where(x => x.ClassId == classId).ToListAsync();
            var order = (request.Ids ?? []).Select((id, index) => (id, index)).ToDictionary(x => x.id, x => x.index);
            foreach (var s in students) s.SortOrder = order.TryGetValue(s.Id, out int i) ? i : order.Count + s.SortOrder;
            await db.SaveChangesAsync();
            return Results.NoContent();
        });

        // ---------------------------------------------------------------- 值日安排
        app.MapGet("/api/classes/{classId:guid}/duty", async (HttpRequest http, Guid classId, DateOnly? date, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var row = await db.DutyPlans.FindAsync(classId);
            var plan = DutyPlanner.Parse(row?.PlanJson);
            var names = await StudentNames(db, classId);
            DateOnly day = date ?? Today();
            DateOnly monday = day.AddDays(1 - DutyPlanner.IsoWeekday(day));
            var week = Enumerable.Range(0, 7).Select(i => DutyPlanner.Resolve(plan, monday.AddDays(i), names)).ToList();
            return Results.Ok(new DutyPlanResponse(plan, row?.Revision ?? 0, row?.UpdatedAt, row?.UpdatedBy ?? "", week));
        });

        app.MapPut("/api/classes/{classId:guid}/duty", async (HttpRequest http, Guid classId, DutyPlanWriteRequest request, PancakeDbContext db, SessionStore sessions, ClassSocketHub hub) =>
        {
            if (!Access.User(http, sessions, out var session) || !await CanManageRoster(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var row = await db.DutyPlans.FindAsync(classId);
            if ((row?.Revision ?? 0) != request.ExpectedRevision) return Results.Conflict(new { error = "值日安排已被其他老师修改，请刷新后重试。" });
            var ids = (await db.Students.Where(x => x.ClassId == classId && x.Active).Select(x => x.Id).ToListAsync()).ToHashSet();
            DutyPlanModel plan;
            try { plan = DutyPlanner.Normalize(request.Plan ?? new(), ids); }
            catch (InvalidDataException ex) { return Results.BadRequest(ex.Message); }
            if (row is null) { row = new DutyPlan { ClassId = classId }; db.DutyPlans.Add(row); }
            row.PlanJson = JsonSerializer.Serialize(plan, DutyPlanner.Json);
            row.Revision++; row.UpdatedAt = DateTime.UtcNow; row.UpdatedBy = Access.Actor(session);
            Access.Audit(db, Access.Actor(session), "更新值日安排", plan.Mode == "rotate" ? $"小组轮换 · {plan.Groups.Count} 组" : $"按星期固定 · {plan.Tasks.Count} 个岗位", classId);
            await db.SaveChangesAsync();
            await BoardEndpoints.PublishBoardAsync(hub, classId);
            return Results.Ok(new { row.Revision });
        });
    }

    public static async Task<DutyToday?> DutyFor(PancakeDbContext db, Guid classId, DateOnly date)
    {
        var row = await db.DutyPlans.AsNoTracking().SingleOrDefaultAsync(x => x.ClassId == classId);
        if (row is null) return null;
        return DutyPlanner.Resolve(DutyPlanner.Parse(row.PlanJson), date, await StudentNames(db, classId));
    }

    /// <summary>服务器本地日期：值日按学校所在地的日历计算。</summary>
    public static DateOnly Today() => DateOnly.FromDateTime(DateTime.Now);

    /// <summary>管理员、班主任可以维护名单和值日；还没有班主任的班级允许本班老师维护。</summary>
    private static async Task<bool> CanManageRoster(UserSession session, Guid classId, PancakeDbContext db)
    {
        if (await Access.CanManageStaff(session, classId, db)) return true;
        return await Access.CanManageClass(session, classId, db) && !await db.Memberships.AnyAsync(x => x.ClassId == classId && x.Duty == StaffDuties.HeadTeacher);
    }

    public static string DutyLabel(string duty) => duty switch
    {
        StaffDuties.HeadTeacher => "班主任",
        StaffDuties.Assistant => "助教",
        _ => "科任老师"
    };

    private static async Task<List<StaffItem>> StaffOf(PancakeDbContext db, Guid classId)
    {
        var rows = await (from m in db.Memberships
                          join u in db.Users on m.UserId equals u.Id
                          where m.ClassId == classId
                          select new { u.Id, u.UserName, u.DisplayName, u.Approved, m.Duty, m.SubjectsJson }).ToListAsync();
        int Rank(string duty) => duty == StaffDuties.HeadTeacher ? 0 : duty == StaffDuties.SubjectTeacher ? 1 : 2;
        return rows.OrderBy(x => Rank(x.Duty)).ThenBy(x => x.DisplayName)
            .Select(x => new StaffItem(x.Id, x.UserName, x.DisplayName, x.Approved, x.Duty, Access.ParseSubjects(x.SubjectsJson))).ToList();
    }

    private static async Task<List<StudentItem>> StudentsOf(PancakeDbContext db, Guid classId) =>
        (await db.Students.Where(x => x.ClassId == classId).ToListAsync())
            .OrderBy(x => x.SortOrder).ThenBy(x => x.Number).ThenBy(x => x.Name).Select(ToItem).ToList();

    private static async Task<Dictionary<Guid, string>> StudentNames(PancakeDbContext db, Guid classId) =>
        await db.Students.Where(x => x.ClassId == classId && x.Active).ToDictionaryAsync(x => x.Id, x => x.Name);

    private static StudentItem ToItem(Student s) => new(s.Id, s.Name, s.Number, s.Group, s.Note, s.Active, s.SortOrder);

    private static string? Validate(StudentWriteRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Name) || request.Name.Trim().Length > 30) return "姓名需为 1–30 个字符。";
        if ((request.Number ?? "").Trim().Length > 20 || (request.Group ?? "").Trim().Length > 20 || (request.Note ?? "").Trim().Length > 100) return "学号、小组或备注过长。";
        return null;
    }

    private static void Apply(Student student, StudentWriteRequest request)
    {
        student.Name = request.Name.Trim();
        if (request.Number is not null) student.Number = request.Number.Trim();
        if (request.Group is not null) student.Group = request.Group.Trim();
        if (request.Note is not null) student.Note = request.Note.Trim();
        if (request.Active is { } active) student.Active = active;
    }

    /// <summary>每行一名学生：“姓名”“学号 姓名”或“学号 姓名 小组”；首列不含数字时视为姓名。</summary>
    public static List<(string Number, string Name, string Group)> ParseRoster(string text)
    {
        List<(string, string, string)> result = [];
        foreach (string rawLine in text.Split('\n'))
        {
            string line = rawLine.Trim().Trim('﻿');
            if (line.Length == 0 || line.StartsWith('#')) continue;
            string[] parts = line.Split([',', '，', '\t', ' ', '　', ';', '；'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (parts.Length == 0) continue;
            if (parts[0] is "学号" or "姓名" or "序号") continue;
            string number = "", name, group = "";
            if (parts.Length >= 2 && parts[0].Any(char.IsAsciiDigit)) { number = parts[0]; name = parts[1]; if (parts.Length >= 3) group = parts[2]; }
            else { name = parts[0]; if (parts.Length >= 2) group = parts[1]; }
            if (name.Length is < 1 or > 30 || number.Length > 20 || group.Length > 20) continue;
            result.Add((number, name, group));
        }
        return result;
    }
}
