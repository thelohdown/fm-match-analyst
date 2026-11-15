// Runs FMMatchLens's own capture code against a macOS probe graph snapshot. The snapshot's
// objects are mapped back at their original addresses, the macOS offset table is forced on,
// and the capture's read paths are called directly: tick record, team stats, event source,
// player frames, and player/team/competition metadata. With a truth file (local/truth/*.json)
// it also compares the results with what FM showed on screen.
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using FMMatchLens.Plugin.Domain;
using FMMatchLens.Plugin.Memory;

namespace FMMatchLens.MacOffline;

internal static partial class Program
{
    private const BindingFlags AnyInstance = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public;

    private static int Main(string[] args)
    {
        if (args.Length < 1)
        {
            Console.Error.WriteLine("usage: FMMatchLens.MacOffline SNAPSHOT-graph.bin [truth.json]");
            Console.Error.WriteLine("       FMMatchLens.MacOffline --archive MATCH.fmlens");
            Console.Error.WriteLine("       FMMatchLens.MacOffline --archive-json MATCH.fmlens OUT   (frames as the API sends them, OUT.NN.json)");
            Console.Error.WriteLine("       FMMatchLens.MacOffline --serve MATCH.fmlens [framesPerSecond]   (replay into the local API)");
            return 2;
        }

        if (args[0] == "--archive" && args.Length > 1) return ArchiveSummary.Print(args[1]);
        if (args[0] == "--archive-json" && args.Length > 2) return ArchiveSummary.WriteFramesJson(args[1], args[2]);
        if (args[0] == "--serve" && args.Length > 1) return ArchiveServer.Serve(args[1], args.Length > 2 ? int.Parse(args[2]) : 0);

        // Must happen before Offsets is first touched.
        Environment.SetEnvironmentVariable("FMMATCHLENS_MAC_OFFSETS", "1");
        if (!Offsets.IsMac) throw new InvalidOperationException("macOS offsets were not selected.");

        var graph = GraphFile.Read(args[0]);
        var pages = GraphMemory.Map(graph);
        Console.WriteLine($"snapshot: match 0x{graph.Match:X}, tick {graph.Tick}, {graph.Records.Count} objects, {pages} pages mapped");

        // The plugin's logger needs BepInEx's IL2CPP runtime, which cannot load here; the read paths
        // used below only queue diagnostics, so it is left unset.
        var hook = new GameMatchTickHook(null!);
        var truth = args.Length > 1 ? JsonDocument.Parse(File.ReadAllText(args[1])).RootElement : (JsonElement?)null;
        var checks = new Checks();

        var match = (nint)(long)graph.Match;
        var recordArgs = new object?[] { match, 0UL, null, null, null };
        var captured = (bool)Call(hook, "TryCaptureTickRecord", recordArgs)!;
        if (!captured)
        {
            Console.WriteLine("TryCaptureTickRecord: false (match not active: team pointers or player counts unreadable)");
            return 1;
        }

        var record = (GameMatchTickRecord)recordArgs[2]!;
        Console.WriteLine($"\ntick record: tick {record.Tick} (display {record.DisplayTick}), period {record.Period}, " +
                          $"players {record.HomePlayerCount}+{record.AwayPlayerCount}, finished flag {record.FinishedByFlags}, " +
                          $"possession {(record.PossessionTeam == record.HomeTeam ? "home" : record.PossessionTeam == record.AwayTeam ? "away" : "none")}, " +
                          $"ball holder 0x{record.CurrentBallHolder:X}");
        Console.WriteLine($"  team stats: goals {record.HomeGoals}-{record.AwayGoals}, shots {record.HomeShots}-{record.AwayShots}, " +
                          $"xG {record.HomeXg:0.00}-{record.AwayXg:0.00}");
        if (truth is { } t)
        {
            checks.Pair("score", t.GetProperty("score"), record.HomeGoals, record.AwayGoals);
            checks.Pair("shots", t.GetProperty("team").GetProperty("shots"), record.HomeShots, record.AwayShots);
            checks.PairFloat("xG", t.GetProperty("team").GetProperty("xg"), record.HomeXg, record.AwayXg, 0.006);
        }

        // Momentum, as the capture session computes it: the calculator works on its own thread,
        // so capture once, wait, and capture again to collect its output.
        using (var calculator = new MomentumCalculator())
        {
            var native = new MomentumTickData[RawRealtimeTickFrame.MaxMomentumPoints];
            var rolling = new MomentumTickData[RawRealtimeTickFrame.MaxRollingMomentumPoints];
            calculator.Capture(match, out _, native, out var nativeCount, rolling, out var rollingCount);
            Thread.Sleep(500);
            calculator.Capture(match, out _, native, out nativeCount, rolling, out rollingCount);
            Console.WriteLine($"\nmomentum: {nativeCount} points, {rollingCount} rolling; " +
                              string.Join(" ", native.Take(nativeCount).Select(p => $"{p.TimeTicks}:{p.Value:+0.00;-0.00;0}")));
        }

        if (NativeMomentumSource.TryRead(match, out var source))
        {
            Console.WriteLine($"\nevent source: {source.Count} events, pitch {source.HalfWidth * 2:0.0} x {source.HalfLength * 2:0.0} m, " +
                              $"first half ends {Show(source.FirstEnd)}, full time {Show(source.FullEnd)}, calculation data {source.HasCalculationData}");
        }
        else
        {
            Console.WriteLine("\nevent source: unreadable");
        }

        // Player frames, as TryCaptureRealtimeFrame reads them.
        var uids = typeof(GameMatchTickHook).GetField("_playerUids", AnyInstance)!.GetValue(hook)!;
        var uidCapture = uids.GetType().GetMethod("Begin")!
            .Invoke(uids, new object[] { match, record.HomeTeam, record.AwayTeam, record.Tick, Stopwatch.GetTimestamp() });
        var frames = new List<PlayerTickData>();
        var framePointers = new List<nint>();
        foreach (var (team, count, side, slotOffset) in new[]
                 {
                     (record.HomeTeam, (int)record.HomePlayerCount, TeamSide.Home, 0),
                     (record.AwayTeam, (int)record.AwayPlayerCount, TeamSide.Away, (int)record.HomePlayerCount),
                 })
        {
            for (var slot = 0; slot < count; slot++)
            {
                var matchPlayer = Marshal.ReadIntPtr(team + Offsets.Team.PlayerTable + slot * IntPtr.Size);
                var frameArgs = new object?[] { matchPlayer, slotOffset + slot, side, record.CurrentBallHolder, uidCapture, null };
                if ((bool)Call(hook, "TryReadPlayerFrame", frameArgs)!)
                {
                    frames.Add((PlayerTickData)frameArgs[5]!);
                    framePointers.Add(matchPlayer);
                }
            }
        }

        // Tactics, as the tactical sampler reads them (the context is each team's manager object).
        {
            var raw = new RawRealtimeTickFrame(0) { Tick = record.Tick, PlayerCount = (byte)Math.Min(frames.Count, RawRealtimeTickFrame.MaxPlayers) };
            for (var i = 0; i < raw.PlayerCount; i++) raw.Players[i] = frames[i];
            var pointers = framePointers.Take(raw.PlayerCount).ToArray();
            EnsurePluginLog();
            var sampler = new GameMatchTickHook.TacticalStateSampler();
            var tactics = sampler.Capture(record.HomeTeam, record.AwayTeam, raw, pointers);
            if (tactics is not null && Environment.GetEnvironmentVariable("FMMATCHLENS_TACTICS_OUT") is { Length: > 0 } tacticsOut)
            {
                // The API's own JSON form, for checking the dashboard and analyst decoding.
                var options = (JsonSerializerOptions)typeof(FMMatchLens.Plugin.Services.LocalApiServer)
                    .GetField("JsonOptions", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
                File.WriteAllText(tacticsOut, JsonSerializer.Serialize(tactics, options));
                Console.WriteLine($"  wrote the tactic as API JSON to {tacticsOut}");
            }
            Console.WriteLine("\ntactics:");
            if (tactics is null) Console.WriteLine("  none read");
            foreach (var (label, team) in tactics is null ? Array.Empty<(string, TacticalTeamData)>() : new[] { ("home", tactics.Home), ("away", tactics.Away) })
            {
                Console.WriteLine($"  {label}: status {team.Status}, processing {DescribeTactic(team.Processing)}, command {(team.Command is null ? "not read" : "read")}");
                Console.WriteLine($"    players with a formation slot: {team.Players.Count(p => p.TacticSlot is >= 0 and < 11)}, " +
                                  $"opposition keys: {string.Join(" ", team.Players.Where(p => p.OppositionPositionKey is > 0).Select(p => $"0x{p.OppositionPositionKey:X}"))}");
            }
        }

        // Metadata, as CapturePlayerMetadata reads it.
        var metadata = new List<RealtimePlayerMetadata>();
        Call(hook, "CaptureTeamPlayerMetadata", new object?[] { metadata, record.HomeTeam, (int)record.HomePlayerCount, TeamSide.Home, 0 });
        Call(hook, "CaptureTeamPlayerMetadata", new object?[] { metadata, record.AwayTeam, (int)record.AwayPlayerCount, TeamSide.Away, (int)record.HomePlayerCount });
        var homeMeta = (RealtimeTeamMetadata)Call(hook, "ReadTeamMetadata", new object?[] { record.HomeTeam, "Home" })!;
        var awayMeta = (RealtimeTeamMetadata)Call(hook, "ReadTeamMetadata", new object?[] { record.AwayTeam, "Away" })!;
        var competition = Call(hook, "ReadCompetitionMetadata", new object?[] { match });

        Console.WriteLine("\nteams:");
        foreach (var team in new[] { homeMeta, awayMeta })
        {
            Console.WriteLine($"  {team.Name}: team uid {Show(team.Uid)}, club uid {Show(team.ClubUid)}, " +
                              $"colours {Hex(team.BackgroundColour)}/{Hex(team.ForegroundColour)}/{Hex(team.OutlineColour)}, " +
                              $"shirt {Hex(team.ShirtBackgroundColor)}, manager {(team.Manager is { } m ? $"{m.FirstName} {m.SecondName} (uid {Show(m.Uid)}, human {m.IsHumanControlled})" : "-")}");
        }

        Console.WriteLine($"competition: {competition?.ToString() ?? "-"}");

        Console.WriteLine("\nprofiles and attributes (attributes on FM's 1-100 scale; the game shows them /5):");
        foreach (var meta in metadata.OrderBy(m => m.Slot))
        {
            var p = meta.Profile;
            var a = meta.Attributes;
            int A(IReadOnlyDictionary<string, int>? group, string name) => group is not null && group.TryGetValue(name, out var v) ? v : -1;
            Console.WriteLine($"  {meta.Slot,2} {meta.DisplayName,-24} pos {meta.Position ?? "-",-4} height {Show(p?.HeightCm)} CA {Show(p?.CurrentAbility)}/{Show(p?.PotentialAbility)} " +
                              $"cond {Show(p?.Condition)} sharp {Show(p?.MatchSharpness)} morale {Show(p?.Morale)} value {Show(p?.GuideValueGbp)} | " +
                              (a is null ? "no attributes" : $"fin {A(a.Technical, "Finishing")} pas {A(a.Technical, "Passing")} tck {A(a.Technical, "Tackling")} pace {A(a.Physical, "Pace")} acc {A(a.Physical, "Acceleration")} sta {A(a.Physical, "Stamina")} dec {A(a.Mental, "Decisions")} han {A(a.Goalkeeping, "Handling")} ref {A(a.Goalkeeping, "Reflexes")}"));
        }

        Console.WriteLine("\nplayers (frame + metadata):");
        Console.WriteLine("  slot side  no  name                          uid         born        rating  G  A  sh/ot  pass     tkl    dist(m)   x,y");
        var bySlot = metadata.ToDictionary(m => m.Slot);
        foreach (var frame in frames)
        {
            RealtimePlayerMetadata? meta = bySlot.TryGetValue(frame.Slot, out var found) ? found : null;
            Console.WriteLine(
                $"  {frame.Slot,4} {frame.Team,-5} {Show(meta?.ShirtNumber),3} {Trim(meta?.DisplayName, 29),-29} {Show(meta?.Uid),-11} " +
                $"{meta?.Profile?.DateOfBirth ?? "-",-11} {frame.Rating,6:0.00} {frame.Goals,2} {frame.Assists,2} {frame.Shots,2}/{frame.ShotsOnTarget,-2} " +
                $"{frame.PassesCompleted,3}/{frame.Passes,-3} {frame.TacklesWon,2}/{frame.TacklesAttempted,-2} {frame.DistanceM,9:0} " +
                $"{frame.X:0.0},{frame.Y:0.0}{(frame.IsOnPitch ? "" : " (bench/off)")}");
        }

        if (truth is { } truthRoot)
        {
            var team = truthRoot.GetProperty("team");
            int Sum(TeamSide side, Func<PlayerTickData, int> pick) => frames.Where(f => f.Team == side).Sum(pick);
            checks.Pair("passes", team.GetProperty("passes_completed"), Sum(TeamSide.Home, f => f.Passes), Sum(TeamSide.Away, f => f.Passes), index: 1);
            checks.Pair("passes completed", team.GetProperty("passes_completed"), Sum(TeamSide.Home, f => f.PassesCompleted), Sum(TeamSide.Away, f => f.PassesCompleted), index: 0);
            checks.Pair("shots on target", team.GetProperty("shots_on_target"), Sum(TeamSide.Home, f => f.ShotsOnTarget), Sum(TeamSide.Away, f => f.ShotsOnTarget));
            checks.Pair("tackles won", team.GetProperty("tackles_won"), Sum(TeamSide.Home, f => f.TacklesWon), Sum(TeamSide.Away, f => f.TacklesWon), index: 0);
            checks.Pair("fouls", team.GetProperty("fouls"), Sum(TeamSide.Home, f => f.Fouls), Sum(TeamSide.Away, f => f.Fouls));
            checks.PairFloat("distance km", team.GetProperty("distance_km"),
                frames.Where(f => f.Team == TeamSide.Home).Sum(f => f.DistanceM) / 1000f,
                frames.Where(f => f.Team == TeamSide.Away).Sum(f => f.DistanceM) / 1000f, 1.0);

            if (truthRoot.TryGetProperty("ratings", out var ratings))
            {
                var matched = 0;
                var total = 0;
                foreach (var entry in ratings.EnumerateObject())
                {
                    var player = frames.FirstOrDefault(f =>
                        bySlot.TryGetValue(f.Slot, out var m) &&
                        (m.ShirtName?.StartsWith(entry.Name, StringComparison.OrdinalIgnoreCase) == true ||
                         m.DisplayName.EndsWith(entry.Name, StringComparison.OrdinalIgnoreCase)));
                    total++;
                    if (player.Slot == 0 && player.PlayerId == 0) { checks.Fail($"rating {entry.Name}: player not found"); continue; }
                    var shown = Math.Floor(player.Rating * 10 + 1e-4) / 10;
                    if (Math.Abs(shown - entry.Value.GetDouble()) < 1e-6) matched++;
                    else checks.Fail($"rating {entry.Name}: {shown:0.0} v {entry.Value.GetDouble():0.0}");
                }

                checks.Note($"ratings: {matched}/{total} match FM's screen");
            }
        }

        checks.Report();
        return checks.Failures == 0 ? 0 : 1;
    }

    private static object? Call(object target, string name, object?[] args)
    {
        var method = target.GetType().GetMethod(name, AnyInstance)
                     ?? throw new MissingMethodException(target.GetType().Name, name);
        try
        {
            return method.Invoke(target, args);
        }
        catch (TargetInvocationException ex) when (ex.InnerException is not null)
        {
            throw ex.InnerException;
        }
    }

    private static string Show<T>(T? value) where T : struct => value?.ToString() ?? "-";
    private static string Show(uint value) => value == uint.MaxValue ? "unset" : value.ToString();
    private static string Hex(uint? value) => value is { } v ? $"{v:X8}" : "-";
    private static string Trim(string? value, int length) =>
        value is null ? "-" : value.Length <= length ? value : value[..(length - 1)] + "…";

    private sealed class Checks
    {
        private readonly List<string> _lines = [];
        public int Failures { get; private set; }

        public void Pair(string name, JsonElement expected, int home, int away, int? index = null)
        {
            var (eh, ea) = Expected(expected, index);
            Record(name, $"{home}/{away}", $"{eh}/{ea}", home == (int)eh && away == (int)ea);
        }

        public void PairFloat(string name, JsonElement expected, double home, double away, double tolerance)
        {
            var (eh, ea) = Expected(expected, null);
            Record(name, $"{home:0.00}/{away:0.00}", $"{eh:0.00}/{ea:0.00}",
                Math.Abs(home - eh) <= tolerance && Math.Abs(away - ea) <= tolerance);
        }

        public void Fail(string line)
        {
            Failures++;
            _lines.Add("  MISMATCH " + line);
        }

        public void Note(string line) => _lines.Add("  " + line);

        public void Report()
        {
            if (_lines.Count == 0) return;
            Console.WriteLine("\nchecks against FM's screens:");
            foreach (var line in _lines) Console.WriteLine(line);
        }

        private void Record(string name, string got, string expected, bool ok)
        {
            if (!ok) Failures++;
            _lines.Add($"  {(ok ? "ok      " : "MISMATCH")} {name}: {got} (FM {expected})");
        }

        private static (double Home, double Away) Expected(JsonElement pair, int? index)
        {
            JsonElement Side(int i) => index is { } k ? pair[i][k] : pair[i];
            return (Side(0).GetDouble(), Side(1).GetDouble());
        }
    }
}

/// <summary>A probe graph snapshot: "FMPG" v1, written by MacMatchProbe.DeepSnapshot.</summary>
internal sealed record GraphFile(ulong Match, int Tick, List<(ulong Address, byte[] Data)> Records)
{
    public static GraphFile Read(string path)
    {
        using var reader = new BinaryReader(File.OpenRead(path));
        if (reader.ReadUInt32() != 0x47504D46) throw new InvalidDataException($"{path} is not a graph snapshot.");
        if (reader.ReadUInt32() != 1) throw new InvalidDataException($"{path} has an unsupported version.");
        var match = reader.ReadUInt64();
        var tick = reader.ReadInt32();
        reader.ReadInt32(); // target tick
        var count = reader.ReadUInt32();
        var records = new List<(ulong, byte[])>((int)count);
        for (var i = 0; i < count; i++)
        {
            var address = reader.ReadUInt64();
            reader.ReadUInt64(); // pointer that led here
            var size = reader.ReadUInt32();
            reader.ReadInt32(); // parent
            reader.ReadUInt32(); // offset in parent
            reader.ReadUInt32(); // depth
            records.Add((address, reader.ReadBytes((int)size)));
        }

        return new GraphFile(match, tick, records);
    }
}

/// <summary>Maps snapshot records at their original addresses in this process.</summary>
internal static unsafe class GraphMemory
{
    private const int ProtRead = 1, ProtWrite = 2, MapPrivate = 0x02, MapAnonymous = 0x20, MapFixedNoReplace = 0x100000;
    private const ulong Page = 4096;

