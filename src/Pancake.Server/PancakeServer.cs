using Microsoft.EntityFrameworkCore;
using Pancake.Server.Data;
using Pancake.Server.Endpoints;
using Pancake.Server.Services;
using Pancake.Shared;

namespace Pancake.Server;

/// <summary>组装服务端；Program 与集成测试共用，测试可以换成临时数据库和随机端口。</summary>
public static class PancakeServer
{
    public static WebApplication Build(string[] args, Action<WebApplicationBuilder>? configure = null)
    {
        var builder = WebApplication.CreateBuilder(args);
        configure?.Invoke(builder);
        builder.WebHost.UseUrls(builder.Configuration["Urls"] ?? "http://0.0.0.0:5080");
        builder.Services.AddDbContext<PancakeDbContext>(options => options.UseSqlite(builder.Configuration.GetConnectionString("Pancake") ?? "Data Source=pancake.db"));
        builder.Services.AddSingleton<ClassSocketHub>();
        builder.Services.AddSingleton<SessionStore>();
        string assets = builder.Configuration["Pancake:AssetsPath"] ?? "assets";
        if (!Path.IsPathRooted(assets)) assets = Path.Combine(builder.Environment.ContentRootPath, assets);
        long maxMegabytes = long.TryParse(builder.Configuration["Pancake:MaxAssetMegabytes"], out long mb) && mb > 0 ? mb : 200;
        builder.Services.AddSingleton(new AssetStore(assets, maxMegabytes * 1024 * 1024));
        var app = builder.Build();

        app.Use(async (context, next) =>
        {
            context.Response.Headers.XContentTypeOptions = "nosniff";
            context.Response.Headers["Referrer-Policy"] = "same-origin";
            context.Response.Headers.XFrameOptions = "SAMEORIGIN";
            await next();
        });
        app.UseDefaultFiles();
        // 网页控制台随服务端一起升级，浏览器每次都校验静态文件，避免旧脚本配新接口。
        app.UseStaticFiles(new StaticFileOptions { OnPrepareResponse = ctx => ctx.Context.Response.Headers.CacheControl = "no-cache" });
        // 大屏字体、图标与预览底图随程序一起复制到输出目录；文件很大且只随版本变化，允许浏览器缓存一周。
        string boardAssets = Path.Combine(AppContext.BaseDirectory, "board-assets");
        if (Directory.Exists(boardAssets))
            app.UseStaticFiles(new StaticFileOptions
            {
                FileProvider = new Microsoft.Extensions.FileProviders.PhysicalFileProvider(boardAssets), RequestPath = "/board-assets",
                OnPrepareResponse = ctx => ctx.Context.Response.Headers.CacheControl = "public, max-age=604800"
            });
        app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(30) });

        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<PancakeDbContext>();
            db.Database.EnsureCreated();
            SchemaUpgrader.Upgrade(db);
            if (!db.Users.Any())
            {
                db.Users.Add(new UserAccount { UserName = "admin", DisplayName = "系统管理员", Role = nameof(PancakeRole.Administrator), PasswordHash = SecurityService.HashPassword("admin") });
                db.SaveChanges();
            }
        }

        app.MapPublicEndpoints();
        app.MapAuthEndpoints();
        app.MapClassEndpoints();
        app.MapProjectEndpoints();
        app.MapLayoutEndpoints();
        app.MapAssetEndpoints();
        app.MapPeopleEndpoints();
        app.MapBoardEndpoints();
        app.MapAdminEndpoints();
        return app;
    }
}
