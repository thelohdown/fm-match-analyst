using FMMatchLens.Plugin.Diagnostics;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace FMMatchLens.Plugin.Memory;

/// <summary>
/// macOS-only, read-only probe of the GAME_MATCH Advance function. It hooks the
/// function located in the arm64 build, calls the original first, and then only
/// reads: it logs a few candidate fields per match object and saves raw snapshots
/// of the object, so the macOS layout can be checked against what the game shows.
/// It runs instead of the full capture until the macOS offsets are verified.
/// </summary>
internal sealed class MacMatchProbe
{
    // Known macOS builds of game_plugin (SHA-256 of Contents/MacOS/game_plugin).
    private static readonly (string Name, string Sha256, int Arm64Rva)[] KnownBuilds =
    [
        ("steam-mac-fm27-demo", "c1298708d883972529621746f3e91dd90254a5ebd3569d388322be38f0b0107a", 0x4499CC0),
    ];

    // Candidate macOS offsets: the Windows Offsets.GameMatch value minus 0x10, as
    // seen in both slices of the demo build. Windows values are logged beside them.
    private const int Shift = -0x10;
    private const int Tick = 0x154EC + Shift;
    private const int DisplayTick = 0x15464 + Shift;
    private const int Period = 0x15547 + Shift;
    private const int LifecycleA = 0x15568 + Shift;
    private const int BallPosition = 0x12A40 + Shift;
    private const int HomeTeam = 0x15380 + Shift;
    private const int AwayTeam = 0x15388 + Shift;

    private const int SnapshotSize = 0x16000;
    private const int TeamSnapshotSize = 0x4000;
    private const int MaxSnapshots = 60;
    private const int MaxSnapshotsPerMatch = 6;
    private const int SnapshotAfterCalls = 50;
    private const int SnapshotEveryTicks = 1200;
    private static readonly TimeSpan LogInterval = TimeSpan.FromSeconds(5);

    private readonly string _outputDirectory;
    private readonly MatchUpdateDelegate _hookDelegate;
    private readonly ConcurrentDictionary<nint, MatchState> _matches = new();
    private NativeDetourHandle? _detour;
    private MatchUpdateDelegate? _original;
    private Timer? _retryTimer;
    private int _installing;
    private int _snapshots;
    private bool _rejected;
    private bool _waitLogged;
    private int _failuresLogged;

    public MacMatchProbe(string outputDirectory)
    {
        _outputDirectory = outputDirectory;
        _hookDelegate = Hook;
    }

    public bool IsInstalled => _detour is not null;

    public void Start()
    {
        PluginLogger.Info($"[macOS probe] Read-only probe mode; snapshots go to {_outputDirectory}.");
        _retryTimer = new Timer(_ => TryInstall(), null, TimeSpan.Zero, TimeSpan.FromSeconds(1));
    }

    public void Stop()
    {
        _retryTimer?.Dispose();
        _retryTimer = null;
        _detour?.Dispose();
        _detour = null;
        _original = null;
    }

