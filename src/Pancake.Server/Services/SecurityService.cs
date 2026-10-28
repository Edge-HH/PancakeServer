using System.Security.Cryptography;
using System.Text;

namespace Pancake.Server.Services;

public static class SecurityService
{
    public static string HashPassword(string password)
    {
        byte[] salt = RandomNumberGenerator.GetBytes(16);
        byte[] hash = Rfc2898DeriveBytes.Pbkdf2(password, salt, 120_000, HashAlgorithmName.SHA256, 32);
        return $"pbkdf2$120000${Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}";
    }

    public static bool VerifyPassword(string password, string encoded)
    {
        string[] parts = encoded.Split('$');
        if (parts.Length != 4 || parts[0] != "pbkdf2" || !int.TryParse(parts[1], out int iterations)) return false;
        byte[] salt = Convert.FromBase64String(parts[2]);
        byte[] expected = Convert.FromBase64String(parts[3]);
        byte[] actual = Rfc2898DeriveBytes.Pbkdf2(password, salt, iterations, HashAlgorithmName.SHA256, expected.Length);
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }

    /// <summary>默认密码、过短或与账号相同的密码会在控制台提示修改。</summary>
    public static bool IsWeakPassword(string password, string userName) =>
        password.Length < 8 || string.Equals(password, userName, StringComparison.OrdinalIgnoreCase) || password is "admin" or "12345678" or "password";

    public static string NewToken(int bytes = 32) => Convert.ToBase64String(RandomNumberGenerator.GetBytes(bytes));
    public static string PublicCode() => Convert.ToHexString(RandomNumberGenerator.GetBytes(4)).ToLowerInvariant();
}
