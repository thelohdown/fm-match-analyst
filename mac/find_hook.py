#!/usr/bin/env python3
"""Rank candidates for FM's GAME_MATCH Advance function in an arm64 game_plugin.

On Windows, FMMatchLens hooks this function by an x86-64 byte pattern
(Memory/GameMatchTickSignature.cs). That pattern shows what the function
does first:

  * saves the floating-point control state and sets flush-to-zero
    (stmxcsr / ldmxcsr with 0x8000), and
  * tests three bytes of the match object, its first argument:
    [match+0x15570] == 1, [match+0x1556E] == 1 and [match+0x15575] == 0.

If the macOS build shares the Windows object layout, its arm64 version must do
the same: read or write FPCR (mrs/msr fpcr) and load bytes at x0+0x1556E,
x0+0x15570 and x0+0x15575. On arm64 those offsets are too large for one load,
so the compiler forms them in two steps, for example:

  add  x8, x0, #0x15, lsl #12     ; x8 = match + 0x15000
  ldrb w9, [x8, #0x570]           ; byte at match + 0x15570

This script follows copies of x0 through mov/add/sub, records every load it can
resolve relative to x0, and scores each function by how many of those signs it
shows. It prints the best candidates with their first instructions and a draft
PatternArm64 for the plugin.

Usage:
  python3 mac/find_hook.py local/game/<path to the arm64 game_plugin binary>
Needs: pip install lief capstone
"""
import argparse
import re
import sys

import capstone
import lief

# Windows offsets. --shift moves them all, e.g. --shift -0x10 for the macOS demo
# build, whose x86_64 slice makes the same checks at 0x1555E, 0x15560 and 0x15565.
WINDOWS_TARGETS = (0x1556E, 0x15570, 0x15575)
WINDOWS_LIFECYCLE = range(0x15568, 0x1556C)  # Offsets.GameMatch.LifecycleStateA..D
TARGETS = set(WINDOWS_TARGETS)
LIFECYCLE = set(WINDOWS_LIFECYCLE)
WINDOW = (0x15000, 0x16000)                  # loads near the checks, shown as evidence

LOAD_WIDTH = {
    "ldrb": 1, "ldurb": 1, "ldrsb": 1, "ldursb": 1,
    "ldrh": 2, "ldurh": 2, "ldrsh": 2, "ldursh": 2,
    "ldrsw": 4, "ldursw": 4,
}
CALLER_SAVED = {f"x{n}" for n in range(19)} | {"x30"}
NO_DEST = {"cmp", "cmn", "tst", "ccmp", "ccmn", "fcmp", "fcmpe", "cbz", "cbnz", "tbz", "tbnz",
           "b", "bl", "blr", "br", "ret", "prfm", "msr", "nop", "dmb", "dsb", "isb", "hint",
           "bti", "paciasp", "autiasp", "pacibsp", "autibsp"}
PC_RELATIVE = ("adr", "adrp", "b", "bl", "cbz", "cbnz", "tbz", "tbnz")

MEM = re.compile(r"\[(?P<base>x\d+|sp)(?:,\s*#(?P<disp>-?0x[0-9a-f]+|-?\d+))?\]")
IMM = re.compile(r"#(-?0x[0-9a-f]+|-?\d+)")


def num(text):
    return int(text, 16) if text.lower().lstrip("-").startswith("0x") else int(text)


def xreg(name):
    """x-register written by an operand name (w8 writes x8)."""
    if re.fullmatch(r"[wx]\d+", name):
        return "x" + name[1:]
    return None