    public static int Map(GraphFile graph)
    {
        var pages = new SortedSet<ulong>();
        foreach (var (address, data) in graph.Records)
        {
            for (var page = address & ~(Page - 1); page < address + (ulong)data.Length; page += Page) pages.Add(page);
        }

        // Map runs of consecutive pages.
        ulong runStart = 0, runEnd = 0;
        foreach (var page in pages.Append(ulong.MaxValue))
        {
            if (page == runEnd) { runEnd += Page; continue; }
            if (runEnd > runStart) MapRun(runStart, runEnd - runStart);
            runStart = page;
            runEnd = page + Page;
        }

        foreach (var (address, data) in graph.Records)
            Marshal.Copy(data, 0, (nint)(long)address, data.Length);
        return pages.Count;
    }

    private static void MapRun(ulong start, ulong length)
    {
        var result = mmap((void*)start, (nuint)length, ProtRead | ProtWrite, MapPrivate | MapAnonymous | MapFixedNoReplace, -1, 0);
        if ((ulong)result != start)
            throw new InvalidOperationException($"could not map 0x{start:X}+0x{length:X} (got 0x{(ulong)result:X}, errno {Marshal.GetLastPInvokeError()})");
    }

    [DllImport("libc", SetLastError = true)]
    private static extern void* mmap(void* address, nuint length, int protection, int flags, int fd, nint offset);
}

/// <summary>Summarises a .fmlens archive written by the capture: frames, events and momentum.</summary>
internal static class ArchiveSummary
{
    public static int Print(string path)
    {
        if (!FMMatchLens.Plugin.Services.ArchiveReader.TryScan(path, 0, null, 1, int.MaxValue, true, out var result))
        {
            Console.WriteLine($"could not read {path}");
            return 1;
        }

        var frames = result.Frames;
        Console.WriteLine($"{Path.GetFileName(path)}: {frames.Count} frames, ticks {frames.FirstOrDefault()?.Tick}-{frames.LastOrDefault()?.Tick}");
        var meta = result.Metadata;
        if (meta is not null)
            Console.WriteLine($"  metadata: {meta.Home.Name} v {meta.Away.Name}, {meta.Players?.Count} players");
        var withEvents = frames.Count(f => f.MomentumEvents.Count > 0);
        var events = frames.Sum(f => f.MomentumEvents.Count);
        var momentum = frames.Sum(f => f.Momentum.Count);
        var rolling = frames.Sum(f => f.RollingMomentum.Count);
        var updates = frames.Sum(f => f.MomentumEventUpdates?.Count ?? 0);
        var pitch = frames.Where(f => f.HalfPitchWidth > 0).Select(f => $"{f.HalfPitchWidth:0.0}x{f.HalfPitchLength:0.0}").Distinct().Take(3);
        Console.WriteLine($"  momentum events: {events} in {withEvents} frames, event updates {updates}; momentum points {momentum}, rolling {rolling}");
        Console.WriteLine($"  half pitch sizes seen: {string.Join(", ", pitch)}; frames with zero pitch: {frames.Count(f => f.HalfPitchWidth <= 0)}");
        var shots = frames.SelectMany(f => f.MomentumEvents).Where(e => e.EventType is >= 1 and <= 5)
            .GroupBy(e => e.Team).Select(g => $"{g.Key}: {g.Count()}");
        Console.WriteLine($"  shot events by team: {string.Join(", ", shots)}");
        var last = frames.LastOrDefault();
        if (last is not null)
            Console.WriteLine($"  last frame: tick {last.Tick}, period {last.Period}, home goals {last.Home.Goals} shots {last.Home.Shots}, away goals {last.Away.Goals} shots {last.Away.Shots}, players {last.Players.Count}");
        return 0;
    }