    private void TryInstall()
    {
        if (IsInstalled || _rejected)
        {
            _retryTimer?.Dispose();
            _retryTimer = null;
            return;
        }

        if (Interlocked.Exchange(ref _installing, 1) == 1) return;
        try
        {
            var header = MacNative.FindGamePlugin(out var path, out _);
            if (header == default)
            {
                if (!_waitLogged) PluginLogger.Info("[macOS probe] Waiting for game_plugin to load.");
                _waitLogged = true;
                return;
            }

            var sha256 = HashFile(path);
            var known = KnownBuilds.FirstOrDefault(b => b.Sha256 == sha256);
            int rva;
            string source;
            if (known.Name is not null)
            {
                rva = known.Arm64Rva;
                source = $"known build {known.Name}";
            }
            else if (GamePluginBuildCatalog.TryResolveAob(header, path, sha256, out var build, out var failure))
            {
                rva = build.MatchTickHookRva;
                // The BepInEx launcher re-signs a copy of the game, which changes the file hash but not the code.
                source = KnownBuilds.Any(b => b.Arm64Rva == rva)
                    ? "arm64 AOB signature, same RVA as the known FM27 demo build"
                    : "arm64 AOB signature";
            }
            else
            {
                _rejected = true;
                PluginLogger.Warning($"[macOS probe] Unknown game_plugin build (sha256={sha256}); {failure}. Probe disabled.");
                return;
            }

            if (!MacNative.IsFunctionEntry(header, rva))
            {
                _rejected = true;
                PluginLogger.Warning($"[macOS probe] RVA 0x{rva:X} is not a function start in {path}. Probe disabled.");
                return;
            }

            PluginLogger.Info($"[macOS probe] Detour provider: {NativeDetourCompat.DescribeProvider()}");
            _detour = NativeDetourCompat.CreateAndApply(header + rva, _hookDelegate, original => _original = original);
            PluginLogger.Info(
                $"[macOS probe] Hooked GAME_MATCH Advance at game_plugin+0x{rva:X} ({source}, sha256={sha256}) " +
                $"via {_detour.Provider}, trampoline=0x{(long)_detour.TrampolinePtr:X}.");
        }
        catch (Exception ex)
        {
            _rejected = true;
            PluginLogger.Warning($"[macOS probe] Install failed: {ex}");
        }
        finally
        {
            Interlocked.Exchange(ref _installing, 0);
        }
    }

    private void Hook(nint match, uint mode, int targetTick)
    {
        var original = _original;
        if (original is null) return;
        original(match, mode, targetTick);
        try
        {
            Observe(match, mode, targetTick);
        }
        catch (Exception ex)
        {
            // Never let a managed exception cross back into native code.
            if (Interlocked.Increment(ref _failuresLogged) <= 5)
            {
                try { PluginLogger.Warning($"[macOS probe] Observe failed: {ex.Message}"); } catch { }
            }
        }
    }

    private void Observe(nint match, uint mode, int targetTick)
    {
        var state = _matches.GetOrAdd(match, _ => new MatchState());
        var calls = Interlocked.Increment(ref state.Calls);
        lock (state)
        {
            state.Modes.Add(mode);
            state.LastTargetTick = targetTick;
            var tick = ReadInt32(match + Tick);
            var now = DateTime.UtcNow;

            if (calls == 1 || now - state.LastLog >= LogInterval)
            {
                state.LastLog = now;
                PluginLogger.Info(Describe(match, state, tick));
            }

            // FM advances many matches at once; wait until a match has run for a while
            // so background simulations do not use up the snapshot budget.
            var due = calls >= SnapshotAfterCalls && state.Snapshots < MaxSnapshotsPerMatch &&
                      (state.Snapshots == 0 || (tick is { } t && t - state.LastSnapshotTick >= SnapshotEveryTicks));
            if (due && Interlocked.Increment(ref _snapshots) <= MaxSnapshots)
            {
                state.Snapshots++;
                state.LastSnapshotTick = tick ?? state.LastSnapshotTick;
                Snapshot(match, tick ?? -1, targetTick);
            }
        }
    }

    private static string Describe(nint match, MatchState state, int? tick)
    {
        var text = new StringBuilder();
        text.Append($"[macOS probe] match=0x{(ulong)match:X} calls={state.Calls} modes={string.Join("/", state.Modes)} ");
        text.Append($"targetTick={state.LastTargetTick} ");
        text.Append($"tick@0x{Tick:X}={Show(tick)} (Windows 0x154EC={Show(ReadInt32(match + 0x154EC))}) ");
        text.Append($"displayTick@0x{DisplayTick:X}={Show(ReadInt32(match + DisplayTick))} ");
        text.Append($"period@0x{Period:X}={Show(ReadByte(match + Period))} ");
        text.Append($"lifecycle@0x{LifecycleA:X}={ShowBytes(match + LifecycleA, 4)} ");
        text.Append($"checks={ShowBytes(match + 0x1555E, 1)}/{ShowBytes(match + 0x15560, 1)}/{ShowBytes(match + 0x15565, 1)} ");
        text.Append($"ball@0x{BallPosition:X}=({ShowFloat(match + BallPosition + Offsets.BallPosition.X)}, ");
        text.Append($"{ShowFloat(match + BallPosition + Offsets.BallPosition.Y)}, {ShowFloat(match + BallPosition + Offsets.BallPosition.Z)}) ");
        text.Append($"home@0x{HomeTeam:X}={ShowPointer(match + HomeTeam)} away@0x{AwayTeam:X}={ShowPointer(match + AwayTeam)}");
        return text.ToString();
    }

