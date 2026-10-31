using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Pancake.Server;
using Pancake.Server.Contracts;
using Pancake.Server.Data;
using Pancake.Server.Endpoints;
using Pancake.Server.Services;
using Pancake.Shared;
using Pancake.Shared.RichText;

// 服务端集成测试：在临时目录启动真实服务（随机端口 + 临时 SQLite），走一遍设备、网页和公开接口。
int checks = 0;
void Check(bool value, string message) { if (!value) throw new Exception("FAIL: " + message); checks++; }

// ---------------------------------------------------------------- 富文本 RTF 编解码
{
    // 来自真实大屏保存的 RTF：字体表 \fcharset136（Big5）与 \'hh 字节、\uN 混排，含高光与多段落。
    var samples = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "rtf-samples.json")))!.AsArray();
    foreach (JsonNode? sample in samples)
    {
        string rtf = sample!["rtf"]!.GetValue<string>(), content = sample["content"]!.GetValue<string>();
        var runs = RtfCodec.Parse(rtf);
        Check(RtfCodec.PlainText(runs) == content.Replace("\r\n", "\n").Replace('\r', '\n'), $"RTF 解析出的文字与大屏保存的纯文本一致：{content}");
        Check(runs.All(r => !string.IsNullOrWhiteSpace(r.FontFamily) && r.FontSize > 0), "解析出字体与字号：" + string.Join(" | ", runs));
        var again = RtfCodec.Parse(RtfCodec.Write(runs));
        Check(again.SequenceEqual(runs), $"RTF 生成后再解析格式不变：{content}");
    }
    Check(samples.Any(s => RtfCodec.Parse(s!["rtf"]!.GetValue<string>()).Any(r => r.Highlight == "#F87171")), "解析出高光颜色");
    var styled = new List<RichRun>
    {
        new("红色加粗", Bold: true, FontSize: 24, Color: "#F87171"),
        new("、斜体下划线{括号}\\", Italic: true, Underline: true, FontFamily: "微软雅黑"),
        new("\n第二行 高光", Highlight: "#FBBF24"),
        new(" 😀 emoji")
    };
    var parsed = RtfCodec.Parse(RtfCodec.Write(styled, "HarmonyOS Sans SC", 20));
    Check(parsed.Count == 4 && parsed[0] == new RichRun("红色加粗", true, false, false, "HarmonyOS Sans SC", 24, "#F87171")
        && parsed[1] == new RichRun("、斜体下划线{括号}\\", false, true, true, "微软雅黑", 20)
        && parsed[2].Text == "\n第二行 高光" && parsed[2].Highlight == "#FBBF24" && parsed[3].Text == " 😀 emoji", "格式、转义、换行、高光与代理对往返一致");
    Check(RtfCodec.Parse(RtfCodec.Write([new RichRun("白字", Color: "#FFFFFF")])).Single().Color is null, "默认白色按默认文字色处理");

    // 网页富文本编辑：改动的条目写入 RTF，没改动的条目保留原始 RTF；磁贴位置与跟随色系
    string originalRtf = samples[1]!["rtf"]!.GetValue<string>();
    string doc = new JsonObject
    {
        ["Subjects"] = new JsonArray(
            new JsonObject { ["Name"] = "语文", ["AccentHex"] = "#123456", ["IsAccentExplicit"] = true, ["X"] = 48.0, ["Y"] = 48.0, ["Width"] = 430.0, ["Height"] = 320.0,
                ["Entries"] = new JsonArray(
                    new JsonObject { ["Content"] = "背诵", ["RtfContent"] = "", ["Attachments"] = new JsonArray(), ["FontFallbacks"] = new JsonArray() },
                    new JsonObject { ["Content"] = RtfCodec.PlainText(RtfCodec.Parse(originalRtf)), ["RtfContent"] = originalRtf, ["Attachments"] = new JsonArray(), ["FontFallbacks"] = new JsonArray { new JsonObject { ["Family"] = "X" } } }) })
    }.ToJsonString();
    var current = PayloadEditor.EntryRuns(doc);
    Check(current[0][0].Single() == new RichRun("背诵") && current[0][1].SequenceEqual(RtfCodec.Parse(originalRtf)), "详情附带每条作业的富文本片段");
    var edit = PayloadEditor.ApplyEdit(doc, [new SubjectEdit(0, "语文", null, [
        new EntryEdit(0, "", null, [new RichRun("背诵", Bold: true, Color: "#F87171"), new RichRun("全文")]),
        new EntryEdit(1, "", null, current[0][1])], new SubjectRect(96, 144, 480, 360), FollowPalette: true)], null, "微软雅黑", 24);
    var edited = JsonNode.Parse(edit.PayloadJson)!["Subjects"]![0]!;
    var newRuns = RtfCodec.Parse(edited["Entries"]![0]!["RtfContent"]!.GetValue<string>());
    Check(newRuns.Count == 2 && newRuns[0] == new RichRun("背诵", true, false, false, "微软雅黑", 24, "#F87171") && newRuns[1].FontFamily == "微软雅黑" && edited["Entries"]![0]!["Content"]!.GetValue<string>() == "背诵全文", "富文本写入 RTF，未指定的字体字号用班级默认值");
    Check(edited["Entries"]![1]!["RtfContent"]!.GetValue<string>() == originalRtf && edited["Entries"]![1]!["FontFallbacks"]!.AsArray().Count == 1, "格式没变的条目保留原始 RTF");
    Check(edited["X"]!.GetValue<double>() == 96 && edited["Width"]!.GetValue<double>() == 480 && edited["IsAccentExplicit"]!.GetValue<bool>() == false && edit.ChangedSubjects.SequenceEqual(["语文"]), "磁贴位置与跟随色系");
    bool badRect = false;
    try { PayloadEditor.ApplyEdit(doc, [new SubjectEdit(0, "语文", null, null, new SubjectRect(0, 0, 10, 10))], null); } catch (InvalidDataException) { badRect = true; }
    Check(badRect, "过小的磁贴尺寸被拒绝");
}

