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

internal static class Program
{
    private const BindingFlags AnyInstance = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public;

    private static int Main(string[] args)
    {
        if (args.Length < 1)
        {
            Console.Error.WriteLine("usage: FMMatchLens.MacOffline SNAPSHOT-graph.bin [truth.json]");
            return 2;
        }

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
                if ((bool)Call(hook, "TryReadPlayerFrame", frameArgs)!) frames.Add((PlayerTickData)frameArgs[5]!);
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
