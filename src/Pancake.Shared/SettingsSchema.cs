using System.Text.Json;
using System.Text.Json.Nodes;

namespace Pancake.Shared;

public enum SettingKind { Bool, Number, Enum, Color, Font, Text, Background, Widgets, Internal }

public sealed record SettingOption(string Value, string Label);

/// <summary>
/// 一项可同步的软件设置。Key 是 BoardSettingsState 上的属性名，嵌套设置用点号连接（例如 Autofill.Subject.Enabled）。
/// Page 对应大屏设置页（见 <see cref="SettingsSchema.Pages"/>），网页按同样的分类、顺序和名称排列；Section 是页内小标题。
/// Hidden 的设置照常同步，但网页表单不单独显示（组件位置由布局预览处理，颜色清除标记与不透明度由取色控件处理）。
/// When / EnableWhen 是显示与可用条件，与大屏设置页的联动一致："Key" 为真、"Key=A|B" 取值之一、"Key^=前缀"、"Key$=后缀"，
/// 前面加 "!" 取反，多个条件用 "&amp;" 连接。
/// Variant 指定控件外观：Surface（磁贴、控制窗、组件卡这类面板背景）、Position（控制窗位置九宫格）、NumberBox。
/// </summary>
public sealed record SettingDescriptor(string Key, string Page, string Label, SettingKind Kind, JsonNode? Default,
    double? Min = null, double? Max = null, double? Step = null, IReadOnlyList<SettingOption>? Options = null,
    string? Hint = null, bool Hidden = false, string? ClearedKey = null, string? Section = null, string? When = null,
    string? EnableWhen = null, string? Variant = null, string? OpacityKey = null, string? Unit = null);

/// <summary>大屏设置页。Nav 是左侧导航的分组（null 表示一级页面），Preview 是右侧预览的种类，Note 是页底说明。</summary>
public sealed record SettingPage(string Key, string? Nav, string Title, string Description, string Icon, string? Preview = null, string? Note = null);