    /// <summary>Writes the archive's frames as /api/match/frames would serve them, for the dashboard's code.</summary>
    public static int WriteFramesJson(string path, string output)
    {
        if (!FMMatchLens.Plugin.Services.ArchiveReader.TryScan(path, 0, null, 1, int.MaxValue, true, out var result))
        {
            Console.WriteLine($"could not read {path}");
            return 1;
        }

        RealtimeTickFrame? previous = null;
        var wire = result.Frames.Select(frame =>
        {
            var converted = FMMatchLens.Plugin.Services.RealtimeMatchTimeline.ToWireFrame(frame, previous);
            previous = frame;
            return converted;
        }).ToArray();
        var options = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
        };
        // One file per 2,400 frames, like the dashboard's own paged history requests.
        const int page = 2_400;
        for (var start = 0; start < wire.Length; start += page)
        {
            var file = $"{output}.{start / page:D2}.json";
            using var stream = File.Create(file);
            JsonSerializer.Serialize(stream, new
            {
                matchId = "archive", status = "ended", totalFrameCount = wire.Length,
                frames = wire.Skip(start).Take(page).ToArray(),
            }, options);
        }

        Console.WriteLine($"wrote {wire.Length} frames to {output}.NN.json");
        return 0;
    }
}

/// <summary>
/// Replays an archive into the plugin's own timeline and local API server, so the dashboard's
/// live requests can be exercised against the managed HttpListener used on macOS and Linux.
/// Frames are appended at the given rate per second (0 = all at once; the game makes 4), then
/// the match is marked over. Usage: --serve FILE.fmlens [framesPerSecond]
/// </summary>
internal static class ArchiveServer
{
    public static int Serve(string path, int framesPerSecond)
    {
        Program.ResolveBepInExAssemblies();
        return ServeCore(path, framesPerSecond);
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static int ServeCore(string path, int framesPerSecond)
    {
        Program.EnsurePluginLog();
        if (!FMMatchLens.Plugin.Services.ArchiveReader.TryScan(path, 0, null, 1, int.MaxValue, true, out var result))
        {
            Console.WriteLine($"could not read {path}");
            return 1;
        }

        var work = Directory.CreateTempSubdirectory("fmmatchlens-serve").FullName;
        var archives = new FMMatchLens.Plugin.Services.MatchArchiveStore(Path.Combine(work, "matches"));
        var graphics = new FMMatchLens.Plugin.Services.GraphicsAssetIndex(Path.Combine(work, "graphics"), Path.Combine(work, "graphics.json"));
        var timeline = new FMMatchLens.Plugin.Services.RealtimeMatchTimeline(archives, graphics);
        var server = new FMMatchLens.Plugin.Services.LocalApiServer(timeline, archives, graphics);
        server.Start();
        const nint source = 0x1000;
        timeline.Begin(source);
        if (result.Metadata is { } meta)
            timeline.SetMetadata(meta.Home, meta.Away, meta.Players, meta.MatchDate, meta.Competition);

        Console.WriteLine(framesPerSecond > 0
            ? $"Serving {Path.GetFileName(path)} on http://127.0.0.1:16726, {result.Frames.Count} frames at {framesPerSecond} a second (the game makes 4)."
            : $"Serving {Path.GetFileName(path)} on http://127.0.0.1:16726, all {result.Frames.Count} frames at once.");
        var raw = new RawRealtimeTickFrame(0);
        var watch = Stopwatch.StartNew();
        var index = 0;
        foreach (var frame in result.Frames)
        {
            Fill(raw, frame, source);
            timeline.Append(raw);
            index++;
            if (framesPerSecond > 0)
            {
                var due = index * 1000L / framesPerSecond;
                var wait = due - watch.ElapsedMilliseconds;
                if (wait > 0) Thread.Sleep((int)wait);
            }
        }

        // Full time, as the game reports it once the last frame is in.
        Thread.Sleep(1000);
        timeline.MarkEnded(source);
        Console.WriteLine($"Replayed {index} frames in {watch.Elapsed.TotalSeconds:0.0} s; the match is now over. " +
                          "Still serving on http://127.0.0.1:16726 (Ctrl+C to stop).");
        Thread.Sleep(Timeout.Infinite);
        return 0;
    }

    private static void Fill(RawRealtimeTickFrame raw, RealtimeTickFrame frame, nint source)
    {
        raw.Sequence = frame.Sequence;
        raw.InstanceGeneration = 1;
        raw.MatchAddress = source;
        raw.Tick = frame.Tick;
        raw.DisplayTick = frame.DisplayTick;
        raw.Period = (byte)frame.Period;
        raw.PossessionTeam = frame.PossessionTeam;
        raw.BallHolderPlayerId = frame.BallHolderPlayerId ?? 0;
        raw.BallXCentimeters = frame.BallXCentimeters;
        raw.BallYCentimeters = frame.BallYCentimeters;
        raw.BallZCentimeters = frame.BallZCentimeters;
        raw.HalfPitchWidth = frame.HalfPitchWidth;
        raw.HalfPitchLength = frame.HalfPitchLength;
        raw.Home = frame.Home;
        raw.Away = frame.Away;
        raw.RatingResearch = frame.RatingResearch;
        raw.Tactics = frame.Tactics;
        raw.LegacyFormation = frame.LegacyFormation;
        raw.FinishedByFlags = false;
        raw.PlayerCount = (byte)Math.Min(frame.Players.Count, RawRealtimeTickFrame.MaxPlayers);
        for (var i = 0; i < raw.PlayerCount; i++) raw.Players[i] = frame.Players[i];
        raw.MomentumEventCount = (byte)Math.Min(frame.MomentumEvents.Count, RawRealtimeTickFrame.MaxMomentumEvents);
        for (var i = 0; i < raw.MomentumEventCount; i++) raw.MomentumEvents[i] = frame.MomentumEvents[i];
        raw.MomentumCount = (byte)Math.Min(frame.Momentum.Count, RawRealtimeTickFrame.MaxMomentumPoints);
        for (var i = 0; i < raw.MomentumCount; i++) raw.Momentum[i] = frame.Momentum[i];
        raw.RollingMomentumCount = (byte)Math.Min(frame.RollingMomentum.Count, RawRealtimeTickFrame.MaxRollingMomentumPoints);
        for (var i = 0; i < raw.RollingMomentumCount; i++) raw.RollingMomentum[i] = frame.RollingMomentum[i];
    }
}

internal static partial class Program
{
    private static string DescribeTactic(TacticalConfiguration? config)
    {
        if (config is null) return "not read";
        var name = config.NameUtf8 is { Length: > 0 } bytes ? System.Text.Encoding.UTF8.GetString(bytes) : "(no name)";
        string Shape(TacticalPosition[] positions) => string.Join(" ", positions.Select(p => TacticalFormationDecoder.DecodePosition(p.PositionMask) ?? "?"));
        return $"\"{name}\" mentality {config.Mentality}, in possession [{Shape(config.InPossession)}], out of possession [{Shape(config.OutOfPossession)}], " +
               $"slot map {string.Join(",", config.PhaseSlotMapping)}, overrides {(config.InPossessionOverrides is null ? "?" : config.InPossessionOverrides.Length.ToString())}/" +
               $"{(config.OutOfPossessionOverrides is null ? "?" : config.OutOfPossessionOverrides.Length.ToString())}";
    }
}

internal static partial class Program
{
    private static bool _resolverInstalled;

