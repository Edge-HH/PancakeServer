using Microsoft.EntityFrameworkCore;
using Pancake.Server.Contracts;
using Pancake.Server.Data;
using Pancake.Server.Services;
using Pancake.Shared;

namespace Pancake.Server.Endpoints;

public static class AdminEndpoints
{
    public static void MapAdminEndpoints(this WebApplication app)
    {
        app.MapGet("/api/admin/users", async (HttpRequest http, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.Admin(http, sessions, out _)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var users = await db.Users.OrderBy(x => x.Role).ThenBy(x => x.UserName).ToListAsync();
            var memberships = await (from m in db.Memberships
                                     join c in db.Classes on m.ClassId equals c.Id
                                     where !c.Deleted
                                     select new { m.UserId, c.Id, c.Name }).ToListAsync();
            return Results.Ok(users.Select(u => new UserItem(u.Id, u.UserName, u.DisplayName, u.Role, u.Approved, u.CreatedAt, u.LastLoginAt,
                memberships.Where(m => m.UserId == u.Id).Select(m => new ClassRef(m.Id, m.Name)).OrderBy(x => x.Name).ToList())));
        });

        app.MapPost("/api/admin/users", async (HttpRequest http, CreateUserRequest request, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.Admin(http, sessions, out var session)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            return await CreateUser(db, session, request);
        });

        // 旧接口：只创建老师账号。
        app.MapPost("/api/admin/teachers", async (HttpRequest http, CreateTeacherRequest request, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.Admin(http, sessions, out var session)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            return await CreateUser(db, session, new CreateUserRequest(request.UserName, request.Password, request.DisplayName));
        });

        app.MapPatch("/api/admin/users/{userId:guid}", async (HttpRequest http, Guid userId, UpdateUserRequest request, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.Admin(http, sessions, out var session)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var user = await db.Users.FindAsync(userId);
            if (user is null) return Results.NotFound();
            List<string> changes = [];
            if (request.DisplayName is not null)
            {
                if (string.IsNullOrWhiteSpace(request.DisplayName) || request.DisplayName.Trim().Length > 40) return Results.BadRequest("显示名称需为 1–40 个字符。");
                if (user.DisplayName != request.DisplayName.Trim()) changes.Add($"名称 → {request.DisplayName.Trim()}");
                user.DisplayName = request.DisplayName.Trim();
            }
            bool wasAdmin = user.Role == nameof(PancakeRole.Administrator) && user.Approved;
            if (request.Role is not null && request.Role != user.Role)
            {
                if (request.Role is not (nameof(PancakeRole.Administrator) or nameof(PancakeRole.Teacher))) return Results.BadRequest("角色无效。");
                if (user.Id == session.UserId) return Results.BadRequest("不能修改自己的角色。");
                changes.Add(request.Role == nameof(PancakeRole.Administrator) ? "设为管理员" : "设为老师");
                user.Role = request.Role;
            }
            if (request.Enabled is { } enabled && enabled != user.Approved)
            {
                if (user.Id == session.UserId && !enabled) return Results.BadRequest("不能停用自己的账号。");
                changes.Add(enabled ? "启用" : "停用");
                user.Approved = enabled;
            }
            bool isAdmin = user.Role == nameof(PancakeRole.Administrator) && user.Approved;
            if (wasAdmin && !isAdmin && !await db.Users.AnyAsync(x => x.Id != user.Id && x.Role == nameof(PancakeRole.Administrator) && x.Approved))
                return Results.BadRequest("至少需要保留一个启用的管理员。");
            if (changes.Count == 0) return Results.NoContent();
            Access.Audit(db, Access.Actor(session), "修改账号", $"{user.UserName}：{string.Join("，", changes)}");
            await db.SaveChangesAsync();
            if (!user.Approved || request.Role is not null) sessions.RevokeUser(user.Id);
            else sessions.Update(user.Id, s => s with { DisplayName = user.DisplayName });
            return Results.NoContent();
        });

        app.MapPut("/api/admin/users/{userId:guid}/classes", async (HttpRequest http, Guid userId, UserClassesRequest request, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.Admin(http, sessions, out var session)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var user = await db.Users.FindAsync(userId);
            if (user is null) return Results.NotFound();
            var wanted = await db.Classes.Where(x => request.ClassIds.Contains(x.Id) && !x.Deleted).Select(x => x.Id).ToListAsync();
            var current = await db.Memberships.Where(x => x.UserId == userId).ToListAsync();
            db.Memberships.RemoveRange(current.Where(x => !wanted.Contains(x.ClassId)));
            db.Memberships.AddRange(wanted.Where(id => current.All(x => x.ClassId != id)).Select(id => new ClassMembership { UserId = userId, ClassId = id }));
            Access.Audit(db, Access.Actor(session), "分配班级", $"{user.UserName}：{wanted.Count} 个班级");
            await db.SaveChangesAsync();
            return Results.NoContent();
        });

        app.MapPost("/api/admin/users/{userId:guid}/password", async (HttpRequest http, Guid userId, ResetPasswordRequest request, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.Admin(http, sessions, out var session)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            if (request.NewPassword.Length < 8) return Results.BadRequest("新密码至少 8 位。");
            var user = await db.Users.FindAsync(userId);
            if (user is null) return Results.NotFound();
            user.PasswordHash = SecurityService.HashPassword(request.NewPassword);
            Access.Audit(db, Access.Actor(session), "重置密码", user.UserName);
            await db.SaveChangesAsync();
            sessions.RevokeUser(user.Id, user.Id == session.UserId ? http.Headers.Authorization.ToString() : null);
            return Results.NoContent();
        });

        app.MapDelete("/api/admin/users/{userId:guid}", async (HttpRequest http, Guid userId, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.Admin(http, sessions, out var session)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            if (userId == session.UserId) return Results.BadRequest("不能删除自己的账号。");
            var user = await db.Users.FindAsync(userId);
            if (user is null) return Results.NotFound();
            if (user.Role == nameof(PancakeRole.Administrator) && !await db.Users.AnyAsync(x => x.Id != userId && x.Role == nameof(PancakeRole.Administrator) && x.Approved))
                return Results.BadRequest("至少需要保留一个启用的管理员。");
            db.Memberships.RemoveRange(db.Memberships.Where(x => x.UserId == userId));
            db.Users.Remove(user);
            Access.Audit(db, Access.Actor(session), "删除账号", $"{user.DisplayName}（{user.UserName}）");
            await db.SaveChangesAsync();
            sessions.RevokeUser(userId);
            return Results.NoContent();
        });

        app.MapGet("/api/admin/audit", async (HttpRequest http, PancakeDbContext db, SessionStore sessions, string? q, Guid? classId, int? take, long? before) =>
        {
            if (!Access.Admin(http, sessions, out _)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var query = db.AuditEvents.AsQueryable();
            if (classId is { } id) query = query.Where(x => x.ClassId == id);
            if (before is { } b) query = query.Where(x => x.Id < b);
            if (!string.IsNullOrWhiteSpace(q)) query = query.Where(x => x.Actor.Contains(q) || x.Action.Contains(q) || x.Detail.Contains(q));
            var items = await query.OrderByDescending(x => x.Id).Take(Math.Clamp(take ?? 100, 1, 500)).ToListAsync();
            var names = await db.Classes.ToDictionaryAsync(x => x.Id, x => x.Name);
            return Results.Ok(items.Select(x => new { x.Id, x.At, x.Actor, x.Action, x.Detail, x.ClassId, className = x.ClassId is { } c ? names.GetValueOrDefault(c) : null }));
        });

        // 在线热备份：VACUUM INTO 生成一致的数据库副本，不需要停服。
        app.MapGet("/api/admin/backup", async (HttpRequest http, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.Admin(http, sessions, out var session)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            string path = Path.Combine(Path.GetTempPath(), $"pancake-backup-{Guid.NewGuid():N}.db");
            await db.Database.ExecuteSqlRawAsync("VACUUM INTO {0}", path);
            byte[] bytes = await File.ReadAllBytesAsync(path);
            File.Delete(path);
            Access.Audit(db, Access.Actor(session), "下载备份", $"{bytes.Length / 1024} KB");
            await db.SaveChangesAsync();
            return Results.File(bytes, "application/vnd.sqlite3", $"pancake-backup-{DateTime.Now:yyyyMMdd-HHmm}.db");
        });
    }

    private static async Task<IResult> CreateUser(PancakeDbContext db, UserSession session, CreateUserRequest request)
    {
        string userName = (request.UserName ?? "").Trim();
        if (userName.Length is < 2 or > 32 || userName.Any(char.IsWhiteSpace)) return Results.BadRequest("账号需为 2–32 个字符且不能包含空格。");
        if ((request.Password ?? "").Length < 8) return Results.BadRequest("密码至少 8 位。");
        if (request.Role is not (nameof(PancakeRole.Administrator) or nameof(PancakeRole.Teacher))) return Results.BadRequest("角色无效。");
        if (await db.Users.AnyAsync(x => x.UserName == userName)) return Results.Conflict("账号已存在。");
        string displayName = string.IsNullOrWhiteSpace(request.DisplayName) ? userName : request.DisplayName.Trim();
        var user = new UserAccount { UserName = userName, DisplayName = displayName, Role = request.Role, PasswordHash = SecurityService.HashPassword(request.Password!) };
        db.Users.Add(user);
        Access.Audit(db, Access.Actor(session), "创建账号", $"{displayName}（{userName}）· {(user.Role == nameof(PancakeRole.Administrator) ? "管理员" : "老师")}");
        await db.SaveChangesAsync();
        return Results.Created($"/api/admin/users/{user.Id}", new { user.Id, user.UserName, user.DisplayName, user.Role });
    }
}
