using Microsoft.EntityFrameworkCore;
using Pancake.Server.Data;
using Pancake.Shared;

namespace Pancake.Server.Services;

/// <summary>访问班级接口的一方：登录用户或已配对设备，二者之一非空。</summary>
public sealed record ClassCaller(string Actor, UserSession? Session, DeviceRegistration? Device);

/// <summary>集中处理“谁在调用、能访问哪个班级”，端点里只做业务判断。</summary>
public static class Access
{
    private static readonly TimeSpan DeviceSeenThrottle = TimeSpan.FromMinutes(1);

    public static bool User(HttpRequest request, SessionStore sessions, out UserSession session) =>
        sessions.TryGetSession(request.Headers.Authorization, out session);

    public static bool Admin(HttpRequest request, SessionStore sessions, out UserSession session) =>
        User(request, sessions, out session) && session.Role == PancakeRole.Administrator;

    /// <summary>管理员可管理所有班级；老师只能管理被分配的班级。</summary>
    public static async Task<bool> CanManageClass(UserSession session, Guid classId, PancakeDbContext db) =>
        session.Role == PancakeRole.Administrator
        || (session.Role == PancakeRole.Teacher && await db.Memberships.AnyAsync(x => x.ClassId == classId && x.UserId == session.UserId));

    /// <summary>解析设备令牌；成功时顺便刷新“最近在线”，一分钟内只写一次数据库。</summary>
    public static async Task<DeviceRegistration?> Device(HttpRequest request, Guid classId, PancakeDbContext db)
    {
        string? authorization = request.Headers.Authorization.FirstOrDefault();
        if (authorization?.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) != true) return null;
        return await DeviceByToken(authorization[7..].Trim(), classId, db);
    }

    public static async Task<DeviceRegistration?> DeviceByToken(string token, Guid classId, PancakeDbContext db)
    {
        var device = await db.Devices.SingleOrDefaultAsync(x => x.DeviceToken == token && x.ClassId == classId && !x.Revoked);
        if (device is not null && (device.LastSeenAt is null || DateTime.UtcNow - device.LastSeenAt > DeviceSeenThrottle))
        {
            device.LastSeenAt = DateTime.UtcNow;
            await db.SaveChangesAsync();
        }
        return device;
    }

    /// <summary>登录用户（需能管理该班）或本班设备。</summary>
    public static async Task<ClassCaller?> Caller(HttpRequest request, Guid classId, PancakeDbContext db, SessionStore sessions)
    {
        if (User(request, sessions, out var session))
            return await CanManageClass(session, classId, db) ? new ClassCaller(Actor(session), session, null) : null;
        return await Device(request, classId, db) is { } device ? new ClassCaller(Actor(device), null, device) : null;
    }

    public static Task<ClassMembership?> Membership(UserSession session, Guid classId, PancakeDbContext db) =>
        db.Memberships.SingleOrDefaultAsync(x => x.ClassId == classId && x.UserId == session.UserId);

    /// <summary>管理员和班主任可以调整本班老师的职务与科目。</summary>
    public static async Task<bool> CanManageStaff(UserSession session, Guid classId, PancakeDbContext db) =>
        session.Role == PancakeRole.Administrator
        || (await Membership(session, classId, db))?.Duty == StaffDuties.HeadTeacher;

    /// <summary>
    /// 网页编辑作业时允许改动的科目名称；null 表示不限。管理员、班主任和未指定科目的老师不受限，
    /// 指定了科目的科任老师和助教只能改自己负责的科目。
    /// </summary>
    public static async Task<HashSet<string>?> EditableSubjects(UserSession session, Guid classId, PancakeDbContext db)
    {
        if (session.Role == PancakeRole.Administrator) return null;
        var membership = await Membership(session, classId, db);
        if (membership is null) return [];
        if (membership.Duty == StaffDuties.HeadTeacher) return null;
        var subjects = ParseSubjects(membership.SubjectsJson);
        return subjects.Count == 0 ? null : subjects.ToHashSet(StringComparer.OrdinalIgnoreCase);
    }

    public static List<string> ParseSubjects(string? json)
    {
        try { return (System.Text.Json.JsonSerializer.Deserialize<List<string>>(json ?? "[]") ?? []).Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim()).Distinct().ToList(); }
        catch (System.Text.Json.JsonException) { return []; }
    }

    public static string Actor(UserSession session) => $"{session.DisplayName}（{session.UserName}）";
    public static string Actor(DeviceRegistration device) => $"设备 {device.DeviceName}";

    public static void Audit(PancakeDbContext db, string actor, string action, string detail, Guid? classId = null) =>
        db.AuditEvents.Add(new AuditEvent { Actor = actor, Action = action, Detail = detail, ClassId = classId });

    public static string ClientKey(HttpContext context, string userName) =>
        $"{context.Connection.RemoteIpAddress}|{userName.Trim().ToLowerInvariant()}";
}
