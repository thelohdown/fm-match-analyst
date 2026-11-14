using System.Runtime.InteropServices;

namespace FMMatchLens.Plugin.Memory;

internal static class GameMatchTickSignature
{
    // steam-26385295, image base 0x180000000, entry 0x184764AC0.
    // Covers inlined floating-point initialization and three GAME_MATCH state checks.
    // Wildcard the RIP-relative security-cookie reference and branch targets.
    internal const string Pattern =
        "41 57 41 56 41 55 41 54 56 57 55 53 48 83 EC 58 " +
        "48 8B 05 ? ? ? ? 48 31 E0 48 89 44 24 50 " +
        "0F AE 5C 24 4C B8 FF 9F FF FF 23 44 24 4C " +
        "89 44 24 48 0F AE 54 24 48 0F AE 5C 24 44 " +
        "B8 00 80 00 00 0B 44 24 44 89 44 24 40 0F AE 54 24 40 " +
        "80 B9 70 55 01 00 01 0F 85 ? ? ? ? 48 89 CF " +
        "80 B9 6E 55 01 00 01 0F 85 ? ? ? ? " +
        "80 BF 75 55 01 00 00 0F 84 ? ? ? ?";

    // macOS on Apple Silicon runs an arm64 build of game_plugin, so the x86-64
    // pattern above cannot match there. FM27 demo (Steam, macOS), arm64 RVA 0x4499CC0:
    // the frame setup, the saved third argument, then the same three GAME_MATCH
    // state checks, 0x10 lower in the object than on Windows:
    //   ldrb [x22+0x2AC] (match+0x15560) == 1, ldrb [x22+0x2AA] (+0x1555E) == 1,
    //   ldrb [x22+0x2B1] (+0x15565) == 0, with x22 = match + 0x152B4.
    // Branch instructions are wildcarded. Matches exactly one function start there.
    internal const string PatternArm64 =
        "FF 43 02 D1 FC 6F 03 A9 FA 67 04 A9 F8 5F 05 A9 F6 57 06 A9 F4 4F 07 A9 " +
        "FD 7B 08 A9 FD 03 02 91 E2 1F 00 B9 08 54 40 91 16 D1 0A 91 " +
        "C8 B2 4A 39 1F 05 00 71 ? ? ? ? " +
        "C8 AA 4A 39 1F 05 00 71 ? ? ? ? " +
        "C8 C6 4A 39 ? ? ? ?";

    private static readonly byte?[] Bytes = Parse(
        RuntimeInformation.ProcessArchitecture == Architecture.Arm64 ? PatternArm64 : Pattern);

    internal static bool IsAvailable => Bytes.Length > 0;

    internal static int Length => Bytes.Length;

    private static byte?[] Parse(string pattern) => pattern
        .Split(' ', StringSplitOptions.RemoveEmptyEntries)
        .Select(token => token == "?" ? (byte?)null : Convert.ToByte(token, 16)).ToArray();

    // Return false on ambiguity, even if one of the matches is not an entry.
    // The caller retains the candidate across chunks and executable sections.
    internal static bool Scan(ReadOnlySpan<byte> data, int baseRva, ref int matchRva)
    {
        for (var offset = 0; offset <= data.Length - Bytes.Length; offset++)
        {
            var next = data.Slice(offset, data.Length - Bytes.Length - offset + 1)
                .IndexOf(Bytes[0]!.Value);
            if (next < 0) break;
            offset += next;
            var index = 1;
            for (; index < Bytes.Length; index++)
                if (Bytes[index] is { } expected && data[offset + index] != expected)
                    break;
            if (index != Bytes.Length) continue;
            var rva = checked(baseRva + offset);
            if (matchRva >= 0 && matchRva != rva) return false;
            matchRva = rva;
        }
        return true;
    }
}
