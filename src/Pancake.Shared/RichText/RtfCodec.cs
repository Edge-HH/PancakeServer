using System.Globalization;
using System.Text;

namespace Pancake.Shared.RichText;

/// <summary>
/// 一段同格式的文字。颜色为 #RRGGBB；为空表示默认文字色（大屏按深浅主题显示白或黑）或无高光。
/// FontSize 以磅为单位。换行用 \n 表示。
/// </summary>
public sealed record RichRun(string Text, bool Bold = false, bool Italic = false, bool Underline = false,
    string? FontFamily = null, double? FontSize = null, string? Color = null, string? Highlight = null)
{
    public bool SameFormat(RichRun other) =>
        Bold == other.Bold && Italic == other.Italic && Underline == other.Underline && FontFamily == other.FontFamily
        && FontSize == other.FontSize && Color == other.Color && Highlight == other.Highlight;
}

/// <summary>
/// 作业富文本与 RTF 互转。只覆盖大屏编辑器提供的格式：字体、字号、粗体、斜体、下划线、文字颜色与高光。
/// 解析 RichEdit 实际输出的 RTF（字体表按各自的 \fcharset 解码 \'hh 字节，支持 \uN 与 \ucN），
/// 生成的 RTF 与大屏保存的写法一致：非 ASCII 字符一律写成 \uN?，默认文字色存为白色 #F7F7F9。
/// </summary>
public static class RtfCodec
{
    public const string DefaultFamily = "HarmonyOS Sans SC";
    public const double DefaultSize = 20;
    /// <summary>大屏把默认文字色存为白色，浅色主题显示时再换成黑色。</summary>
    public const string StoredDefaultColor = "#F7F7F9";

    static RtfCodec() => Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

    /// <summary>与桌面端 DefaultContentColors.IsDefaultWhite 一致：这些白色都表示“默认文字色”。</summary>
    public static bool IsDefaultWhite(string hex) => hex.ToUpperInvariant() is "#FFFFFF" or "#F7F7F9" or "#F5F5F7" or "#F0F0F5";

    public static string PlainText(IEnumerable<RichRun> runs) => string.Concat(runs.Select(r => r.Text));

    /// <summary>合并相邻的同格式片段，去掉空片段。</summary>
    public static List<RichRun> Normalize(IEnumerable<RichRun> runs)
    {
        List<RichRun> result = [];
        foreach (RichRun run in runs)
        {
            if (run.Text.Length == 0) continue;
            if (result.Count > 0 && result[^1].SameFormat(run)) result[^1] = result[^1] with { Text = result[^1].Text + run.Text };
            else result.Add(run);
        }
        return result;
    }

    // ------------------------------------------------------------------ 解析

    private sealed class State
    {
        public bool Bold, Italic, Underline, Skip;
        public int Font = -1, Size = -1, Color, Highlight, UnicodeSkip = 1;
        public State Clone() => (State)MemberwiseClone();
    }

    private static readonly HashSet<string> SkippedDestinations =
    [
        "stylesheet", "info", "pict", "object", "header", "footer", "headerl", "headerr", "footerl", "footerr",
        "listtable", "listoverridetable", "rsidtbl", "themedata", "colorschememapping", "latentstyles", "datastore",
        "xmlnstbl", "mmathPr", "generator", "fldinst", "filetbl", "revtbl", "pgdsctbl", "bkmkstart", "bkmkend"
    ];

