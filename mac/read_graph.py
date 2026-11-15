#!/usr/bin/env python3
"""Read the macOS probe's graph snapshots (local/probe/*-graph.bin).

Usage:
  python3 mac/read_graph.py FILE                 summary of one snapshot
  python3 mac/read_graph.py FILE --players       match players: where they point back to the
                                                 match, and floats that look like pitch positions
  python3 mac/read_graph.py FILE --record N      hex dump of one record

The layout is written by MacMatchProbe.DeepSnapshot: "FMPG", u32 version, u64 match,
i32 tick, i32 targetTick, u32 count; then per record u64 address, u64 pointer,
u32 size, i32 parent, u32 offset in parent, u32 depth, and the bytes.
"""
import argparse
import struct
from collections import Counter
from dataclasses import dataclass

MAGIC = 0x47504D46  # "FMPG"


@dataclass
class Record:
    index: int
    address: int
    pointer: int
    parent: int
    parent_offset: int
    depth: int
    data: bytes

    def qword(self, offset):
        return struct.unpack_from("<Q", self.data, offset)[0] if offset + 8 <= len(self.data) else None

    def int32(self, offset):
        return struct.unpack_from("<i", self.data, offset)[0] if offset + 4 <= len(self.data) else None

    def float32(self, offset):
        return struct.unpack_from("<f", self.data, offset)[0] if offset + 4 <= len(self.data) else None

    def at_pointer(self, offset):
        """Offset measured from the pointer that led here (windows start before it)."""
        return offset + (self.pointer - self.address)


@dataclass
class Graph:
    match: int
    tick: int
    target_tick: int
    records: list

    def children(self, index):
        return [r for r in self.records if r.parent == index]

    def players(self, scan_end=0x400):
        """Depth-2 records (objects a team points to) holding a pointer back to the match."""
        result = []
        for record in self.records:
            if record.depth != 2:
                continue
            back = next((o for o in range(0, min(scan_end, len(record.data)) - 7, 8)
                         if record.qword(o) == self.match), None)
            if back is not None:
                result.append((record, back))
        return result


def read_graph(path):
    with open(path, "rb") as handle:
        data = handle.read()
    magic, version, match, tick, target, count = struct.unpack_from("<IIQiiI", data, 0)
    if magic != MAGIC:
        raise ValueError(f"{path} is not a graph snapshot (magic 0x{magic:08X})")
    if version != 1:
        raise ValueError(f"{path} has unsupported version {version}")
    offset = struct.calcsize("<IIQiiI")
    records = []
    header = struct.Struct("<QQIiII")
    for index in range(count):
        address, pointer, size, parent, parent_offset, depth = header.unpack_from(data, offset)
        offset += header.size
        records.append(Record(index, address, pointer, parent, parent_offset, depth, data[offset:offset + size]))
        offset += size
    return Graph(match, tick, target, records)


def summary(graph):
    print(f"match 0x{graph.match:X} tick {graph.tick} target {graph.target_tick}: {len(graph.records)} records")
    print("records per depth:", dict(sorted(Counter(r.depth for r in graph.records).items())))
    for team in (r for r in graph.records if r.depth == 1 and r.parent == 0 and len(r.data) >= 0x1000):
        kids = graph.children(team.index)
        print(f"team at match+0x{team.parent_offset:X} (0x{team.address:X}): {len(kids)} children")
    players = graph.players()
    print(f"{len(players)} objects point back to the match; back-pointer offsets:",
          dict(Counter(f"+0x{b:X}" for _, b in players)))
    by_team = Counter((graph.records[r.parent].parent_offset, r.parent_offset) for r, _ in players)
    tables = {}
    for (team_field, offset), _ in sorted(by_team.items()):
        tables.setdefault(team_field, []).append(offset)
    for team_field, offsets in tables.items():
        print(f"  team at match+0x{team_field:X}: players from team offsets "
              f"0x{min(offsets):X}..0x{max(offsets):X} ({len(offsets)} slots)")


def players_report(graph):
    players = graph.players()
    print(f"{len(players)} match players")
    if not players:
        return
    size = min(len(r.data) for r, _ in players)
    # Offsets where every player holds a float inside pitch bounds, and the values differ between players.
    candidates = []
    for offset in range(0, size - 3, 4):
        values = [r.float32(offset) for r, _ in players]
        if all(v == v and -80.0 <= v <= 80.0 for v in values) and len({round(v, 2) for v in values}) > len(values) // 2:
            if any(abs(v) > 1.0 for v in values):
                candidates.append((offset, min(values), max(values)))
    print("float fields that look like pitch coordinates (offset, min, max):")
    for offset, low, high in candidates[:40]:
        print(f"  +0x{offset:X}: {low:.2f} .. {high:.2f}")
    # Small integers 1..99 that differ between players: shirt numbers.
    print("int32 fields with values 1..99, mostly distinct within each team (shirt number candidates):")
    teams = {}
    for record, _ in players:
        teams.setdefault(record.parent, []).append(record)
    for offset in range(0, size - 3, 4):
        ok = True
        for members in teams.values():
            values = [r.int32(offset) for r in members]
            if not all(1 <= v <= 99 for v in values) or len(set(values)) < len(values) * 0.8:
                ok = False
                break
        if ok:
            sample = sorted(r.int32(offset) for r in next(iter(teams.values())))
            print(f"  +0x{offset:X}: {sample[:12]}")


def hexdump(record, limit=0x400):
    print(f"record {record.index}: address 0x{record.address:X} pointer 0x{record.pointer:X} "
          f"depth {record.depth} parent {record.parent}+0x{record.parent_offset:X} size 0x{len(record.data):X}")
    for offset in range(0, min(limit, len(record.data)), 16):
        chunk = record.data[offset:offset + 16]
        text = "".join(chr(c) if 32 <= c < 127 else "." for c in chunk)
        print(f"  {offset:06X}  {chunk.hex(' ')}  {text}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("file")
    parser.add_argument("--players", action="store_true")
    parser.add_argument("--record", type=int)
    args = parser.parse_args()
    graph = read_graph(args.file)
    if args.record is not None:
        hexdump(graph.records[args.record])
    elif args.players:
        players_report(graph)
    else:
        summary(graph)


if __name__ == "__main__":
    main()
