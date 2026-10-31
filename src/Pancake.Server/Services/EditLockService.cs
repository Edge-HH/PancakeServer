using System.Collections.Concurrent;
using Pancake.Server.Data;
using Pancake.Shared;

namespace Pancake.Server.Services;

/// <summary>
/// 项目编辑占用，只放在内存里：服务重启后由双方的心跳重新建立。大屏进入编辑模式、网页开始修改时占用，
/// 另一端在占用期间只能查看——老师占用时设备不能上传这个项目，大屏占用时网页不能保存。
/// 占用靠心跳续期，超过 Ttl 没有续期即失效；同一占用者再次申请就是续期。
/// </summary>
public sealed class EditLockService(TimeProvider clock)
{
    public static readonly TimeSpan Ttl = TimeSpan.FromSeconds(45);

    /// <summary>申请占用的一方。网页按页面区分（ClientId），同一位老师的两个窗口也互相占用。</summary>
    public sealed record Holder(string Kind, Guid? DeviceId, Guid? UserId, string? ClientId, string Name)
    {
        public bool Same(Holder other) => Kind == other.Kind && DeviceId == other.DeviceId && UserId == other.UserId && ClientId == other.ClientId;
        public static Holder Device(DeviceRegistration device) => new(EditLockHolders.Device, device.Id, null, null, device.DeviceName);
        public static Holder User(UserSession session, string? clientId) => new(EditLockHolders.User, null, session.UserId, clientId, session.DisplayName);
    }

    public enum Outcome { Acquired, Renewed, TakenOver, Denied }

    /// <summary>Current 为申请后的占用（被拒绝时是占着的一方）；接管时 Previous 是被接管的大屏。</summary>
    public sealed record Result(Outcome Outcome, EditLockInfo Current, EditLockInfo? Previous = null);

    private sealed record Entry(Holder Holder, DateTime Since, DateTime Beat);

    private readonly ConcurrentDictionary<(Guid ClassId, Guid ProjectId), Entry> _locks = new();
    private readonly object _gate = new();

    private DateTime Now => clock.GetUtcNow().UtcDateTime;

    /// <summary>占用或续期。force 只对老师有效，且只能接管大屏的占用（大屏可能卡在对话框里没有响应）。</summary>
    public Result Acquire(Guid classId, Guid projectId, Holder holder, bool force = false)
    {
        lock (_gate)
        {
            DateTime now = Now;
            var key = (classId, projectId);
            Entry? current = Live(key, now);
            if (current is not null && current.Holder.Same(holder))
            {
                Entry renewed = current with { Holder = holder, Beat = now };
                _locks[key] = renewed;
                return new Result(Outcome.Renewed, Info(projectId, renewed));
            }
            bool takeOver = force && holder.Kind == EditLockHolders.User && current?.Holder.Kind == EditLockHolders.Device;
            if (current is not null && !takeOver) return new Result(Outcome.Denied, Info(projectId, current));
            Entry entry = new(holder, now, now);
            _locks[key] = entry;
            return current is null
                ? new Result(Outcome.Acquired, Info(projectId, entry))
                : new Result(Outcome.TakenOver, Info(projectId, entry), Info(projectId, current));
        }
    }

    /// <summary>只有占用者本人能释放；返回是否真的释放了。</summary>
    public bool Release(Guid classId, Guid projectId, Holder holder)
    {
        lock (_gate)
        {
            var key = (classId, projectId);
            if (Live(key, Now) is not { } current || !current.Holder.Same(holder)) return false;
            return _locks.TryRemove(key, out _);
        }
    }

    public EditLockInfo? Find(Guid classId, Guid projectId) =>
        Live((classId, projectId), Now) is { } entry ? Info(projectId, entry) : null;

    public List<EditLockInfo> List(Guid classId)
    {
        DateTime now = Now;
        return _locks.Where(x => x.Key.ClassId == classId && now - x.Value.Beat <= Ttl).Select(x => Info(x.Key.ProjectId, x.Value)).ToList();
    }

    /// <summary>
    /// 写入项目前检查占用：老师占用时拦住设备，大屏占用时拦住网页。同一类写入方之间不拦，交给修订号判断冲突。
    /// 返回拦住这次写入的占用。
    /// </summary>
    public EditLockInfo? Blocking(Guid classId, Guid projectId, bool byDevice) =>
        Find(classId, projectId) is { } current && current.Holder == (byDevice ? EditLockHolders.User : EditLockHolders.Device) ? current : null;

    /// <summary>移除过期的占用，返回被移除的（班级，占用），由调用方通知网页。</summary>
    public List<(Guid ClassId, EditLockInfo Lock)> Sweep()
    {
        List<(Guid, EditLockInfo)> removed = [];
        lock (_gate)
        {
            DateTime now = Now;
            foreach (var (key, entry) in _locks.ToArray())
                if (now - entry.Beat > Ttl && _locks.TryRemove(key, out _)) removed.Add((key.ClassId, Info(key.ProjectId, entry)));
        }
        return removed;
    }

    private Entry? Live((Guid, Guid) key, DateTime now) =>
        _locks.TryGetValue(key, out var entry) && now - entry.Beat <= Ttl ? entry : null;

    private static EditLockInfo Info(Guid projectId, Entry entry) =>
        new(projectId, entry.Holder.Kind, entry.Holder.DeviceId, entry.Holder.UserId, entry.Holder.ClientId, entry.Holder.Name, entry.Since);
}

/// <summary>定时清理过期的编辑占用（大屏断电、网页直接关掉），并通知打开着的网页。</summary>
public sealed class EditLockSweeper(EditLockService locks, ClassSocketHub hub) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using PeriodicTimer timer = new(TimeSpan.FromSeconds(10));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
                foreach (var (classId, item) in locks.Sweep())
                    await hub.PublishToUsersAsync(new SyncEvent(classId, item.ProjectId, 0, SyncEventTypes.Editing), stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }
}
