using System.Text.Json;
using System.Text.Json.Serialization;
using Pancake.Shared;

namespace Pancake.Server.Services;

/// <summary>
/// 值日安排。两种模式：
/// fixed  —— 按星期固定：每个值日日、每个岗位指定学生；
/// rotate —— 小组轮换：按天（只数值日日）或按周从 anchor 起依次轮到下一组，组员按顺序分到各岗位。
/// </summary>
public sealed class DutyPlanModel
{
    public string Mode { get; set; } = "fixed";
    public List<int> Weekdays { get; set; } = [1, 2, 3, 4, 5];
    public List<DutyTaskModel> Tasks { get; set; } = [];
    /// <summary>星期（1–7，周一为 1）→ 岗位 ID → 学生 ID。</summary>
    public Dictionary<string, Dictionary<string, List<Guid>>> Fixed { get; set; } = [];
    public List<DutyGroupModel> Groups { get; set; } = [];
    public string Unit { get; set; } = "day";
    public DateOnly? Anchor { get; set; }
}

public sealed class DutyTaskModel
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
}

public sealed class DutyGroupModel
{
    public string Name { get; set; } = "";
    public List<Guid> Members { get; set; } = [];
}

public static class DutyPlanner
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = JsonIgnoreCondition.Never };
    private const string WeekNames = "日一二三四五六日";

    public static DutyPlanModel Parse(string? json)
    {
        try { return JsonSerializer.Deserialize<DutyPlanModel>(string.IsNullOrWhiteSpace(json) ? "{}" : json, Json) ?? new(); }
        catch (JsonException) { return new(); }
    }

    /// <summary>清理并校验网页提交的安排；无效岗位、不存在的学生和越界的星期会被丢弃。</summary>
    public static DutyPlanModel Normalize(DutyPlanModel plan, IReadOnlySet<Guid> studentIds)
    {
        if (plan.Mode is not ("fixed" or "rotate")) throw new InvalidDataException("值日模式无效。");
        if (plan.Unit is not ("day" or "week")) throw new InvalidDataException("轮换单位无效。");
        if (plan.Tasks.Count > 30 || plan.Groups.Count > 60) throw new InvalidDataException("岗位或小组过多。");
        List<DutyTaskModel> tasks = [];
        foreach (DutyTaskModel task in plan.Tasks)
        {
            string name = (task.Name ?? "").Trim();
            if (name.Length is < 1 or > 20) throw new InvalidDataException("岗位名称需为 1–20 个字符。");
            string id = string.IsNullOrWhiteSpace(task.Id) ? Guid.NewGuid().ToString("N")[..8] : task.Id.Trim()[..Math.Min(task.Id.Trim().Length, 32)];
            if (tasks.Any(t => t.Id == id)) id = Guid.NewGuid().ToString("N")[..8];
            tasks.Add(new DutyTaskModel { Id = id, Name = name });
        }
        DutyPlanModel result = new()
        {
            Mode = plan.Mode,
            Unit = plan.Unit,
            Anchor = plan.Anchor,
            Weekdays = plan.Weekdays.Where(d => d is >= 1 and <= 7).Distinct().Order().ToList(),
            Tasks = tasks,
            Groups = plan.Groups.Select((g, i) => new DutyGroupModel
            {
                Name = string.IsNullOrWhiteSpace(g.Name) ? $"第{i + 1}组" : g.Name.Trim()[..Math.Min(g.Name.Trim().Length, 20)],
                Members = g.Members.Where(studentIds.Contains).Distinct().ToList()
            }).ToList()
        };
        foreach (var (day, slots) in plan.Fixed)
        {
            if (!int.TryParse(day, out int weekday) || weekday is < 1 or > 7) continue;
            Dictionary<string, List<Guid>> cleaned = [];
            foreach (var (taskId, members) in slots)
                if (tasks.Any(t => t.Id == taskId)) cleaned[taskId] = members.Where(studentIds.Contains).Distinct().ToList();
            result.Fixed[weekday.ToString()] = cleaned;
        }
        return result;
    }

    public static int IsoWeekday(DateOnly date) => date.DayOfWeek == DayOfWeek.Sunday ? 7 : (int)date.DayOfWeek;

    /// <summary>算出某天的值日；不是值日日或还没安排时返回 null。</summary>
    public static DutyToday? Resolve(DutyPlanModel plan, DateOnly date, IReadOnlyDictionary<Guid, string> names)
    {
        int weekday = IsoWeekday(date);
        if (!plan.Weekdays.Contains(weekday)) return null;
        string Name(Guid id) => names.TryGetValue(id, out string? n) ? n : "";
        string label = $"周{WeekNames[weekday]}";
        List<DutyTaskAssignment> assignments = [];

        if (plan.Mode == "fixed")
        {
            if (!plan.Fixed.TryGetValue(weekday.ToString(), out var slots)) return null;
            foreach (DutyTaskModel task in plan.Tasks)
                if (slots.TryGetValue(task.Id, out var members))
                {
                    List<string> students = members.Select(Name).Where(n => n.Length > 0).ToList();
                    if (students.Count > 0) assignments.Add(new DutyTaskAssignment(task.Name, students));
                }
        }
        else
        {
            List<DutyGroupModel> groups = plan.Groups.Where(g => g.Members.Count > 0).ToList();
            if (groups.Count == 0) return null;
            DateOnly anchor = plan.Anchor ?? date;
            long step = plan.Unit == "week" ? WeeksBetween(anchor, date) : DutyDaysBetween(anchor, date, plan.Weekdays);
            DutyGroupModel group = groups[(int)(((step % groups.Count) + groups.Count) % groups.Count)];
            label += $" · {group.Name}";
            List<string> members = group.Members.Select(Name).Where(n => n.Length > 0).ToList();
            if (plan.Tasks.Count == 0) assignments.Add(new DutyTaskAssignment("值日", members));
            else
                for (int i = 0; i < plan.Tasks.Count; i++)
                {
                    List<string> students = members.Where((_, m) => m % plan.Tasks.Count == i).ToList();
                    if (students.Count > 0) assignments.Add(new DutyTaskAssignment(plan.Tasks[i].Name, students));
                }
        }
        return assignments.Count == 0 ? null : new DutyToday(date, label, assignments);
    }

    private static long WeeksBetween(DateOnly from, DateOnly to)
    {
        DateOnly Monday(DateOnly d) => d.AddDays(1 - IsoWeekday(d));
        return (Monday(to).DayNumber - Monday(from).DayNumber) / 7;
    }

    /// <summary>从 anchor 到 date 之间经过了多少个值日日（anchor 当天记为 0），date 早于 anchor 时为负数。</summary>
    private static long DutyDaysBetween(DateOnly from, DateOnly to, List<int> weekdays)
    {
        if (weekdays.Count == 0) return 0;
        int sign = to >= from ? 1 : -1;
        (DateOnly start, DateOnly end) = sign > 0 ? (from, to) : (to, from);
        int days = end.DayNumber - start.DayNumber;
        long count = days / 7 * weekdays.Count;
        for (DateOnly d = start.AddDays(days / 7 * 7); d < end; d = d.AddDays(1)) if (weekdays.Contains(IsoWeekday(d))) count++;
        return sign * count;
    }
}