    private void Snapshot(nint match, int tick, int targetTick)
    {
        var size = VirtualMemory.IsReadable(match, SnapshotSize) ? SnapshotSize
            : VirtualMemory.IsReadable(match, Tick + 0x100) ? Tick + 0x100 : 0;
        if (size == 0) return;
        var bytes = new byte[size];
        Marshal.Copy(match, bytes, 0, size);
        var home = CopyPointee(match + HomeTeam);
        var away = CopyPointee(match + AwayTeam);
        var stamp = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff");
        var baseName = $"match-{(ulong)match:X}-tick{tick}-target{targetTick}-{stamp}";
        var directory = _outputDirectory;
        Task.Run(() =>
        {
            try
            {
                Directory.CreateDirectory(directory);
                File.WriteAllBytes(Path.Combine(directory, baseName + ".bin"), bytes);
                if (home is not null) File.WriteAllBytes(Path.Combine(directory, baseName + "-home.bin"), home);
                if (away is not null) File.WriteAllBytes(Path.Combine(directory, baseName + "-away.bin"), away);
            }
            catch (Exception ex)
            {
                PluginLogger.Warning($"[macOS probe] Snapshot write failed: {ex.Message}");
            }
        });
    }

    private static byte[]? CopyPointee(nint field)
    {
        var pointer = ReadPointer(field);
        if (pointer is not { } target || !VirtualMemory.IsReadable(target, TeamSnapshotSize)) return null;
        var bytes = new byte[TeamSnapshotSize];
        Marshal.Copy(target, bytes, 0, TeamSnapshotSize);
        return bytes;
    }

    private static int? ReadInt32(nint address) =>
        VirtualMemory.IsReadable(address, 4) ? Marshal.ReadInt32(address) : null;

    private static byte? ReadByte(nint address) =>
        VirtualMemory.IsReadable(address, 1) ? Marshal.ReadByte(address) : null;

    private static nint? ReadPointer(nint address) =>
        VirtualMemory.IsReadable(address, 8) ? Marshal.ReadIntPtr(address) : null;

    private static string Show<T>(T? value) where T : struct => value?.ToString() ?? "unreadable";

    private static string ShowFloat(nint address) =>
        VirtualMemory.IsReadable(address, 4)
            ? BitConverter.Int32BitsToSingle(Marshal.ReadInt32(address)).ToString("0.##")
            : "unreadable";

    private static string ShowBytes(nint address, int count)
    {
        if (!VirtualMemory.IsReadable(address, count)) return "unreadable";
        var bytes = new byte[count];
        Marshal.Copy(address, bytes, 0, count);
        return Convert.ToHexString(bytes);
    }

    private static string ShowPointer(nint address)
    {
        var pointer = ReadPointer(address);
        if (pointer is not { } value) return "unreadable";
        return $"0x{(ulong)value:X}{(VirtualMemory.IsReadable(value, 8) ? "" : " (not mapped)")}";
    }

    private static string HashFile(string path)
    {
        using var stream = File.OpenRead(path);
        using var algorithm = SHA256.Create();
        return Convert.ToHexString(algorithm.ComputeHash(stream)).ToLowerInvariant();
    }

    private sealed class MatchState
    {
        public long Calls;
        public readonly SortedSet<uint> Modes = [];
        public int LastTargetTick;
        public int Snapshots;
        public int LastSnapshotTick = int.MinValue / 2;
        public DateTime LastLog = DateTime.MinValue;
    }

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate void MatchUpdateDelegate(nint match, uint mode, int targetTick);
}