/// <summary>
/// 班级设置清单：大屏、服务端和网页共用的唯一来源。服务端按它校验网页和设备上传的设置，
/// 网页按它生成与大屏相同分类的设置页，桌面端按它挑选要同步的字段。新增软件设置时必须在这里登记，或者写进 DeviceLocalKeys。
/// </summary>
public static class SettingsSchema
{
    /// <summary>与大屏设置窗口左侧导航一致；窗口、集控、锁定与关于只和本机有关，不在网页出现。</summary>
    public static readonly IReadOnlyList<SettingPage> Pages =
    [
        new("Layout", null, "布局", "调整布局模式、无限作业板与网格。", "layout", "Layout",
            "点击自动排列时按文字、图片和笔迹收紧磁贴；自动对齐会尽量统一相近尺寸并对齐行列。看板与图片导出共用这些设置，优先从左上角排列。"),
        new("AppearanceTile", "外观", "磁贴", "调整磁贴标题和背景样式。", "board", "Tile",
            "默认正文样式用于新建和尚未单独设置格式的正文；已有的局部字体、粗体、斜体、颜色与高光不会被覆盖。开启纯文本粘贴后，Ctrl+V 和右键粘贴都会移除来源格式。"),
        new("AppearanceBackground", "外观", "背景板", "设置跨区、时钟与作业板背景。", "image", "Background",
            "跨区背景仅在分屏生效，开启后区域底图由跨区背景统一管理，毛玻璃仍可分别调整。自由布局使用磁贴样式和主题底色。"),
        new("AppearanceTheme", "外观", "主题", "调整界面主题和看板色系。", "palette", "Board"),
        new("AppearanceGrid", "外观", "网格", "设置网格的显示样式，不改变吸附逻辑。", "grid", "Grid",
            "此页只改变网格显示样貌；网格吸附在“布局”页的“吸附到网格”中设置。"),
        new("AppearanceToolbar", "外观", "控制窗", "调整控制窗的显示、位置和外观。", "settings", "Toolbar",
            "控制窗、画笔栏和浮岛共用这套边框；粗细为 0 时没有边框。颜色默认跟随主题线条色，设定后不再随深浅主题变化。"),
        new("AppearanceComponents", "外观", "组件", "调整天气与噪音组件卡的背景和毛玻璃效果。", "components", "Components",
            "天气和噪音组件卡共用这套背景，默认沿用主题底色。毛玻璃的模糊透过颜色层显示：颜色层完全不透明时只能看到底色，想让模糊透出来需要适当调高透明度。"),
        new("AppearanceClock", "外观", "时钟", "调整时钟的字体、粗细与颜色。", "clock", "Clock",
            "字体作用于时间、秒数和日期；粗细只作用于时间数字。黑色和白色会跟随深浅色模式自动反转（深色模式显示白色，浅色模式显示黑色），其他颜色固定不变。"),
        new("ComponentsWeather", "组件", "天气", "选择天气地区并查看预警。", "weather", "Components", "使用小米天气 API，地区修改后大屏会自动刷新天气。"),
        new("ComponentsNoise", "组件", "噪音检测", "设置检测间隔、吵闹阈值与提示音。", "mic", "Components",
            "只计算实时音量，不录音、不保存音频。输入设备与麦克风校准和每块大屏的硬件有关，请在大屏上设置。"),
        new("ComponentsBanner", "组件", "班务条", "选择大屏顶部班务条显示哪些公告。", "megaphone"),
        new("AutofillSubject", "自动填充", "学科补全", "设置学科补全的匹配严格度。", "book", null,
            "宽松：输入 1 个字符即提示，首字母允许跳字；正常：汉字 1 个或字母 2 个起按前缀匹配；严格：2 个字符起，只认完整前缀。学科列表和默认颜色保存在每块大屏上。"),
        new("AutofillHomework", "自动填充", "作业补全", "记录常输入的作业名称，并按学科范围提示补全。", "edit", null,
            "全局隔离把所有词记进同一个词库；分学科隔离把自动学习写入当前学科，全局词仍然始终可用。已收录与待收录的词库保存在每块大屏上。"),
        new("Data", null, "数据", "管理自动保存。数据导出与自动备份目录和每块大屏有关，请在大屏上设置。", "db")
    ];

    private static readonly SettingOption[] ToolbarPositions =
    [
        new("TopLeft", "左上"), new("TopCenter", "上居中"), new("TopRight", "右上"),
        new("CenterLeft", "左居中（竖置）"), new("CenterRight", "右居中（竖置）"),
        new("BottomLeft", "左下"), new("BottomCenter", "下居中"), new("BottomRight", "右下")
    ];
    /// <summary>与桌面端 BackgroundSettings 的默认值一致。</summary>
    private static JsonObject BackgroundDefault() => new()
    {
        ["Color"] = "", ["ColorOpacity"] = 0.8, ["ColorCleared"] = false, ["ImagePath"] = "", ["ImageMode"] = "Zoom",
        ["PlaylistEnabled"] = false, ["Playlist"] = new JsonArray(), ["Shuffle"] = false, ["SwitchOnTimer"] = true,
        ["SwitchIntervalSeconds"] = 60.0, ["SwitchOnMediaEnded"] = true, ["Glass"] = false, ["Blur"] = 20.0
    };
    private static readonly SettingOption[] Levels = [new("Loose", "宽松"), new("Normal", "正常"), new("Strict", "严格")];

