using Microsoft.EntityFrameworkCore;

namespace Pancake.Server.Data;

public sealed class PancakeDbContext(DbContextOptions<PancakeDbContext> options) : DbContext(options)
{
    public DbSet<UserAccount> Users => Set<UserAccount>();
    public DbSet<Classroom> Classes => Set<Classroom>();
    public DbSet<ClassMembership> Memberships => Set<ClassMembership>();
    public DbSet<ServerProject> Projects => Set<ServerProject>();
    public DbSet<DeviceRegistration> Devices => Set<DeviceRegistration>();
    public DbSet<ProjectRevision> ProjectRevisions => Set<ProjectRevision>();
    public DbSet<AuditEvent> AuditEvents => Set<AuditEvent>();
    public DbSet<ClassLayout> Layouts => Set<ClassLayout>();
    public DbSet<LayoutRevision> LayoutRevisions => Set<LayoutRevision>();
    public DbSet<AssetBlob> Assets => Set<AssetBlob>();
    public DbSet<Student> Students => Set<Student>();
    public DbSet<DutyPlan> DutyPlans => Set<DutyPlan>();
    public DbSet<Announcement> Announcements => Set<Announcement>();
    public DbSet<ClassGroup> ClassGroups => Set<ClassGroup>();

    protected override void OnModelCreating(ModelBuilder model)
    {
        model.Entity<UserAccount>().HasIndex(x => x.UserName).IsUnique();
        model.Entity<Classroom>().HasIndex(x => x.PublicCode).IsUnique();
        model.Entity<ClassMembership>().HasKey(x => new { x.UserId, x.ClassId });
        model.Entity<ServerProject>().HasKey(x => new { x.ClassId, x.ProjectId });
        model.Entity<ServerProject>().Property(x => x.PayloadJson).HasColumnType("TEXT");
        model.Entity<DeviceRegistration>().HasIndex(x => x.DeviceToken).IsUnique();
        model.Entity<ProjectRevision>().HasIndex(x => new { x.ClassId, x.ProjectId, x.Revision });
        model.Entity<ProjectRevision>().Property(x => x.PayloadJson).HasColumnType("TEXT");
        model.Entity<AuditEvent>().HasIndex(x => x.At);
        model.Entity<ClassLayout>().HasKey(x => x.ClassId);
        model.Entity<ClassLayout>().Property(x => x.PayloadJson).HasColumnType("TEXT");
        model.Entity<LayoutRevision>().HasIndex(x => new { x.ClassId, x.Revision });
        model.Entity<AssetBlob>().HasKey(x => new { x.ClassId, x.Sha256 });
        model.Entity<Student>().HasIndex(x => x.ClassId);
        model.Entity<DutyPlan>().HasKey(x => x.ClassId);
        model.Entity<Announcement>().HasIndex(x => x.ClassId);

        // SQLite 不保存 DateTime.Kind；所有时间按 UTC 写入，读回时标记为 UTC，JSON 才会带上 Z。
        var utc = new Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<DateTime, DateTime>(v => v, v => DateTime.SpecifyKind(v, DateTimeKind.Utc));
        foreach (var property in model.Model.GetEntityTypes().SelectMany(x => x.GetProperties()))
            if (property.ClrType == typeof(DateTime) || property.ClrType == typeof(DateTime?)) property.SetValueConverter(utc);
    }
}

public sealed class UserAccount
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string UserName { get; set; } = "";
    public string PasswordHash { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string Role { get; set; } = "Teacher";
    public bool Approved { get; set; } = true;
    public DateTime? CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? LastLoginAt { get; set; }
}

public sealed class Classroom
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Name { get; set; } = "";
    public string PublicCode { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public bool Deleted { get; set; }
    public string LayoutPolicy { get; set; } = Pancake.Shared.LayoutPolicies.Shared;
    /// <summary>所属的班级分组；为空表示未分组。</summary>
    public Guid? GroupId { get; set; }
}

