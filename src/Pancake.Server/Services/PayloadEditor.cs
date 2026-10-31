using System.Text.Json;
using System.Text.Json.Nodes;
using Pancake.Server.Contracts;
using Pancake.Shared;
using Pancake.Shared.RichText;

namespace Pancake.Server.Services;

public sealed class EditDeniedException(string message) : Exception(message);

/// <summary>
/// 在服务端直接修改桌面端的项目 JSON（PascalCase）。只改动网页能编辑的字段（科目、颜色、磁贴位置、作业富文本与图片），
/// 笔迹、没改动的格式和未知字段全部原样保留，旧客户端也能读回。
/// </summary>
public static class PayloadEditor
{
    private const double TileWidth = 430, TileHeight = 320, TileGap = 48;
    /// <summary>大屏新建作业条目时的占位文字，不算作业内容。</summary>
    public const string Placeholder = "在这里输入作业内容";
    /// <summary>项目配色的取值与桌面端校验一致：其他值会让大屏拒收整个项目。</summary>
    public static readonly string[] Themes = ["Dark", "Light", "Default"];
    public static readonly string[] Palettes = ["Vivid", "Macaron"];
    // 不转义中文：内容只作为 JSON 传输和存储，不会嵌进网页源码。
    public static readonly JsonSerializerOptions Compact = new() { WriteIndented = false, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    /// <summary>AppearanceChanged 表示项目配色（主题或色系）有变化。</summary>
    public sealed record EditResult(string PayloadJson, IReadOnlyList<string> ChangedSubjects, IReadOnlyList<string> AssetRefs, bool AppearanceChanged = false);

    /// <summary>Copied 为写入目标项目的科目，Skipped 为没有权限改动而跳过的科目，AssetRefs 为复制过去的附件资源。</summary>
    public sealed record CopyResult(string PayloadJson, IReadOnlyList<string> Copied, IReadOnlyList<string> Skipped, IReadOnlyList<string> AssetRefs);

    /// <summary>新建项目；有模板时沿用模板的科目、颜色与位置，清空作业和笔迹。</summary>
    public static string CreatePayload(Guid id, string name, DateOnly? date, string? templateJson)
    {
        JsonObject doc = new()
        {
            ["Version"] = 1,
            ["Id"] = id.ToString(),
            ["Name"] = name,
            ["AssignmentDate"] = date?.ToString("yyyy-MM-dd"),
            ["SyncRevision"] = 0,
            ["SyncDeleted"] = false,
            ["CreatedAt"] = DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss"),
            ["LastUsedAt"] = DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss"),
            ["LinkedFile"] = null,
            ["Theme"] = "Dark",
            ["Palette"] = "Vivid",
            ["Subjects"] = new JsonArray(),
            ["ClockInkStrokes"] = new JsonArray()
        };
        if (TryParse(templateJson) is { } template)
        {
            if (template["Theme"]?.GetValue<string>() is { } theme and ("Dark" or "Light" or "Default")) doc["Theme"] = theme;
            if (template["Palette"]?.GetValue<string>() is { } palette and ("Vivid" or "Macaron")) doc["Palette"] = palette;
            JsonArray subjects = new();
            foreach (JsonObject subject in (template["Subjects"] as JsonArray ?? []).OfType<JsonObject>())
            {
                JsonObject copy = (JsonObject)subject.DeepClone();
                copy["Entries"] = new JsonArray();
                copy["InkStrokes"] = new JsonArray();
                subjects.Add(copy);
            }
            doc["Subjects"] = subjects;
        }
        return doc.ToJsonString(Compact);
    }

    /// <summary>把名称和日期写回项目 JSON，避免网页改名后 JSON 内外不一致。</summary>
    public static string SetMeta(string payloadJson, string name, DateOnly? date)
    {
        if (TryParse(payloadJson) is not { } doc) return payloadJson;
        doc["Name"] = name;
        doc["AssignmentDate"] = date?.ToString("yyyy-MM-dd");
        return doc.ToJsonString(Compact);
    }

    /// <summary>每个科目、每条作业的富文本片段：有 RTF 时解析 RTF，否则整段文字作为一个无格式片段。</summary>
    public static List<List<List<RichRun>>> EntryRuns(string payloadJson)
    {
        if (TryParse(payloadJson) is not { } doc) return [];
        return (doc["Subjects"] as JsonArray ?? []).OfType<JsonObject>()
            .Select(subject => (subject["Entries"] as JsonArray ?? []).OfType<JsonObject>().Select(CurrentRuns).ToList()).ToList();
    }

    private static List<RichRun> CurrentRuns(JsonObject entry)
    {
        string rtf = entry["RtfContent"]?.GetValue<string>() ?? "";
        if (rtf.Length > 0) return RtfCodec.Parse(rtf);
        string content = (entry["Content"]?.GetValue<string>() ?? "").Replace("\r\n", "\n").Replace('\r', '\n');
        return content.Length == 0 ? [] : [new RichRun(content)];
    }

    /// <summary>网页提交的富文本片段：限制数量与长度，颜色、字号与字体名做基本校验。</summary>
    private static List<RichRun> SanitizeRuns(IReadOnlyList<RichRun> runs)
    {
        if (runs.Count > 2000) throw new InvalidDataException("作业格式过于复杂。");
        static string? Hex(string? value) => value is { Length: 7 } v && v[0] == '#' && v[1..].All(Uri.IsHexDigit) ? v.ToUpperInvariant() : null;
        List<RichRun> clean = runs.Select(r => new RichRun(
            (r.Text ?? "").Replace("\r\n", "\n").Replace('\r', '\n'), r.Bold, r.Italic, r.Underline,
            string.IsNullOrWhiteSpace(r.FontFamily) || r.FontFamily.Length > 100 || r.FontFamily.Any(char.IsControl) ? null : r.FontFamily.Trim(),
            r.FontSize is { } size && double.IsFinite(size) ? Math.Round(Math.Clamp(size, 8, 144), 1) : null,
            Hex(r.Color), Hex(r.Highlight))).ToList();
        if (clean.Sum(r => r.Text.Length) > 20000) throw new InvalidDataException("作业内容过长。");
        return RtfCodec.Normalize(clean);
    }

    /// <summary>theme / palette 为项目配色，为空保持不变；只有不受科目限制的人（allowed 为空）可以修改。</summary>
    public static EditResult ApplyEdit(string payloadJson, IReadOnlyList<SubjectEdit> edits, HashSet<string>? allowed, string? defaultFamily = null, double? defaultSize = null,
        string? theme = null, string? palette = null)
    {
        JsonObject doc = TryParse(payloadJson) ?? throw new InvalidDataException("项目内容无法解析。");
        JsonArray original = doc["Subjects"] as JsonArray ?? [];
        List<JsonObject> originals = original.OfType<JsonObject>().ToList();
        if (edits.Count > 200) throw new InvalidDataException("科目数量过多。");
        bool appearance = SetAppearance(doc, theme, palette);
        if (appearance && allowed is not null) throw new EditDeniedException("项目配色作用于整块大屏，只有班主任和管理员可以修改。");

        HashSet<int> referenced = [];
        List<JsonObject> result = [];
        List<string> changed = [];
        List<(double X, double Y, double W, double H)> occupied = originals.Select(Rect).ToList();

        foreach (SubjectEdit edit in edits)
        {
            string name = (edit.Name ?? "").Trim();
            if (name.Length is < 1 or > 40) throw new InvalidDataException("科目名称需为 1–40 个字符。");
            JsonObject? source = null;
            if (edit.Index is { } index)
            {
                if (index < 0 || index >= originals.Count || !referenced.Add(index)) throw new InvalidDataException("科目引用无效。");
                source = originals[index];
            }
            JsonObject node = source is null ? NewSubject(name, occupied) : (JsonObject)source.DeepClone();
            if (source?["Name"]?.GetValue<string>()?.Trim() != name) node["Name"] = name;
            // 颜色没变时不改写，保留原值的大小写与“跟随色系”标记。
            string? color = NormalizeColor(edit.AccentHex);
            if (color is not null && !string.Equals(source?["AccentHex"]?.GetValue<string>(), color, StringComparison.OrdinalIgnoreCase))
            { node["AccentHex"] = color; node["IsAccentExplicit"] = true; }
            if (edit.FollowPalette is { } follow && (node["IsAccentExplicit"]?.GetValue<bool>() ?? true) == follow) node["IsAccentExplicit"] = !follow;
            if (edit.Rect is { } rect)
            {
                if (!double.IsFinite(rect.X) || !double.IsFinite(rect.Y) || !double.IsFinite(rect.Width) || !double.IsFinite(rect.Height)
                    || Math.Abs(rect.X) > 100000 || Math.Abs(rect.Y) > 100000 || rect.Width is < 120 or > 20000 || rect.Height is < 80 or > 20000)
                    throw new InvalidDataException("磁贴位置或大小无效。");
                if (Rect(node) != (rect.X, rect.Y, rect.Width, rect.Height))
                {
                    node["X"] = Math.Round(rect.X, 1); node["Y"] = Math.Round(rect.Y, 1);
                    node["Width"] = Math.Round(rect.Width, 1); node["Height"] = Math.Round(rect.Height, 1);
                }
            }
            node["Entries"] = BuildEntries(source?["Entries"] as JsonArray, edit.Entries ?? [], defaultFamily, defaultSize);

            bool isChanged = source is null || !JsonNode.DeepEquals(source, node);
            if (isChanged)
            {
                string originalName = source?["Name"]?.GetValue<string>()?.Trim() ?? name;
                if (allowed is not null && (!allowed.Contains(name) || !allowed.Contains(originalName)))
                    throw new EditDeniedException($"你没有被分配“{(allowed.Contains(name) ? originalName : name)}”科目，不能修改它。");
                changed.Add(name);
            }
            result.Add(node);
        }
        for (int i = 0; i < originals.Count; i++)
        {
            if (referenced.Contains(i)) continue;
            string removedName = originals[i]["Name"]?.GetValue<string>()?.Trim() ?? "";
            if (allowed is not null && !allowed.Contains(removedName))
                throw new EditDeniedException($"你没有被分配“{removedName}”科目，不能删除它。");
            changed.Add($"删除 {removedName}");
        }

        JsonArray subjects = new();
        foreach (JsonObject node in result) subjects.Add(node);
        doc["Subjects"] = subjects;
        string json = doc.ToJsonString(Compact);
        return new EditResult(json, changed, AssetRefs(json).ToList(), appearance);
    }

    private static bool SetAppearance(JsonObject doc, string? theme, string? palette)
    {
        bool changed = false;
        foreach (var (key, value, allowedValues, label) in new[] { ("Theme", theme, Themes, "主题"), ("Palette", palette, Palettes, "色系") })
        {
            if (value is null) continue;
            if (!allowedValues.Contains(value)) throw new InvalidDataException($"{label}无效。");
            if (Text(doc[key]) == value) continue;
            doc[key] = value;
            changed = true;
        }
        return changed;
    }

    /// <summary>科目里是否布置了作业：有文字（占位文字不算）、附件、手写或笔迹之一。</summary>
    public static bool HasHomework(JsonObject subject) =>
        (subject["InkStrokes"] as JsonArray)?.Count > 0
        || (subject["Entries"] as JsonArray ?? []).OfType<JsonObject>().Any(e =>
            Text(e["Content"]).Trim() is { Length: > 0 } text && text != Placeholder
            || (e["Attachments"] as JsonArray)?.Count > 0
            || (e["HasHandwriting"] is JsonValue v && v.TryGetValue(out bool hand) && hand));

    /// <summary>
    /// 把来源项目的作业复制到目标项目：同名科目（忽略大小写和首尾空格）替换作业条目与笔迹，保留目标磁贴的位置、大小和颜色；
    /// 目标里没有的科目整块新增，放到空位上。只复制布置了作业的科目；names 为空表示全部，allowed 为空表示不限科目。
    /// </summary>
    public static CopyResult CopySubjects(string sourceJson, string targetJson, IReadOnlySet<string>? names, IReadOnlySet<string>? allowed)
    {
        JsonObject source = TryParse(sourceJson) ?? throw new InvalidDataException("来源项目内容无法解析。");
        JsonObject target = TryParse(targetJson) ?? throw new InvalidDataException("目标项目内容无法解析。");
        if (target["Subjects"] is not JsonArray subjects) target["Subjects"] = subjects = new JsonArray();
        List<(double X, double Y, double W, double H)> occupied = subjects.OfType<JsonObject>().Select(Rect).ToList();
        List<string> copied = [], skipped = [];
        HashSet<string> refs = [];
        foreach (JsonObject subject in (source["Subjects"] as JsonArray ?? []).OfType<JsonObject>())
        {
            string name = Text(subject["Name"]).Trim();
            if (name.Length == 0 || (names is not null && !names.Contains(name)) || !HasHomework(subject)) continue;
            if (allowed is not null && !allowed.Contains(name)) { skipped.Add(name); continue; }
            JsonObject? match = subjects.OfType<JsonObject>().FirstOrDefault(t => string.Equals(Text(t["Name"]).Trim(), name, StringComparison.OrdinalIgnoreCase));
            if (match is null)
            {
                JsonObject added = (JsonObject)subject.DeepClone();
                var size = Rect(subject);
                (double x, double y) = FreeSpot(occupied, size.W > 0 ? size.W : TileWidth, size.H > 0 ? size.H : TileHeight);
                added["X"] = x; added["Y"] = y;
                subjects.Add(added);
            }
            else
            {
                match["Entries"] = subject["Entries"]?.DeepClone() ?? new JsonArray();
                match["InkStrokes"] = subject["InkStrokes"]?.DeepClone() ?? new JsonArray();
                if (subject["InkCoordinateVersion"] is { } version) match["InkCoordinateVersion"] = version.DeepClone();
            }
            foreach (JsonObject entry in (subject["Entries"] as JsonArray ?? []).OfType<JsonObject>())
                foreach (JsonObject attachment in (entry["Attachments"] as JsonArray ?? []).OfType<JsonObject>())
                    if (AssetReference.TryParse(Text(attachment["Path"]), out string sha, out _)) refs.Add(sha);
            copied.Add(name);
        }
        return new CopyResult(target.ToJsonString(Compact), copied, skipped, refs.ToList());
    }

    private static string Text(JsonNode? node) => node is JsonValue v && v.TryGetValue(out string? s) ? s : "";

    /// <summary>项目里引用的服务器资源哈希。</summary>
    public static IEnumerable<string> AssetRefs(string payloadJson)
    {
        if (TryParse(payloadJson) is not { } doc) yield break;
        foreach (JsonObject subject in (doc["Subjects"] as JsonArray ?? []).OfType<JsonObject>())
            foreach (JsonObject entry in (subject["Entries"] as JsonArray ?? []).OfType<JsonObject>())
                foreach (JsonObject attachment in (entry["Attachments"] as JsonArray ?? []).OfType<JsonObject>())
                    if (AssetReference.TryParse(attachment["Path"]?.GetValue<string>(), out string sha, out _)) yield return sha;
    }

    /// <summary>JSON 中任意位置出现的资源引用（布局里的背景图、播放列表等）。</summary>
    public static IEnumerable<string> AllAssetRefs(string json)
    {
        if (TryParseNode(json) is not { } root) yield break;
        Stack<JsonNode> stack = new(); stack.Push(root);
        while (stack.Count > 0)
        {
            switch (stack.Pop())
            {
                case JsonObject obj: foreach (var item in obj) if (item.Value is not null) stack.Push(item.Value); break;
                case JsonArray array: foreach (var item in array) if (item is not null) stack.Push(item); break;
                case JsonValue value when value.TryGetValue(out string? text) && AssetReference.TryParse(text, out string sha, out _): yield return sha; break;
            }
        }
    }

    private static JsonArray BuildEntries(JsonArray? sourceEntries, IReadOnlyList<EntryEdit> edits, string? defaultFamily, double? defaultSize)
    {
        List<JsonObject> originals = (sourceEntries ?? []).OfType<JsonObject>().ToList();
        if (edits.Count > 500) throw new InvalidDataException("作业条目过多。");
        HashSet<int> used = [];
        JsonArray entries = new();
        foreach (EntryEdit edit in edits)
        {
            string content = (edit.Content ?? "").Replace("\r\n", "\n").Replace('\r', '\n');
            if (content.Length > 20000) throw new InvalidDataException("作业内容过长。");
            JsonObject node;
            List<RichRun>? runs = edit.Runs is null ? null : SanitizeRuns(edit.Runs);
            if (runs is not null) content = RtfCodec.PlainText(runs);
            if (edit.Index is { } index)
            {
                if (index < 0 || index >= originals.Count || !used.Add(index)) throw new InvalidDataException("作业条目引用无效。");
                node = (JsonObject)originals[index].DeepClone();
                if (runs is not null)
                {
                    // 富文本：格式或文字有变化才重写 RTF，没改动的条目保留大屏写入的原始内容。
                    bool plain = runs.All(r => r == new RichRun(r.Text)) && string.IsNullOrEmpty(node["RtfContent"]?.GetValue<string>());
                    if (CurrentRuns(node).SequenceEqual(runs)) { }
                    else if (plain)
                    {
                        // 原来就是纯文本、也没加任何格式：仍按纯文本保存，大屏用正文默认样式显示。
                        node["Content"] = content; node["RtfContent"] = ""; node["FontFallbacks"] = new JsonArray();
                    }
                    else WriteRich(node, runs, defaultFamily, defaultSize);
                    if (edit.Attachments is not null) node["Attachments"] = BuildAttachments(node["Attachments"] as JsonArray, edit.Attachments);
                    entries.Add(node);
                    continue;
                }
                string before = (node["Content"]?.GetValue<string>() ?? "").Replace("\r\n", "\n").Replace('\r', '\n');
                // 文字变了才丢弃富文本：桌面端在 RtfContent 为空时按纯文本显示。
                if (before.TrimEnd() != content.TrimEnd())
                {
                    node["Content"] = content;
                    node["RtfContent"] = "";
                    node["FontFallbacks"] = new JsonArray();
                }
            }
            else
            {
                node = new JsonObject
                {
                    ["Content"] = content, ["RtfContent"] = "", ["HasHandwriting"] = false,
                    ["Attachments"] = new JsonArray(), ["FontFallbacks"] = new JsonArray()
                };
                if (runs is not null && runs.Any(r => r != new RichRun(r.Text))) WriteRich(node, runs, defaultFamily, defaultSize);
            }
            if (edit.Attachments is not null) node["Attachments"] = BuildAttachments(node["Attachments"] as JsonArray, edit.Attachments);
            entries.Add(node);
        }
        return entries;
    }

    /// <summary>
    /// 写入富文本：RTF 与大屏保存的写法一致；纯文本与大屏 RichEdit 一样用 \r 分段。
    /// 清空字体回退记录，大屏加载时会按 RTF 里的字体名重新绑定。
    /// </summary>
    private static void WriteRich(JsonObject node, List<RichRun> runs, string? defaultFamily, double? defaultSize)
    {
        node["Content"] = RtfCodec.PlainText(runs).Replace('\n', '\r');
        node["RtfContent"] = runs.Count == 0 ? "" : RtfCodec.Write(runs, defaultFamily, defaultSize);
        node["FontFallbacks"] = new JsonArray();
    }

    private static JsonArray BuildAttachments(JsonArray? sourceAttachments, IReadOnlyList<AttachmentEdit> edits)
    {
        List<JsonObject> originals = (sourceAttachments ?? []).OfType<JsonObject>().ToList();
        if (edits.Count > 50) throw new InvalidDataException("附件过多。");
        HashSet<int> used = [];
        JsonArray attachments = new();
        foreach (AttachmentEdit edit in edits)
        {
            if (edit.Index is { } index)
            {
                if (index < 0 || index >= originals.Count || !used.Add(index)) throw new InvalidDataException("附件引用无效。");
                attachments.Add(originals[index].DeepClone());
                continue;
            }
            if (!AssetReference.TryParse(edit.Asset, out _, out _)) throw new InvalidDataException("附件资源无效。");
            string name = string.IsNullOrWhiteSpace(edit.Name) ? "图片" : edit.Name.Trim()[..Math.Min(edit.Name.Trim().Length, 120)];
            attachments.Add(new JsonObject
            {
                ["Name"] = name, ["Kind"] = "图片", ["Path"] = edit.Asset,
                ["Scale"] = 1.0, ["OffsetX"] = 0.0, ["OffsetY"] = 0.0, ["ViewportHeight"] = 180.0, ["FrameWidth"] = 360.0,
                ["AspectRatio"] = 0.0, ["Rotation"] = 0.0, ["PositionX"] = 0.0, ["PositionY"] = 0.0
            });
        }
        return attachments;
    }

    /// <summary>新科目放进 3 列网格里第一个不与现有磁贴重叠的位置，大屏上可以再用“自动排列”整理。</summary>
    private static JsonObject NewSubject(string name, List<(double X, double Y, double W, double H)> occupied)
    {
        (double x, double y) = FreeSpot(occupied, TileWidth, TileHeight);
        return new JsonObject
        {
            ["Name"] = name, ["AccentHex"] = "#818CF8", ["IsAccentExplicit"] = false, ["InkCoordinateVersion"] = 1,
            ["X"] = x, ["Y"] = y, ["Width"] = TileWidth, ["Height"] = TileHeight,
            ["Entries"] = new JsonArray(), ["InkStrokes"] = new JsonArray()
        };
    }

    /// <summary>3 列网格里第一个放得下 w×h、且不与已有磁贴重叠的格子；找到后记为已占用。</summary>
    private static (double X, double Y) FreeSpot(List<(double X, double Y, double W, double H)> occupied, double w, double h)
    {
        (double x, double y) = (TileGap, TileGap);
        for (int cell = 0; cell < 400; cell++)
        {
            double cx = TileGap + cell % 3 * (TileWidth + TileGap), cy = TileGap + cell / 3 * (TileHeight + TileGap);
            if (!occupied.Any(r => cx < r.X + r.W && r.X < cx + w && cy < r.Y + r.H && r.Y < cy + h)) { (x, y) = (cx, cy); break; }
        }
        occupied.Add((x, y, w, h));
        return (x, y);
    }

    private static (double X, double Y, double W, double H) Rect(JsonObject subject)
    {
        static double Read(JsonNode? node) => node is JsonValue v && v.TryGetValue(out double d) && double.IsFinite(d) ? d : 0;
        return (Read(subject["X"]), Read(subject["Y"]), Read(subject["Width"]), Read(subject["Height"]));
    }

    public static string? NormalizeColor(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        string v = value.Trim();
        return (v.Length is 7 or 9) && v[0] == '#' && v[1..].All(Uri.IsHexDigit) ? v.ToUpperInvariant() : null;
    }

    public static JsonObject? TryParse(string? json) => TryParseNode(json) as JsonObject;

    private static JsonNode? TryParseNode(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try { return JsonNode.Parse(json); }
        catch (JsonException) { return null; }
    }
}