    public static List<RichRun> Parse(string? rtf)
    {
        if (string.IsNullOrWhiteSpace(rtf)) return [];
        if (!rtf.TrimStart().StartsWith(@"{\rtf", StringComparison.Ordinal)) return Normalize([new RichRun(rtf.Replace("\r\n", "\n").Replace('\r', '\n'))]);

        Dictionary<int, (string Name, int CodePage)> fonts = [];
        List<string?> colors = [];
        int defaultCodePage = 1252, defaultFont = 0;
        List<RichRun> runs = [];
        StringBuilder text = new();
        List<byte> bytes = [];
        Stack<State> stack = new();
        State state = new();
        int pendingSkip = 0;

        int CodePage()
        {
            int font = state.Font >= 0 ? state.Font : defaultFont;
            return fonts.TryGetValue(font, out var f) && f.CodePage > 0 ? f.CodePage : defaultCodePage;
        }
        void FlushBytes()
        {
            if (bytes.Count == 0) return;
            text.Append(Decode(bytes.ToArray(), CodePage()));
            bytes.Clear();
        }
        void FlushRun()
        {
            FlushBytes();
            if (text.Length == 0) return;
            string? family = fonts.TryGetValue(state.Font >= 0 ? state.Font : defaultFont, out var f) ? f.Name : null;
            string? color = state.Color > 0 && state.Color < colors.Count ? colors[state.Color] : null;
            if (color is not null && IsDefaultWhite(color)) color = null;
            string? highlight = state.Highlight > 0 && state.Highlight < colors.Count ? colors[state.Highlight] : null;
            runs.Add(new RichRun(text.ToString(), state.Bold, state.Italic, state.Underline, family,
                state.Size > 0 ? state.Size / 2.0 : null, color, highlight));
            text.Clear();
        }
        void Emit(string value)
        {
            if (state.Skip) return;
            FlushBytes();
            text.Append(value);
        }

        int i = 0;
        while (i < rtf.Length)
        {
            char c = rtf[i];
            if (c == '{')
            {
                FlushRun();
                stack.Push(state.Clone());
                i++;
                // 字体表与颜色表单独解析，整组跳过。
                if (Peek(rtf, i, @"\fonttbl")) { i = ParseFontTable(rtf, i, fonts); stack.Pop(); continue; }
                if (Peek(rtf, i, @"\colortbl")) { i = ParseColorTable(rtf, i, colors); stack.Pop(); continue; }
                if (Peek(rtf, i, @"\*")) state.Skip = true;
                continue;
            }
            if (c == '}')
            {
                FlushRun();
                if (stack.Count > 0) state = stack.Pop();
                i++;
                continue;
            }
            if (c == '\\')
            {
                if (i + 1 >= rtf.Length) break;
                char next = rtf[i + 1];
                if (next == '\'')
                {
                    if (i + 3 < rtf.Length && byte.TryParse(rtf.AsSpan(i + 2, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out byte b))
                    {
                        if (pendingSkip > 0) pendingSkip--;
                        else if (!state.Skip) bytes.Add(b);
                    }
                    i += 4;
                    continue;
                }
                if (next is '\\' or '{' or '}') { if (pendingSkip > 0) pendingSkip--; else Emit(next.ToString()); i += 2; continue; }
                if (next == '~') { Emit("\u00A0"); i += 2; continue; }
                if (next is '\r' or '\n') { Emit("\n"); i += 2; continue; }
                if (!char.IsAsciiLetter(next)) { i += 2; continue; }

                int start = i + 1, end = start;
                while (end < rtf.Length && char.IsAsciiLetter(rtf[end])) end++;
                string word = rtf[start..end];
                int numberStart = end;
                if (end < rtf.Length && (rtf[end] == '-' || char.IsAsciiDigit(rtf[end])))
                {
                    end++;
                    while (end < rtf.Length && char.IsAsciiDigit(rtf[end])) end++;
                }
                int? parameter = end > numberStart && int.TryParse(rtf.AsSpan(numberStart, end - numberStart), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out int n) ? n : null;
                if (end < rtf.Length && rtf[end] == ' ') end++;
                i = end;

                if (SkippedDestinations.Contains(word)) { state.Skip = true; continue; }
                switch (word)
                {
                    case "ansicpg": defaultCodePage = parameter ?? 1252; break;
                    case "deff": defaultFont = parameter ?? 0; break;
                    case "uc": state.UnicodeSkip = Math.Max(0, parameter ?? 1); break;
                    case "u" when parameter is { } code:
                        if (!state.Skip) { FlushBytes(); text.Append((char)(code < 0 ? code + 65536 : code)); }
                        pendingSkip = state.UnicodeSkip;
                        break;
                    case "par" or "line": Emit("\n"); break;
                    case "tab": Emit("\t"); break;
                    case "plain":
                        FlushRun();
                        state.Bold = state.Italic = state.Underline = false; state.Font = -1; state.Size = -1; state.Color = 0; state.Highlight = 0;
                        break;
                    case "b": FlushRun(); state.Bold = parameter is not 0; break;
                    case "i": FlushRun(); state.Italic = parameter is not 0; break;
                    case "ul": FlushRun(); state.Underline = parameter is not 0; break;
                    case "ulnone": FlushRun(); state.Underline = false; break;
                    case "f": FlushRun(); state.Font = parameter ?? 0; break;
                    case "fs": FlushRun(); state.Size = parameter ?? -1; break;
                    case "cf": FlushRun(); state.Color = parameter ?? 0; break;
                    case "highlight" or "cb" or "chcbpat": FlushRun(); state.Highlight = parameter ?? 0; break;
                }
                continue;
            }
            if (c is '\r' or '\n') { i++; continue; }
            if (pendingSkip > 0) { pendingSkip--; i++; continue; }
            Emit(c.ToString());
            i++;
        }
        FlushRun();
        return Normalize(runs);
    }

    private static bool Peek(string rtf, int index, string token)
    {
        while (index < rtf.Length && rtf[index] is '\r' or '\n' or ' ') index++;
        if (string.CompareOrdinal(rtf, index, token, 0, token.Length) != 0) return false;
        int after = index + token.Length;
        return token == @"\*" || after >= rtf.Length || !char.IsAsciiLetter(rtf[after]);
    }

    /// <summary>跳到与 start 之前的 { 配对的 } 之后，返回组内文本。</summary>
    private static int GroupEnd(string rtf, int start)
    {
        int depth = 1, i = start;
        while (i < rtf.Length && depth > 0)
        {
            if (rtf[i] == '\\') { i += 2; continue; }
            if (rtf[i] == '{') depth++;
            else if (rtf[i] == '}') depth--;
            i++;
        }
        return i;
    }

    private static int ParseFontTable(string rtf, int start, Dictionary<int, (string Name, int CodePage)> fonts)
    {
        int end = GroupEnd(rtf, start);
        string table = rtf[start..(end - 1)];
        // 每个字体一组：{\f0\fnil\fcharset134 名称;}；也兼容不带花括号、以分号分隔的写法。
        foreach (string entry in SplitFontEntries(table))
        {
            int index = -1, charset = -1;
            StringBuilder name = new();
            List<byte> raw = [];
            int i = 0;
            void FlushRaw(int codePage) { if (raw.Count > 0) { name.Append(Decode(raw.ToArray(), codePage)); raw.Clear(); } }
            while (i < entry.Length)
            {
                if (entry[i] == '\\' && i + 1 < entry.Length)
                {
                    if (entry[i + 1] == '\'' && i + 3 < entry.Length && byte.TryParse(entry.AsSpan(i + 2, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out byte b)) { raw.Add(b); i += 4; continue; }
                    int s = i + 1, e = s;
                    while (e < entry.Length && char.IsAsciiLetter(entry[e])) e++;
                    string word = entry[s..e];
                    int ns = e;
                    if (e < entry.Length && (entry[e] == '-' || char.IsAsciiDigit(entry[e]))) { e++; while (e < entry.Length && char.IsAsciiDigit(entry[e])) e++; }
                    int.TryParse(entry.AsSpan(ns, e - ns), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out int value);
                    if (e < entry.Length && entry[e] == ' ') e++;
                    if (word == "f") index = value;
                    else if (word == "fcharset") charset = value;
                    else if (word == "u") { FlushRaw(CharsetCodePage(charset)); name.Append((char)(value < 0 ? value + 65536 : value)); if (e < entry.Length && entry[e] == '?') e++; }
                    i = e == s ? i + 2 : e;
                    continue;
                }
                if (entry[i] is '{' or '}' or '\r' or '\n') { i++; continue; }
                if (entry[i] == ';') break;
                FlushRaw(CharsetCodePage(charset));
                name.Append(entry[i]);
                i++;
            }
            FlushRaw(CharsetCodePage(charset));
            if (index >= 0) fonts[index] = (name.ToString().Trim(), CharsetCodePage(charset));
        }
        return end;
    }

    private static IEnumerable<string> SplitFontEntries(string table)
    {
        int depth = 0, start = -1;
        bool grouped = false;
        for (int i = 0; i < table.Length; i++)
        {
            if (table[i] == '\\') { i++; continue; }
            if (table[i] == '{') { if (depth == 0) start = i + 1; depth++; grouped = true; }
            else if (table[i] == '}') { depth--; if (depth == 0 && start >= 0) { yield return table[start..i]; start = -1; } }
        }
        if (!grouped)
            foreach (string part in table.Split(';')) if (part.Contains(@"\f", StringComparison.Ordinal)) yield return part + ";";
    }

    private static int ParseColorTable(string rtf, int start, List<string?> colors)
    {
        int end = GroupEnd(rtf, start);
        string table = rtf[start..(end - 1)];
        int at = table.IndexOf(@"\colortbl", StringComparison.Ordinal);
        string body = at >= 0 ? table[(at + 9)..] : table;
        foreach (string entry in body.Split(';').SkipLast(1))
        {
            int? r = Component(entry, "red"), g = Component(entry, "green"), b = Component(entry, "blue");
            colors.Add(r is null && g is null && b is null ? null : $"#{r ?? 0:X2}{g ?? 0:X2}{b ?? 0:X2}");
        }
        if (colors.Count == 0) colors.Add(null);
        return end;
    }

    private static int? Component(string entry, string name)
    {
        int at = entry.IndexOf("\\" + name, StringComparison.Ordinal);
        if (at < 0) return null;
        int s = at + name.Length + 1, e = s;
        while (e < entry.Length && char.IsAsciiDigit(entry[e])) e++;
        return int.TryParse(entry.AsSpan(s, e - s), out int value) ? Math.Clamp(value, 0, 255) : null;
    }

    /// <summary>RTF 字符集编号对应的代码页；未知或 ANSI 默认时返回 0，使用文档的 \ansicpg。</summary>
    private static int CharsetCodePage(int charset) => charset switch
    {
        0 => 1252, 2 => 0, 77 => 10000, 128 => 932, 129 => 949, 130 => 1361, 134 => 936, 136 => 950,
        161 => 1253, 162 => 1254, 163 => 1258, 177 => 1255, 178 => 1256, 186 => 1257, 204 => 1251, 222 => 874, 238 => 1250,
        _ => 0
    };

    private static string Decode(byte[] data, int codePage)
    {
        try { return Encoding.GetEncoding(codePage).GetString(data); }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException) { return Encoding.Latin1.GetString(data); }
    }

    // ------------------------------------------------------------------ 生成

    /// <summary>
    /// 生成 RTF。片段未指定的字体、字号用 defaultFamily / defaultSize；未指定颜色时写默认白色，
    /// 由大屏在浅色主题下显示为黑色，与大屏自己保存的内容一致。
    /// </summary>
    public static string Write(IEnumerable<RichRun> source, string? defaultFamily = null, double? defaultSize = null)
    {
        List<RichRun> runs = Normalize(source);
        string family = string.IsNullOrWhiteSpace(defaultFamily) ? DefaultFamily : defaultFamily.Trim();
        double size = defaultSize is > 0 ? defaultSize.Value : DefaultSize;
        List<string> fonts = [];
        List<string> colors = [StoredDefaultColor];
        int FontIndex(string? name)
        {
            string value = string.IsNullOrWhiteSpace(name) ? family : name.Trim();
            int index = fonts.IndexOf(value);
            if (index < 0) { fonts.Add(value); index = fonts.Count - 1; }
            return index;
        }
        int ColorIndex(string? hex)
        {
            if (hex is null) return 0;
            string value = hex.ToUpperInvariant();
            int index = colors.IndexOf(value);
            if (index < 0) { colors.Add(value); index = colors.Count - 1; }
            return index + 1;
        }

        StringBuilder body = new();
        int font = -1, fs = -1, color = -1, highlight = -1;
        bool bold = false, italic = false, underline = false;
        foreach (RichRun run in runs)
        {
            int runFont = FontIndex(run.FontFamily);
            int runSize = (int)Math.Round(Math.Clamp(run.FontSize ?? size, 1, 1638) * 2);
            int runColor = ColorIndex(run.Color is { } c && IsColorHex(c) && !IsDefaultWhite(c) ? c : StoredDefaultColor);
            int runHighlight = run.Highlight is { } h && IsColorHex(h) ? ColorIndex(h) : 0;
            StringBuilder controls = new();
            if (runColor != color) controls.Append(@"\cf").Append(runColor);
            if (runFont != font) controls.Append(@"\f").Append(runFont);
            if (runSize != fs) controls.Append(@"\fs").Append(runSize);
            if (run.Bold != bold) controls.Append(run.Bold ? @"\b" : @"\b0");
            if (run.Italic != italic) controls.Append(run.Italic ? @"\i" : @"\i0");
            if (run.Underline != underline) controls.Append(run.Underline ? @"\ul" : @"\ulnone");
            if (runHighlight != highlight) controls.Append(@"\highlight").Append(runHighlight);
            if (controls.Length > 0) body.Append(controls).Append(' ');
            (font, fs, color, highlight, bold, italic, underline) = (runFont, runSize, runColor, runHighlight, run.Bold, run.Italic, run.Underline);
            AppendText(body, run.Text);
        }

        StringBuilder rtf = new(@"{\rtf1\fbidis\ansi\ansicpg936\deff0\nouicompat\deflang1033\deflangfe2052{\fonttbl");
        if (fonts.Count == 0) fonts.Add(family);
        for (int i = 0; i < fonts.Count; i++)
        {
            rtf.Append(@"{\f").Append(i).Append(@"\fnil\fcharset134 ");
            AppendText(rtf, fonts[i]);
            rtf.Append(";}");
        }
        rtf.Append("}\r\n{\\colortbl ;");
        foreach (string hex in colors)
            rtf.Append(@"\red").Append(Convert.ToInt32(hex[1..3], 16)).Append(@"\green").Append(Convert.ToInt32(hex[3..5], 16)).Append(@"\blue").Append(Convert.ToInt32(hex[5..7], 16)).Append(';');
        rtf.Append("}\r\n\\uc1 \r\n\\pard\\tx720").Append(body).Append('}');
        return rtf.ToString();
    }

    private static bool IsColorHex(string value) => value.Length == 7 && value[0] == '#' && value[1..].All(Uri.IsHexDigit);

    private static void AppendText(StringBuilder output, string text)
    {
        foreach (char ch in text.Replace("\r\n", "\n").Replace('\r', '\n'))
        {
            switch (ch)
            {
                case '\\': output.Append(@"\\"); break;
                case '{': output.Append(@"\{"); break;
                case '}': output.Append(@"\}"); break;
                case '\n': output.Append("\\par\r\n"); break;
                case '\t': output.Append(@"\tab "); break;
                default:
                    if (ch < 0x80 && !char.IsControl(ch)) output.Append(ch);
                    else if (!char.IsControl(ch)) output.Append(@"\u").Append((short)ch).Append('?');
                    break;
            }
        }
    }
}
