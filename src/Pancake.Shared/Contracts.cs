namespace Pancake.Shared;

public enum PancakeRole { Administrator, Teacher, Student }

public sealed record LoginRequest(string UserName, string Password);
public sealed record ChangePasswordRequest(string CurrentPassword, string NewPassword);
public sealed record LoginResponse(string AccessToken, PancakeRole Role, string DisplayName);
public sealed record CreateClassRequest(string Name);
public sealed record CreateTeacherRequest(string UserName, string Password, string DisplayName);
public sealed record ClassSummary(Guid Id, string Name, string PublicCode, DateTime CreatedAt);
public sealed record ProjectSummary(Guid Id, string Name, DateOnly? Date, long Revision, bool Deleted, DateTime UpdatedAt);
public sealed record ProjectSnapshot(Guid Id, string Name, DateOnly? Date, long Revision, bool Deleted, string PayloadJson, DateTime UpdatedAt);
/// <summary>删除时 PayloadJson 可以为空，服务端保留最后一份内容，便于从网页恢复。</summary>
public sealed record ProjectWriteRequest(long ExpectedRevision, string Name, DateOnly? Date, bool Deleted, string PayloadJson);
public sealed record ConflictResponse(string Error, ProjectSnapshot ServerVersion, ProjectSnapshot LocalVersion);
public sealed record DevicePairRequest(string PairingCode, string DeviceName);
public sealed record DevicePairResponse(string DeviceToken, Guid ClassId, DateTime ExpiresAt, string ClassName = "", Guid DeviceId = default);

/// <summary>
/// 班级实时通知。Type：updated / deleted（项目）、layout（班级布局）、board（公告与值日）、command（发给单台设备的指令）。
/// SourceDeviceId 是触发这次修改的设备（网页修改时为空），设备据此忽略自己的回声；Keys 是布局通知里改动的设置键。
/// 旧客户端只认识前四个字段，新增字段都有默认值。
/// </summary>
public sealed record SyncEvent(Guid ClassId, Guid ProjectId, long Revision, string Type, Guid? DeviceId = null, string? Command = null, string? Text = null,
    Guid? SourceDeviceId = null, List<string>? Keys = null);

public static class SyncEventTypes
{
    public const string Updated = "updated";
    public const string Deleted = "deleted";
    public const string Layout = "layout";
    public const string Board = "board";
    public const string Command = "command";
}

/// <summary>
/// 班级布局同步策略：Shared 设备与网页双向同步；Managed 只由网页下发，设备不能上传；Off 不同步布局。
/// </summary>
public static class LayoutPolicies
{
    public const string Shared = "Shared";
    public const string Managed = "Managed";
    public const string Off = "Off";
    public static bool IsValid(string? value) => value is Shared or Managed or Off;
}

public sealed record LayoutSnapshot(long Revision, string Policy, string PayloadJson, DateTime? UpdatedAt, string UpdatedBy);
public sealed record LayoutWriteRequest(long ExpectedRevision, string PayloadJson);

/// <summary>
/// 按键修改班级设置：Set 中的键写入新值，Unset 中的键删除。BaseRevision 是修改方最后看到的修订号；
/// 只有某个键在 BaseRevision 之后被别人改成了不同的值才算冲突，其余键直接合并。
/// </summary>
public sealed record LayoutPatchRequest(long BaseRevision, Dictionary<string, System.Text.Json.JsonElement>? Set, List<string>? Unset);
public sealed record LayoutConflictResponse(string Error, List<string> Keys, LayoutSnapshot Server);

/// <summary>Fonts 是本机已安装的字体，网页据此提供字体选择；内容没变时设备不重复上报（为 null 表示保持上次）。</summary>
public sealed record DeviceStatusRequest(string AppVersion, int PendingChanges, string? LastError, Guid? ActiveProjectId, string? ActiveProjectName, List<string>? Fonts = null);

public sealed record AnnouncementItem(Guid Id, string Title, string Body, string Level, bool Pinned, DateTime CreatedAt, DateTime? StartsAt, DateTime? ExpiresAt, string Author);
public sealed record DutyTaskAssignment(string Task, List<string> Students);
public sealed record DutyToday(DateOnly Date, string Label, List<DutyTaskAssignment> Tasks);

/// <summary>
/// 班级大屏需要的班务信息：生效中的公告、今天的值日和布局修订号。
/// Upcoming 是 24 小时内将开始的定时公告，大屏到点自行显示，不必等下一次同步；旧客户端会忽略它。
/// </summary>
public sealed record BoardInfo(Guid DeviceId, string ClassName, List<AnnouncementItem> Announcements, DutyToday? Duty, long LayoutRevision, string LayoutPolicy, DateTime ServerTime, List<AnnouncementItem>? Upcoming = null);

/// <summary>项目内容里引用服务器资源的附件路径前缀，后面跟 SHA-256 与扩展名，例如 asset:ab12…ef.png。</summary>
public static class AssetReference
{
    public const string Prefix = "asset:";

    public static string Create(string sha256, string extension) =>
        Prefix + sha256.ToLowerInvariant() + NormalizeExtension(extension);

    public static bool TryParse(string? path, out string sha256, out string extension)
    {
        sha256 = ""; extension = "";
        if (string.IsNullOrEmpty(path) || !path.StartsWith(Prefix, StringComparison.Ordinal)) return false;
        string rest = path[Prefix.Length..];
        if (rest.Length < 64 || !IsSha256(rest[..64])) return false;
        string ext = rest[64..];
        if (ext.Length > 0 && NormalizeExtension(ext) != ext.ToLowerInvariant()) return false;
        sha256 = rest[..64].ToLowerInvariant(); extension = ext.ToLowerInvariant();
        return true;
    }

    public static bool IsSha256(string value) => value.Length == 64 && value.All(Uri.IsHexDigit);

    /// <summary>只保留 1–10 位字母数字扩展名，其余一律丢弃，避免把路径片段带进文件名。</summary>
    public static string NormalizeExtension(string? extension)
    {
        if (string.IsNullOrEmpty(extension)) return "";
        string ext = extension.StartsWith('.') ? extension[1..] : extension;
        return ext.Length is >= 1 and <= 10 && ext.All(char.IsAsciiLetterOrDigit) ? "." + ext.ToLowerInvariant() : "";
    }
}
