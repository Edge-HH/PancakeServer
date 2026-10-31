using Microsoft.EntityFrameworkCore;
using Pancake.Server.Contracts;
using Pancake.Server.Data;
using Pancake.Server.Services;
using Pancake.Shared;

namespace Pancake.Server.Endpoints;

/// <summary>班级分组（年级、校区等）：管理员维护分组并把班级归入分组；老师只看到含有自己班级的分组。</summary>
public static class ClassGroupEndpoints
{
    public static void MapClassGroupEndpoints(this WebApplication app)
    {
        app.MapGet("/api/class-groups", async (HttpRequest http, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.User(http, sessions, out var session)) return Results.Unauthorized();
            bool admin = session.Role == PancakeRole.Administrator;
            var classes = db.Classes.Where(x => !x.Deleted);
            if (!admin) classes = classes.Where(x => db.Memberships.Any(m => m.ClassId == x.Id && m.UserId == session.UserId));
            var counts = (await classes.Where(x => x.GroupId != null).Select(x => x.GroupId!.Value).ToListAsync()).GroupBy(x => x).ToDictionary(x => x.Key, x => x.Count());
            var groups = await db.ClassGroups.OrderBy(x => x.SortOrder).ThenBy(x => x.Name).ToListAsync();
            return Results.Ok(groups.Where(g => admin || counts.ContainsKey(g.Id)).Select(g => new ClassGroupItem(g.Id, g.Name, g.SortOrder, counts.GetValueOrDefault(g.Id))));
        });

        app.MapPost("/api/admin/class-groups", async (HttpRequest http, ClassGroupWriteRequest request, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.Admin(http, sessions, out var session)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            if (await ValidName(db, request.Name, null) is { } error) return Results.BadRequest(error);
            int order = (await db.ClassGroups.MaxAsync(x => (int?)x.SortOrder) ?? 0) + 1;
            var group = new ClassGroup { Name = request.Name.Trim(), SortOrder = order };
            db.ClassGroups.Add(group);
            Access.Audit(db, Access.Actor(session), "新建班级分组", group.Name);
            await db.SaveChangesAsync();
            return Results.Created($"/api/class-groups/{group.Id}", new ClassGroupItem(group.Id, group.Name, group.SortOrder, 0));
        });

        app.MapPatch("/api/admin/class-groups/{groupId:guid}", async (HttpRequest http, Guid groupId, ClassGroupWriteRequest request, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.Admin(http, sessions, out var session)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var group = await db.ClassGroups.FindAsync(groupId);
            if (group is null) return Results.NotFound();
            if (await ValidName(db, request.Name, groupId) is { } error) return Results.BadRequest(error);
            Access.Audit(db, Access.Actor(session), "重命名班级分组", $"{group.Name} → {request.Name.Trim()}");
            group.Name = request.Name.Trim();
            await db.SaveChangesAsync();
            return Results.NoContent();
        });

        // 按给定顺序排列分组；没列出的分组排在后面，保持原来的相对顺序。
        app.MapPut("/api/admin/class-groups/order", async (HttpRequest http, ClassGroupOrderRequest request, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.Admin(http, sessions, out _)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var ids = (request.Ids ?? []).Distinct().ToList();
            var groups = await db.ClassGroups.OrderBy(x => x.SortOrder).ThenBy(x => x.Name).ToListAsync();
            int order = 0;
            foreach (var group in groups.OrderBy(g => ids.IndexOf(g.Id) is var i and >= 0 ? i : ids.Count)) group.SortOrder = ++order;
            await db.SaveChangesAsync();
            return Results.NoContent();
        });

        app.MapDelete("/api/admin/class-groups/{groupId:guid}", async (HttpRequest http, Guid groupId, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.Admin(http, sessions, out var session)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var group = await db.ClassGroups.FindAsync(groupId);
            if (group is null) return Results.NotFound();
            // 分组里的班级变为未分组，班级本身不受影响。
            foreach (var classroom in await db.Classes.Where(x => x.GroupId == groupId).ToListAsync()) classroom.GroupId = null;
            db.ClassGroups.Remove(group);
            Access.Audit(db, Access.Actor(session), "删除班级分组", group.Name);
            await db.SaveChangesAsync();
            return Results.NoContent();
        });

        app.MapPut("/api/admin/classes/{classId:guid}/group", async (HttpRequest http, Guid classId, ClassGroupAssignRequest request, PancakeDbContext db, SessionStore sessions) =>
        {
            if (!Access.Admin(http, sessions, out var session)) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var classroom = await db.Classes.SingleOrDefaultAsync(x => x.Id == classId && !x.Deleted);
            if (classroom is null) return Results.NotFound();
            string target = "未分组";
            if (request.GroupId is { } groupId)
            {
                if (await db.ClassGroups.FindAsync(groupId) is not { } group) return Results.NotFound("分组不存在。");
                target = group.Name;
            }
            if (classroom.GroupId == request.GroupId) return Results.NoContent();
            classroom.GroupId = request.GroupId;
            Access.Audit(db, Access.Actor(session), "调整班级分组", $"{classroom.Name} → {target}", classId);
            await db.SaveChangesAsync();
            return Results.NoContent();
        });
    }

    private static async Task<string?> ValidName(PancakeDbContext db, string? name, Guid? self)
    {
        string value = (name ?? "").Trim();
        if (value.Length is < 1 or > 40) return "分组名称需为 1–40 个字符。";
        if (await db.ClassGroups.AnyAsync(x => x.Name == value && x.Id != self)) return "已有同名分组。";
        return null;
    }
}