// ---------------------------------------------------------------- 纯逻辑
{
    var names = new Dictionary<Guid, string>();
    Guid a = Guid.NewGuid(), b = Guid.NewGuid(), c = Guid.NewGuid(), d = Guid.NewGuid();
    names[a] = "甲"; names[b] = "乙"; names[c] = "丙"; names[d] = "丁";
    var plan = new DutyPlanModel
    {
        Mode = "rotate", Unit = "day", Weekdays = [1, 2, 3, 4, 5], Anchor = new DateOnly(2026, 10, 5), // 周一
        Tasks = [new() { Id = "t1", Name = "扫地" }, new() { Id = "t2", Name = "擦黑板" }],
        Groups = [new() { Name = "第一组", Members = [a, b] }, new() { Name = "第二组", Members = [c, d] }]
    };
    var monday = DutyPlanner.Resolve(plan, new DateOnly(2026, 10, 5), names)!;
    Check(monday.Label.Contains("第一组") && monday.Tasks.Count == 2 && monday.Tasks[0].Students.Single() == "甲" && monday.Tasks[1].Students.Single() == "乙", "轮换首日应为第一组且组员按顺序分岗");
    Check(DutyPlanner.Resolve(plan, new DateOnly(2026, 10, 6), names)!.Label.Contains("第二组"), "第二个值日日轮到第二组");
    Check(DutyPlanner.Resolve(plan, new DateOnly(2026, 10, 12), names)!.Label.Contains("第二组"), "跳过周末后继续按值日日计数（第 6 个值日日）");
    Check(DutyPlanner.Resolve(plan, new DateOnly(2026, 10, 10), names) is null, "周六不是值日日");
    Check(DutyPlanner.Resolve(plan, new DateOnly(2026, 10, 2), names)!.Label.Contains("第二组"), "锚点之前的日期按负数回推");
    plan.Unit = "week";
    Check(DutyPlanner.Resolve(plan, new DateOnly(2026, 10, 9), names)!.Label.Contains("第一组") && DutyPlanner.Resolve(plan, new DateOnly(2026, 10, 13), names)!.Label.Contains("第二组"), "按周轮换");
    var fixedPlan = DutyPlanner.Normalize(new DutyPlanModel
    {
        Mode = "fixed", Weekdays = [1, 9], Tasks = [new() { Id = "x", Name = " 倒垃圾 " }],
        Fixed = new() { ["1"] = new() { ["x"] = [a, Guid.NewGuid()], ["missing"] = [b] }, ["8"] = new() }
    }, new HashSet<Guid> { a, b });
    Check(fixedPlan.Weekdays.SequenceEqual([1]) && fixedPlan.Tasks[0].Name == "倒垃圾" && fixedPlan.Fixed["1"].Keys.Single() == "x" && fixedPlan.Fixed["1"]["x"].Single() == a && !fixedPlan.Fixed.ContainsKey("8"), "规范化应丢弃越界星期、未知岗位和不存在的学生");

    var roster = PeopleEndpoints.ParseRoster("学号,姓名,小组\n01 张三 一组\n李四\n\n# 注释\n03，王五，二组");
    Check(roster.Count == 3 && roster[0] == ("01", "张三", "一组") && roster[1] == ("", "李四", "") && roster[2] == ("03", "王五", "二组"), "名单解析");

    Check(AssetReference.TryParse(AssetReference.Create(new string('a', 64), ".PNG"), out var sha, out var ext) && sha == new string('a', 64) && ext == ".png", "资源引用往返");
    Check(!AssetReference.TryParse("asset:" + new string('a', 64) + "/../x", out _, out _) && !AssetReference.TryParse("C:/x.png", out _, out _), "非法资源引用应被拒绝");

    string payload = PayloadEditor.CreatePayload(Guid.NewGuid(), "测试", null, """{"Theme":"Light","Subjects":[{"Name":"语文","X":10,"Y":20,"Width":300,"Height":200,"InkCoordinateVersion":1,"AccentHex":"#123456","Entries":[{"Content":"a"}],"InkStrokes":[{}]}]}""");
    var doc = JsonNode.Parse(payload)!;
    Check(doc["Theme"]!.GetValue<string>() == "Light" && doc["Subjects"]![0]!["X"]!.GetValue<double>() == 10 && doc["Subjects"]![0]!["Entries"]!.AsArray().Count == 0 && doc["Subjects"]![0]!["InkStrokes"]!.AsArray().Count == 0, "模板应保留位置并清空内容与笔迹");

    // 项目配色：随内容一起保存，取值受限，受科目限制的老师不能改
    var themed = PayloadEditor.ApplyEdit(payload, [new SubjectEdit(0, "语文", null, [])], null, theme: "Default", palette: "Macaron");
    var themedDoc = JsonNode.Parse(themed.PayloadJson)!;
    Check(themed.AppearanceChanged && themed.ChangedSubjects.Count == 0 && themedDoc["Theme"]!.GetValue<string>() == "Default" && themedDoc["Palette"]!.GetValue<string>() == "Macaron", "项目配色写入项目");
    Check(!PayloadEditor.ApplyEdit(themed.PayloadJson, [new SubjectEdit(0, "语文", null, [])], null, theme: "Default").AppearanceChanged, "配色没变不算改动");
    bool badTheme = false, deniedTheme = false;
    try { PayloadEditor.ApplyEdit(payload, [], null, theme: "Neon"); } catch (InvalidDataException) { badTheme = true; }
    try { PayloadEditor.ApplyEdit(payload, [new SubjectEdit(0, "语文", null, [])], ["语文"], palette: "Macaron"); } catch (EditDeniedException) { deniedTheme = true; }
    Check(badTheme && deniedTheme, "非法配色被拒绝，受科目限制的老师不能改配色");

    // 复制作业：同名科目替换内容、保留目标位置；目标没有的科目放到空位；没权限的科目跳过
    string copySource = """{"Subjects":[{"Name":"语文","X":0,"Y":0,"Width":300,"Height":200,"Entries":[{"Content":"背诵","Attachments":[{"Path":"asset:""" + new string('c', 64) + """.png"}]}],"InkStrokes":[]},{"Name":"数学","X":0,"Y":0,"Width":300,"Height":200,"Entries":[{"Content":"在这里输入作业内容"}],"InkStrokes":[]},{"Name":"英语","X":0,"Y":0,"Width":500,"Height":300,"Entries":[{"Content":"Unit 1"}],"InkStrokes":[]},{"Name":"物理","Entries":[{"Content":"预习"}]}]}""";
    string copyTarget = """{"Subjects":[{"Name":" 语文 ","AccentHex":"#ABCDEF","X":48,"Y":48,"Width":430,"Height":320,"Entries":[{"Content":"旧作业"}],"InkStrokes":[{}]}]}""";
    var copiedHomework = PayloadEditor.CopySubjects(copySource, copyTarget, null, new HashSet<string>(["语文", "英语"], StringComparer.OrdinalIgnoreCase));
    var copiedDoc = JsonNode.Parse(copiedHomework.PayloadJson)!["Subjects"]!.AsArray();
    Check(copiedHomework.Copied.SequenceEqual(["语文", "英语"]) && copiedHomework.Skipped.SequenceEqual(["物理"]), "只复制有作业且有权限的科目，占位文字不算作业");
    Check(copiedDoc.Count == 2 && copiedDoc[0]!["Entries"]![0]!["Content"]!.GetValue<string>() == "背诵" && copiedDoc[0]!["X"]!.GetValue<double>() == 48
        && copiedDoc[0]!["AccentHex"]!.GetValue<string>() == "#ABCDEF" && copiedDoc[0]!["InkStrokes"]!.AsArray().Count == 0, "同名科目替换作业与笔迹，保留位置与颜色");
    Check(copiedDoc[1]!["Name"]!.GetValue<string>() == "英语" && copiedDoc[1]!["X"]!.GetValue<double>() == 526 && copiedDoc[1]!["Width"]!.GetValue<double>() == 500, "新科目保留大小并放到空位");
    Check(copiedHomework.AssetRefs.SequenceEqual([new string('c', 64)]), "复制时列出附件资源");

    // 随项目保存的设置不作为班级设置同步
    var syncedOnly = SettingsSchema.Sanitize(JsonNode.Parse("""{"Theme":"Light","Palette":"Macaron","GridSize":40}""")!.AsObject());
    Check(!syncedOnly.ContainsKey("Theme") && !syncedOnly.ContainsKey("Palette") && syncedOnly["GridSize"]!.GetValue<double>() == 40, "班级设置校验丢弃主题与色系");
    Check(!SettingsSchema.Keys.Contains("Theme") && SettingsSchema.Find("Palette") is not null
        && SettingsSchema.ChangedKeys(JsonNode.Parse("""{"Theme":"Dark"}""")!.AsObject(), new JsonObject()).Count == 0, "主题与色系仍登记，但不参与同步与比较");
}