    // 页面、顺序与名称照搬大屏设置页，网页逐页按这个顺序生成控件。
    public static readonly IReadOnlyList<SettingDescriptor> All =
    [
        // 布局
        new("LayoutMode", "Layout", "布局模式", SettingKind.Enum, "Split", Options: [new("Split", "分屏"), new("Board", "仅作业"), new("Clock", "仅时钟"), new("Free", "自由布局")]),
        new("SplitRatio", "Layout", "时钟区宽度", SettingKind.Number, 0.4, 0.1, 0.9, 0.01, Hint: "也可以在预览里拖动分隔条。", When: "LayoutMode=Split"),
        new("InfiniteBoard", "Layout", "无限作业板", SettingKind.Bool, false, Hint: "开启后可滚动、触摸平移、Ctrl + 滚轮缩放；编辑磁贴时可用滚动条平移。"),
        new("GridSize", "Layout", "网格大小", SettingKind.Number, 48, 16, 160, 1, Unit: "px"),
        new("GridSnappingEnabled", "Layout", "吸附到网格", SettingKind.Bool, true, Section: "自动布局"),
        new("AutoLayoutGap", "Layout", "自动排版磁贴间隔", SettingKind.Number, 0, 0, 120, 1, Unit: "px", Section: "自动布局"),
        new("AutoLayoutAlign", "Layout", "自动对齐", SettingKind.Bool, true, Section: "自动布局"),
        new("AutoLayoutResize", "Layout", "自动调整磁贴大小", SettingKind.Bool, true, Section: "自动布局"),
        new("Widgets", "Layout", "组件位置", SettingKind.Widgets, new JsonObject(), Hidden: true),
        new("CustomizedDockedWidgets", "Layout", "手动调整过的停靠组件", SettingKind.Internal, new JsonArray(), Hidden: true),
        new("DockedWidgetLayoutVersion", "Layout", "停靠布局版本", SettingKind.Internal, 0, Hidden: true),

        // 外观 → 磁贴
        new("TileTitleSize", "AppearanceTile", "标题大小", SettingKind.Number, 29, 16, 72, 1, Unit: "px"),
        new("TileBodyFontSize", "AppearanceTile", "正文默认字号", SettingKind.Number, 20, 12, 72, 1, Unit: "px"),
        new("TileBodyFontFamily", "AppearanceTile", "正文默认字体", SettingKind.Font, "HarmonyOS Sans SC"),
        new("TileBodyBold", "AppearanceTile", "正文默认粗体", SettingKind.Bool, false),
        new("TileBodyItalic", "AppearanceTile", "正文默认斜体", SettingKind.Bool, false),
        new("PastePlainTextOnly", "AppearanceTile", "仅粘贴纯文本", SettingKind.Bool, false),
        new("TileBackground", "AppearanceTile", "磁贴背景", SettingKind.Background, BackgroundDefault(), Section: "磁贴背景", Variant: "Surface"),

        // 外观 → 背景板
        new("SharedBackgroundEnabled", "AppearanceBackground", "使用跨区背景", SettingKind.Bool, false, Hint: "仅分屏时可用。", EnableWhen: "LayoutMode=Split"),
        new("SharedBackground", "AppearanceBackground", "跨区背景", SettingKind.Background, BackgroundDefault(), EnableWhen: "LayoutMode=Split&SharedBackgroundEnabled"),
        new("ClockBackground", "AppearanceBackground", "时钟区域背景", SettingKind.Background, BackgroundDefault(), Section: "时钟区域背景", EnableWhen: "LayoutMode=Split|Clock"),
        new("BoardBackground", "AppearanceBackground", "作业板区域背景", SettingKind.Background, BackgroundDefault(), Section: "作业板区域背景", EnableWhen: "LayoutMode=Split|Board"),

        // 外观 → 主题
        new("Theme", "AppearanceTheme", "主题", SettingKind.Enum, "Dark", Options: [new("Dark", "深色"), new("Light", "浅色"), new("Default", "跟随系统")], Hint: "深色更接近教室黑板，强光环境可切换浅色。"),
        new("Palette", "AppearanceTheme", "色系", SettingKind.Enum, "Vivid", Options: [new("Vivid", "鲜艳"), new("Macaron", "马卡龙")], Hint: "磁贴主题色按色系一一对应切换；已设置的文字颜色与高光保持不变。"),

        // 外观 → 网格
        new("GridStyle", "AppearanceGrid", "样式", SettingKind.Enum, "Grid", Options: [new("Grid", "网格"), new("Dots", "点阵"), new("None", "不显示")]),
        new("GridColor", "AppearanceGrid", "网格颜色", SettingKind.Color, "#6956565C", When: "GridStyle=Grid"),
        new("GridLineThickness", "AppearanceGrid", "网格粗细", SettingKind.Number, 1.6, 0.5, 5, 0.1, Unit: "px", When: "GridStyle=Grid"),
        new("GridDotColor", "AppearanceGrid", "点阵颜色", SettingKind.Color, "#8F56565C", When: "GridStyle=Dots"),
        new("GridDotDiameter", "AppearanceGrid", "点的直径", SettingKind.Number, 3, 1, 12, 0.5, Unit: "px", When: "GridStyle=Dots"),
        new("ShowGridWhileEditing", "AppearanceGrid", "编辑时显示常规网格", SettingKind.Bool, true),

        // 外观 → 控制窗
        new("ToolbarPosition", "AppearanceToolbar", "位置", SettingKind.Enum, "BottomCenter", Options: ToolbarPositions, Variant: "Position"),
        new("ToolbarBackgroundColor", "AppearanceToolbar", "背景颜色", SettingKind.Color, "", ClearedKey: "ToolbarBackgroundColorCleared", Variant: "Surface", OpacityKey: "ToolbarBackgroundOpacity"),
        new("ToolbarBackgroundColorCleared", "AppearanceToolbar", "清除背景颜色", SettingKind.Bool, false, Hidden: true),
        new("ToolbarBackgroundOpacity", "AppearanceToolbar", "背景颜色不透明度", SettingKind.Number, 0.8, 0, 1, 0.01, Hidden: true),
        new("ToolbarAutoHide", "AppearanceToolbar", "自动隐藏", SettingKind.Bool, false, Hint: "仅在查看模式下无操作时隐藏；移动鼠标、触摸或按键后重新显示。飞出动画朝最近的窗口边框移动。"),
        new("ToolbarAutoHideSeconds", "AppearanceToolbar", "自动隐藏时间（秒）", SettingKind.Number, 5, 1, 600, 1, EnableWhen: "ToolbarAutoHide", Variant: "NumberBox"),
        new("ToolbarHideAnimation", "AppearanceToolbar", "隐藏动画", SettingKind.Enum, "Fade", Options: [new("Fade", "渐入渐出"), new("Fly", "飞出")], EnableWhen: "ToolbarAutoHide"),
        new("ToolbarIconOnly", "AppearanceToolbar", "无字模式", SettingKind.Bool, true),
        new("ToolbarScale", "AppearanceToolbar", "大小", SettingKind.Number, 1, 0.6, 2, 0.05, Unit: "×"),
        new("ToolbarRadius", "AppearanceToolbar", "圆角", SettingKind.Number, 14, 0, 60, 1, Unit: "px"),
        new("ToolbarBorderThickness", "AppearanceToolbar", "边框粗细", SettingKind.Number, 1, 0, 20, 0.5, Unit: "px"),
        new("ToolbarBorderColor", "AppearanceToolbar", "边框颜色", SettingKind.Color, ""),
        new("ToolbarHorizontalInset", "AppearanceToolbar", "距左右边框", SettingKind.Number, 24, 0, 200, 1, Unit: "px", When: "!ToolbarPosition$=Center"),
        new("ToolbarVerticalInset", "AppearanceToolbar", "距上下边框", SettingKind.Number, 24, 0, 200, 1, Unit: "px", When: "!ToolbarPosition^=Center"),
        new("ToolbarGlass", "AppearanceToolbar", "毛玻璃效果", SettingKind.Bool, false),
        new("ToolbarBlur", "AppearanceToolbar", "模糊程度", SettingKind.Number, 20, 0, 100, 1, EnableWhen: "ToolbarGlass"),

        // 外观 → 组件
        new("WidgetBackgroundColor", "AppearanceComponents", "背景颜色", SettingKind.Color, "", ClearedKey: "WidgetBackgroundColorCleared", Variant: "Surface", OpacityKey: "WidgetBackgroundOpacity"),
        new("WidgetBackgroundColorCleared", "AppearanceComponents", "清除背景颜色", SettingKind.Bool, false, Hidden: true),
        new("WidgetBackgroundOpacity", "AppearanceComponents", "背景颜色不透明度", SettingKind.Number, 1, 0, 1, 0.01, Hidden: true),
        new("WidgetGlass", "AppearanceComponents", "毛玻璃效果", SettingKind.Bool, false),
        new("WidgetBlur", "AppearanceComponents", "模糊程度", SettingKind.Number, 20, 0, 100, 1, EnableWhen: "WidgetGlass"),

        // 外观 → 时钟
        new("ClockFontFamily", "AppearanceClock", "时钟字体", SettingKind.Font, ""),
        new("ClockFontWeight", "AppearanceClock", "时钟粗细", SettingKind.Enum, "Normal", Options: [new("Light", "细体"), new("Normal", "常规"), new("Medium", "中等"), new("Bold", "粗体")]),
        new("ClockColor", "AppearanceClock", "时钟颜色", SettingKind.Color, ""),

        // 组件 → 天气
        new("WeatherCityName", "ComponentsWeather", "地区", SettingKind.Text, "北京", Hidden: true),
        new("WeatherCityCode", "ComponentsWeather", "地区编码", SettingKind.Text, "101010100", Hidden: true),
        new("ShowWeatherAlerts", "ComponentsWeather", "显示极端天气预警", SettingKind.Bool, true),

        // 组件 → 噪音检测
        new("NoiseIntervalSeconds", "ComponentsNoise", "检测间隔", SettingKind.Number, 0.1, 0.1, 2, 0.1, Unit: "秒"),
        new("NoiseThresholdDb", "ComponentsNoise", "吵闹阈值", SettingKind.Number, 60, 20, 120, 1, Unit: "dB"),
        new("NoiseAlertEnabled", "ComponentsNoise", "吵闹时播放提示音", SettingKind.Bool, false),
        new("NoiseAlertVolume", "ComponentsNoise", "提示音音量", SettingKind.Number, 1, 0, 1, 0.01, EnableWhen: "NoiseAlertEnabled"),
        new("PauseNoiseWhenMinimized", "ComponentsNoise", "最小化时暂停监测", SettingKind.Bool, false),

        // 组件 → 班务条
        new("BoardBannerLevels", "ComponentsBanner", "显示的公告", SettingKind.Enum, "All", Options: [new("All", "全部生效公告"), new("ImportantOnly", "仅重要、紧急与置顶")]),

        // 自动填充
        new("Autofill.Subject.Enabled", "AutofillSubject", "学科补全", SettingKind.Bool, false, Hint: "在磁贴标题里输入中文、全拼或首字母会弹出候选，采纳后标题与磁贴主题色切换为该学科的默认颜色。"),
        new("Autofill.Subject.MatchLevel", "AutofillSubject", "匹配程度", SettingKind.Enum, "Normal", Options: Levels),
        new("Autofill.Homework.Enabled", "AutofillHomework", "作业补全", SettingKind.Bool, false),
        new("Autofill.Homework.AutoRecord", "AutofillHomework", "自动记录常输入的作业名称", SettingKind.Bool, true),
        new("Autofill.Homework.RecordLevel", "AutofillHomework", "自动记录阈值", SettingKind.Enum, "Normal", Options: [new("Loose", "宽松（2 次）"), new("Normal", "正常（3 次）"), new("Strict", "严格（5 次）")]),
        new("Autofill.Homework.Isolation", "AutofillHomework", "记录隔离", SettingKind.Enum, "Global", Options: [new("Global", "全局"), new("Subject", "分学科")]),

        // 数据
        new("AutoSaveEnabled", "Data", "自动保存", SettingKind.Bool, true)
    ];

