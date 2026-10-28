using System.Security.Cryptography;
using Pancake.Shared;

namespace Pancake.Server.Services;

/// <summary>
/// 按 SHA-256 存放的文件仓库：assets/ab/ab12…。写入时边读边算哈希，校验通过后才原子移动到位，
/// 半截上传和哈希不符的内容不会留在仓库里。
/// </summary>
public sealed class AssetStore
{
    public string Root { get; }
    public long MaxBytes { get; }

    public AssetStore(string root, long maxBytes)
    {
        Root = Path.GetFullPath(root);
        MaxBytes = maxBytes;
        Directory.CreateDirectory(Root);
    }

    public string PathOf(string sha256)
    {
        if (!AssetReference.IsSha256(sha256)) throw new ArgumentException("无效的资源哈希。", nameof(sha256));
        string sha = sha256.ToLowerInvariant();
        return Path.Combine(Root, sha[..2], sha);
    }

    public bool Exists(string sha256) => File.Exists(PathOf(sha256));

    /// <summary>保存上传内容；返回写入的字节数。哈希不符或超过上限时抛出 InvalidDataException。</summary>
    public async Task<long> SaveAsync(Stream body, string expectedSha256, CancellationToken cancellationToken)
    {
        string target = PathOf(expectedSha256);
        string temporary = Path.Combine(Root, $".upload-{Guid.NewGuid():N}.tmp");
        long total = 0;
        try
        {
            using (IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256))
            await using (FileStream output = new(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, true))
            {
                byte[] buffer = new byte[81920];
                int read;
                while ((read = await body.ReadAsync(buffer, cancellationToken)) > 0)
                {
                    total += read;
                    if (total > MaxBytes) throw new InvalidDataException($"文件超过服务器限制（{MaxBytes / 1024 / 1024} MB）。");
                    hash.AppendData(buffer, 0, read);
                    await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                }
                string actual = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
                if (actual != expectedSha256.ToLowerInvariant()) throw new InvalidDataException("文件内容与哈希不符。");
            }
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            if (!File.Exists(target)) File.Move(temporary, target);
            return total;
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    /// <summary>网页上传：浏览器在非 HTTPS 局域网地址下没有 crypto.subtle，由服务端计算哈希。</summary>
    public async Task<(string Sha256, long Size)> SaveUnhashedAsync(Stream body, CancellationToken cancellationToken)
    {
        string temporary = Path.Combine(Root, $".upload-{Guid.NewGuid():N}.tmp");
        try
        {
            long total = 0;
            string sha;
            using (IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256))
            await using (FileStream output = new(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, true))
            {
                byte[] buffer = new byte[81920];
                int read;
                while ((read = await body.ReadAsync(buffer, cancellationToken)) > 0)
                {
                    total += read;
                    if (total > MaxBytes) throw new InvalidDataException($"文件超过服务器限制（{MaxBytes / 1024 / 1024} MB）。");
                    hash.AppendData(buffer, 0, read);
                    await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                }
                sha = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
            }
            if (total == 0) throw new InvalidDataException("文件为空。");
            string target = PathOf(sha);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            if (!File.Exists(target)) File.Move(temporary, target);
            return (sha, total);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    /// <summary>可以在浏览器里直接显示的类型；其余一律作为下载，防止上传的网页或 SVG 在本站执行脚本。</summary>
    public static bool IsInlineSafe(string contentType) => contentType.StartsWith("image/", StringComparison.Ordinal) && contentType != "image/svg+xml"
        || contentType.StartsWith("video/", StringComparison.Ordinal);

    public static string ContentTypeFor(string extension) => AssetReference.NormalizeExtension(extension) switch
    {
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".bmp" => "image/bmp",
        ".svg" => "image/svg+xml",
        ".mp4" or ".m4v" => "video/mp4",
        ".webm" => "video/webm",
        ".mov" => "video/quicktime",
        ".wmv" => "video/x-ms-wmv",
        ".avi" => "video/x-msvideo",
        ".pdf" => "application/pdf",
        _ => "application/octet-stream"
    };
}
