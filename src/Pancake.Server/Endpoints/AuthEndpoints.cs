using Microsoft.EntityFrameworkCore;
using Pancake.Server.Data;
using Pancake.Server.Services;
using Pancake.Shared;

namespace Pancake.Server.Endpoints;

public static class AuthEndpoints
{
    public static void MapAuthEndpoints(this WebApplication app)
    {
        app.MapPost("/api/auth/login", async (HttpContext http, LoginRequest request, PancakeDbContext db, SessionStore sessions) =>
        {
            string key = Access.ClientKey(http, request.UserName ?? "");
            if (sessions.LoginLockout(key) is { } wait)
                return Results.Problem($"尝试次数过多，请在 {Math.Ceiling(wait.TotalMinutes)} 分钟后再试。", statusCode: StatusCodes.Status429TooManyRequests);
            string userName = (request.UserName ?? "").Trim();
            var user = await db.Users.SingleOrDefaultAsync(x => x.UserName == userName && x.Approved);
            if (user is null || !SecurityService.VerifyPassword(request.Password ?? "", user.PasswordHash))
            {
                sessions.RecordLoginFailure(key);
                return Results.Unauthorized();
            }
            sessions.ClearLoginFailures(key);
            user.LastLoginAt = DateTime.UtcNow;
            Access.Audit(db, $"{user.DisplayName}（{user.UserName}）", "登录", $"来自 {http.Connection.RemoteIpAddress}");
            await db.SaveChangesAsync();
            string token = sessions.CreateSession(user, SecurityService.IsWeakPassword(request.Password!, user.UserName));
            return Results.Ok(new LoginResponse(token, Enum.Parse<PancakeRole>(user.Role), user.DisplayName));
        });

        app.MapPost("/api/auth/logout", (HttpRequest http, SessionStore sessions) =>
        {
            sessions.Remove(http.Headers.Authorization);
            return Results.NoContent();
        });

        app.MapGet("/api/auth/me", (HttpRequest http, SessionStore sessions) =>
            Access.User(http, sessions, out var s)
                ? Results.Ok(new { id = s.UserId, s.UserName, s.DisplayName, role = s.Role.ToString(), s.WeakPassword, s.ExpiresAt })
                : Results.Unauthorized());

        app.MapPost("/api/auth/password", async (HttpRequest http, ChangePasswordRequest request, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session)) return Results.Unauthorized();
            if (request.NewPassword.Length < 8) return Results.BadRequest("新密码至少 8 位。");
            var user = await db.Users.FindAsync(session.UserId);
            if (user is null || !SecurityService.VerifyPassword(request.CurrentPassword, user.PasswordHash)) return Results.BadRequest("当前密码不正确。");
            if (request.NewPassword == request.CurrentPassword) return Results.BadRequest("新密码不能与当前密码相同。");
            user.PasswordHash = SecurityService.HashPassword(request.NewPassword);
            Access.Audit(db, Access.Actor(session), "修改密码", "");
            await db.SaveChangesAsync();
            sessions.RevokeUser(user.Id, http.Headers.Authorization);
            sessions.Update(user.Id, s => s with { WeakPassword = SecurityService.IsWeakPassword(request.NewPassword, user.UserName) });
            return Results.NoContent();
        });
    }
}