    /// <summary>
    /// 不同步的设置及原因：安全凭据、本机硬件、本机路径、安装行为与本机学习数据。
    /// 测试会检查 BoardSettingsState 的每个属性都在 All 或这里登记过。
    /// </summary>
    public static readonly IReadOnlyDictionary<string, string> DeviceLocalKeys = new Dictionary<string, string>
    {
        ["CloudSync"] = "集控连接凭据",
        ["Lock"] = "锁定密码与两步验证密钥",
        ["MicrophoneDeviceId"] = "本机麦克风",
        ["MicrophoneSampleRate"] = "本机麦克风",
        ["MicrophoneCalibrationDb"] = "本机麦克风校准",
        ["CalibrationTargetDb"] = "本机麦克风校准",
        ["Data"] = "备份目录等本机路径",
        ["UpdateSource"] = "本机更新方式",
        ["AutoUpdateEnabled"] = "本机更新方式",
        ["AllowMultipleInstances"] = "本机启动行为",
        ["SecondLaunchAction"] = "本机启动行为",
        ["Autofill.Subject.Subjects"] = "本机补全词库",
        ["Autofill.Homework.Items"] = "本机学习的作业词库",
        ["Autofill.Homework.Blocked"] = "本机补全屏蔽词"
    };

    /// <summary>
    /// 随作业项目保存的设置：每个项目有自己的主题与色系，大屏切换项目时跟着换，网页在编辑项目时修改。
    /// 它们仍登记在 All 里（设置页照常显示），但不作为班级设置同步：同步键、校验与差异比较都跳过它们。
    /// </summary>
    public static readonly IReadOnlyDictionary<string, string> ProjectScopedKeys = new Dictionary<string, string>
    {
        ["Theme"] = "随作业项目保存",
        ["Palette"] = "随作业项目保存"
    };

