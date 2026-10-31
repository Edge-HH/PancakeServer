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

/// <summary>Online 是保持实时连接的大屏数量（老师网页与公开页不算）。</summary>
public sealed record ClassDetail(Guid Id, string Name, string PublicCode, DateTime CreatedAt, int ProjectCount, int DeviceCount, int TeacherCount, DateTime? LastUpdatedAt, int Online,
    Guid? GroupId = null, string? GroupName = null);
public sealed record RenameRequest(string Name);
/// <summary>Screen 是大屏最近上报的屏幕与分区，ScreenAt 为它最后一次变化的时间。</summary>
public sealed record DeviceItem(Guid Id, string DeviceName, DateTime CreatedAt, DateTime? LastSeenAt, bool Revoked,
    string AppVersion, DateTime? LastSyncAt, int PendingChanges, string LastError, string ActiveProject, bool Online,
    Guid? ActiveProjectId = null, Pancake.Shared.DeviceScreenReport? Screen = null, DateTime? ScreenAt = null);
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
/// <summary>Theme（Dark / Light / Default）与 Palette（Vivid / Macaron）是项目配色，为空保持不变。</summary>
public sealed record HomeworkEditRequest(long ExpectedRevision, List<SubjectEdit> Subjects, string? Theme = null, string? Palette = null);
/// <summary>TemplateProjectId 为空且 UseLatestTemplate 时沿用最近一个项目的科目布局。</summary>
public sealed record CreateProjectRequest(string Name, DateOnly? Date, Guid? TemplateProjectId, bool UseLatestTemplate = true);
/// <summary>把作业复制到其他班级同一天的项目；Subjects 为空表示复制全部有内容的科目。</summary>
public sealed record CopyHomeworkRequest(List<Guid> ClassIds, List<string>? Subjects);
/// <summary>每个目标班级的结果：Copied 为写入的科目，Skipped 为没有权限改动而跳过的科目；Error 不为空表示整个班级被跳过。</summary>
public sealed record CopyHomeworkItem(Guid ClassId, string ClassName, Guid? ProjectId, bool Created, List<string> Copied, List<string> Skipped, string? Error);

// ---------- 班级分组
public sealed record ClassGroupItem(Guid Id, string Name, int SortOrder, int ClassCount);
public sealed record ClassGroupWriteRequest(string Name);
public sealed record ClassGroupOrderRequest(List<Guid> Ids);
public sealed record ClassGroupAssignRequest(Guid? GroupId);

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

// ---------- 考试模式
/// <summary>考试计划列表项：Dates 是有安排的日期，ClassIds 是展开后的目标班级。</summary>
public sealed record ExamPlanListItem(Guid Id, string Name, bool Enabled, long Revision,
    List<DateOnly> Dates, int SegmentCount, List<Guid> ClassIds, List<string> ClassNames,
    DateTime CreatedAt, DateTime UpdatedAt, string UpdatedBy);
public sealed record ExamPlanDetail(Guid Id, string Name, bool Enabled, long Revision,
    Pancake.Shared.ExamSchedulePayload Schedule, List<Guid> ClassIds, DateTime CreatedAt, DateTime UpdatedAt, string UpdatedBy);
/// <summary>ClassIds 为展开后的目标班级；ExpectedRevision 0 表示新建，非 0 时版本不符返回 409。</summary>
public sealed record ExamPlanWriteRequest(string Name, Pancake.Shared.ExamSchedulePayload Schedule, List<Guid> ClassIds, bool Enabled, long ExpectedRevision = 0);
public sealed record ExamEnabledRequest(bool Enabled, long ExpectedRevision);

/// <summary>考场名按班级保存；网页在考试页统一查看与设置。</summary>
public sealed record ClassExamRoomItem(Guid ClassId, string ClassName, Guid? GroupId, string? GroupName, string Room);
public sealed record ExamRoomItem(Guid ClassId, string Room);
public sealed record ExamRoomWriteRequest(List<ExamRoomItem> Items);
