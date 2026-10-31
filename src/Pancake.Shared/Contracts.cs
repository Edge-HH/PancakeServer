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
/// 班级实时通知。Type：updated / deleted（项目）、layout（班级布局）、board（公告与值日）、command（发给单台设备的指令）、
/// editing（项目编辑占用变化）、screen（大屏上报的屏幕与分区）。editing 与 screen 只发给老师的网页，大屏和公开页收不到。
/// SourceDeviceId 是触发这次修改的设备（网页修改时为空），设备据此忽略自己的回声；Keys 是布局通知里改动的设置键；
/// Lock 是 editing 通知里的当前占用（为空表示已释放）；Screen 是 screen 通知里的屏幕信息，DeviceId 为上报的设备。
/// 旧客户端只认识前四个字段，新增字段都有默认值。
/// </summary>
public sealed record SyncEvent(Guid ClassId, Guid ProjectId, long Revision, string Type, Guid? DeviceId = null, string? Command = null, string? Text = null,
    Guid? SourceDeviceId = null, List<string>? Keys = null, EditLockInfo? Lock = null, DeviceScreenReport? Screen = null);

public static class SyncEventTypes
{
    public const string Updated = "updated";
    public const string Deleted = "deleted";
    public const string Layout = "layout";
    public const string Board = "board";
    public const string Command = "command";
    public const string Editing = "editing";
    public const string Screen = "screen";
    public const string Exam = "exam";
}

/// <summary>
/// 发给设备的指令（SyncEvent.Command）：message 显示 Text；open-project 切换到 ProjectId；
/// end-edit 保存并退出 ProjectId 的编辑模式，Text 是请求编辑的老师；其余指令按“立即同步”处理。
/// </summary>
public static class DeviceCommands
{
    public const string Message = "message";
    public const string Sync = "sync";
    public const string OpenProject = "open-project";
    public const string EndEdit = "end-edit";
}

/// <summary>
/// 项目编辑占用：大屏进入编辑模式或网页开始修改时占用，期间另一端只能查看。Holder 为 device 或 user；
/// 网页按页面区分（ClientId），同一位老师的两个窗口也互相占用。占用靠心跳续期，超过有效期没有续期即失效。
/// </summary>
public sealed record EditLockInfo(Guid ProjectId, string Holder, Guid? DeviceId, Guid? UserId, string? ClientId, string Name, DateTime Since);

/// <summary>占用或续期。Force 只对老师有效：接管大屏的占用，大屏随后保存并退出编辑。</summary>
public sealed record EditLockRequest(string? ClientId = null, bool Force = false);

public static class EditLockHolders
{
    public const string Device = "device";
    public const string User = "user";
}

/// <summary>屏幕上的一块区域，单位与磁贴坐标相同（DIP），相对整个显示区域的左上角。</summary>
public sealed record ScreenRegion(double X, double Y, double Width, double Height);

/// <summary>
/// 大屏当前的显示区域：整屏尺寸（DIP）、缩放比例、布局模式与分屏比例，以及时钟区和作业区的实际位置与大小。
/// Compact 为窗口过窄时时钟区与作业区上下排列；某个区域不显示时为空。窗口、布局或缩放变化后重新上报。
/// </summary>
public sealed record DeviceScreenReport(double Width, double Height, double Scale, string LayoutMode, double SplitRatio, bool Compact,
    ScreenRegion? Clock, ScreenRegion? Board, Guid? ActiveProjectId);

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

// ------------------------------------------------------------------ 考试模式

public static class ExamSegmentKinds
{
    public const string Exam = "exam";     // 考试段：Subject 必填
    public const string Break = "break";   // 休息段：Label 为显示文案（默认“休息时间”）
}

/// <summary>
/// 考试时间表的一段。StartMinute/EndMinute 是当天 00:00 起的分钟数（0–1440），避免 UTC/本地时区混用；
/// 日期由所在 ExamDayDto 提供。
/// </summary>
public sealed record ExamSegmentDto(string Kind, string Subject, int StartMinute, int EndMinute, string? Label = null);

public sealed record ExamDayDto(DateOnly Date, List<ExamSegmentDto> Segments);

/// <summary>
/// 考试计划的完整时间表；EnterMinutesBefore 为开考前提前进入考试画面的分钟数（只作用于当天第一场）。
/// ShowSeconds 控制考试画面的大时钟与倒计时是否显示到秒。
/// </summary>
public sealed record ExamSchedulePayload(List<ExamDayDto> Days, int EnterMinutesBefore = 5, bool ShowSeconds = true);

/// <summary>
/// 下发给大屏的考试安排；ServerTime（UTC）供客户端校准本地时钟，RoomName 是该班级的考场名。
/// 无启用计划时设备端点返回 204。
/// </summary>
public sealed record ExamScheduleDto(Guid PlanId, string PlanName, List<ExamDayDto> Days, int EnterMinutesBefore,
    DateTime ServerTime, bool ShowSeconds = true, string? RoomName = null);

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