    private static readonly Dictionary<string, SettingDescriptor> ByKey = All.ToDictionary(x => x.Key, StringComparer.Ordinal);

    public static SettingDescriptor? Find(string key) => ByKey.GetValueOrDefault(key);

    /// <summary>作为班级设置同步的键：已登记且不随项目保存。</summary>
    public static bool IsSynced(string key) => ByKey.ContainsKey(key) && !ProjectScopedKeys.ContainsKey(key);

    public static IEnumerable<string> Keys => All.Where(x => !ProjectScopedKeys.ContainsKey(x.Key)).Select(x => x.Key);

    public static IEnumerable<string> BackgroundKeys => All.Where(x => x.Kind == SettingKind.Background).Select(x => x.Key);

    // ------------------------------------------------------------------ 路径读写

    /// <summary>按点号路径读取嵌套设置；路径不存在时返回 null。</summary>
    public static JsonNode? Get(JsonObject root, string key)
    {
        JsonNode? node = root;
        foreach (string part in key.Split('.'))
        {
            if (node is not JsonObject obj || !obj.TryGetPropertyValue(part, out node)) return null;
        }
        return node;
    }

    /// <summary>按点号路径写入嵌套设置，缺失的中间对象自动补齐。</summary>
    public static void Set(JsonObject root, string key, JsonNode? value)
    {
        string[] parts = key.Split('.');
        JsonObject current = root;
        for (int i = 0; i < parts.Length - 1; i++)
        {
            if (current[parts[i]] is not JsonObject next) { next = new JsonObject(); current[parts[i]] = next; }
            current = next;
        }
        current[parts[^1]] = value;
    }

