using Microsoft.EntityFrameworkCore;
using Pancake.Server.Contracts;
using Pancake.Server.Data;
using Pancake.Server.Services;
using Pancake.Shared;

namespace Pancake.Server.Endpoints;

/// <summary>班务信息：公告、给大屏的汇总信息、设备上报状态与远程指令。</summary>
public static class BoardEndpoints
{
    private static readonly string[] Levels = ["info", "important", "urgent"];

    public static void MapBoardEndpoints(this WebApplication app)
    {
        // ---------------------------------------------------------------- 公告
        app.MapGet("/api/announcements", async (HttpRequest http, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session)) return Results.Unauthorized();
            var classes = await ManageableClasses(db, session);
            var ids = classes.Keys.ToList();
            var items = await db.Announcements.Where(x => ids.Contains(x.ClassId) && !x.Deleted).OrderByDescending(x => x.CreatedAt).Take(300).ToListAsync();
            return Results.Ok(items.Select(x => ToListItem(x, classes.GetValueOrDefault(x.ClassId, ""))));
        });

        app.MapGet("/api/classes/{classId:guid}/announcements", async (HttpRequest http, Guid classId, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            string name = await db.Classes.Where(x => x.Id == classId).Select(x => x.Name).SingleOrDefaultAsync() ?? "";
            var items = await db.Announcements.Where(x => x.ClassId == classId && !x.Deleted).OrderByDescending(x => x.Pinned).ThenByDescending(x => x.CreatedAt).ToListAsync();
            return Results.Ok(items.Select(x => ToListItem(x, name)));
        });

        app.MapPost("/api/classes/{classId:guid}/announcements", async (HttpRequest http, Guid classId, AnnouncementWriteRequest request, PancakeDbContext db, SessionStore sessions, ClassSocketHub hub) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            if (!await db.Classes.AnyAsync(x => x.Id == classId && !x.Deleted)) return Results.NotFound();
            if (Validate(request.Title, request.Body, request.Level, request.StartsAt, request.ExpiresAt) is { } error) return Results.BadRequest(error);
            var item = new Announcement { ClassId = classId, Author = session.DisplayName };
            Apply(item, request);
            db.Announcements.Add(item);
            Access.Audit(db, Access.Actor(session), "发布公告", item.Title, classId);
            await db.SaveChangesAsync();
            await PublishBoardAsync(hub, classId);
            return Results.Ok(ToListItem(item, ""));
        });

        app.MapPut("/api/classes/{classId:guid}/announcements/{id:guid}", async (HttpRequest http, Guid classId, Guid id, AnnouncementWriteRequest request, PancakeDbContext db, SessionStore sessions, ClassSocketHub hub) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            if (Validate(request.Title, request.Body, request.Level, request.StartsAt, request.ExpiresAt) is { } error) return Results.BadRequest(error);
            var item = await db.Announcements.SingleOrDefaultAsync(x => x.Id == id && x.ClassId == classId && !x.Deleted);
            if (item is null) return Results.NotFound();
            Apply(item, request);
            item.UpdatedAt = DateTime.UtcNow;
            Access.Audit(db, Access.Actor(session), "修改公告", item.Title, classId);
            await db.SaveChangesAsync();
            await PublishBoardAsync(hub, classId);
            return Results.Ok(ToListItem(item, ""));
        });

        app.MapDelete("/api/classes/{classId:guid}/announcements/{id:guid}", async (HttpRequest http, Guid classId, Guid id, PancakeDbContext db, SessionStore sessions, ClassSocketHub hub) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var item = await db.Announcements.SingleOrDefaultAsync(x => x.Id == id && x.ClassId == classId && !x.Deleted);
            if (item is null) return Results.NotFound();
            item.Deleted = true; item.UpdatedAt = DateTime.UtcNow;
            Access.Audit(db, Access.Actor(session), "删除公告", item.Title, classId);
            await db.SaveChangesAsync();
            await PublishBoardAsync(hub, classId);
            return Results.NoContent();
        });

        // 一次发给多个班级，例如年级通知。
        app.MapPost("/api/announcements/broadcast", async (HttpRequest http, BroadcastRequest request, PancakeDbContext db, SessionStore sessions, ClassSocketHub hub) =>
        {
            if (!Access.User(http, sessions, out var session)) return Results.Unauthorized();
            if (Validate(request.Title, request.Body, request.Level, request.StartsAt, request.ExpiresAt) is { } error) return Results.BadRequest(error);
            var classes = await ManageableClasses(db, session);
            var targets = (request.ClassIds ?? []).Distinct().ToList();
            if (targets.Count == 0) return Results.BadRequest("请选择班级。");
            if (targets.Any(id => !classes.ContainsKey(id))) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var write = new AnnouncementWriteRequest(request.Title, request.Body, request.Level, request.Pinned, request.StartsAt, request.ExpiresAt);
            foreach (Guid classId in targets)
            {
                var item = new Announcement { ClassId = classId, Author = session.DisplayName };
                Apply(item, write);
                db.Announcements.Add(item);
            }
            Access.Audit(db, Access.Actor(session), "群发公告", $"{request.Title.Trim()} → {string.Join("、", targets.Select(x => classes[x]))}");
            await db.SaveChangesAsync();
            foreach (Guid classId in targets) await PublishBoardAsync(hub, classId);
            return Results.Ok(new { count = targets.Count });
        });

        // ---------------------------------------------------------------- 大屏汇总
        app.MapGet("/api/classes/{classId:guid}/board", async (HttpRequest http, Guid classId, PancakeDbContext db, SessionStore sessions) =>
        {
            if (await Access.Caller(http, classId, db, sessions) is not { } caller) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var classroom = await db.Classes.AsNoTracking().SingleOrDefaultAsync(x => x.Id == classId && !x.Deleted);
            if (classroom is null) return Results.NotFound();
            return Results.Ok(await BoardFor(db, classroom, caller.Device?.Id ?? Guid.Empty));
        });

        app.MapGet("/api/public/classes/{publicCode}/board", async (string publicCode, PancakeDbContext db) =>
        {
            var classroom = await db.Classes.AsNoTracking().SingleOrDefaultAsync(x => x.PublicCode == publicCode.Trim().ToLower() && !x.Deleted);
            if (classroom is null) return Results.NotFound();
            var board = await BoardFor(db, classroom, Guid.Empty);
            return Results.Ok(new { board.ClassName, board.Announcements, board.Duty, board.ServerTime });
        });

        // 班级大屏上报的已安装字体（并集），网页的字体选择只提供大屏上真实存在的字体。
        app.MapGet("/api/classes/{classId:guid}/fonts", async (HttpRequest http, Guid classId, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var lists = await db.Devices.Where(x => x.ClassId == classId && !x.Revoked).Select(x => x.FontsJson).ToListAsync();
            SortedSet<string> fonts = new(StringComparer.CurrentCulture) { Pancake.Shared.RichText.RtfCodec.DefaultFamily };
            foreach (string json in lists)
            {
                try { foreach (string f in System.Text.Json.JsonSerializer.Deserialize<List<string>>(json) ?? []) fonts.Add(f); }
                catch (System.Text.Json.JsonException) { }
            }
            return Results.Ok(fonts);
        });

        // ---------------------------------------------------------------- 设备状态与指令
        app.MapPost("/api/classes/{classId:guid}/devices/me/status", async (HttpRequest http, Guid classId, DeviceStatusRequest request, PancakeDbContext db) =>
        {
            if (await Access.Device(http, classId, db) is not { } device) return Results.Unauthorized();
            device.AppVersion = Clip(request.AppVersion, 40);
            device.PendingChanges = Math.Clamp(request.PendingChanges, 0, 100000);
            device.LastError = Clip(request.LastError, 300);
            device.ActiveProject = Clip(request.ActiveProjectName, 80);
            device.ActiveProjectId = request.ActiveProjectId;
            if (request.Fonts is { } fonts)
                device.FontsJson = System.Text.Json.JsonSerializer.Serialize(fonts.Where(f => !string.IsNullOrWhiteSpace(f) && f.Length <= 100).Select(f => f.Trim()).Distinct().Take(2000).ToList());
            device.LastSyncAt = DateTime.UtcNow; device.LastSeenAt = DateTime.UtcNow;
            await db.SaveChangesAsync();
            return Results.Ok(new { deviceId = device.Id, deviceName = device.DeviceName });
        });

        // 大屏的屏幕与分区：窗口、布局或缩放变化后上报，网页据此按真实尺寸画出整屏和各区域。只有内容变了才写库并通知网页。
        app.MapPut("/api/classes/{classId:guid}/devices/me/screen", async (HttpRequest http, Guid classId, DeviceScreenReport request, PancakeDbContext db, ClassSocketHub hub) =>
        {
            if (await Access.Device(http, classId, db) is not { } device) return Results.Unauthorized();
            if (CleanScreen(request) is not { } screen) return Results.BadRequest("屏幕信息无效。");
            string json = System.Text.Json.JsonSerializer.Serialize(screen, ScreenJson);
            if (json == device.ScreenJson) return Results.NoContent();
            device.ScreenJson = json;
            device.ScreenAt = DateTime.UtcNow;
            if (screen.ActiveProjectId is { } active) device.ActiveProjectId = active;
            await db.SaveChangesAsync();
            await hub.PublishToUsersAsync(new SyncEvent(classId, Guid.Empty, 0, SyncEventTypes.Screen, device.Id, Screen: screen), CancellationToken.None);
            return Results.NoContent();
        });

        app.MapPost("/api/classes/{classId:guid}/devices/{deviceId:guid}/command", async (HttpRequest http, Guid classId, Guid deviceId, DeviceCommandRequest request, PancakeDbContext db, SessionStore sessions, ClassSocketHub hub) =>
        {
            if (!Access.User(http, sessions, out var session) || !await Access.CanManageClass(session, classId, db)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            if (request.Command is not ("sync" or "message")) return Results.BadRequest("不支持的指令。");
            string text = Clip(request.Text, 200);
            if (request.Command == "message" && text.Length == 0) return Results.BadRequest("消息内容不能为空。");
            var device = await db.Devices.SingleOrDefaultAsync(x => x.Id == deviceId && x.ClassId == classId && !x.Revoked);
            if (device is null) return Results.NotFound();
            bool delivered = await hub.SendToDeviceAsync(new SyncEvent(classId, Guid.Empty, 0, SyncEventTypes.Command, deviceId, request.Command, text), deviceId, CancellationToken.None);
            Access.Audit(db, Access.Actor(session), request.Command == "sync" ? "远程同步" : "发送消息", $"{device.DeviceName}{(text.Length > 0 ? "：" + text : "")}{(delivered ? "" : "（设备离线）")}", classId);
            await db.SaveChangesAsync();
            return Results.Ok(new { delivered });
        });
    }

    public static Task PublishBoardAsync(ClassSocketHub hub, Guid classId) =>
        hub.PublishAsync(new SyncEvent(classId, Guid.Empty, 0, SyncEventTypes.Board), CancellationToken.None);

    public static async Task<BoardInfo> BoardFor(PancakeDbContext db, Classroom classroom, Guid deviceId)
    {
        DateTime now = DateTime.UtcNow, soon = now.AddHours(24);
        var announcements = await db.Announcements.AsNoTracking()
            .Where(x => x.ClassId == classroom.Id && !x.Deleted && (x.StartsAt == null || x.StartsAt <= now) && (x.ExpiresAt == null || x.ExpiresAt > now))
            .OrderByDescending(x => x.Pinned).ThenByDescending(x => x.CreatedAt).Take(20).ToListAsync();
        var upcoming = await db.Announcements.AsNoTracking()
            .Where(x => x.ClassId == classroom.Id && !x.Deleted && x.StartsAt != null && x.StartsAt > now && x.StartsAt <= soon)
            .OrderBy(x => x.StartsAt).Take(20).ToListAsync();
        var layoutRevision = await db.Layouts.Where(x => x.ClassId == classroom.Id).Select(x => (long?)x.Revision).SingleOrDefaultAsync() ?? 0;
        return new BoardInfo(deviceId, classroom.Name,
            announcements.OrderBy(x => LevelRank(x.Level)).ThenByDescending(x => x.Pinned).ThenByDescending(x => x.CreatedAt).Select(ToItem).ToList(),
            await PeopleEndpoints.DutyFor(db, classroom.Id, PeopleEndpoints.Today()), layoutRevision, classroom.LayoutPolicy, now,
            upcoming.Select(ToItem).ToList());
    }

    private static int LevelRank(string level) => level == "urgent" ? 0 : level == "important" ? 1 : 2;

    private static async Task<Dictionary<Guid, string>> ManageableClasses(PancakeDbContext db, UserSession session)
    {
        var query = db.Classes.Where(x => !x.Deleted);
        if (session.Role != PancakeRole.Administrator) query = query.Where(x => db.Memberships.Any(m => m.ClassId == x.Id && m.UserId == session.UserId));
        return await query.ToDictionaryAsync(x => x.Id, x => x.Name);
    }

    private static string? Validate(string? title, string? body, string? level, DateTime? startsAt, DateTime? expiresAt)
    {
        if (string.IsNullOrWhiteSpace(title) || title.Trim().Length > 60) return "标题需为 1–60 个字符。";
        if ((body ?? "").Length > 2000) return "内容不能超过 2000 个字符。";
        if (level is not null && !Levels.Contains(level)) return "级别无效。";
        if (startsAt is { } s && expiresAt is { } e && e <= s) return "结束时间必须晚于开始时间。";
        return null;
    }

    private static void Apply(Announcement item, AnnouncementWriteRequest request)
    {
        item.Title = request.Title.Trim();
        item.Body = (request.Body ?? "").Trim();
        item.Level = request.Level ?? "info";
        item.Pinned = request.Pinned;
        item.StartsAt = request.StartsAt?.ToUniversalTime();
        item.ExpiresAt = request.ExpiresAt?.ToUniversalTime();
    }

    private static string Clip(string? value, int max) { string v = (value ?? "").Trim(); return v.Length > max ? v[..max] : v; }

    public static readonly System.Text.Json.JsonSerializerOptions ScreenJson = new(System.Text.Json.JsonSerializerDefaults.Web);
    private static readonly string[] LayoutModes = ["Split", "Board", "Clock", "Free"];

    /// <summary>屏幕上报：尺寸有限且不超过 20000，区域在合理范围内，数值保留一位小数；不合法时返回 null。</summary>
    private static DeviceScreenReport? CleanScreen(DeviceScreenReport? report)
    {
        static double? Round(double value, double min, double max) => double.IsFinite(value) && value >= min && value <= max ? Math.Round(value, 1) : null;
        static ScreenRegion? Region(ScreenRegion? r, out bool bad)
        {
            bad = false;
            if (r is null) return null;
            if (Round(r.X, -20000, 20000) is not { } x || Round(r.Y, -20000, 20000) is not { } y || Round(r.Width, 0, 20000) is not { } w || Round(r.Height, 0, 20000) is not { } h) { bad = true; return null; }
            return new ScreenRegion(x, y, w, h);
        }
        if (report is null || !LayoutModes.Contains(report.LayoutMode)) return null;
        if (Round(report.Width, 1, 20000) is not { } width || Round(report.Height, 1, 20000) is not { } height) return null;
        if (!double.IsFinite(report.Scale) || report.Scale is <= 0 or > 10 || !double.IsFinite(report.SplitRatio) || report.SplitRatio is < 0 or > 1) return null;
        ScreenRegion? clock = Region(report.Clock, out bool badClock), board = Region(report.Board, out bool badBoard);
        if (badClock || badBoard) return null;
        return new DeviceScreenReport(width, height, Math.Round(report.Scale, 3), report.LayoutMode, Math.Round(report.SplitRatio, 4), report.Compact, clock, board, report.ActiveProjectId);
    }

    private static AnnouncementItem ToItem(Announcement x) => new(x.Id, x.Title, x.Body, x.Level, x.Pinned, x.CreatedAt, x.StartsAt, x.ExpiresAt, x.Author);

    private static AnnouncementListItem ToListItem(Announcement x, string className)
    {
        DateTime now = DateTime.UtcNow;
        bool active = (x.StartsAt is null || x.StartsAt <= now) && (x.ExpiresAt is null || x.ExpiresAt > now);
        return new AnnouncementListItem(x.Id, x.ClassId, className, x.Title, x.Body, x.Level, x.Pinned, x.CreatedAt, x.UpdatedAt, x.StartsAt, x.ExpiresAt, x.Author, active);
    }
}