    /// <summary>
    /// The plugin's logger lives on its BepInEx plugin class, so BepInEx's IL2CPP assemblies
    /// must load. They are not in this tool's deps.json: look next to the tool, then in the
    /// BepInEx core folder named by FMMATCHLENS_BEPINEX_CORE (./mac/dev.sh serve sets it).
    /// </summary>
    internal static void ResolveBepInExAssemblies()
    {
        if (_resolverInstalled) return;
        _resolverInstalled = true;
        var folders = new[] { AppContext.BaseDirectory, Environment.GetEnvironmentVariable("FMMATCHLENS_BEPINEX_CORE") }
            .Where(folder => !string.IsNullOrEmpty(folder)).Cast<string>().ToArray();
        System.Runtime.Loader.AssemblyLoadContext.Default.Resolving += (context, name) =>
        {
            foreach (var folder in folders)
            {
                var candidate = Path.Combine(folder, name.Name + ".dll");
                if (File.Exists(candidate)) return context.LoadFromAssemblyPath(candidate);
            }

            return null;
        };
    }

    /// <summary>Gives the plugin a log source that prints to the console.</summary>
    internal static void EnsurePluginLog()
    {
        ResolveBepInExAssemblies();
        SetPluginLog();
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void SetPluginLog()
    {
        var property = typeof(FMMatchLens.Plugin.Plugin).GetProperty("PluginLog", BindingFlags.Static | BindingFlags.NonPublic)!;
        if (property.GetValue(null) is not null) return;
        var log = new BepInEx.Logging.ManualLogSource("FMMatchLens");
        log.LogEvent += (_, e) => Console.WriteLine($"[{e.Level}] {e.Data}");
        property.SetValue(null, log);
    }
}