    // ------------------------------------------------------------------ 比较

    /// <summary>逐键比较两份扁平设置 JSON，返回值不同的同步键（含一边缺失的键）。</summary>
    public static List<string> ChangedKeys(JsonObject from, JsonObject to) =>
        Keys.Where(key => from.TryGetPropertyValue(key, out JsonNode? a) != to.TryGetPropertyValue(key, out JsonNode? b) || !Same(a, b)).ToList();

    /// <summary>JSON 值语义相等：数字按数值比较（48 与 48.0 相同），对象不看键顺序。</summary>
    public static bool Same(JsonNode? a, JsonNode? b)
    {
        switch (a, b)
        {
            case (null, null): return true;
            case (JsonObject x, JsonObject y):
                return x.Count == y.Count && x.All(p => y.TryGetPropertyValue(p.Key, out JsonNode? other) && Same(p.Value, other));
            case (JsonArray x, JsonArray y):
                return x.Count == y.Count && x.Zip(y).All(p => Same(p.First, p.Second));
            case (JsonValue x, JsonValue y):
                if (x.GetValueKind() == JsonValueKind.Number && y.GetValueKind() == JsonValueKind.Number) return double.Parse(x.ToJsonString(), System.Globalization.CultureInfo.InvariantCulture) == double.Parse(y.ToJsonString(), System.Globalization.CultureInfo.InvariantCulture);
                return x.ToJsonString() == y.ToJsonString();
            default: return false;
        }
    }

