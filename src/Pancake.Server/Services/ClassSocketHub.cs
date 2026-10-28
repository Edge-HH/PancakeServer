using System.Collections.Concurrent;
using System.Net.WebSockets;
using Pancake.Shared;

namespace Pancake.Server.Services;

public sealed class ClassSocketHub
{
    private sealed record Connection(WebSocket Socket, Guid? DeviceId);

    private static readonly System.Text.Json.JsonSerializerOptions WebJson = new(System.Text.Json.JsonSerializerDefaults.Web);
    private readonly ConcurrentDictionary<Guid, ConcurrentDictionary<Guid, Connection>> _sockets = new();

    private void Add(Guid classId, Guid connectionId, Connection connection) => _sockets.GetOrAdd(classId, _ => new())[connectionId] = connection;
    private void Remove(Guid classId, Guid connectionId) { if (_sockets.TryGetValue(classId, out var set)) set.TryRemove(connectionId, out _); }
    public int Count(Guid classId) => _sockets.TryGetValue(classId, out var set) ? set.Count : 0;
    public int Total => _sockets.Values.Sum(x => x.Count);

    /// <summary>设备当前是否保持着实时连接；网页设备列表据此显示“在线”。</summary>
    public bool IsDeviceOnline(Guid classId, Guid deviceId) =>
        _sockets.TryGetValue(classId, out var set) && set.Values.Any(x => x.DeviceId == deviceId && x.Socket.State == WebSocketState.Open);

    public Task PublishAsync(SyncEvent value, CancellationToken cancellationToken) =>
        SendAsync(value.ClassId, value, _ => true, cancellationToken);

    /// <summary>只发给指定设备的连接；返回是否至少送达一个连接。</summary>
    public async Task<bool> SendToDeviceAsync(SyncEvent value, Guid deviceId, CancellationToken cancellationToken) =>
        await SendAsync(value.ClassId, value, x => x.DeviceId == deviceId, cancellationToken) > 0;

    private async Task<int> SendAsync(Guid classId, SyncEvent value, Func<Connection, bool> filter, CancellationToken cancellationToken)
    {
        if (!_sockets.TryGetValue(classId, out var set)) return 0;
        byte[] data = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(value, WebJson);
        int sent = 0;
        foreach (var item in set.ToArray())
        {
            if (!filter(item.Value)) continue;
            if (item.Value.Socket.State != WebSocketState.Open) { Remove(classId, item.Key); continue; }
            try { await item.Value.Socket.SendAsync(data, WebSocketMessageType.Text, true, cancellationToken); sent++; }
            catch { Remove(classId, item.Key); }
        }
        return sent;
    }

    /// <summary>保持连接直到对方关闭；期间收到的内容会被忽略。</summary>
    public async Task HoldAsync(Guid classId, WebSocket socket, CancellationToken cancellationToken, Guid? deviceId = null)
    {
        Guid connectionId = Guid.NewGuid(); Add(classId, connectionId, new Connection(socket, deviceId));
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
