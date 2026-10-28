using Microsoft.AspNetCore.Http.Features;
using Microsoft.EntityFrameworkCore;
using Pancake.Server.Data;
using Pancake.Server.Services;
using Pancake.Shared;

namespace Pancake.Server.Endpoints;

/// <summary>
/// 附件与背景文件。设备先算好 SHA-256 再上传（PUT），网页上传由服务端计算哈希（POST）。
/// 项目和布局 JSON 里只保存 asset:哈希.扩展名，文件按班级登记访问权限。
/// </summary>
public static class AssetEndpoints
{
    public static void MapAssetEndpoints(this WebApplication app)
    {
        app.MapMethods("/api/classes/{classId:guid}/assets/{sha}", ["HEAD"], async (HttpRequest http, Guid classId, string sha, PancakeDbContext db, SessionStore sessions, AssetStore store) =>
        {
            if (!AssetReference.IsSha256(sha)) return Results.BadRequest();
            if (await Access.Caller(http, classId, db, sessions) is null) return Results.StatusCode(StatusCodes.Status403Forbidden);
            sha = sha.ToLowerInvariant();
            return await db.Assets.AnyAsync(x => x.ClassId == classId && x.Sha256 == sha) && store.Exists(sha) ? Results.Ok() : Results.NotFound();
        });

        app.MapPut("/api/classes/{classId:guid}/assets/{sha}", async (HttpContext context, Guid classId, string sha, string? name, PancakeDbContext db, SessionStore sessions, AssetStore store) =>
        {
            if (!AssetReference.IsSha256(sha)) return Results.BadRequest("哈希格式无效。");
            if (await Access.Caller(context.Request, classId, db, sessions) is not { } caller) return Results.StatusCode(StatusCodes.Status403Forbidden);
            sha = sha.ToLowerInvariant();
            if (!store.Exists(sha))
            {
                if (TooLarge(context, store) is { } tooLarge) return tooLarge;
                try { await store.SaveAsync(context.Request.Body, sha, context.RequestAborted); }
                catch (InvalidDataException ex) { return Results.BadRequest(ex.Message); }
                catch (BadHttpRequestException) { return TooLargeResult(store); }
            }
            return Results.Ok(await Register(db, classId, sha, name, caller.Actor, store));
        });

        app.MapPost("/api/classes/{classId:guid}/assets", async (HttpContext context, Guid classId, string? name, PancakeDbContext db, SessionStore sessions, AssetStore store) =>
        {
            if (await Access.Caller(context.Request, classId, db, sessions) is not { } caller) return Results.StatusCode(StatusCodes.Status403Forbidden);
            if (TooLarge(context, store) is { } tooLarge) return tooLarge;
            string sha;
            try { (sha, _) = await store.SaveUnhashedAsync(context.Request.Body, context.RequestAborted); }
            catch (InvalidDataException ex) { return Results.BadRequest(ex.Message); }
            catch (BadHttpRequestException) { return TooLargeResult(store); }
            return Results.Ok(await Register(db, classId, sha, name, caller.Actor, store));
        });

        // 浏览器的 <img> 无法附带请求头，登录令牌可以放在 access_token 查询参数里。
        app.MapGet("/api/classes/{classId:guid}/assets/{sha}", async (HttpContext context, Guid classId, string sha, string? access_token, PancakeDbContext db, SessionStore sessions, AssetStore store) =>
        {
            if (!AssetReference.IsSha256(sha)) return Results.BadRequest();
            bool allowed = await Access.Caller(context.Request, classId, db, sessions) is not null
                || (access_token is not null && sessions.TryGetSession("Bearer " + access_token, out var session) && await Access.CanManageClass(session, classId, db));
            if (!allowed) return Results.StatusCode(StatusCodes.Status403Forbidden);
            return await Serve(context, db, store, classId, sha.ToLowerInvariant());
        });

        // 公开短码只能读取本班已登记的资源；哈希不可猜测，但仍按班级校验。
        app.MapGet("/api/public/classes/{publicCode}/assets/{sha}", async (HttpContext context, string publicCode, string sha, PancakeDbContext db, AssetStore store) =>
        {
            if (!AssetReference.IsSha256(sha)) return Results.BadRequest();
            var classId = await db.Classes.Where(x => x.PublicCode == publicCode.Trim().ToLower() && !x.Deleted).Select(x => (Guid?)x.Id).SingleOrDefaultAsync();
            if (classId is null) return Results.NotFound();
            return await Serve(context, db, store, classId.Value, sha.ToLowerInvariant());
        });
    }