    // ------------------------------------------------------------------ 校验

    /// <summary>
    /// 校验一组扁平设置（键为描述符 Key）：丢弃未知键、随项目保存的键和类型不符的值，数字限幅并按步长取整，枚举只接受登记的取值。
    /// 返回新对象，原对象不变。
    /// </summary>
    public static JsonObject Sanitize(JsonObject values)
    {
        JsonObject result = new();
        foreach (var (key, value) in values)
        {
            if (!IsSynced(key) || Find(key) is not { } descriptor) continue;
            if (SanitizeValue(descriptor, value) is { } clean) result[key] = clean;
        }
        return result;
    }

    public static JsonNode? SanitizeValue(SettingDescriptor descriptor, JsonNode? value) => descriptor.Kind switch
    {
        SettingKind.Bool => BoolOf(value) is { } b ? JsonValue.Create(b) : null,
        SettingKind.Number => Number(value, descriptor.Min, descriptor.Max, descriptor.Step) is { } n ? JsonValue.Create(n) : null,
        SettingKind.Enum => Text(value, 40) is { } e && descriptor.Options!.Any(o => o.Value == e) ? JsonValue.Create(e) : null,
        SettingKind.Color => Text(value, 9) is { } c && IsColor(c) ? JsonValue.Create(c.ToUpperInvariant()) : null,
        SettingKind.Font => Text(value, 100) is { } f && !f.Any(char.IsControl) ? JsonValue.Create(f.Trim()) : null,
        SettingKind.Text => Text(value, 100) is { } t && !t.Any(char.IsControl) ? JsonValue.Create(t.Trim()) : null,
        SettingKind.Background => value is JsonObject o ? Background(o) : null,
        SettingKind.Widgets => value is JsonObject w ? Widgets(w) : null,
        SettingKind.Internal => value?.DeepClone(),
        _ => null
    };

    /// <summary>颜色：空字符串（跟随主题）或 #RRGGBB / #AARRGGBB。</summary>
    public static bool IsColor(string value) =>
        value.Length == 0 || ((value.Length is 7 or 9) && value[0] == '#' && value[1..].All(Uri.IsHexDigit));

    // 按 JSON 类型读取，不依赖 JsonValue 是从文本解析的还是由 CLR 值创建的。
    private static bool? BoolOf(JsonNode? node) => node?.GetValueKind() switch
    {
        JsonValueKind.True => true, JsonValueKind.False => false, _ => null
    };

    private static string? Text(JsonNode? node, int max) =>
        node?.GetValueKind() == JsonValueKind.String && node.GetValue<string>() is { } s && s.Length <= max ? s : null;

    private static double? Number(JsonNode? node, double? min, double? max, double? step)
    {
        if (node?.GetValueKind() != JsonValueKind.Number) return null;
        double d = double.Parse(node.ToJsonString(), System.Globalization.CultureInfo.InvariantCulture);
        if (!double.IsFinite(d)) return null;
        if (min is { } lo) d = Math.Max(lo, d);
        if (max is { } hi) d = Math.Min(hi, d);
        // 只对整数步长取整：大屏滑块的步长更细，不能把用户拖出来的值改掉。
        if (step is { } s and >= 1) d = Math.Round(d / s) * s;
        return d;
    }

    private static readonly string[] ImageModes = ["Zoom", "Stretch", "Fit"];

