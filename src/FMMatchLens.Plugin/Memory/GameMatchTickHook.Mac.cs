using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using FMMatchLens.Plugin.Diagnostics;
using FMMatchLens.Plugin.Domain;

namespace FMMatchLens.Plugin.Memory;

/// <summary>macOS-only parts of the hook, called from one-line checks in GameMatchTickHook.cs.</summary>
internal sealed partial class GameMatchTickHook
{
    // Itanium C++ objects keep a subobject's distance from the start of the whole object at
    // vtable-0x10 ("offset to top"), the counterpart of the MSVC RTTI subobject offset used on
    // Windows (Offsets.Rtti). On macOS a human manager's person sits 0x548 into its object and an
    // AI manager's 0x208 (FM27, seen live for both sides of one match).
    private const uint MacHumanManagerPersonOffset = 0x548;
    private const uint MacStaffPersonOffset = 0x208;

    private readonly ConcurrentDictionary<uint, byte> _loggedMacManagerOffsets = new();
    private readonly ConditionalWeakTable<CaptureSession, object> _macMetadataLogged = new();

    /// <summary>macOS counterpart of <see cref="TryReadManagerIdentity"/>. Each new offset seen is logged once.</summary>
    private bool TryReadMacManagerIdentity(
        nint team,
        out nint person,
        out uint offsetToTop,
        out ManagerKind kind,
        out uint? uid)
    {
        person = default;
        offsetToTop = default;
        kind = ManagerKind.Unknown;
        uid = null;
        if (team == default ||
            !_memoryReader.TryReadPointer(team + Offsets.Team.Manager, out var manager) ||
            manager == default ||
            !_memoryReader.TryReadPointer(manager + Offsets.Manager.Person, out person) ||
            person == default ||
            !_memoryReader.TryReadPointer(person, out var virtualFunctionTable) ||
            virtualFunctionTable == default ||
            !_memoryReader.TryReadUInt64(virtualFunctionTable - 0x10, out var rawOffsetToTop))
        {
            return false;
        }

        offsetToTop = unchecked((uint)(-(long)rawOffsetToTop));
        kind = offsetToTop switch
        {
            MacHumanManagerPersonOffset => ManagerKind.Human,
            MacStaffPersonOffset => ManagerKind.Staff,
            _ => ManagerKind.Unsupported
        };
        uid = ReadUid(person + Offsets.Person.Uid);
        if (_loggedMacManagerOffsets.TryAdd(offsetToTop, 0))
        {
            QueueDiagnostic(DiagnosticSeverity.Info,
                $"macOS manager person: offset to top 0x{offsetToTop:X}, uid={uid?.ToString() ?? "?"}, " +
                $"name={ReadPersonName(person, Offsets.Person.FirstName)} {ReadPersonName(person, Offsets.Person.SecondName)}.");
        }

        return true;
    }

    /// <summary>
    /// Logs the match's names once per session, so the macOS offsets for teams, managers, competition and
    /// players can be checked against what FM shows.
    /// </summary>
    private void LogMacMetadataOnce(
        CaptureSession session,
        RealtimeTeamMetadata home,
        RealtimeTeamMetadata away,
        List<RealtimePlayerMetadata> players,
        string? date,
        RealtimeCompetitionMetadata? competition)
    {
        if (_macMetadataLogged.TryGetValue(session, out _)) return;
        _macMetadataLogged.AddOrUpdate(session, new object());
        var firstPlayers = string.Join(", ", players.Take(4).Select(p => $"{p.DisplayName} #{p.ShirtNumber}"));
        QueueDiagnostic(DiagnosticSeverity.Info,
            $"macOS metadata check: home='{home.Name}' (team {home.Uid}, club {home.ClubUid}, manager " +
            $"{home.Manager?.FirstName} {home.Manager?.SecondName}), away='{away.Name}' (team {away.Uid}, club " +
            $"{away.ClubUid}, manager {away.Manager?.FirstName} {away.Manager?.SecondName}), competition=" +
            $"'{competition?.Name}' ({competition?.Uid}), date={date}, players: {firstPlayers}.");
    }

    /// <summary>
    /// macOS check before trusting the ActualPlayer layout: 15 position familiarities of 1-20
    /// with at least one natural position, and every attribute byte between 1 and 100.
    /// </summary>
    private bool MacPlayerRecordLooksRight(nint actualPlayer)
    {
        var start = actualPlayer + Offsets.ActualPlayer.PositionGk;
        var length = Offsets.ActualPlayer.Concentration - Offsets.ActualPlayer.PositionGk + 1;
        if (!VirtualMemory.IsReadable(start, length)) return false;
        var best = 0;
        for (var i = 0; i < PlayerPositionFamiliarity.Labels.Length; i++)
        {
            var value = Marshal.ReadByte(start + i);
            if (value is < 1 or > 20) return false;
            best = Math.Max(best, value);
        }
        if (best < 15) return false;
        for (var offset = Offsets.ActualPlayer.Crossing; offset <= Offsets.ActualPlayer.Concentration; offset++)
        {
            var value = Marshal.ReadByte(actualPlayer + offset);
            if (value is < 1 or > 100) return false;
        }
        return true;
    }

    private int _macPlayerRecordLogged;

    /// <summary>
    /// Reports once whether the player record sits where expected relative to the person. When it
    /// does not, lists every nearby distance at which a record does look like a player's, so one
    /// live match gives the value to use.
    /// </summary>
    private void LogMacPlayerRecordOnce(nint person, bool looksRight)
    {
        if (Interlocked.Exchange(ref _macPlayerRecordLogged, 1) != 0) return;
        if (looksRight)
        {
            QueueDiagnostic(DiagnosticSeverity.Info,
                $"macOS player record check: looks right at person-0x{-Offsets.Person.ActualPlayerDelta:X}.");
            return;
        }

        var found = new List<string>();
        for (var delta = -0x800; delta <= 0x400 && found.Count < 8; delta += 8)
        {
            if (MacPlayerRecordLooksRight(person + delta)) found.Add(delta < 0 ? $"-0x{-delta:X}" : $"+0x{delta:X}");
        }
        QueueDiagnostic(DiagnosticSeverity.Warning,
            $"macOS player record check: nothing player-like at person-0x{-Offsets.Person.ActualPlayerDelta:X}; " +
            $"player-like records at person{(found.Count == 0 ? " (none within -0x800..+0x400)" : string.Join(", ", found))}.");
    }
}
