using Pancake.Server.Services;

namespace Pancake.Server.Contracts;

// 仅网页控制台使用的协议；桌面客户端依赖的协议仍在 Pancake.Shared 中。
// 列表/详情在共享协议字段之外附带额外字段，旧客户端按名称反序列化时会忽略它们。

public sealed record ProjectListItem(Guid Id, string Name, DateOnly? Date, long Revision, bool Deleted, DateTime UpdatedAt, string UpdatedBy);
/// <summary>Runs 按科目、作业条目排列，是服务端从 RTF 解析出的富文本片段，网页据此显示和编辑格式；设备读取时不附带。</summary>
public sealed record ProjectDetail(Guid Id, string Name, DateOnly? Date, long Revision, bool Deleted, string PayloadJson, DateTime UpdatedAt, string UpdatedBy,
    List<List<List<Pancake.Shared.RichText.RichRun>>>? Runs = null);
public sealed record ProjectRevisionItem(long Revision, string Name, DateOnly? Date, bool Deleted, string Author, DateTime CreatedAt, int Size);
public sealed record ProjectPatchRequest(string? Name, DateOnly? Date, bool ClearDate = false);
public sealed record RestoreRequest(long? Revision);

public sealed record ClassDetail(Guid Id, string Name, string PublicCode, DateTime CreatedAt, int ProjectCount, int DeviceCount, int TeacherCount, DateTime? LastUpdatedAt, int Online);
public sealed record RenameRequest(string Name);
public sealed record DeviceItem(Guid Id, string DeviceName, DateTime CreatedAt, DateTime? LastSeenAt, bool Revoked,
    string AppVersion, DateTime? LastSyncAt, int PendingChanges, string LastError, string ActiveProject, bool Online);
public sealed record DeviceCommandRequest(string Command, string? Text);

public sealed record UserItem(Guid Id, string UserName, string DisplayName, string Role, bool Enabled, DateTime? CreatedAt, DateTime? LastLoginAt, List<ClassRef> Classes);
public sealed record ClassRef(Guid Id, string Name);
public sealed record CreateUserRequest(string UserName, string Password, string DisplayName, string Role = "Teacher");
public sealed record UpdateUserRequest(string? DisplayName, string? Role, bool? Enabled);
public sealed record ResetPasswordRequest(string NewPassword);
public sealed record UserClassesRequest(List<Guid> ClassIds);

// ---------- 网页编辑作业
public sealed record AttachmentEdit(int? Index, string? Asset, string? Name);
/// <summary>Runs 不为空时按富文本写入（Content 以 Runs 的文字为准）；为空时按纯文本处理，文字没变则保留原格式。</summary>
public sealed record EntryEdit(int? Index, string Content, List<AttachmentEdit>? Attachments, List<Pancake.Shared.RichText.RichRun>? Runs = null);
public sealed record SubjectRect(double X, double Y, double Width, double Height);
/// <summary>Rect 为磁贴位置与大小（为空保持不变）；FollowPalette 为 true 时科目颜色跟随色系。</summary>
public sealed record SubjectEdit(int? Index, string Name, string? AccentHex, List<EntryEdit>? Entries, SubjectRect? Rect = null, bool? FollowPalette = null);
public sealed record HomeworkEditRequest(long ExpectedRevision, List<SubjectEdit> Subjects);
/// <summary>TemplateProjectId 为空且 UseLatestTemplate 时沿用最近一个项目的科目布局。</summary>
public sealed record CreateProjectRequest(string Name, DateOnly? Date, Guid? TemplateProjectId, bool UseLatestTemplate = true);

// ---------- 布局
public sealed record LayoutPolicyRequest(string Policy);
public sealed record CopyLayoutRequest(List<Guid> ClassIds);
public sealed record LayoutRevisionItem(long Revision, string Author, DateTime CreatedAt, int Size);
public sealed record LayoutRestoreRequest(long Revision);

// ---------- 人员
public sealed record StaffItem(Guid Id, string UserName, string DisplayName, bool Enabled, string Duty, List<string> Subjects);
public sealed record StaffUpdateRequest(string Duty, List<string>? Subjects);
public sealed record StudentItem(Guid Id, string Name, string Number, string Group, string Note, bool Active, int SortOrder);
public sealed record StudentWriteRequest(string Name, string? Number, string? Group, string? Note, bool? Active);
/// <summary>每行一名学生：姓名，或“学号 姓名 [小组]”，逗号、制表符或空格分隔。</summary>
public sealed record StudentImportRequest(string Text, bool ReplaceAll = false);
public sealed record StudentOrderRequest(List<Guid> Ids);
public sealed record DutyPlanResponse(DutyPlanModel Plan, long Revision, DateTime? UpdatedAt, string UpdatedBy, List<Pancake.Shared.DutyToday?> Week);
public sealed record DutyPlanWriteRequest(long ExpectedRevision, DutyPlanModel Plan);

// ---------- 公告
public sealed record AnnouncementWriteRequest(string Title, string? Body, string? Level, bool Pinned, DateTime? StartsAt, DateTime? ExpiresAt);
public sealed record BroadcastRequest(List<Guid> ClassIds, string Title, string? Body, string? Level, bool Pinned, DateTime? StartsAt, DateTime? ExpiresAt);
public sealed record AnnouncementListItem(Guid Id, Guid ClassId, string ClassName, string Title, string Body, string Level, bool Pinned,
    DateTime CreatedAt, DateTime UpdatedAt, DateTime? StartsAt, DateTime? ExpiresAt, string Author, bool Active);