def analyse(code, address, max_instructions=200):
    """Follow copies of x0 and score loads relative to it."""
    md = capstone.Cs(getattr(capstone, "CS_ARCH_ARM64", None) or capstone.CS_ARCH_AARCH64,
                     capstone.CS_MODE_ARM)
    tracked = {"x0": 0}
    loads = {}
    fpcr = set()
    listing = []
    for index, insn in enumerate(md.disasm(code, address)):
        if index >= max_instructions:
            break
        mnemonic, ops = insn.mnemonic, insn.op_str
        listing.append(insn)
        parts = [p.strip() for p in ops.split(",")]
        dest = xreg(parts[0]) if parts and parts[0] else None

        if mnemonic in ("mrs", "msr") and "fpcr" in ops:
            fpcr.add(mnemonic)

        if mnemonic == "mov" and len(parts) == 2 and xreg(parts[1]) and parts[1].startswith("x"):
            source = parts[1]
            if source in tracked:
                tracked[dest] = tracked[source]
            else:
                tracked.pop(dest, None)
            continue

        if mnemonic in ("add", "sub") and len(parts) >= 3 and parts[1] in tracked and parts[2].startswith("#"):
            value = num(parts[2][1:])
            if len(parts) >= 4 and parts[3].startswith("lsl #"):
                value <<= num(parts[3][5:])
            tracked[dest] = tracked[parts[1]] + (value if mnemonic == "add" else -value)
            continue

        memory = MEM.search(ops)
        if memory and mnemonic.startswith(("ldr", "ldur", "ldp")) and memory.group("base") in tracked:
            offset = tracked[memory.group("base")] + (num(memory.group("disp")) if memory.group("disp") else 0)
            if mnemonic.startswith("ldp"):
                width = 16 if parts[0].startswith("x") else 8
            else:
                width = LOAD_WIDTH.get(mnemonic, 8 if parts[0].startswith("x") else 4)
            loads.setdefault(offset, (mnemonic, width, insn.address))

        if mnemonic in ("bl", "blr"):
            for register in list(tracked):
                if register in CALLER_SAVED:
                    tracked.pop(register)
        elif dest and dest in tracked and mnemonic not in NO_DEST and not mnemonic.startswith(("st", "b.")):
            tracked.pop(dest)
        if mnemonic == "ret":
            break

    covered = set()
    for offset, (_, width, _) in loads.items():
        covered.update(range(offset, offset + width))
    hits = sorted(set(TARGETS) & covered)
    lifecycle = sorted(LIFECYCLE & covered)
    score = 3 * len(hits) + len(lifecycle) + 2 * len(fpcr)
    nearby = sorted(o for o in loads if WINDOW[0] <= o < WINDOW[1])
    return score, hits, lifecycle, sorted(fpcr), nearby, listing


def draft_pattern(listing, count=24):
    """First instructions as bytes, with PC-relative instructions wildcarded."""
    tokens = []
    for insn in listing[:count]:
        if insn.mnemonic in PC_RELATIVE or insn.mnemonic.startswith("b."):
            tokens += ["?"] * 4
        else:
            tokens += [f"{b:02X}" for b in insn.bytes]
    return " ".join(tokens)


def load_binary(path):
    fat = lief.MachO.parse(path)
    if fat is None:
        sys.exit(f"LIEF could not parse {path} as Mach-O")
    binary = fat.take(lief.MachO.Header.CPU_TYPE.ARM64)
    if binary is None:
        sys.exit("the file has no arm64 slice")
    return binary


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("binary")
    parser.add_argument("--top", type=int, default=10)
    parser.add_argument("--min-score", type=int, default=3)
    parser.add_argument("--shift", type=lambda v: int(v, 0), default=0,
                        help="add this to every Windows offset (e.g. -0x10)")
    args = parser.parse_args()
    global TARGETS, LIFECYCLE
    TARGETS = {o + args.shift for o in WINDOWS_TARGETS}
    LIFECYCLE = {o + args.shift for o in WINDOWS_LIFECYCLE}

    binary = load_binary(args.binary)
    text = binary.get_segment("__TEXT")
    text_base = text.virtual_address
    starts = sorted(binary.function_starts.functions) if binary.has_function_starts else []
    if not starts:
        sys.exit("no LC_FUNCTION_STARTS table: cannot enumerate functions")
    section = binary.get_section("__text")
    code = bytes(section.content)
    code_start = section.virtual_address - text_base
    print(f"{args.binary}: cpu={binary.header.cpu_type}, functions={len(starts)}, "
          f"__text=0x{code_start:X}+0x{len(code):X}", flush=True)

    results = []
    for i, start in enumerate(starts):
        if not code_start <= start < code_start + len(code):
            continue
        end = starts[i + 1] if i + 1 < len(starts) else code_start + len(code)
        chunk = code[start - code_start:min(end, start + 4096) - code_start]
        score, hits, lifecycle, fpcr, nearby, listing = analyse(chunk, start)
        if score >= args.min_score:
            results.append((score, start, hits, lifecycle, fpcr, nearby, listing))
        if i and i % 20000 == 0:
            print(f"  scanned {i}/{len(starts)} functions", flush=True)

    results.sort(key=lambda r: (-r[0], r[1]))
    print(f"\n{len(results)} functions scored >= {args.min_score}; best {min(args.top, len(results))}:")
    for score, start, hits, lifecycle, fpcr, nearby, listing in results[:args.top]:
        print(f"\nRVA 0x{start:X}  score={score}  checks={[hex(h) for h in hits]}  "
              f"lifecycle={[hex(h) for h in lifecycle]}  fpcr={fpcr}")
        print(f"  loads near the checks: {[hex(o) for o in nearby[:16]]}")
        for insn in listing[:16]:
            print(f"    0x{insn.address:X}: {insn.mnemonic:8} {insn.op_str}")
        print(f"  draft PatternArm64: {draft_pattern(listing)}")


if __name__ == "__main__":
    main()
