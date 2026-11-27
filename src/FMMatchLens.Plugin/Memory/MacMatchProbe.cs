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
/// reads: it logs a few candidate fields per match object and saves "graph"
/// snapshots of the match, its teams, the objects the teams point to (match
/// players), and the objects those point to (people, names), so the macOS layout
/// can be mapped offline. It runs instead of the full capture until the macOS
/// offsets are verified.
/// </summary>
internal sealed class MacMatchProbe
{
    // Known macOS builds of game_plugin (SHA-256 of Contents/MacOS/game_plugin).
    private static readonly (string Name, string Sha256, int Arm64Rva)[] KnownBuilds =
    [
        ("steam-mac-fm27-demo", "c1298708d883972529621746f3e91dd90254a5ebd3569d388322be38f0b0107a", 0x4499CC0),
        ("steam-mac-fm27", "68adfde2e0588458c1830cb7e688855d9c61237973a7eb7a105af5ac4ed112a4", 0x44A6450),
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
    private const int MaxSnapshots = 40;
    private const int MaxSnapshotsPerMatch = 2;
    private const int SnapshotAfterCalls = 50;
    private const int SnapshotEveryTicks = 1200;

    // Graph snapshot sizes and limits (see DeepSnapshot).
    private const int MatchChildSize = 0x800;
    private const int TeamChildSize = 0x2000;
    private const int TeamScanEnd = 0x800;
    private const int PlayerScanEnd = 0x100;
    private const int BackPointerScanEnd = 0x400;
    private const int WindowBefore = 0x400;
    private const int WindowSize = 0x800;
    private const int WindowScan = 0x140;
    private const int LeafSize = 0x80;
    private const int MaxMatchChildren = 64;
    private const int MaxTeamChildren = 160;
    private const int MaxPlayerChildren = 12;
    private const int MaxWindowChildren = 24;
    private const int MaxRecords = 4000;
    private const int ShirtNameCandidate = 0x38;
    private const string TriggerFileName = "snapshot-now";
    private const int MomentumEventSourceCandidate = 0x14E98;
    private const int StatsCandidate = 0x1880;
    private const int StatsSize = 0x180;
    private const int MomentumEventSize = 0x38;
    private const ulong MaxEventBytes = 0x38UL * 20000;
    private const int MaxManualSnapshots = 40;
    private const long IdleMatchMaxAgeMs = 2 * 60 * 60 * 1000;
    private const long StoppedAfterCalls = 1000;
    private const long StoppedAfterMs = 5000;
    private const int MaxStoppedSnapshotsPerMatch = 4;
    private const uint GraphMagic = 0x47504D46; // "FMPG"
    private const uint GraphVersion = 1;
    private static readonly TimeSpan LogInterval = TimeSpan.FromSeconds(5);

    private readonly string _outputDirectory;
    private readonly MatchUpdateDelegate _hookDelegate;
    private readonly ConcurrentDictionary<nint, MatchState> _matches = new();
    private NativeDetourHandle? _detour;
    private (ulong Start, ulong End)[] _imageSpans = [];
    private MatchUpdateDelegate? _original;
    private Timer? _retryTimer;
    private Timer? _idleTimer;
    private long _generationStartedAt;
    private int _installing;
    private int _snapshots;
    private int _manualSnapshots;
    private int _manualGeneration;
    private long _nextTriggerCheck;
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
        _idleTimer = new Timer(_ => SnapshotIdleMatches(), null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
    }

    public void Stop()
    {
        _retryTimer?.Dispose();
        _retryTimer = null;
        _idleTimer?.Dispose();
        _idleTimer = null;
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

            _imageSpans = BuildImageSpans();
            PluginLogger.Info($"[macOS probe] {_imageSpans.Length} image address ranges excluded from graph snapshots.");
            // The same steps as the capture hook: create, generate the trampoline, apply.
            _detour = NativeDetourHandle.Create(header + rva, _hookDelegate);
            _original = _detour.GenerateTrampoline<MatchUpdateDelegate>();
            if (_detour.TrampolinePtr == 0)
                throw new InvalidOperationException("Native detour returned a null trampoline.");
            _detour.Apply();
            PluginLogger.Info(
                $"[macOS probe] Hooked GAME_MATCH Advance at game_plugin+0x{rva:X} ({source}, sha256={sha256}), " +
                $"trampoline=0x{(long)_detour.TrampolinePtr:X}.");
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
        Volatile.Write(ref state.LastCallAt, Environment.TickCount64);
        lock (state)
        {
            state.Modes.Add(mode);
            if (calls == 1 || state.HomeTeam == 0) state.HomeTeam = ReadPointer(match + HomeTeam) ?? 0;
            state.LastTargetTick = targetTick;
            var tick = ReadInt32(match + Tick);
            var now = DateTime.UtcNow;

            if (calls == 1 || now - state.LastLog >= LogInterval)
            {
                state.LastLog = now;
                PluginLogger.Info(Describe(match, state, tick));
            }

            // On demand: every live match takes one snapshot after a trigger file appears.
            CheckTrigger();
            var generation = Volatile.Read(ref _manualGeneration);
            if (state.ManualGeneration != generation && calls >= SnapshotAfterCalls)
            {
                state.ManualGeneration = generation;
                if (Interlocked.Increment(ref _manualSnapshots) <= MaxManualSnapshots)
                {
                    DeepSnapshot(match, tick ?? -1, targetTick, "manual");
                    return;
                }
            }

            // FM advances many matches at once; wait until a match has run for a while
            // so background simulations do not use up the snapshot budget.
            var due = calls >= SnapshotAfterCalls && state.Snapshots < MaxSnapshotsPerMatch &&
                      (state.Snapshots == 0 || (tick is { } t && t - state.LastSnapshotTick >= SnapshotEveryTicks));
            if (due && Interlocked.Increment(ref _snapshots) <= MaxSnapshots)
            {
                state.Snapshots++;
                state.LastSnapshotTick = tick ?? state.LastSnapshotTick;
                DeepSnapshot(match, tick ?? -1, targetTick);
            }
        }
    }

    /// <summary>At most once a second, looks for the trigger file and starts a new manual round.</summary>
    private void CheckTrigger()
    {
        var now = Environment.TickCount64;
        var next = Interlocked.Read(ref _nextTriggerCheck);
        if (now < next || Interlocked.CompareExchange(ref _nextTriggerCheck, now + 1000, next) != next) return;
        var path = Path.Combine(_outputDirectory, TriggerFileName);
        if (!File.Exists(path)) return;
        try { File.Delete(path); } catch { /* the next check would see it again; a second round is harmless */ }
        Interlocked.Exchange(ref _generationStartedAt, now);
        var generation = Interlocked.Increment(ref _manualGeneration);
        PluginLogger.Info(
            $"[macOS probe] Snapshot requested (round {generation}); each live match saves one on its next step, " +
            "or within a few seconds if it is paused or over.");
    }

    /// <summary>
    /// Runs once a second on a timer. Picks up the trigger file even when no match is
    /// stepping, and two seconds into a manual round snapshots the matches that have not
    /// stepped since (paused, or past the final whistle) from this thread. A match is only
    /// read if its object still points at the same home team, so a freed match is skipped.
    /// </summary>
    private void SnapshotIdleMatches()
    {
        try
        {
            CheckTrigger();
            SnapshotStoppedMatches();
            var generation = Volatile.Read(ref _manualGeneration);
            if (generation == 0) return;
            var now = Environment.TickCount64;
            if (now - Interlocked.Read(ref _generationStartedAt) < 2000) return;
            foreach (var (match, state) in _matches)
            {
                if (state.ManualGeneration == generation || Interlocked.Read(ref state.Calls) < SnapshotAfterCalls) continue;
                if (now - Volatile.Read(ref state.LastCallAt) > IdleMatchMaxAgeMs) continue;
                lock (state)
                {
                    if (state.ManualGeneration == generation) continue;
                    state.ManualGeneration = generation;
                    if (state.HomeTeam == 0 || ReadPointer(match + HomeTeam) != state.HomeTeam) continue;
                    if (Interlocked.Increment(ref _manualSnapshots) > MaxManualSnapshots) return;
                    DeepSnapshot(match, ReadInt32(match + Tick) ?? -1, state.LastTargetTick, "manual");
                }
            }
        }
        catch (Exception ex)
        {
            if (Interlocked.Increment(ref _failuresLogged) <= 5)
                PluginLogger.Warning($"[macOS probe] Idle snapshot failed: {ex.Message}");
        }
    }

    /// <summary>
    /// Saves a snapshot of a match that has played for a while and then stopped stepping
    /// for a few seconds: the final whistle, or a pause. Full-time numbers are then on
    /// disk without anyone asking. At most a few per match, one per stop.
    /// </summary>
    private void SnapshotStoppedMatches()
    {
        var now = Environment.TickCount64;
        foreach (var (match, state) in _matches)
        {
            var calls = Interlocked.Read(ref state.Calls);
            if (calls < StoppedAfterCalls || state.StoppedSnapshots >= MaxStoppedSnapshotsPerMatch) continue;
            var lastCall = Volatile.Read(ref state.LastCallAt);
            if (now - lastCall < StoppedAfterMs || now - lastCall > IdleMatchMaxAgeMs) continue;
            lock (state)
            {
                if (state.StoppedAtCalls == calls) continue;
                state.StoppedAtCalls = calls;
                if (state.HomeTeam == 0 || ReadPointer(match + HomeTeam) != state.HomeTeam) continue;
                state.StoppedSnapshots++;
                DeepSnapshot(match, ReadInt32(match + Tick) ?? -1, state.LastTargetTick, "stopped");
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

    /// <summary>
    /// Copies the match object, both team objects, and the objects reachable from them
    /// into one "graph" file. Depth 1: heap objects the match points to near its team and
    /// official fields, and every heap object the teams point to in their first 0x800
    /// bytes. Objects among those that point back to the match are taken to be match
    /// players; depth 2 copies a window around each heap object they point to in their
    /// first 0x100 bytes (people, shirt names), and depth 3 the small objects those
    /// point to (names). Pointers into loaded images (vtables, code) are skipped.
    /// File layout: "FMPG", u32 version, u64 match, i32 tick, i32 targetTick,
    /// u32 record count; then per record: u64 address, u64 pointer that led to it,
    /// u32 size, i32 parent record, u32 offset in parent, u32 depth, bytes.
    /// </summary>
    private void DeepSnapshot(nint match, int tick, int targetTick, string kind = "auto")
    {
        using var scope = VirtualMemory.BeginReadScope();
        var graph = new Graph();
        var matchAddress = (ulong)match;
        var root = graph.Add(matchAddress, matchAddress, SnapshotSize, -1, 0, 0);
        if (root < 0) return;

        var summary = new StringBuilder();
        var teams = new[] { ("home", HomeTeam), ("away", AwayTeam) };
        var teamRecords = new List<(string Side, int Index)>();
        foreach (var (side, field) in teams)
        {
            var pointer = ReadPointer(match + field);
            if (pointer is not { } team) continue;
            var index = graph.Add((ulong)team, (ulong)team, TeamSnapshotSize, root, field, 1);
            if (index >= 0) teamRecords.Add((side, index));
        }

        foreach (var (side, teamIndex) in teamRecords)
        {
            var teamBytes = graph.Records[teamIndex].Data;
            var players = new List<int>();
            var backOffsets = new SortedDictionary<int, int>();
            int firstOffset = int.MaxValue, lastOffset = -1, children = 0;
            for (var offset = 0; offset + 8 <= TeamScanEnd && offset + 8 <= teamBytes.Length && children < MaxTeamChildren; offset += 8)
            {
                var value = BitConverter.ToUInt64(teamBytes, offset);
                if (!IsHeapPointer(value) || value == matchAddress) continue;
                var child = graph.Add(value, value, TeamChildSize, teamIndex, offset, 2);
                if (child < 0) continue;
                children++;
                var back = FindQword(graph.Records[child].Data, matchAddress, BackPointerScanEnd);
                if (back < 0) continue;
                players.Add(child);
                backOffsets[back] = backOffsets.GetValueOrDefault(back) + 1;
                firstOffset = Math.Min(firstOffset, offset);
                lastOffset = Math.Max(lastOffset, offset);
            }

            foreach (var player in players)
            {
                var playerBytes = graph.Records[player].Data;
                // MatchPlayer.Stats: a pointer at 0x1880, as on Windows, to the per-match stats
                // (goals, assists, shots, passes, tackles; Windows fields reach 0xF6).
                if (playerBytes.Length >= StatsCandidate + 8)
                {
                    var stats = BitConverter.ToUInt64(playerBytes, StatsCandidate);
                    if (IsHeapPointer(stats, 3)) graph.Add(stats, stats, StatsSize, player, StatsCandidate, 3);
                }

                var windows = 0;
                for (var offset = 0; offset + 8 <= PlayerScanEnd && windows < MaxPlayerChildren; offset += 8)
                {
                    var value = BitConverter.ToUInt64(playerBytes, offset);
                    // Player fields can point at 4-byte aligned subobjects and strings.
                    if (!IsHeapPointer(value, 3) || value == matchAddress) continue;
                    var window = graph.AddWindow(value, WindowBefore, WindowSize, player, offset, 3);
                    if (window < 0) continue;
                    windows++;

                    var record = graph.Records[window];
                    var anchor = (int)(value - record.Address);
                    var leaves = 0;
                    for (var inner = Math.Max(0, anchor - WindowScan); inner + 8 <= anchor + WindowScan && inner + 8 <= record.Data.Length && leaves < MaxWindowChildren; inner += 8)
                    {
                        var leaf = BitConverter.ToUInt64(record.Data, inner);
                        if (!IsHeapPointer(leaf, 3)) continue;
                        if (graph.Add(leaf, leaf, LeafSize, window, inner, 4) >= 0) leaves++;
                    }
                }
            }

            summary.Append($" {side}: {children} objects, {players.Count} point back to the match");
            var names = players.Take(4)
                .Select(p => ReadFmString(BitConverter.ToUInt64(graph.Records[p].Data, ShirtNameCandidate)))
                .Where(n => n is not null)
                .ToList();
            if (names.Count > 0) summary.Append($", shirt names at +0x{ShirtNameCandidate:X}: {string.Join(", ", names)}");
            if (players.Count > 0)
            {
                summary.Append($" (at {string.Join(", ", backOffsets.Select(p => $"+0x{p.Key:X}x{p.Value}"))};");
                summary.Append($" from team offsets 0x{firstOffset:X}-0x{lastOffset:X})");
            }
            summary.Append('.');
        }

        // Objects the match points to around its officials, ball holders and teams. This runs
        // after the teams: the match also lists the players near 0x14ED0, and they should be
        // copied in full as team children first.
        var matchBytes = graph.Records[root].Data;
        var added = 0;
        foreach (var (start, end) in new[] { (0x600, 0x700), (0x14E00, 0x15560) })
        {
            for (var offset = start; offset + 8 <= end && offset + 8 <= matchBytes.Length && added < MaxMatchChildren; offset += 8)
            {
                var value = BitConverter.ToUInt64(matchBytes, offset);
                if (!IsHeapPointer(value)) continue;
                if (graph.Add(value, value, MatchChildSize, root, offset, 1) >= 0) added++;
            }
        }

        // Momentum events: match+0x14E98 (Windows 0x14EA8 - 0x10) points to the event source, whose
        // +0x08/+0x10 are the begin/end of an array of 0x38-byte events, as on Windows.
        var sourceIndex = graph.Records.FindIndex(r => r.Parent == root && r.ParentOffset == MomentumEventSourceCandidate);
        if (sourceIndex >= 0 && graph.Records[sourceIndex].Data.Length >= 0x18)
        {
            var source = graph.Records[sourceIndex].Data;
            var begin = BitConverter.ToUInt64(source, 0x08);
            var end = BitConverter.ToUInt64(source, 0x10);
            var length = end - begin;
            if (begin != 0 && end > begin && length % MomentumEventSize == 0 && length <= MaxEventBytes &&
                graph.Add(begin, begin, (int)length, sourceIndex, 0x08, 2) is var eventsIndex && eventsIndex >= 0)
            {
                var events = graph.Records[eventsIndex].Data;
                var shots = new SortedDictionary<int, int>();
                var onTarget = new SortedDictionary<int, int>();
                for (var offset = 0; offset + MomentumEventSize <= events.Length; offset += MomentumEventSize)
                {
                    int team = events[offset + 0x28], type = events[offset + 0x2A];
                    if (type is >= 1 and <= 5) shots[team] = shots.GetValueOrDefault(team) + 1;
                    if (type is 1 or 4) onTarget[team] = onTarget.GetValueOrDefault(team) + 1;
                }

                summary.Append($" {events.Length / MomentumEventSize} momentum events; shots by team byte ");
                summary.Append(string.Join(", ", shots.Select(p => $"{p.Key}:{p.Value}")));
                summary.Append(", on target ");
                summary.Append(string.Join(", ", onTarget.Select(p => $"{p.Key}:{p.Value}")));
                summary.Append('.');
            }
        }

        var stamp = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff");
        var suffix = kind == "auto" ? string.Empty : "-" + kind;
        var fileName = $"match-{matchAddress:X}-tick{tick}-target{targetTick}-{stamp}{suffix}-graph.bin";
        PluginLogger.Info(
            $"[macOS probe] Graph snapshot ({kind}) of match 0x{matchAddress:X} at tick {tick}: {graph.Records.Count} objects, " +
            $"{graph.Bytes / 1024} KiB.{summary}");

        var directory = _outputDirectory;
        Task.Run(() =>
        {
            try
            {
                Directory.CreateDirectory(directory);
                using var stream = File.Create(Path.Combine(directory, fileName));
                using var writer = new BinaryWriter(stream);
                writer.Write(GraphMagic);
                writer.Write(GraphVersion);
                writer.Write(matchAddress);
                writer.Write(tick);
                writer.Write(targetTick);
                writer.Write((uint)graph.Records.Count);
                foreach (var record in graph.Records)
                {
                    writer.Write(record.Address);
                    writer.Write(record.Pointer);
                    writer.Write((uint)record.Data.Length);
                    writer.Write(record.Parent);
                    writer.Write((uint)record.ParentOffset);
                    writer.Write((uint)record.Depth);
                    writer.Write(record.Data);
                }
            }
            catch (Exception ex)
            {
                PluginLogger.Warning($"[macOS probe] Snapshot write failed: {ex.Message}");
            }
        });
    }

    private bool IsHeapPointer(ulong value, ulong alignmentMask = 7)
    {
        if (value < 0x1_0000_0000UL || value >= 0x8000_0000_0000UL || (value & alignmentMask) != 0) return false;
        var spans = _imageSpans;
        int low = 0, high = spans.Length - 1;
        while (low <= high)
        {
            var mid = (low + high) >>> 1;
            if (spans[mid].End <= value) low = mid + 1;
            else if (spans[mid].Start > value) high = mid - 1;
            else return false;
        }

        return true;
    }

    private static (ulong Start, ulong End)[] BuildImageSpans()
    {
        var spans = new List<(ulong Start, ulong End)>();
        foreach (var image in MacNative.FindImages(string.Empty))
        {
            try { MacNative.TryGetSegmentSpans(image.Header, spans); }
            catch { /* an image without readable load commands is simply not excluded */ }
        }

        spans.Sort();
        var merged = new List<(ulong Start, ulong End)>();
        foreach (var span in spans)
        {
            if (merged.Count > 0 && span.Start <= merged[^1].End)
                merged[^1] = (merged[^1].Start, Math.Max(merged[^1].End, span.End));
            else merged.Add(span);
        }

        return merged.ToArray();
    }

    /// <summary>FM string instance: int32 byte length at +0, UTF-8 text at +4.</summary>
    private static string? ReadFmString(ulong pointer)
    {
        var address = (nint)(long)pointer;
        if (pointer == 0 || !VirtualMemory.IsReadable(address, 4)) return null;
        var length = Marshal.ReadInt32(address);
        if (length <= 0 || length > 64 || !VirtualMemory.IsReadable(address + 4, length)) return null;
        var bytes = new byte[length];
        Marshal.Copy(address + 4, bytes, 0, length);
        return Encoding.UTF8.GetString(bytes);
    }

    private static int FindQword(byte[] data, ulong value, int scanEnd)
    {
        for (var offset = 0; offset + 8 <= scanEnd && offset + 8 <= data.Length; offset += 8)
        {
            if (BitConverter.ToUInt64(data, offset) == value) return offset;
        }

        return -1;
    }

    private sealed class Graph
    {
        public readonly List<GraphRecord> Records = [];
        private readonly HashSet<ulong> _seen = [];
        public long Bytes;

        /// <summary>Copies up to <paramref name="size"/> readable bytes at <paramref name="address"/>.</summary>
        public int Add(ulong address, ulong pointer, int size, int parent, int parentOffset, int depth)
        {
            if (Records.Count >= MaxRecords || !_seen.Add(pointer)) return -1;
            for (var length = size; length >= 0x40; length /= 2)
            {
                if (!VirtualMemory.IsReadable((nint)(long)address, length)) continue;
                var data = new byte[length];
                Marshal.Copy((nint)(long)address, data, 0, length);
                Records.Add(new GraphRecord(address, pointer, parent, parentOffset, depth, data));
                Bytes += length;
                return Records.Count - 1;
            }

            return -1;
        }

        /// <summary>Copies a window that starts <paramref name="before"/> bytes ahead of the pointer when readable.</summary>
        public int AddWindow(ulong pointer, int before, int size, int parent, int parentOffset, int depth)
        {
            if (Records.Count >= MaxRecords || _seen.Contains(pointer)) return -1;
            var start = pointer - (ulong)before;
            if (VirtualMemory.IsReadable((nint)(long)start, size))
                return Add(start, pointer, size, parent, parentOffset, depth);
            return Add(pointer, pointer, size - before, parent, parentOffset, depth);
        }
    }

    private readonly record struct GraphRecord(
        ulong Address, ulong Pointer, int Parent, int ParentOffset, int Depth, byte[] Data);

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
        public int ManualGeneration;
        public long LastCallAt;
        public long StoppedAtCalls;
        public int StoppedSnapshots;
        public nint HomeTeam;
    }

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate void MatchUpdateDelegate(nint match, uint mode, int targetTick);
}