    /// <summary>把同一份文件登记到另一个班级（复制布局时用），文件本身不复制。</summary>
    public static async Task ShareAsync(PancakeDbContext db, Guid fromClassId, Guid toClassId, IEnumerable<string> shas, string actor)
    {
        var list = shas.Distinct().ToList();
        var source = await db.Assets.Where(x => x.ClassId == fromClassId && list.Contains(x.Sha256)).ToListAsync();
        var existing = await db.Assets.Where(x => x.ClassId == toClassId && list.Contains(x.Sha256)).Select(x => x.Sha256).ToListAsync();
        foreach (var asset in source.Where(x => !existing.Contains(x.Sha256)))
            db.Assets.Add(new AssetBlob { ClassId = toClassId, Sha256 = asset.Sha256, Size = asset.Size, ContentType = asset.ContentType, FileName = asset.FileName, CreatedBy = actor });
    }

    /// <summary>放宽本次请求的正文上限到资源上限；声明的长度已经超限时直接拒绝，不读正文。</summary>
    private static IResult? TooLarge(HttpContext context, AssetStore store)
    {
        if (context.Request.ContentLength > store.MaxBytes) return TooLargeResult(store);
        if (context.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } feature) feature.MaxRequestBodySize = store.MaxBytes + 1;
        return null;
    }

    private static IResult TooLargeResult(AssetStore store) =>
        Results.Problem($"文件超过服务器限制（{store.MaxBytes / 1024 / 1024} MB）。", statusCode: StatusCodes.Status413PayloadTooLarge);

    private static async Task<object> Register(PancakeDbContext db, Guid classId, string sha, string? name, string actor, AssetStore store)
    {
        string fileName = Path.GetFileName(name ?? "").Trim();
        if (fileName.Length > 120) fileName = fileName[^120..];
        string extension = AssetReference.NormalizeExtension(Path.GetExtension(fileName));
        var asset = await db.Assets.SingleOrDefaultAsync(x => x.ClassId == classId && x.Sha256 == sha);
        if (asset is null)
        {
            asset = new AssetBlob
            {
                ClassId = classId, Sha256 = sha, Size = new FileInfo(store.PathOf(sha)).Length,
                ContentType = AssetStore.ContentTypeFor(extension), FileName = fileName, CreatedBy = actor
            };
            db.Assets.Add(asset);
            await db.SaveChangesAsync();
        }
        return new { sha256 = sha, asset.Size, asset.ContentType, reference = AssetReference.Create(sha, extension) };
    }

    private static async Task<IResult> Serve(HttpContext context, PancakeDbContext db, AssetStore store, Guid classId, string sha)
    {
        var asset = await db.Assets.AsNoTracking().SingleOrDefaultAsync(x => x.ClassId == classId && x.Sha256 == sha);
        if (asset is null || !store.Exists(sha)) return Results.NotFound();
        context.Response.Headers.CacheControl = "private, max-age=31536000, immutable";
        context.Response.Headers["Content-Security-Policy"] = "sandbox; default-src 'none'; img-src 'self'; media-src 'self'";
        bool inline = AssetStore.IsInlineSafe(asset.ContentType);
        return Results.File(store.PathOf(sha), inline ? asset.ContentType : "application/octet-stream",
            fileDownloadName: inline ? null : (string.IsNullOrEmpty(asset.FileName) ? sha : asset.FileName), enableRangeProcessing: true);
    }
}
