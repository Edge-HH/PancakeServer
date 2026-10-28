using System.Collections.Concurrent;
using System.Security.Cryptography;
using Pancake.Server.Data;
using Pancake.Shared;

namespace Pancake.Server.Services;

public sealed record UserSession(Guid UserId, PancakeRole Role, string UserName, string DisplayName, bool WeakPassword, DateTime ExpiresAt);

public sealed class SessionStore
{
    public static readonly TimeSpan PairingCodeLifetime = TimeSpan.FromMinutes(10);
    private const string PairingAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    private const int MaxLoginFailures = 5;
    private static readonly TimeSpan LoginWindow = TimeSpan.FromMinutes(10);

    private readonly ConcurrentDictionary<string, UserSession> _sessions = new();
    private readonly ConcurrentDictionary<string, (Guid ClassId, DateTime ExpiresAt)> _pairingCodes = new();
    private readonly ConcurrentDictionary<string, (int Count, DateTime FirstAt)> _loginFailures = new();

    public string CreateSession(UserAccount user, bool weakPassword)
    {
        Prune();
        string token = SecurityService.NewToken();
        _sessions[token] = new UserSession(user.Id, Enum.Parse<PancakeRole>(user.Role), user.UserName, user.DisplayName, weakPassword, DateTime.UtcNow.AddDays(7));
        return token;
    }

    public bool TryGet(string? authorization, out (Guid UserId, PancakeRole Role) session)
    {
        session = default;
        if (!TryGetSession(authorization, out var value)) return false;
        session = (value.UserId, value.Role); return true;
    }

    public bool TryGetSession(string? authorization, out UserSession session)
    {
        session = null!;
        string? token = BearerToken(authorization);
        if (token is null || !_sessions.TryGetValue(token, out var value) || value.ExpiresAt <= DateTime.UtcNow) return false;
        session = value; return true;
    }

    public void Remove(string? authorization) { if (BearerToken(authorization) is { } token) _sessions.TryRemove(token, out _); }

    /// <summary>账号被禁用、删除或重置密码后，所有已签发的会话立即失效。</summary>
    public void RevokeUser(Guid userId, string? exceptAuthorization = null)
    {
        string? keep = BearerToken(exceptAuthorization);
        foreach (var item in _sessions) if (item.Value.UserId == userId && item.Key != keep) _sessions.TryRemove(item.Key, out _);
    }

    public void Update(Guid userId, Func<UserSession, UserSession> change)
    {
        foreach (var item in _sessions) if (item.Value.UserId == userId) _sessions[item.Key] = change(item.Value);
    }

    public int ActiveSessionCount => _sessions.Values.Count(x => x.ExpiresAt > DateTime.UtcNow);

    public string CreatePairingCode(Guid classId)
    {
        Prune();
        string code = RandomNumberGenerator.GetString(PairingAlphabet, 8);
        _pairingCodes[code] = (classId, DateTime.UtcNow.Add(PairingCodeLifetime));
        return code;
    }

    public bool ConsumePairingCode(string code, out Guid classId)
    {
        classId = Guid.Empty;
        string normalized = code.Replace("-", "").Replace(" ", "").Trim().ToUpperInvariant();
        if (!_pairingCodes.TryRemove(normalized, out var value) || value.ExpiresAt <= DateTime.UtcNow) return false;
        classId = value.ClassId; return true;
    }

    /// <summary>同一来源对同一账号连续输错过多时暂时拒绝登录，返回需要等待的时间。</summary>
    public TimeSpan? LoginLockout(string key)
    {
        if (!_loginFailures.TryGetValue(key, out var value)) return null;
        TimeSpan elapsed = DateTime.UtcNow - value.FirstAt;
        if (elapsed >= LoginWindow) { _loginFailures.TryRemove(key, out _); return null; }
        return value.Count >= MaxLoginFailures ? LoginWindow - elapsed : null;
    }

    public void RecordLoginFailure(string key) =>
        _loginFailures.AddOrUpdate(key, _ => (1, DateTime.UtcNow), (_, v) => DateTime.UtcNow - v.FirstAt >= LoginWindow ? (1, DateTime.UtcNow) : (v.Count + 1, v.FirstAt));

    public void ClearLoginFailures(string key) => _loginFailures.TryRemove(key, out _);

    private void Prune()
    {
        DateTime now = DateTime.UtcNow;
        foreach (var item in _sessions) if (item.Value.ExpiresAt <= now) _sessions.TryRemove(item.Key, out _);
        foreach (var item in _pairingCodes) if (item.Value.ExpiresAt <= now) _pairingCodes.TryRemove(item.Key, out _);
    }

    private static string? BearerToken(string? authorization) =>
        !string.IsNullOrWhiteSpace(authorization) && authorization.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? authorization[7..].Trim() : null;
}