// ---------------------------------------------------------------- 编辑占用
{
    var clock = new ManualClock();
    var locks = new EditLockService(clock);
    Guid lockClass = Guid.NewGuid(), lockProject = Guid.NewGuid();
    var board = EditLockService.Holder.Device(new DeviceRegistration { Id = Guid.NewGuid(), DeviceName = "教室大屏" });
    var tab1 = new EditLockService.Holder(EditLockHolders.User, null, Guid.NewGuid(), "tab-1", "张老师");
    var tab2 = tab1 with { ClientId = "tab-2" };
    Check(locks.Acquire(lockClass, lockProject, board).Outcome == EditLockService.Outcome.Acquired, "大屏占用");
    var denied = locks.Acquire(lockClass, lockProject, tab1);
    Check(denied.Outcome == EditLockService.Outcome.Denied && denied.Current.Holder == EditLockHolders.Device && denied.Current.Name == "教室大屏", "大屏占用时网页被拒绝，并告知占用者");
    Check(locks.Blocking(lockClass, lockProject, byDevice: false) is not null && locks.Blocking(lockClass, lockProject, byDevice: true) is null, "大屏占用只拦网页写入");
    clock.Advance(TimeSpan.FromSeconds(30));
    Check(locks.Acquire(lockClass, lockProject, board).Outcome == EditLockService.Outcome.Renewed, "同一占用者再次申请就是续期");
    clock.Advance(TimeSpan.FromSeconds(30));
    Check(locks.Find(lockClass, lockProject) is not null, "续期后仍在有效期内");
    var forced = locks.Acquire(lockClass, lockProject, tab1, force: true);
    Check(forced.Outcome == EditLockService.Outcome.TakenOver && forced.Previous?.DeviceId == board.DeviceId && forced.Current.ClientId == "tab-1", "老师可以强制接管大屏的占用");
    Check(locks.Acquire(lockClass, lockProject, tab2, force: true).Outcome == EditLockService.Outcome.Denied, "不能强制接管另一个网页的占用");
    Check(locks.Blocking(lockClass, lockProject, byDevice: true) is not null && !locks.Release(lockClass, lockProject, tab2), "老师占用拦设备写入；只有占用者能释放");
    clock.Advance(EditLockService.Ttl + TimeSpan.FromSeconds(1));
    Check(locks.Find(lockClass, lockProject) is null && locks.List(lockClass).Count == 0, "超过有效期没有续期即失效");
    var swept = locks.Sweep();
    Check(swept.Count == 1 && swept[0].ClassId == lockClass && swept[0].Lock.ClientId == "tab-1" && locks.Sweep().Count == 0, "清理过期占用并返回以便通知");
}

