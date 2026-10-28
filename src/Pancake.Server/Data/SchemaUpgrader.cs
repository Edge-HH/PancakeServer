using Microsoft.EntityFrameworkCore;

namespace Pancake.Server.Data;

/// <summary>
/// EnsureCreated 只会创建全新的数据库；已部署的旧库在这里按需补齐新表和新列，
/// 所有语句都可重复执行。
/// </summary>
public static class SchemaUpgrader
{
    public static void Upgrade(PancakeDbContext db)
    {
        db.Database.ExecuteSqlRaw("PRAGMA journal_mode=WAL;");

        AddColumn(db, "Users", "CreatedAt", "TEXT NULL");
        AddColumn(db, "Users", "LastLoginAt", "TEXT NULL");
        AddColumn(db, "Devices", "LastSeenAt", "TEXT NULL");
        AddColumn(db, "Projects", "UpdatedBy", "TEXT NOT NULL DEFAULT ''");
        AddColumn(db, "Classes", "LayoutPolicy", "TEXT NOT NULL DEFAULT 'Shared'");
        AddColumn(db, "Memberships", "Duty", "TEXT NOT NULL DEFAULT 'SubjectTeacher'");
        AddColumn(db, "Memberships", "SubjectsJson", "TEXT NOT NULL DEFAULT '[]'");
        AddColumn(db, "Devices", "AppVersion", "TEXT NOT NULL DEFAULT ''");
        AddColumn(db, "Devices", "LastSyncAt", "TEXT NULL");
        AddColumn(db, "Devices", "PendingChanges", "INTEGER NOT NULL DEFAULT 0");
        AddColumn(db, "Devices", "LastError", "TEXT NOT NULL DEFAULT ''");
        AddColumn(db, "Devices", "ActiveProject", "TEXT NOT NULL DEFAULT ''");
        AddColumn(db, "Devices", "FontsJson", "TEXT NOT NULL DEFAULT '[]'");

        db.Database.ExecuteSqlRaw("""
            CREATE TABLE IF NOT EXISTS "ProjectRevisions" (
                "Id" INTEGER NOT NULL CONSTRAINT "PK_ProjectRevisions" PRIMARY KEY AUTOINCREMENT,
                "ClassId" TEXT NOT NULL, "ProjectId" TEXT NOT NULL, "Revision" INTEGER NOT NULL,
                "Name" TEXT NOT NULL, "Date" TEXT NULL, "Deleted" INTEGER NOT NULL,
                "PayloadJson" TEXT NOT NULL, "Author" TEXT NOT NULL, "CreatedAt" TEXT NOT NULL);
            """);
        db.Database.ExecuteSqlRaw("""CREATE INDEX IF NOT EXISTS "IX_ProjectRevisions_ClassId_ProjectId_Revision" ON "ProjectRevisions" ("ClassId", "ProjectId", "Revision");""");
        db.Database.ExecuteSqlRaw("""
            CREATE TABLE IF NOT EXISTS "AuditEvents" (
                "Id" INTEGER NOT NULL CONSTRAINT "PK_AuditEvents" PRIMARY KEY AUTOINCREMENT,
                "At" TEXT NOT NULL, "Actor" TEXT NOT NULL, "Action" TEXT NOT NULL,
                "Detail" TEXT NOT NULL, "ClassId" TEXT NULL);
            """);
        db.Database.ExecuteSqlRaw("""CREATE INDEX IF NOT EXISTS "IX_AuditEvents_At" ON "AuditEvents" ("At");""");

        db.Database.ExecuteSqlRaw("""
            CREATE TABLE IF NOT EXISTS "Layouts" (
                "ClassId" TEXT NOT NULL CONSTRAINT "PK_Layouts" PRIMARY KEY,
                "Revision" INTEGER NOT NULL, "PayloadJson" TEXT NOT NULL, "UpdatedAt" TEXT NOT NULL, "UpdatedBy" TEXT NOT NULL);
            """);
        db.Database.ExecuteSqlRaw("""
            CREATE TABLE IF NOT EXISTS "LayoutRevisions" (
                "Id" INTEGER NOT NULL CONSTRAINT "PK_LayoutRevisions" PRIMARY KEY AUTOINCREMENT,
                "ClassId" TEXT NOT NULL, "Revision" INTEGER NOT NULL, "PayloadJson" TEXT NOT NULL,
                "Author" TEXT NOT NULL, "CreatedAt" TEXT NOT NULL);
            """);
        AddColumn(db, "Layouts", "KeyRevisionsJson", "TEXT NOT NULL DEFAULT '{}'");
        db.Database.ExecuteSqlRaw("""CREATE INDEX IF NOT EXISTS "IX_LayoutRevisions_ClassId_Revision" ON "LayoutRevisions" ("ClassId", "Revision");""");
        db.Database.ExecuteSqlRaw("""
            CREATE TABLE IF NOT EXISTS "Assets" (
                "ClassId" TEXT NOT NULL, "Sha256" TEXT NOT NULL, "Size" INTEGER NOT NULL, "ContentType" TEXT NOT NULL,
                "FileName" TEXT NOT NULL, "CreatedAt" TEXT NOT NULL, "CreatedBy" TEXT NOT NULL,
                CONSTRAINT "PK_Assets" PRIMARY KEY ("ClassId", "Sha256"));
            """);
        db.Database.ExecuteSqlRaw("""
            CREATE TABLE IF NOT EXISTS "Students" (
                "Id" TEXT NOT NULL CONSTRAINT "PK_Students" PRIMARY KEY,
                "ClassId" TEXT NOT NULL, "Name" TEXT NOT NULL, "Number" TEXT NOT NULL, "Group" TEXT NOT NULL,
                "Note" TEXT NOT NULL, "Active" INTEGER NOT NULL, "SortOrder" INTEGER NOT NULL, "CreatedAt" TEXT NOT NULL);
            """);
        db.Database.ExecuteSqlRaw("""CREATE INDEX IF NOT EXISTS "IX_Students_ClassId" ON "Students" ("ClassId");""");
        db.Database.ExecuteSqlRaw("""
            CREATE TABLE IF NOT EXISTS "DutyPlans" (
                "ClassId" TEXT NOT NULL CONSTRAINT "PK_DutyPlans" PRIMARY KEY,
                "PlanJson" TEXT NOT NULL, "Revision" INTEGER NOT NULL, "UpdatedAt" TEXT NOT NULL, "UpdatedBy" TEXT NOT NULL);
            """);
        db.Database.ExecuteSqlRaw("""
            CREATE TABLE IF NOT EXISTS "Announcements" (
                "Id" TEXT NOT NULL CONSTRAINT "PK_Announcements" PRIMARY KEY,
                "ClassId" TEXT NOT NULL, "Title" TEXT NOT NULL, "Body" TEXT NOT NULL, "Level" TEXT NOT NULL,
                "Pinned" INTEGER NOT NULL, "StartsAt" TEXT NULL, "ExpiresAt" TEXT NULL, "CreatedAt" TEXT NOT NULL,
                "UpdatedAt" TEXT NOT NULL, "Author" TEXT NOT NULL, "Deleted" INTEGER NOT NULL);
            """);
        db.Database.ExecuteSqlRaw("""CREATE INDEX IF NOT EXISTS "IX_Announcements_ClassId" ON "Announcements" ("ClassId");""");
    }

    private static void AddColumn(PancakeDbContext db, string table, string column, string definition)
    {
        bool exists = db.Database.SqlQuery<string>($"SELECT name AS Value FROM pragma_table_info({table})").AsEnumerable().Contains(column);
        // 表名、列名和定义都来自上面的常量，DDL 无法参数化。ExecuteSqlRaw 会把花括号当作参数占位符，
        // 默认值里的 '{}' 必须转义。
#pragma warning disable EF1002
        string sql = $"ALTER TABLE \"{table}\" ADD COLUMN \"{column}\" {definition};".Replace("{", "{{").Replace("}", "}}");
        if (!exists) db.Database.ExecuteSqlRaw(sql);
#pragma warning restore EF1002
    }
}
