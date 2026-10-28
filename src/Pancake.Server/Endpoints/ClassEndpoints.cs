using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Pancake.Server.Contracts;
using Pancake.Server.Data;
using Pancake.Server.Services;
using Pancake.Shared;

namespace Pancake.Server.Endpoints;

public static class ClassEndpoints
{
    public static void MapClassEndpoints(this WebApplication app)
    {
        app.MapGet("/api/classes", async (HttpRequest http, PancakeDbContext db, SessionStore sessions, ClassSocketHub hub) =>
        {
            if (!Access.User(http, sessions, out var session)) return Results.Unauthorized();
            return Results.Ok(await ClassDetails(db, hub, session));
        });

        app.MapGet("/api/classes/{classId:guid}", async (HttpRequest http, Guid classId, PancakeDbContext db, SessionStore sessions, ClassSocketHub hub) =>
        {
            if (!Access.User(http, sessions, out var session)) return Results.Unauthorized();
            if (!await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var item = (await ClassDetails(db, hub, session, classId)).SingleOrDefault();
            return item is null ? Results.NotFound() : Results.Ok(item);
        });

        // 旧版管理员接口保持不变，桌面端和脚本可能在用。
        app.MapGet("/api/admin/classes", async (HttpRequest http, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.Admin(http, sessions, out _)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            return Results.Ok(await db.Classes.Where(x => !x.Deleted).OrderBy(x => x.Name).Select(x => new ClassSummary(x.Id, x.Name, x.PublicCode, x.CreatedAt)).ToListAsync());
        });

        app.MapPost("/api/admin/classes", async (HttpRequest http, CreateClassRequest request, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.Admin(http, sessions, out var session)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            if (string.IsNullOrWhiteSpace(request.Name)) return Results.BadRequest("班级名称不能为空。");
            if (request.Name.Trim().Length > 60) return Results.BadRequest("班级名称不能超过 60 个字符。");
            var classroom = new Classroom { Name = request.Name.Trim(), PublicCode = await UniquePublicCode(db) };
            db.Classes.Add(classroom);
            Access.Audit(db, Access.Actor(session), "创建班级", classroom.Name, classroom.Id);
            await db.SaveChangesAsync();
            return Results.Created($"/api/classes/{classroom.Id}", new
            {
                classroom.Id,
                classroom.Name,
                classroom.PublicCode,
                classroom.CreatedAt,
                PairingCode = sessions.CreatePairingCode(classroom.Id),
                ExpiresInSeconds = (int)SessionStore.PairingCodeLifetime.TotalSeconds
            });
        });

        app.MapPatch("/api/admin/classes/{classId:guid}", async (HttpRequest http, Guid classId, RenameRequest request, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.Admin(http, sessions, out var session)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            if (string.IsNullOrWhiteSpace(request.Name) || request.Name.Trim().Length > 60) return Results.BadRequest("班级名称需为 1–60 个字符。");
            var classroom = await db.Classes.SingleOrDefaultAsync(x => x.Id == classId && !x.Deleted);
            if (classroom is null) return Results.NotFound();
            Access.Audit(db, Access.Actor(session), "重命名班级", $"{classroom.Name} → {request.Name.Trim()}", classId);
            classroom.Name = request.Name.Trim(); await db.SaveChangesAsync();
            return Results.NoContent();
        });

        app.MapDelete("/api/admin/classes/{classId:guid}", async (HttpRequest http, Guid classId, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.Admin(http, sessions, out var session)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var classroom = await db.Classes.FindAsync(classId);
            if (classroom is null) return Results.NotFound();
            classroom.Deleted = true;
            Access.Audit(db, Access.Actor(session), "删除班级", classroom.Name, classId);
            await db.SaveChangesAsync(); return Results.NoContent();
        });

        app.MapPost("/api/admin/classes/{classId:guid}/public-code", async (HttpRequest http, Guid classId, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.Admin(http, sessions, out var session)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var classroom = await db.Classes.SingleOrDefaultAsync(x => x.Id == classId && !x.Deleted);
            if (classroom is null) return Results.NotFound();
            classroom.PublicCode = await UniquePublicCode(db);
            Access.Audit(db, Access.Actor(session), "重置公开短码", classroom.Name, classId);
            await db.SaveChangesAsync();
            return Results.Ok(new { classroom.PublicCode });
        });

        // 管理员和该班老师都可以生成配对码；旧路径保留兼容。
        Delegate pairing = async (HttpRequest http, Guid classId, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            if (!await db.Classes.AnyAsync(x => x.Id == classId && !x.Deleted)) return Results.NotFound();
            Access.Audit(db, Access.Actor(session), "生成配对码", "", classId); await db.SaveChangesAsync();
            return Results.Ok(new { code = sessions.CreatePairingCode(classId), expiresInSeconds = (int)SessionStore.PairingCodeLifetime.TotalSeconds });
        };
        app.MapPost("/api/admin/classes/{classId:guid}/pairing-code", pairing);
        app.MapPost("/api/classes/{classId:guid}/pairing-code", pairing);

        app.MapPost("/api/devices/pair", async (DevicePairRequest request, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!sessions.ConsumePairingCode(request.PairingCode ?? "", out Guid classId)) return Results.BadRequest("配对码无效或已过期。");
            var classroom = await db.Classes.SingleOrDefaultAsync(x => x.Id == classId && !x.Deleted);
            if (classroom is null) return Results.NotFound("班级不存在或已删除。");
            string name = string.IsNullOrWhiteSpace(request.DeviceName) ? "未命名设备" : request.DeviceName.Trim()[..Math.Min(60, request.DeviceName.Trim().Length)];
            var device = new DeviceRegistration { ClassId = classId, DeviceName = name, DeviceToken = SecurityService.NewToken(), LastSeenAt = DateTime.UtcNow };
            db.Devices.Add(device);
            Access.Audit(db, Access.Actor(device), "设备配对", name, classId);
            await db.SaveChangesAsync();
            return Results.Ok(new DevicePairResponse(device.DeviceToken, classId, DateTime.UtcNow.AddYears(1), classroom.Name, device.Id));
        });

        app.MapGet("/api/classes/{classId:guid}/teachers", async (HttpRequest http, Guid classId, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var teachers = await (from m in db.Memberships
                                  join u in db.Users on m.UserId equals u.Id
                                  where m.ClassId == classId
                                  orderby u.DisplayName
                                  select new { u.Id, u.UserName, u.DisplayName, enabled = u.Approved }).ToListAsync();
            return Results.Ok(teachers);
        });

        app.MapPost("/api/admin/classes/{classId:guid}/teachers/{userId:guid}", async (HttpRequest http, Guid classId, Guid userId, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.Admin(http, sessions, out var session)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            if (!await db.Classes.AnyAsync(x => x.Id == classId && !x.Deleted) || !await db.Users.AnyAsync(x => x.Id == userId && x.Role == nameof(PancakeRole.Teacher))) return Results.NotFound();
            if (!await db.Memberships.AnyAsync(x => x.ClassId == classId && x.UserId == userId))
            {
                db.Memberships.Add(new ClassMembership { ClassId = classId, UserId = userId });
                Access.Audit(db, Access.Actor(session), "分配老师", userId.ToString(), classId);
                await db.SaveChangesAsync();
            }
            return Results.NoContent();
        });

        app.MapDelete("/api/admin/classes/{classId:guid}/teachers/{userId:guid}", async (HttpRequest http, Guid classId, Guid userId, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.Admin(http, sessions, out var session)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var membership = await db.Memberships.FindAsync(userId, classId);
            if (membership is null) return Results.NotFound();
            db.Memberships.Remove(membership);
            Access.Audit(db, Access.Actor(session), "移除老师", userId.ToString(), classId);
            await db.SaveChangesAsync(); return Results.NoContent();
        });

        app.MapGet("/api/classes/{classId:guid}/devices", async (HttpRequest http, Guid classId, PancakeDbContext db, SessionStore sessions, ClassSocketHub hub) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var devices = await db.Devices.Where(x => x.ClassId == classId).OrderBy(x => x.Revoked).ThenByDescending(x => x.LastSeenAt).ThenBy(x => x.DeviceName).ToListAsync();
            return Results.Ok(devices.Select(x => new DeviceItem(x.Id, x.DeviceName, x.CreatedAt, x.LastSeenAt, x.Revoked,
                x.AppVersion, x.LastSyncAt, x.PendingChanges, x.LastError, x.ActiveProject, !x.Revoked && hub.IsDeviceOnline(classId, x.Id))));
        });