// ---------------------------------------------------------------- 旧库升级
string root = Path.Combine(Path.GetTempPath(), "Pancake-server-tests-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
{
    // 新库由 EnsureCreated 建好全部列，不会走补列语句；这里删掉新列模拟已部署的旧库，再启动一次。
    string upgradeDb = $"Data Source={Path.Combine(root, "upgrade.db")};Pooling=False";
    string[] upgradeArgs = ["--Urls=http://127.0.0.1:0", $"--ConnectionStrings:Pancake={upgradeDb}", $"--Pancake:AssetsPath={Path.Combine(root, "upgrade-assets")}", "--Logging:LogLevel:Default=Warning"];
    await PancakeServer.Build(upgradeArgs).DisposeAsync();
    using (var connection = new Microsoft.Data.Sqlite.SqliteConnection(upgradeDb))
    {
        connection.Open();
        using var drop = connection.CreateCommand();
        drop.CommandText = """ALTER TABLE "Layouts" DROP COLUMN "KeyRevisionsJson"; ALTER TABLE "Devices" DROP COLUMN "FontsJson"; ALTER TABLE "Devices" DROP COLUMN "ScreenJson"; ALTER TABLE "Classes" DROP COLUMN "GroupId"; DROP TABLE "ClassGroups";""";
        drop.ExecuteNonQuery();
    }
    await PancakeServer.Build(upgradeArgs).DisposeAsync();
    using (var connection = new Microsoft.Data.Sqlite.SqliteConnection(upgradeDb))
    {
        connection.Open();
        using var query = connection.CreateCommand();
        query.CommandText = """SELECT dflt_value FROM pragma_table_info('Layouts') WHERE name = 'KeyRevisionsJson'""";
        Check(query.ExecuteScalar() as string == "'{}'", "旧库升级时补齐带花括号默认值的新列");
        query.CommandText = """SELECT (SELECT count(*) FROM pragma_table_info('Devices') WHERE name = 'ScreenJson') + (SELECT count(*) FROM pragma_table_info('Classes') WHERE name = 'GroupId') + (SELECT count(*) FROM sqlite_master WHERE name = 'ClassGroups')""";
        Check(Convert.ToInt32(query.ExecuteScalar()) == 3, "旧库升级时补齐屏幕上报、班级分组的列和表");
    }
}

// ---------------------------------------------------------------- 集成
var app = PancakeServer.Build([
    "--Urls=http://127.0.0.1:0",
    $"--ConnectionStrings:Pancake=Data Source={Path.Combine(root, "test.db")};Pooling=False",
    $"--Pancake:AssetsPath={Path.Combine(root, "assets")}",
    "--Pancake:MaxAssetMegabytes=1",
    "--Logging:LogLevel:Default=Warning"
]);
await app.StartAsync();
try
{
    string baseUrl = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
    var web = new JsonSerializerOptions(JsonSerializerDefaults.Web);
    HttpClient Client(string? token = null)
    {
        var c = new HttpClient { BaseAddress = new Uri(baseUrl) };
        if (token is not null) c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return c;
    }
    async Task<JsonNode> Json(HttpResponseMessage r, HttpStatusCode expected = HttpStatusCode.OK)
    {
        string body = await r.Content.ReadAsStringAsync();
        Check(r.StatusCode == expected, $"{r.RequestMessage?.Method} {r.RequestMessage?.RequestUri?.AbsolutePath} 期望 {(int)expected}，实际 {(int)r.StatusCode}：{body}");
        return body.Length == 0 ? new JsonObject() : JsonNode.Parse(body)!;
    }

    var anon = Client();
    string adminToken = (await Json(await anon.PostAsJsonAsync("/api/auth/login", new LoginRequest("admin", "admin"))))["accessToken"]!.GetValue<string>();
    var admin = Client(adminToken);

    // 班级与设备配对
    var created = await Json(await admin.PostAsJsonAsync("/api/admin/classes", new CreateClassRequest("高一（3）班")), HttpStatusCode.Created);
    Guid classId = created["id"]!.GetValue<Guid>();
    string publicCode = created["publicCode"]!.GetValue<string>();
    var paired = (await Json(await anon.PostAsJsonAsync("/api/devices/pair", new DevicePairRequest(created["pairingCode"]!.GetValue<string>(), "教室大屏")))).Deserialize<DevicePairResponse>(web)!;
    Check(paired.DeviceId != Guid.Empty && paired.ClassName == "高一（3）班", "配对应返回设备 ID 与班级名称");
    var device = Client(paired.DeviceToken);
    Guid class2 = (await Json(await admin.PostAsJsonAsync("/api/admin/classes", new CreateClassRequest("高一（4）班")), HttpStatusCode.Created))["id"]!.GetValue<Guid>();

    // 项目：新建、无变化不加修订、冲突、删除保留内容
    Guid projectId = Guid.NewGuid();
    string projectJson = JsonSerializer.Serialize(new
    {
        Version = 1, Id = projectId, Name = "10月8日", Theme = "Dark", Palette = "Vivid",
        Subjects = new object[]
        {
            new { Name = "语文", AccentHex = "#123456", IsAccentExplicit = true, InkCoordinateVersion = 1, X = 48, Y = 48, Width = 430, Height = 320,
                Entries = new[] { new { Content = "背诵第一课", RtfContent = "{\\rtf1 x}", HasHandwriting = true, Attachments = Array.Empty<object>(), FontFallbacks = Array.Empty<object>() } },
                InkStrokes = new[] { new { Color = "#FFFFFFFF", Thickness = 2, TipScaleX = 1, TipScaleY = 1, Points = new[] { new { X = 1, Y = 2 } } } } },
            new { Name = "数学", AccentHex = "#654321", IsAccentExplicit = true, InkCoordinateVersion = 1, X = 526, Y = 48, Width = 430, Height = 320,
                Entries = Array.Empty<object>(), InkStrokes = Array.Empty<object>() }
        },
        ClockInkStrokes = Array.Empty<object>()
    });
    DateOnly today = DateOnly.FromDateTime(DateTime.Now);
    var put = await Json(await device.PutAsJsonAsync($"/api/classes/{classId}/projects/{projectId}", new ProjectWriteRequest(0, "10月8日", today, false, projectJson)));
    Check(put["revision"]!.GetValue<long>() == 1, "首次上传修订号为 1");
    put = await Json(await device.PutAsJsonAsync($"/api/classes/{classId}/projects/{projectId}", new ProjectWriteRequest(1, "10月8日", today, false, projectJson)));
    Check(put["revision"]!.GetValue<long>() == 1, "内容未变时不生成新修订");
    var conflict = await Json(await device.PutAsJsonAsync($"/api/classes/{classId}/projects/{projectId}", new ProjectWriteRequest(0, "x", today, false, projectJson)), HttpStatusCode.Conflict);
    Check(conflict["serverVersion"]!["revision"]!.GetValue<long>() == 1, "冲突响应应带服务器版本");
    await Json(await device.PutAsJsonAsync($"/api/classes/{classId}/projects/{Guid.NewGuid()}", new ProjectWriteRequest(0, "坏", null, false, "not json")), HttpStatusCode.BadRequest);

    // 网页新建项目沿用科目布局
    var fromWeb = await Json(await admin.PostAsJsonAsync($"/api/classes/{classId}/projects", new { name = "网页项目", date = today.AddDays(1) }), HttpStatusCode.Created);
    var webDoc = JsonNode.Parse(fromWeb["payloadJson"]!.GetValue<string>())!;
    Check(webDoc["Subjects"]!.AsArray().Count == 2 && webDoc["Subjects"]![1]!["X"]!.GetValue<double>() == 526 && webDoc["Subjects"]![0]!["Entries"]!.AsArray().Count == 0, "网页新建项目应沿用最近项目的科目与位置");

    // 人员分配：只负责数学的老师
    var teacher = await Json(await admin.PostAsJsonAsync("/api/admin/users", new { userName = "math", password = "math-pass-1", displayName = "数学老师", role = "Teacher" }), HttpStatusCode.Created);
    Guid teacherId = teacher["id"]!.GetValue<Guid>();
    await Json(await admin.PutAsJsonAsync($"/api/admin/users/{teacherId}/classes", new { classIds = new[] { classId } }), HttpStatusCode.NoContent);
    var staff = await Json(await admin.PutAsJsonAsync($"/api/classes/{classId}/staff/{teacherId}", new StaffUpdateRequest(StaffDuties.SubjectTeacher, ["数学"])));
    Check(staff.AsArray().Single()!["subjects"]!.AsArray().Single()!.GetValue<string>() == "数学", "老师科目已保存");
    var mathToken = (await Json(await anon.PostAsJsonAsync("/api/auth/login", new LoginRequest("math", "math-pass-1"))))["accessToken"]!.GetValue<string>();
    var math = Client(mathToken);
    await Json(await math.PutAsJsonAsync($"/api/classes/{classId}/staff/{teacherId}", new StaffUpdateRequest(StaffDuties.HeadTeacher, [])), HttpStatusCode.Forbidden);
    var assignments = await Json(await math.GetAsync("/api/me/assignments"));
    Check(assignments.AsArray().Single()!["subjects"]![0]!.GetValue<string>() == "数学", "我的分工");

    // 网页编辑作业：改数学成功，改语文被拒；未改的语文保留富文本与笔迹
    object Edit(long rev, string chinese, string mathText) => new
    {
        expectedRevision = rev,
        subjects = new object[]
        {
            new { index = 0, name = "语文", entries = new object[] { new { index = 0, content = chinese } } },
            new { index = 1, name = "数学", entries = new object[] { new { content = mathText } } }
        }
    };
    var edited = await Json(await math.PutAsJsonAsync($"/api/classes/{classId}/projects/{projectId}/content", Edit(1, "背诵第一课", "练习册 P12")));
    var editedDoc = JsonNode.Parse(edited["payloadJson"]!.GetValue<string>())!;
    Check(edited["revision"]!.GetValue<long>() == 2 && editedDoc["Subjects"]![1]!["Entries"]![0]!["Content"]!.GetValue<string>() == "练习册 P12", "数学老师可以编辑数学");
    Check(editedDoc["Subjects"]![0]!["Entries"]![0]!["RtfContent"]!.GetValue<string>() == "{\\rtf1 x}" && editedDoc["Subjects"]![0]!["InkStrokes"]!.AsArray().Count == 1, "未改动的科目应原样保留富文本与笔迹");
    var denied = await math.PutAsJsonAsync($"/api/classes/{classId}/projects/{projectId}/content", Edit(2, "改语文", "练习册 P12"));
    Check(denied.StatusCode == HttpStatusCode.Forbidden && (await denied.Content.ReadAsStringAsync()).Contains("语文"), "数学老师不能改语文");
    await Json(await math.PutAsJsonAsync($"/api/classes/{classId}/projects/{projectId}/content", Edit(1, "x", "y")), HttpStatusCode.Conflict);
    var byAdmin = await Json(await admin.PutAsJsonAsync($"/api/classes/{classId}/projects/{projectId}/content", Edit(2, "背诵第二课", "练习册 P12")));
    var adminDoc = JsonNode.Parse(byAdmin["payloadJson"]!.GetValue<string>())!;
    Check(adminDoc["Subjects"]![0]!["Entries"]![0]!["RtfContent"]!.GetValue<string>() == "" && adminDoc["Subjects"]![0]!["Entries"]![0]!["HasHandwriting"]!.GetValue<bool>(), "文字改动后清空富文本、保留其余字段");

    // 资源：设备按哈希上传，网页由服务端算哈希，公开页可读
    byte[] image = Encoding.UTF8.GetBytes("fake-png-bytes");
    string imageSha = Convert.ToHexString(SHA256.HashData(image)).ToLowerInvariant();
    var wrongSha = await device.PutAsync($"/api/classes/{classId}/assets/{new string('0', 64)}?name=a.png", new ByteArrayContent(image));
    Check(wrongSha.StatusCode == HttpStatusCode.BadRequest, "哈希不符应拒绝");
    var uploaded = await Json(await device.PutAsync($"/api/classes/{classId}/assets/{imageSha}?name=a.png", new ByteArrayContent(image)));
    Check(uploaded["reference"]!.GetValue<string>() == $"asset:{imageSha}.png", "资源引用格式");
    Check((await device.SendAsync(new HttpRequestMessage(HttpMethod.Head, $"/api/classes/{classId}/assets/{imageSha}"))).StatusCode == HttpStatusCode.OK, "HEAD 已存在资源");
    Check((await anon.SendAsync(new HttpRequestMessage(HttpMethod.Head, $"/api/classes/{classId}/assets/{imageSha}"))).StatusCode == HttpStatusCode.Forbidden, "未登录不能访问班级资源");
    var tooBig = await device.PutAsync($"/api/classes/{classId}/assets/{Convert.ToHexString(SHA256.HashData(new byte[1_200_000])).ToLowerInvariant()}", new ByteArrayContent(new byte[1_200_000]));
    Check(tooBig.StatusCode == HttpStatusCode.RequestEntityTooLarge, "超过大小上限应拒绝");
    var webUpload = await Json(await admin.PostAsync($"/api/classes/{classId}/assets?name=photo.jpg", new ByteArrayContent(Encoding.UTF8.GetBytes("jpeg!"))));
    string webRef = webUpload["reference"]!.GetValue<string>();
    var withImage = await Json(await admin.PutAsJsonAsync($"/api/classes/{classId}/projects/{projectId}/content", new
    {
        expectedRevision = 3,
        subjects = new object[]
        {
            new { index = 0, name = "语文", entries = new object[] { new { index = 0, content = "背诵第二课" } } },
            new { index = 1, name = "数学", entries = new object[] { new { index = 0, content = "练习册 P12", attachments = new object[] { new { asset = webRef, name = "photo.jpg" } } } } },
            new { name = "英语", accentHex = "#22c55e", entries = new object[] { new { content = "Unit 3" } } }
        }
    }));
    var imageDoc = JsonNode.Parse(withImage["payloadJson"]!.GetValue<string>())!;
    Check(imageDoc["Subjects"]![1]!["Entries"]![0]!["Attachments"]![0]!["Path"]!.GetValue<string>() == webRef, "网页添加图片附件");
    Check(imageDoc["Subjects"]![2]!["X"]!.GetValue<double>() == 1004 && imageDoc["Subjects"]![2]!["Y"]!.GetValue<double>() == 48 && imageDoc["Subjects"]![2]!["AccentHex"]!.GetValue<string>() == "#22C55E", "新科目放到空位并使用指定颜色");
    var bogus = await admin.PutAsJsonAsync($"/api/classes/{classId}/projects/{projectId}/content", new
    {
        expectedRevision = 4,
        subjects = new object[] { new { index = 0, name = "语文", entries = new object[] { new { content = "x", attachments = new object[] { new { asset = "asset:" + new string('b', 64) + ".png" } } } } } }
    });
    Check(bogus.StatusCode == HttpStatusCode.BadRequest, "引用未上传的资源应被拒绝");
    var publicImage = await anon.GetAsync($"/api/public/classes/{publicCode}/assets/{webRef[6..70]}");
    Check(publicImage.StatusCode == HttpStatusCode.OK && publicImage.Content.Headers.ContentType?.MediaType == "image/jpeg", "公开页可以读取本班图片");
    Check((await anon.GetAsync($"/api/classes/{classId}/assets/{imageSha}?access_token={Uri.EscapeDataString(adminToken)}")).StatusCode == HttpStatusCode.OK, "img 标签可用 access_token 读取资源");

    // 设备删除：空内容保留最后一份 JSON，恢复后内容仍在
    await Json(await device.PutAsJsonAsync($"/api/classes/{classId}/projects/{projectId}", new ProjectWriteRequest(4, "10月8日", today, true, "")));
    var restored = await Json(await admin.PostAsJsonAsync($"/api/classes/{classId}/projects/{projectId}/restore", new { }));
    Check(!restored["deleted"]!.GetValue<bool>() && restored["payloadJson"]!.GetValue<string>().Contains("Unit 3"), "删除后恢复应保留内容");

    // 布局：设备上传、策略锁定、网页下发、复制到其他班级
    var layout0 = (await Json(await device.GetAsync($"/api/classes/{classId}/layout"))).Deserialize<LayoutSnapshot>(web)!;
    Check(layout0.Revision == 0 && layout0.Policy == LayoutPolicies.Shared, "初始布局为空且双向同步");
    string layoutJson = "{\"LayoutMode\":\"Split\",\"SplitRatio\":0.35,\"BoardBackground\":{\"ImagePath\":\"asset:" + imageSha + ".png\"}}";
    var layout1 = (await Json(await device.PutAsJsonAsync($"/api/classes/{classId}/layout", new LayoutWriteRequest(0, layoutJson)))).Deserialize<LayoutSnapshot>(web)!;
    Check(layout1.Revision == 1, "设备上传布局");
    Check((await Json(await device.PutAsJsonAsync($"/api/classes/{classId}/layout", new LayoutWriteRequest(1, layoutJson))))["revision"]!.GetValue<long>() == 1, "布局未变不加修订");
    await Json(await device.PutAsJsonAsync($"/api/classes/{classId}/layout", new LayoutWriteRequest(0, layoutJson)), HttpStatusCode.Conflict);
    await Json(await admin.PutAsJsonAsync($"/api/classes/{classId}/layout/policy", new LayoutPolicyRequest(LayoutPolicies.Managed)), HttpStatusCode.NoContent);
    await Json(await device.PutAsJsonAsync($"/api/classes/{classId}/layout", new LayoutWriteRequest(1, """{"LayoutMode":"Board"}""")), HttpStatusCode.Locked);
    await Json(await admin.PutAsJsonAsync($"/api/classes/{classId}/layout", new LayoutWriteRequest(1, layoutJson.Replace("0.35", "0.5"))));
    await Json(await admin.PostAsJsonAsync($"/api/classes/{classId}/layout/copy", new CopyLayoutRequest([class2])));
    var copied = (await Json(await admin.GetAsync($"/api/classes/{class2}/layout"))).Deserialize<LayoutSnapshot>(web)!;
    Check(copied.Revision == 1 && copied.PayloadJson.Contains("0.5"), "布局复制到其他班级");
    Check((await admin.SendAsync(new HttpRequestMessage(HttpMethod.Get, $"/api/classes/{class2}/assets/{imageSha}"))).StatusCode == HttpStatusCode.OK, "复制布局时背景资源一并登记");
    var layoutHistory = await Json(await admin.GetAsync($"/api/classes/{classId}/layout/history"));
    Check(layoutHistory.AsArray().Count == 2, "布局历史");
    await Json(await admin.PostAsJsonAsync($"/api/classes/{classId}/layout/restore", new LayoutRestoreRequest(1)));
    Check((await Json(await device.GetAsync($"/api/classes/{classId}/layout")))["payloadJson"]!.GetValue<string>().Contains("0.35"), "布局回滚");

    // 学生、值日、公告与大屏汇总
    var imported = await Json(await admin.PostAsJsonAsync($"/api/classes/{classId}/students/import", new StudentImportRequest("01 张三 一组\n02 李四 一组\n03 王五 二组\n04 赵六 二组")));
    Check(imported["added"]!.GetValue<int>() == 4, "导入学生");
    var reimported = await Json(await admin.PostAsJsonAsync($"/api/classes/{classId}/students/import", new StudentImportRequest("01 张三 三组")));
    Check(reimported["added"]!.GetValue<int>() == 0 && reimported["updated"]!.GetValue<int>() == 1, "重复导入按学号更新");
    var students = (await Json(await admin.GetAsync($"/api/classes/{classId}/students"))).AsArray().Select(x => x!["id"]!.GetValue<Guid>()).ToList();
    await Json(await math.PostAsJsonAsync($"/api/classes/{classId}/students", new StudentWriteRequest("越权", null, null, null, null)));  // 本班还没有班主任，科任老师可维护名单
    await Json(await admin.PutAsJsonAsync($"/api/classes/{classId}/staff/{teacherId}", new StaffUpdateRequest(StaffDuties.SubjectTeacher, ["数学"])));
    var allDays = new List<int> { 1, 2, 3, 4, 5, 6, 7 };
    var dutyPlan = new DutyPlanModel
    {
        Mode = "rotate", Unit = "day", Weekdays = allDays, Anchor = today,
        Tasks = [new() { Name = "扫地" }], Groups = [new() { Name = "第一组", Members = students.Take(2).ToList() }, new() { Name = "第二组", Members = students.Skip(2).Take(2).ToList() }]
    };
    await Json(await admin.PutAsJsonAsync($"/api/classes/{classId}/duty", new DutyPlanWriteRequest(0, dutyPlan)));
    await Json(await admin.PutAsJsonAsync($"/api/classes/{classId}/duty", new DutyPlanWriteRequest(0, dutyPlan)), HttpStatusCode.Conflict);
    var dutyView = await Json(await admin.GetAsync($"/api/classes/{classId}/duty"));
    Check(dutyView["week"]!.AsArray().Count == 7 && dutyView["plan"]!["tasks"]![0]!["id"]!.GetValue<string>().Length > 0, "值日周视图");
    await Json(await admin.PostAsJsonAsync($"/api/classes/{classId}/announcements", new AnnouncementWriteRequest("明天体检", "请穿校服", "important", true, null, null)));
    await Json(await admin.PostAsJsonAsync($"/api/classes/{classId}/announcements", new AnnouncementWriteRequest("已过期", null, "info", false, DateTime.UtcNow.AddDays(-2), DateTime.UtcNow.AddDays(-1))));
    await Json(await admin.PostAsJsonAsync("/api/announcements/broadcast", new BroadcastRequest([classId, class2], "年级大会", null, "urgent", false, null, null)));
    var board = (await Json(await device.GetAsync($"/api/classes/{classId}/board"))).Deserialize<BoardInfo>(web)!;
    Check(board.DeviceId == paired.DeviceId && board.Announcements.Count == 2 && board.Announcements[0].Title == "年级大会", "大屏汇总只含生效公告，紧急在前");
    Check(board.Duty is { } duty && duty.Label.Contains("第一组") && duty.Tasks[0].Students.Contains("张三"), "大屏汇总含今日值日");
    Check(board.LayoutPolicy == LayoutPolicies.Managed && board.LayoutRevision == 3, "大屏汇总含布局策略与修订号");
    var publicBoard = await Json(await anon.GetAsync($"/api/public/classes/{publicCode}/board"));
    Check(publicBoard["announcements"]!.AsArray().Count == 2 && publicBoard["duty"] is not null && publicBoard["deviceId"] is null, "公开页班务信息");

    // 设备状态、实时连接与远程指令
    await Json(await device.PostAsJsonAsync($"/api/classes/{classId}/devices/me/status", new DeviceStatusRequest("3.0.0", 2, "上传失败", projectId, "10月8日")));
    var offline = await Json(await admin.PostAsJsonAsync($"/api/classes/{classId}/devices/{paired.DeviceId}/command", new DeviceCommandRequest("sync", null)));
    Check(!offline["delivered"]!.GetValue<bool>(), "设备离线时指令未送达");
    using (var socket = new ClientWebSocket())
    {
        socket.Options.SetRequestHeader("Authorization", "Bearer " + paired.DeviceToken);
        await socket.ConnectAsync(new Uri(baseUrl.Replace("http", "ws") + $"/ws/classes/{classId}"), CancellationToken.None);
        var devices = await Json(await admin.GetAsync($"/api/classes/{classId}/devices"));
        var row = devices.AsArray().Single()!;
        Check(row["online"]!.GetValue<bool>() && row["appVersion"]!.GetValue<string>() == "3.0.0" && row["pendingChanges"]!.GetValue<int>() == 2, "设备列表显示在线与上报状态");
        var overview = await Json(await admin.GetAsync("/api/overview"));
        Check(overview["deviceIssues"]!.AsArray().Count == 1 && overview["today"]!.AsArray().Any(x => x!["projectId"] is not null && x["filled"]!.GetValue<int>() == 3), "概览含设备异常与今日作业");
        var sent = await Json(await admin.PostAsJsonAsync($"/api/classes/{classId}/devices/{paired.DeviceId}/command", new DeviceCommandRequest("message", "请检查投影")));
        Check(sent["delivered"]!.GetValue<bool>(), "在线设备收到指令");
        byte[] buffer = new byte[4096];
        string message = "";
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!message.Contains("\"command\""))
        {
            var result = await socket.ReceiveAsync(buffer, timeout.Token);
            message = Encoding.UTF8.GetString(buffer, 0, result.Count);
        }
        var ev = JsonSerializer.Deserialize<SyncEvent>(message, web)!;
        Check(ev.Type == SyncEventTypes.Command && ev.Command == "message" && ev.Text == "请检查投影" && ev.DeviceId == paired.DeviceId, "指令内容");
        var displayed = await Json(await admin.PostAsync($"/api/classes/{classId}/projects/{projectId}/display", null));
        Check(displayed["delivered"]!.GetValue<bool>(), "在线大屏收到项目切换通知");
        message = "";
        while (!message.Contains("open-project"))
        {
            var result = await socket.ReceiveAsync(buffer, timeout.Token);
            message = Encoding.UTF8.GetString(buffer, 0, result.Count);
        }
        ev = JsonSerializer.Deserialize<SyncEvent>(message, web)!;
        Check(ev.Type == SyncEventTypes.Command && ev.Command == "open-project" && ev.ProjectId == projectId && ev.DeviceId is null, "项目切换指令包含目标项目并只广播给大屏");
        await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None);
    }

    // 编辑占用、屏幕上报与实时通知：editing / screen 只发给老师网页，大屏和公开页收不到
    async Task<ClientWebSocket> Connect(string path, string? deviceToken = null)
    {
        var socket = new ClientWebSocket();
        if (deviceToken is not null) socket.Options.SetRequestHeader("Authorization", "Bearer " + deviceToken);
        await socket.ConnectAsync(new Uri(baseUrl.Replace("http", "ws") + path), CancellationToken.None);
        return socket;
    }
    async Task<SyncEvent> Next(ClientWebSocket socket, Func<SyncEvent, bool> match, List<SyncEvent>? seen = null)
    {
        byte[] chunk = new byte[16384];
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (true)
        {
            using var message = new MemoryStream();
            WebSocketReceiveResult result;
            do { result = await socket.ReceiveAsync(chunk, timeout.Token); message.Write(chunk, 0, result.Count); } while (!result.EndOfMessage);
            var ev = JsonSerializer.Deserialize<SyncEvent>(message.ToArray(), web)!;
            seen?.Add(ev);
            if (match(ev)) return ev;
        }
    }
    using (var boardSocket = await Connect($"/ws/classes/{classId}", paired.DeviceToken))
    using (var webSocket = await Connect($"/ws/classes/{classId}?access_token={Uri.EscapeDataString(adminToken)}"))
    using (var publicSocket = await Connect($"/ws/public/{publicCode}"))
    {
        Check((await Json(await admin.GetAsync($"/api/classes/{classId}")))["online"]!.GetValue<int>() == 1, "在线数只算大屏，不算老师网页和公开页");
        string lockUrl = $"/api/classes/{classId}/projects/{projectId}/edit-lock";
        var boardLock = await Json(await device.PutAsJsonAsync(lockUrl, new EditLockRequest()));
        Check(boardLock["holder"]!.GetValue<string>() == EditLockHolders.Device && boardLock["name"]!.GetValue<string>() == "教室大屏", "大屏进入编辑时占用项目");
        var editing = await Next(webSocket, e => e.Type == SyncEventTypes.Editing);
        Check(editing.ProjectId == projectId && editing.Lock?.DeviceId == paired.DeviceId, "网页收到大屏占用通知");
        var held = await Json(await admin.PutAsJsonAsync(lockUrl, new EditLockRequest("tab-1")), HttpStatusCode.Locked);
        Check(held["holder"]!.GetValue<string>() == EditLockHolders.Device, "大屏编辑时网页不能占用");
        long revisionNow = (await Json(await admin.GetAsync($"/api/classes/{classId}/projects/{projectId}")))["revision"]!.GetValue<long>();
        var blockedSave = await Json(await admin.PutAsJsonAsync($"/api/classes/{classId}/projects/{projectId}/content", new { expectedRevision = revisionNow, subjects = Array.Empty<object>() }), HttpStatusCode.Locked);
        Check(blockedSave["error"]!.GetValue<string>().StartsWith("本地修改中") && blockedSave["lock"]!["deviceId"]!.GetValue<Guid>() == paired.DeviceId, "大屏编辑时网页保存返回 423 和占用信息");
        var ended = await Json(await admin.PostAsync($"{lockUrl}/end", null));
        Check(ended["delivered"]!.GetValue<bool>(), "结束编辑的请求送达大屏");
        var endEdit = await Next(boardSocket, e => e.Type == SyncEventTypes.Command);
        Check(endEdit.Command == DeviceCommands.EndEdit && endEdit.ProjectId == projectId && endEdit.DeviceId == paired.DeviceId && endEdit.Text == "系统管理员", "大屏收到结束编辑指令和请求人");
        await Json(await device.DeleteAsync(lockUrl), HttpStatusCode.NoContent);
        Check((await Next(webSocket, e => e.Type == SyncEventTypes.Editing)).Lock is null, "大屏释放后网页收到通知");

        var webLock = await Json(await admin.PutAsJsonAsync(lockUrl, new EditLockRequest("tab-1")));
        Check(webLock["holder"]!.GetValue<string>() == EditLockHolders.User && webLock["clientId"]!.GetValue<string>() == "tab-1", "网页开始修改时占用");
        await Json(await admin.PutAsJsonAsync(lockUrl, new EditLockRequest("tab-2")), HttpStatusCode.Locked);
        var blockedUpload = await Json(await device.PutAsJsonAsync($"/api/classes/{classId}/projects/{projectId}", new ProjectWriteRequest(revisionNow, "10月8日", today, false, projectJson)), HttpStatusCode.Locked);
        Check(blockedUpload["error"]!.GetValue<string>().StartsWith("云端修改中"), "网页编辑时大屏上传返回 423");
        Check((await Json(await device.PutAsJsonAsync(lockUrl, new EditLockRequest()), HttpStatusCode.Locked))["name"]!.GetValue<string>() == "系统管理员", "网页编辑时大屏不能进入编辑并得知是谁");
        Check((await Json(await device.GetAsync($"/api/classes/{classId}/edit-locks"))).AsArray().Single()!["holder"]!.GetValue<string>() == EditLockHolders.User, "列出班级的编辑占用");
        await Json(await admin.DeleteAsync($"{lockUrl}?clientId=tab-1"), HttpStatusCode.NoContent);
        Check((await Json(await device.GetAsync($"/api/classes/{classId}/edit-locks"))).AsArray().Count == 0, "网页释放占用");

        await Json(await device.PutAsJsonAsync(lockUrl, new EditLockRequest()));
        var takeover = await Json(await admin.PutAsJsonAsync(lockUrl, new EditLockRequest("tab-1", Force: true)));
        Check(takeover["holder"]!.GetValue<string>() == EditLockHolders.User, "大屏没有响应时网页可以强制接管");
        Check((await Next(boardSocket, e => e.Type == SyncEventTypes.Command)).Command == DeviceCommands.EndEdit, "被接管的大屏收到结束编辑指令");
        await Json(await admin.DeleteAsync($"{lockUrl}?clientId=tab-1"), HttpStatusCode.NoContent);

        var screen = new DeviceScreenReport(1920, 1080, 1.5, "Split", 0.4, false, new ScreenRegion(0, 0, 768, 1080), new ScreenRegion(768, 0, 1152, 1080), projectId);
        await Json(await device.PutAsJsonAsync($"/api/classes/{classId}/devices/me/screen", screen), HttpStatusCode.NoContent);
        var screenEvent = await Next(webSocket, e => e.Type == SyncEventTypes.Screen);
        Check(screenEvent.DeviceId == paired.DeviceId && screenEvent.Screen?.Board?.Width == 1152 && screenEvent.Screen.Scale == 1.5, "网页实时收到大屏的屏幕与分区");
        var withScreen = (await Json(await admin.GetAsync($"/api/classes/{classId}/devices"))).AsArray().Single()!;
        Check(withScreen["screen"]!["clock"]!["width"]!.GetValue<double>() == 768 && withScreen["activeProjectId"]!.GetValue<Guid>() == projectId && withScreen["screenAt"] is not null, "设备列表带最近的屏幕与当前项目");
        await Json(await device.PutAsJsonAsync($"/api/classes/{classId}/devices/me/screen", screen with { Width = -1 }), HttpStatusCode.BadRequest);
        await Json(await device.PutAsJsonAsync($"/api/classes/{classId}/devices/me/screen", screen with { LayoutMode = "Grid" }), HttpStatusCode.BadRequest);

        // 用一条项目通知收尾：大屏和公开页在它之前不应收到 editing 或 screen
        await Json(await admin.PatchAsJsonAsync($"/api/classes/{classId}/projects/{projectId}", new ProjectPatchRequest("10月8日", today)));
        List<SyncEvent> boardSeen = [], publicSeen = [];
        await Next(boardSocket, e => e.Type == SyncEventTypes.Updated, boardSeen);
        await Next(publicSocket, e => e.Type == SyncEventTypes.Updated, publicSeen);
        Check(boardSeen.Concat(publicSeen).All(e => e.Type is not (SyncEventTypes.Editing or SyncEventTypes.Screen)), "大屏和公开页收不到编辑占用与屏幕通知");
    }

    // 项目配色：随项目保存；受科目限制的老师不能改；不再作为班级设置同步
    long schemeRevision = (await Json(await admin.GetAsync($"/api/classes/{classId}/projects/{projectId}")))["revision"]!.GetValue<long>();
    var schemeSubjects = JsonNode.Parse((await Json(await admin.GetAsync($"/api/classes/{classId}/projects/{projectId}")))["payloadJson"]!.GetValue<string>())!["Subjects"]!.AsArray()
        .Select((s, i) => new { index = i, name = s!["Name"]!.GetValue<string>(), entries = s["Entries"]!.AsArray().Select((_, j) => new { index = j, content = s["Entries"]![j]!["Content"]!.GetValue<string>() }).ToArray() }).ToArray();
    var schemed = await Json(await admin.PutAsJsonAsync($"/api/classes/{classId}/projects/{projectId}/content", new { expectedRevision = schemeRevision, subjects = schemeSubjects, theme = "Light", palette = "Macaron" }));
    var schemedDoc = JsonNode.Parse(schemed["payloadJson"]!.GetValue<string>())!;
    Check(schemed["revision"]!.GetValue<long>() == schemeRevision + 1 && schemedDoc["Theme"]!.GetValue<string>() == "Light" && schemedDoc["Palette"]!.GetValue<string>() == "Macaron", "网页修改项目配色");
    await Json(await admin.PutAsJsonAsync($"/api/classes/{classId}/projects/{projectId}/content", new { expectedRevision = schemeRevision + 1, subjects = schemeSubjects, theme = "Neon" }), HttpStatusCode.BadRequest);
    await Json(await math.PutAsJsonAsync($"/api/classes/{classId}/projects/{projectId}/content", new { expectedRevision = schemeRevision + 1, subjects = schemeSubjects, palette = "Vivid" }), HttpStatusCode.Forbidden);
    // 设置键区分大小写，用字典避免被序列化成驼峰。
    await Json(await admin.PatchAsJsonAsync($"/api/classes/{classId}/layout", new { baseRevision = 0, set = new Dictionary<string, object> { ["Theme"] = "Light" } }), HttpStatusCode.BadRequest);
    var themedLayout = await Json(await admin.PatchAsJsonAsync($"/api/classes/{classId}/layout", new { baseRevision = 99, set = new Dictionary<string, object> { ["Palette"] = "Macaron", ["GridSize"] = 40 } }));
    Check(themedLayout["payloadJson"]!.GetValue<string>().Contains("\"GridSize\":40") && !themedLayout["payloadJson"]!.GetValue<string>().Contains("Macaron"), "班级设置里的色系被忽略，其余照常写入");

    // 班级分组与按组批量布置
    var group = await Json(await admin.PostAsJsonAsync("/api/admin/class-groups", new ClassGroupWriteRequest("高一年级")), HttpStatusCode.Created);
    Guid groupId = group["id"]!.GetValue<Guid>();
    await Json(await admin.PostAsJsonAsync("/api/admin/class-groups", new ClassGroupWriteRequest(" 高一年级 ")), HttpStatusCode.BadRequest);
    await Json(await math.PostAsJsonAsync("/api/admin/class-groups", new ClassGroupWriteRequest("越权")), HttpStatusCode.Forbidden);
    await Json(await admin.PutAsJsonAsync($"/api/admin/classes/{classId}/group", new ClassGroupAssignRequest(groupId)), HttpStatusCode.NoContent);
    await Json(await admin.PutAsJsonAsync($"/api/admin/classes/{class2}/group", new ClassGroupAssignRequest(groupId)), HttpStatusCode.NoContent);
    await Json(await admin.PutAsJsonAsync($"/api/admin/classes/{class2}/group", new ClassGroupAssignRequest(Guid.NewGuid())), HttpStatusCode.NotFound);
    var grouped = (await Json(await admin.GetAsync("/api/classes"))).AsArray();
    Check(grouped.All(c => c!["groupName"]!.GetValue<string>() == "高一年级"), "班级列表带分组名称");
    Guid group2 = (await Json(await admin.PostAsJsonAsync("/api/admin/class-groups", new ClassGroupWriteRequest("高二年级")), HttpStatusCode.Created))["id"]!.GetValue<Guid>();
    await Json(await admin.PutAsJsonAsync("/api/admin/class-groups/order", new ClassGroupOrderRequest([group2, groupId])), HttpStatusCode.NoContent);
    var adminGroups = (await Json(await admin.GetAsync("/api/class-groups"))).AsArray();
    Check(adminGroups.Count == 2 && adminGroups[0]!["id"]!.GetValue<Guid>() == group2 && adminGroups[1]!["classCount"]!.GetValue<int>() == 2, "分组按指定顺序排列并统计班级数");
    var mathGroups = (await Json(await math.GetAsync("/api/class-groups"))).AsArray();
    Check(mathGroups.Count == 1 && mathGroups[0]!["classCount"]!.GetValue<int>() == 1, "老师只看到含自己班级的分组，只数自己的班级");
    await Json(await admin.PatchAsJsonAsync($"/api/admin/class-groups/{group2}", new ClassGroupWriteRequest("高二")), HttpStatusCode.NoContent);
    await Json(await admin.DeleteAsync($"/api/admin/class-groups/{group2}"), HttpStatusCode.NoContent);

    var copiedTo = (await Json(await admin.PostAsJsonAsync($"/api/classes/{classId}/projects/{projectId}/copy-to", new CopyHomeworkRequest([class2], null)))).AsArray().Single()!;
    Guid copiedProject = copiedTo["projectId"]!.GetValue<Guid>();
    Check(copiedTo["created"]!.GetValue<bool>() && copiedTo["error"] is null && copiedTo["copied"]!.AsArray().Select(x => x!.GetValue<string>()).SequenceEqual(["语文", "数学", "英语"]), "复制到同组班级：没有当天的项目时新建");
    var targetDetail = await Json(await admin.GetAsync($"/api/classes/{class2}/projects/{copiedProject}"));
    Check(targetDetail["date"]!.GetValue<string>() == today.ToString("yyyy-MM-dd") && targetDetail["payloadJson"]!.GetValue<string>().Contains("练习册 P12"), "新项目与来源同一天且带上作业内容");
    Check((await admin.GetAsync($"/api/classes/{class2}/assets/{webRef[6..70]}")).StatusCode == HttpStatusCode.OK, "复制作业时图片资源一并登记到目标班级");
    var copiedAgain = (await Json(await admin.PostAsJsonAsync($"/api/classes/{classId}/projects/{projectId}/copy-to", new CopyHomeworkRequest([class2], ["数学"])))).AsArray().Single()!;
    Check(!copiedAgain["created"]!.GetValue<bool>() && copiedAgain["projectId"]!.GetValue<Guid>() == copiedProject && copiedAgain["copied"]!.AsArray().Single()!.GetValue<string>() == "数学", "再次复制写入同一天的项目，只复制选中的科目");
    var notMine = (await Json(await math.PostAsJsonAsync($"/api/classes/{classId}/projects/{projectId}/copy-to", new CopyHomeworkRequest([class2], null)))).AsArray().Single()!;
    Check(notMine["error"]!.GetValue<string>().Contains("权限"), "没有目标班级权限时跳过并说明原因");

    var export = await admin.GetStringAsync($"/api/classes/{classId}/export");
    Check(export.Contains("\"students\"") && export.Contains("张三") && export.Contains("\"layout\""), "导出包含名单与布局");
    Console.WriteLine($"PASS: {checks} server checks.");
}
finally
{
    await app.StopAsync();
    await app.DisposeAsync();
    Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
    try { Directory.Delete(root, true); } catch (IOException) { }
}

/// <summary>编辑占用测试用的时钟：只有调用 Advance 才前进。</summary>
sealed class ManualClock : TimeProvider
{
    private DateTimeOffset _now = new(2026, 10, 30, 8, 0, 0, TimeSpan.Zero);
    public override DateTimeOffset GetUtcNow() => _now;
    public void Advance(TimeSpan by) => _now += by;
}