/// <summary>班级分组（年级、校区等）：网页按组归类显示班级，并可以把作业复制到同组的其他班级。</summary>
public sealed class ClassGroup
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Name { get; set; } = "";
    public int SortOrder { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class ClassMembership
{
    public Guid UserId { get; set; }
    public Guid ClassId { get; set; }
    /// <summary>班级职务：HeadTeacher（班主任）、SubjectTeacher（科任老师）、Assistant（助教）。</summary>
    public string Duty { get; set; } = StaffDuties.SubjectTeacher;
    /// <summary>负责科目，JSON 字符串数组；为空表示不限科目。</summary>
    public string SubjectsJson { get; set; } = "[]";
}

public static class StaffDuties
{
    public const string HeadTeacher = "HeadTeacher";
    public const string SubjectTeacher = "SubjectTeacher";
    public const string Assistant = "Assistant";
    public static bool IsValid(string? value) => value is HeadTeacher or SubjectTeacher or Assistant;
}

public sealed class ServerProject
{
    public Guid ClassId { get; set; }
    public Guid ProjectId { get; set; }
    public string Name { get; set; } = "";
    public DateOnly? Date { get; set; }
    public long Revision { get; set; }
    public bool Deleted { get; set; }
    public string PayloadJson { get; set; } = "{}";
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public string UpdatedBy { get; set; } = "";
}

public sealed class DeviceRegistration
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid ClassId { get; set; }
    public string DeviceName { get; set; } = "";
    public string DeviceToken { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public bool Revoked { get; set; }
    public DateTime? LastSeenAt { get; set; }
    public string AppVersion { get; set; } = "";
    public DateTime? LastSyncAt { get; set; }
    public int PendingChanges { get; set; }
    public string LastError { get; set; } = "";
    public string ActiveProject { get; set; } = "";
    public Guid? ActiveProjectId { get; set; }
    public string FontsJson { get; set; } = "[]";
    /// <summary>最近一次上报的屏幕与分区（DeviceScreenReport 的 JSON）；ScreenAt 是它最后一次变化的时间。</summary>
    public string ScreenJson { get; set; } = "";
    public DateTime? ScreenAt { get; set; }
}

/// <summary>每次写入保存一份完整快照，用于在网页端查看历史和回滚。</summary>
public sealed class ProjectRevision
{
    public long Id { get; set; }
    public Guid ClassId { get; set; }
    public Guid ProjectId { get; set; }
    public long Revision { get; set; }
    public string Name { get; set; } = "";
    public DateOnly? Date { get; set; }
    public bool Deleted { get; set; }
    public string PayloadJson { get; set; } = "{}";
    public string Author { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class AuditEvent
{
    public long Id { get; set; }
    public DateTime At { get; set; } = DateTime.UtcNow;
    public string Actor { get; set; } = "";
    public string Action { get; set; } = "";
    public string Detail { get; set; } = "";
    public Guid? ClassId { get; set; }
}

/// <summary>班级布局：大屏的布局模式、组件位置、网格、字体与背景等设置，整份 JSON 由客户端定义。</summary>
public sealed class ClassLayout
{
    public Guid ClassId { get; set; }
    public long Revision { get; set; }
    public string PayloadJson { get; set; } = "{}";
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public string UpdatedBy { get; set; } = "";
    /// <summary>每个设置键最后一次被修改时的修订号，按键合并时据此判断是否冲突。</summary>
    public string KeyRevisionsJson { get; set; } = "{}";
}

public sealed class LayoutRevision
{
    public long Id { get; set; }
    public Guid ClassId { get; set; }
    public long Revision { get; set; }
    public string PayloadJson { get; set; } = "{}";
    public string Author { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>按内容寻址的附件与背景文件；同一文件在不同班级各登记一次，磁盘上只存一份。</summary>
public sealed class AssetBlob
{
    public Guid ClassId { get; set; }
    public string Sha256 { get; set; } = "";
    public long Size { get; set; }
    public string ContentType { get; set; } = "application/octet-stream";
    public string FileName { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public string CreatedBy { get; set; } = "";
}

public sealed class Student
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid ClassId { get; set; }
    public string Name { get; set; } = "";
    public string Number { get; set; } = "";
    public string Group { get; set; } = "";
    public string Note { get; set; } = "";
    public bool Active { get; set; } = true;
    public int SortOrder { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>值日安排；结构见 DutyPlanner。</summary>
public sealed class DutyPlan
{
    public Guid ClassId { get; set; }
    public string PlanJson { get; set; } = "{}";
    public long Revision { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public string UpdatedBy { get; set; } = "";
}

public sealed class Announcement
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid ClassId { get; set; }
    public string Title { get; set; } = "";
    public string Body { get; set; } = "";
    /// <summary>info / important / urgent</summary>
    public string Level { get; set; } = "info";
    public bool Pinned { get; set; }
    public DateTime? StartsAt { get; set; }
    public DateTime? ExpiresAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public string Author { get; set; } = "";
    public bool Deleted { get; set; }
}