        app.MapPatch("/api/classes/{classId:guid}/devices/{deviceId:guid}", async (HttpRequest http, Guid classId, Guid deviceId, RenameRequest request, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            if (string.IsNullOrWhiteSpace(request.Name) || request.Name.Trim().Length > 60) return Results.BadRequest("设备名称需为 1–60 个字符。");
            var device = await db.Devices.SingleOrDefaultAsync(x => x.Id == deviceId && x.ClassId == classId);
            if (device is null) return Results.NotFound();
            Access.Audit(db, Access.Actor(session), "重命名设备", $"{device.DeviceName} → {request.Name.Trim()}", classId);
            device.DeviceName = request.Name.Trim(); await db.SaveChangesAsync();
            return Results.NoContent();
        });

        app.MapDelete("/api/classes/{classId:guid}/devices/{deviceId:guid}", async (HttpRequest http, Guid classId, Guid deviceId, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var device = await db.Devices.SingleOrDefaultAsync(x => x.Id == deviceId && x.ClassId == classId);
            if (device is null) return Results.NotFound();
            device.Revoked = true;
            Access.Audit(db, Access.Actor(session), "吊销设备", device.DeviceName, classId);
            await db.SaveChangesAsync(); return Results.NoContent();
        });

        app.MapGet("/api/classes/{classId:guid}/export", async (HttpRequest http, Guid classId, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var classroom = await db.Classes.SingleOrDefaultAsync(x => x.Id == classId && !x.Deleted);
            if (classroom is null) return Results.NotFound();
            var projects = await db.Projects.Where(x => x.ClassId == classId && !x.Deleted).OrderBy(x => x.Date).ThenBy(x => x.Name).ToListAsync();
            var layout = await db.Layouts.FindAsync(classId);
            var duty = await db.DutyPlans.FindAsync(classId);
            var export = new
            {
                format = "pancake-class-export",
                version = 2,
                exportedAt = DateTime.UtcNow,
                classroom = new { classroom.Id, classroom.Name, classroom.LayoutPolicy },
                layout = layout is null ? null : new { layout.Revision, layout.UpdatedAt, payload = ParseOrNull(layout.PayloadJson) },
                students = await db.Students.Where(x => x.ClassId == classId).OrderBy(x => x.SortOrder).Select(x => new { x.Name, x.Number, x.Group, x.Note, x.Active }).ToListAsync(),
                duty = duty is null ? null : ParseOrNull(duty.PlanJson),
                announcements = await db.Announcements.Where(x => x.ClassId == classId && !x.Deleted).Select(x => new { x.Title, x.Body, x.Level, x.Pinned, x.StartsAt, x.ExpiresAt, x.CreatedAt, x.Author }).ToListAsync(),
                projects = projects.Select(p => new { id = p.ProjectId, p.Name, p.Date, p.Revision, p.UpdatedAt, p.UpdatedBy, payload = ParseOrNull(p.PayloadJson) })
            };
            byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(export, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.Create(System.Text.Unicode.UnicodeRanges.All) });
            string file = $"pancake-{classroom.Name}-{DateTime.Now:yyyyMMdd-HHmm}.json";
            return Results.File(bytes, "application/json", file);
        });

        app.MapGet("/api/overview", async (HttpRequest http, PancakeDbContext db, SessionStore sessions, ClassSocketHub hub) =>
        {
            if (!Access.User(http, sessions, out var session)) return Results.Unauthorized();
            var classes = await ClassDetails(db, hub, session);
            var ids = classes.Select(x => x.Id).ToList();
            DateTime dayAgo = DateTime.UtcNow.AddDays(-1);
            var names = classes.ToDictionary(x => x.Id, x => x.Name);
            var recent = await db.Projects.Where(x => ids.Contains(x.ClassId)).OrderByDescending(x => x.UpdatedAt).Take(8)
                .Select(x => new { x.ClassId, id = x.ProjectId, x.Name, x.Date, x.Revision, x.Deleted, x.UpdatedAt, x.UpdatedBy }).ToListAsync();
            bool admin = session.Role == PancakeRole.Administrator;
            // 今日作业布置情况：每个班今天是否有项目、几个科目已经填写。
            var today = PeopleEndpoints.Today();
            var todayRows = await db.Projects.Where(x => ids.Contains(x.ClassId) && !x.Deleted && x.Date == today)
                .Select(x => new { x.ClassId, id = x.ProjectId, x.Name, x.PayloadJson, x.UpdatedAt }).ToListAsync();
            var todayStatus = classes.Select(c =>
            {
                var p = todayRows.Where(x => x.ClassId == c.Id).OrderByDescending(x => x.UpdatedAt).FirstOrDefault();
                var (total, filled) = p is null ? (0, 0) : CountSubjects(p.PayloadJson);
                return new { classId = c.Id, className = c.Name, projectId = p?.id, projectName = p?.Name, subjects = total, filled, online = c.Online };
            });
            DateTime now = DateTime.UtcNow;
            int activeAnnouncements = await db.Announcements.CountAsync(x => ids.Contains(x.ClassId) && !x.Deleted && (x.StartsAt == null || x.StartsAt <= now) && (x.ExpiresAt == null || x.ExpiresAt > now));
            int studentCount = await db.Students.CountAsync(x => ids.Contains(x.ClassId) && x.Active);
            var troubled = await db.Devices.Where(x => ids.Contains(x.ClassId) && !x.Revoked && (x.LastError != "" || x.PendingChanges > 0))
                .Select(x => new { x.Id, x.ClassId, x.DeviceName, x.LastError, x.PendingChanges, x.LastSyncAt }).ToListAsync();
            return Results.Ok(new
            {
                today = todayStatus,
                activeAnnouncements,
                studentCount,
                deviceIssues = troubled.Select(x => new { x.Id, x.ClassId, className = names.GetValueOrDefault(x.ClassId, ""), x.DeviceName, x.LastError, x.PendingChanges, x.LastSyncAt }),
                classCount = classes.Count,
                projectCount = classes.Sum(x => x.ProjectCount),
                deviceCount = classes.Sum(x => x.DeviceCount),
                activeDevices = await db.Devices.CountAsync(x => ids.Contains(x.ClassId) && !x.Revoked && x.LastSeenAt >= dayAgo),
                updatedToday = await db.Projects.CountAsync(x => ids.Contains(x.ClassId) && x.UpdatedAt >= dayAgo),
                online = classes.Sum(x => x.Online),
                userCount = admin ? await db.Users.CountAsync() : (int?)null,
                recent = recent.Select(x => new { x.ClassId, className = names.GetValueOrDefault(x.ClassId, ""), x.id, x.Name, x.Date, x.Revision, x.Deleted, x.UpdatedAt, x.UpdatedBy }),
                activity = admin
                    ? await db.AuditEvents.OrderByDescending(x => x.Id).Take(8).ToListAsync()
                    : await db.AuditEvents.Where(x => x.ClassId != null && ids.Contains(x.ClassId.Value)).OrderByDescending(x => x.Id).Take(8).ToListAsync()
            });
        });
    }

    private static async Task<List<ClassDetail>> ClassDetails(PancakeDbContext db, ClassSocketHub hub, UserSession session, Guid? only = null)
    {
        var query = db.Classes.Where(x => !x.Deleted);
        if (only is { } id) query = query.Where(x => x.Id == id);
        if (session.Role != PancakeRole.Administrator)
            query = query.Where(x => db.Memberships.Any(m => m.ClassId == x.Id && m.UserId == session.UserId));
        var rows = await query.OrderBy(x => x.Name).Select(x => new
        {
            x.Id, x.Name, x.PublicCode, x.CreatedAt,
            Projects = db.Projects.Count(p => p.ClassId == x.Id && !p.Deleted),
            Devices = db.Devices.Count(d => d.ClassId == x.Id && !d.Revoked),
            Teachers = db.Memberships.Count(m => m.ClassId == x.Id),
            LastUpdated = db.Projects.Where(p => p.ClassId == x.Id).Max(p => (DateTime?)p.UpdatedAt)
        }).ToListAsync();
        return rows.Select(x => new ClassDetail(x.Id, x.Name, x.PublicCode, x.CreatedAt, x.Projects, x.Devices, x.Teachers, x.LastUpdated, hub.Count(x.Id))).ToList();
    }

    private static async Task<string> UniquePublicCode(PancakeDbContext db)
    {
        while (true)
        {
            string code = SecurityService.PublicCode();
            if (!await db.Classes.AnyAsync(x => x.PublicCode == code)) return code;
        }
    }

    /// <summary>项目里的科目数与已填写作业的科目数（有文字、附件或手写之一即算已填写）。</summary>
    private static (int Total, int Filled) CountSubjects(string payloadJson)
    {
        if (PayloadEditor.TryParse(payloadJson)?["Subjects"] is not System.Text.Json.Nodes.JsonArray subjects) return (0, 0);
        int filled = 0;
        foreach (var subject in subjects)
        {
            if (subject?["Entries"] is not System.Text.Json.Nodes.JsonArray entries) continue;
            bool any = entries.Any(e =>
                ((e?["Content"]?.GetValue<string>() ?? "").Trim() is { Length: > 0 } text && text != "在这里输入作业内容")
                || (e?["Attachments"] as System.Text.Json.Nodes.JsonArray)?.Count > 0
                || (e?["HasHandwriting"] is System.Text.Json.Nodes.JsonValue v && v.TryGetValue(out bool hand) && hand));
            if (any) filled++;
        }
        return (subjects.Count, filled);
    }

    private static JsonElement? ParseOrNull(string json)
    {
        try { using var doc = JsonDocument.Parse(json); return doc.RootElement.Clone(); }
        catch (JsonException) { return null; }
    }
}
