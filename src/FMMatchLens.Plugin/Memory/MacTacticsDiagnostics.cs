using System.Runtime.InteropServices;
using System.Text;
using FMMatchLens.Plugin.Diagnostics;
using FMMatchLens.Plugin.Domain;

namespace FMMatchLens.Plugin.Memory;

/// <summary>
/// Checks and one-line reports for the macOS tactic layout, which was mapped from
/// graph snapshots (Offsets.Tactics). Each team context is reported once: what the
/// sampler read, and where in the context every formation-shaped block sits, so a
/// single live match confirms the command copy's offset.
/// </summary>
internal static class MacTacticsDiagnostics
{
    private const int FormationStride = 0x48;
    private const int FormationSlots = 11;
    private static readonly HashSet<nint> Logged = new();
    private static readonly object Gate = new();

    /// <summary>Eleven position records: a goalkeeper first and known positions throughout.</summary>
    public static bool LooksLikeFormation(nint address)
    {
        if (!VirtualMemory.IsReadable(address, FormationStride * FormationSlots)) return false;
        var keepers = 0;
        for (var i = 0; i < FormationSlots; i++)
        {
            var mask = unchecked((uint)Marshal.ReadInt32(address + i * FormationStride));
            var position = TacticalFormationDecoder.DecodePosition(mask);
            if (position is null) return false;
            if (position == "GK") keepers++;
            if (i == 0 && position != "GK") return false;
        }
        return keepers == 1;
    }

    public static void LogOnce(nint context, TeamSide side, TacticalConfiguration? processing, TacticalConfiguration? command,
        IReadOnlyList<TacticalPlayerSlot> players)
    {
        lock (Gate)
        {
            if (!Logged.Add(context)) return;
            if (Logged.Count > 64) Logged.Clear();
        }

        var text = new StringBuilder();
        text.Append($"macOS tactics check ({side}): processing {Describe(processing)}; command {Describe(command)}; ");
        var slotted = players.Count(player => player.TacticSlot is >= 0 and < FormationSlots);
        text.Append($"players in a formation slot {slotted}, with an opposition key {players.Count(player => player.OppositionPositionKey is > 0)}; ");
        text.Append("formation blocks at context+");
        var found = new List<string>();
        var scanEnd = VirtualMemory.IsReadable(context + 0x1000, 0x2800) ? 0x3800 - FormationStride * FormationSlots : 0x1000;
        for (var offset = 0x1000; offset < scanEnd && found.Count < 12; offset += 4)
        {
            if (unchecked((uint)Marshal.ReadInt32(context + offset)) != 1 || !LooksLikeFormation(context + offset)) continue;
            found.Add($"0x{offset:X}");
            offset += FormationStride * FormationSlots - 4;
        }
        text.Append(found.Count == 0 ? "none" : string.Join(", ", found));
        text.Append($" (expected 0x{Offsets.Tactics.Context.ProcessingConfiguration + Offsets.Tactics.Configuration.InPossession:X}/" +
                    $"0x{Offsets.Tactics.Context.ProcessingConfiguration + Offsets.Tactics.Configuration.OutOfPossession:X} and " +
                    $"0x{Offsets.Tactics.Context.CommandConfiguration + Offsets.Tactics.Configuration.InPossession:X}/" +
                    $"0x{Offsets.Tactics.Context.CommandConfiguration + Offsets.Tactics.Configuration.OutOfPossession:X}).");
        PluginLogger.Info(text.ToString());
    }

    private static string Describe(TacticalConfiguration? config)
    {
        if (config is null) return "not read";
        var name = config.NameUtf8 is { Length: > 0 } bytes ? Encoding.UTF8.GetString(bytes) : "(no name)";
        // The style key is four ASCII characters, most significant byte first ("WING", "NULL").
        // (No array.Reverse(): with C# 14 it binds to the in-place Span version and returns void.)
        var style = new string(new[] { 24, 16, 8, 0 }.Select(shift => (char)((config.StyleKey >> shift) & 0xFF)).ToArray());
        string Shape(TacticalPosition[] positions) => string.Join(" ", positions.Select(position => TacticalFormationDecoder.DecodePosition(position.PositionMask) ?? "?"));
        var overrides = $"{config.InPossessionOverrides?.Length.ToString() ?? "?"}/{config.OutOfPossessionOverrides?.Length.ToString() ?? "?"}";
        return $"\"{name}\" style {style} mentality {config.Mentality}, in possession [{Shape(config.InPossession)}], " +
               $"out of possession [{Shape(config.OutOfPossession)}], player overrides {overrides}, slot map {string.Join(",", config.PhaseSlotMapping)}";
    }
}