    /// <summary>背景设置的字段与桌面端 BackgroundSettings 一一对应；路径只接受 asset: 引用或本机路径文本，长度受限。</summary>
    private static JsonObject Background(JsonObject source)
    {
        JsonObject result = new();
        void Copy(string key, Func<JsonNode?, JsonNode?> clean) { if (source.TryGetPropertyValue(key, out JsonNode? v) && clean(v) is { } c) result[key] = c; }
        static JsonNode? Bool(JsonNode? n) => BoolOf(n) is { } b ? JsonValue.Create(b) : null;
        Copy("Color", n => Text(n, 9) is { } c && IsColor(c) ? JsonValue.Create(c.ToUpperInvariant()) : null);
        Copy("ColorOpacity", n => Number(n, 0, 1, null) is { } d ? JsonValue.Create(d) : null);
        Copy("ColorCleared", Bool);
        Copy("ImagePath", n => Text(n, 1024) is { } p ? JsonValue.Create(p) : null);
        Copy("ImageMode", n => Text(n, 20) is { } m && ImageModes.Contains(m) ? JsonValue.Create(m) : null);
        Copy("PlaylistEnabled", Bool);
        Copy("Playlist", n => n is JsonArray a ? new JsonArray(a.Select(x => Text(x, 1024)).OfType<string>().Take(200).Select(x => (JsonNode?)JsonValue.Create(x)).ToArray()) : null);
        Copy("Shuffle", Bool);
        Copy("SwitchOnTimer", Bool);
        Copy("SwitchIntervalSeconds", n => Number(n, 1, 86400, null) is { } d ? JsonValue.Create(d) : null);
        Copy("SwitchOnMediaEnded", Bool);
        Copy("Glass", Bool);
        Copy("Blur", n => Number(n, 0, 100, null) is { } d ? JsonValue.Create(d) : null);
        return result;
    }

    private static JsonObject Widgets(JsonObject source)
    {
        JsonObject result = new();
        foreach (var (key, value) in source.Take(100))
        {
            if (key.Length > 60 || value is not JsonObject rect) continue;
            double? x = Number(rect["X"], -100000, 100000, null), y = Number(rect["Y"], -100000, 100000, null);
            double? w = Number(rect["Width"], 0, 100000, null), h = Number(rect["Height"], 0, 100000, null);
            if (x is null || y is null || w is null || h is null) continue;
            result[key] = new JsonObject { ["X"] = x, ["Y"] = y, ["Width"] = w, ["Height"] = h };
        }
        return result;
    }

    // ------------------------------------------------------------------ 网页使用的描述

    /// <summary>给网页的清单：设置页、控件类型、范围、选项与联动条件。字体列表由服务端按班级设备上报合并后另行提供。</summary>
    public static JsonObject Describe()
    {
        JsonArray items = new();
        foreach (SettingDescriptor d in All)
        {
            JsonObject item = new()
            {
                ["key"] = d.Key, ["page"] = d.Page, ["label"] = d.Label, ["kind"] = d.Kind.ToString(),
                ["default"] = d.Default?.DeepClone(), ["hidden"] = d.Hidden
            };
            if (d.Min is { } min) item["min"] = min;
            if (d.Max is { } max) item["max"] = max;
            if (d.Step is { } step) item["step"] = step;
            foreach (var (name, text) in new[] { ("hint", d.Hint), ("clearedKey", d.ClearedKey), ("section", d.Section), ("when", d.When),
                ("enableWhen", d.EnableWhen), ("variant", d.Variant), ("opacityKey", d.OpacityKey), ("unit", d.Unit) })
                if (text is not null) item[name] = text;
            if (d.Options is { } options) item["options"] = new JsonArray(options.Select(o => (JsonNode?)new JsonObject { ["value"] = o.Value, ["label"] = o.Label }).ToArray());
            items.Add(item);
        }
        JsonArray pages = new(Pages.Select(p => (JsonNode?)new JsonObject
        {
            ["key"] = p.Key, ["nav"] = p.Nav, ["title"] = p.Title, ["description"] = p.Description,
            ["icon"] = p.Icon, ["preview"] = p.Preview, ["note"] = p.Note
        }).ToArray());
        return new JsonObject { ["pages"] = pages, ["settings"] = items };
    }
}
