using System.Collections.Concurrent;
using System.Net.WebSockets;
using Pancake.Shared;

namespace Pancake.Server.Services;

/// <summary>实时连接的一方：班级大屏、登录老师的网页或公开查看页。</summary>
public enum SocketKind { Device, User, Public }

public sealed class ClassSocketHub
{
    // 同一个连接不能同时发送两条消息：逐连接排队。发不出去（超时或出错）的连接直接中断，客户端重连后会补一次同步。
    private sealed record Connection(WebSocket Socket, SocketKind Kind, Guid? DeviceId, Guid? UserId)
    {
        public SemaphoreSlim SendLock { get; } = new(1, 1);
    }

    private static readonly TimeSpan SendTimeout = TimeSpan.FromSeconds(5);
    private static readonly System.Text.Json.JsonSerializerOptions WebJson = new(System.Text.Json.JsonSerializerDefaults.Web);
    private readonly ConcurrentDictionary<Guid, ConcurrentDictionary<Guid, Connection>> _sockets = new();

    private void Add(Guid classId, Guid connectionId, Connection connection) => _sockets.GetOrAdd(classId, _ => new())[connectionId] = connection;
    private void Remove(Guid classId, Guid connectionId) { if (_sockets.TryGetValue(classId, out var set)) set.TryRemove(connectionId, out _); }
    public int Total => _sockets.Values.Sum(x => x.Count);

    /// <summary>保持实时连接的大屏数量；同一台设备的多个连接只算一台。老师网页和公开页不算。</summary>
    public int OnlineDevices(Guid classId) =>
        _sockets.TryGetValue(classId, out var set) ? set.Values.Where(x => x.DeviceId is not null && x.Socket.State == WebSocketState.Open).Select(x => x.DeviceId).Distinct().Count() : 0;

    /// <summary>设备当前是否保持着实时连接；网页设备列表据此显示“在线”。</summary>
    public bool IsDeviceOnline(Guid classId, Guid deviceId) =>
        _sockets.TryGetValue(classId, out var set) && set.Values.Any(x => x.DeviceId == deviceId && x.Socket.State == WebSocketState.Open);

    public Task PublishAsync(SyncEvent value, CancellationToken cancellationToken) =>
        SendAsync(value.ClassId, value, _ => true, cancellationToken);

    /// <summary>只发给登录老师的网页：编辑占用、屏幕上报这类旧版大屏不认识的通知（旧版遇到不认识的类型会完整同步一轮）。</summary>
    public Task PublishToUsersAsync(SyncEvent value, CancellationToken cancellationToken) =>
        SendAsync(value.ClassId, value, x => x.Kind == SocketKind.User, cancellationToken);

    /// <summary>只发给大屏连接，不把老师打开的网页实时连接计为已送达。</summary>
    public async Task<bool> SendToDevicesAsync(SyncEvent value, CancellationToken cancellationToken) =>
        await SendAsync(value.ClassId, value, x => x.DeviceId.HasValue, cancellationToken) > 0;

    /// <summary>只发给指定设备的连接；返回是否至少送达一个连接。</summary>
    public async Task<bool> SendToDeviceAsync(SyncEvent value, Guid deviceId, CancellationToken cancellationToken) =>
        await SendAsync(value.ClassId, value, x => x.DeviceId == deviceId, cancellationToken) > 0;

    private async Task<int> SendAsync(Guid classId, SyncEvent value, Func<Connection, bool> filter, CancellationToken cancellationToken)
    {
        if (!_sockets.TryGetValue(classId, out var set)) return 0;
        byte[] data = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(value, WebJson);
        bool[] sent = await Task.WhenAll(set.ToArray().Where(x => filter(x.Value)).Select(x => SendOneAsync(classId, x.Key, x.Value, data, cancellationToken)));
        return sent.Count(x => x);
    }

    private async Task<bool> SendOneAsync(Guid classId, Guid connectionId, Connection connection, byte[] data, CancellationToken cancellationToken)
    {
        if (connection.Socket.State != WebSocketState.Open) { Remove(classId, connectionId); return false; }
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(SendTimeout);
        try
        {
            await connection.SendLock.WaitAsync(timeout.Token);
            try { await connection.Socket.SendAsync(data, WebSocketMessageType.Text, true, timeout.Token); }
            finally { connection.SendLock.Release(); }
            return true;
        }
        catch
        {
            // 只移除而不中断的话，客户端以为还连着，从此收不到任何通知。
            Remove(classId, connectionId);
            connection.Socket.Abort();
            return false;
        }
    }

    /// <summary>保持连接直到对方关闭；期间收到的内容会被忽略。</summary>
    public async Task HoldAsync(Guid classId, WebSocket socket, SocketKind kind, Guid? deviceId, Guid? userId, CancellationToken cancellationToken)
    {
        Guid connectionId = Guid.NewGuid(); Add(classId, connectionId, new Connection(socket, kind, deviceId, userId));
        byte[] buffer = new byte[256];
        try
        {
            while (socket.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
            {
                var result = await socket.ReceiveAsync(buffer, cancellationToken);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    // 回应关闭帧，客户端才能正常完成握手而不是报连接被中断。
                    await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "", cancellationToken);
                    break;
                }
            }
        }
        catch { }
        finally { Remove(classId, connectionId); }
    }
}
