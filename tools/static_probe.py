from __future__ import annotations

import hashlib
import math
import re
import struct
import sys
from pathlib import Path


KEYWORDS = re.compile(
    rb"(?i)(blacktemple|wireguard|openvpn|wintun|tun2socks|sing-box|xray|v2ray|"
    rb"electron|app\.asar|\.dll|\.exe|\.json|\.yaml|\.yml|\.conf|\.ovpn|"
    rb"https?://|api[./_-]|vpn)"
)


def entropy(data: bytes) -> float:
    if not data:
        return 0.0
    counts = [0] * 256
    for value in data:
        counts[value] += 1
    length = len(data)
    return -sum((c / length) * math.log2(c / length) for c in counts if c)


def printable_strings(data: bytes, minimum: int = 6):
    ascii_re = re.compile(rb"[\x20-\x7e]{%d,}" % minimum)
    utf16_re = re.compile(rb"(?:[\x20-\x7e]\x00){%d,}" % minimum)
    for match in ascii_re.finditer(data):
        yield match.start(), match.group()
    for match in utf16_re.finditer(data):
        yield match.start(), match.group().decode("utf-16le").encode("utf-8")


def pe_exports(data: bytes, pe_offset: int, opt_offset: int, magic: int, sections):
    data_dir_offset = opt_offset + (112 if magic == 0x20B else 96)
    export_rva, export_size = struct.unpack_from("<II", data, data_dir_offset)
    if not export_rva or not export_size:
        return []

    def rva_to_offset(rva: int) -> int:
        for virtual_address, virtual_size, raw_pointer, raw_size in sections:
            span = max(virtual_size, raw_size)
            if virtual_address <= rva < virtual_address + span:
                return raw_pointer + (rva - virtual_address)
        raise ValueError(f"RVA 0x{rva:x} is outside file sections")

    directory = rva_to_offset(export_rva)
    fields = struct.unpack_from("<IIHHIIIIIII", data, directory)
    name_count = fields[7]
    names_rva = fields[9]
    names_offset = rva_to_offset(names_rva)
    exports = []
    for index in range(name_count):
        name_rva = struct.unpack_from("<I", data, names_offset + index * 4)[0]
        name_offset = rva_to_offset(name_rva)
        end = data.find(b"\0", name_offset)
        if end == -1:
            raise ValueError("Unterminated export name")
        exports.append(data[name_offset:end].decode("ascii", "replace"))
    return exports


def main(path_text: str) -> None:
    path = Path(path_text)
    data = path.read_bytes()
    print(f"file={path}")
    print(f"size={len(data)}")
    print(f"sha256={hashlib.sha256(data).hexdigest()}")

    if data[:2] != b"MZ":
        raise SystemExit("Not a PE file")
    pe_offset = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe_offset : pe_offset + 4] != b"PE\0\0":
        raise SystemExit("Invalid PE signature")

    machine, section_count, timestamp, _, _, opt_size, characteristics = struct.unpack_from(
        "<HHIIIHH", data, pe_offset + 4
    )
    opt_offset = pe_offset + 24
    magic = struct.unpack_from("<H", data, opt_offset)[0]
    section_offset = opt_offset + opt_size
    print(
        f"pe_offset=0x{pe_offset:x} machine=0x{machine:04x} "
        f"bits={'64' if magic == 0x20B else '32'} sections={section_count} "
        f"timestamp={timestamp} characteristics=0x{characteristics:04x}"
    )

    raw_end = 0
    sections = []
    for i in range(section_count):
        off = section_offset + i * 40
        name, virtual_size, virtual_address, raw_size, raw_pointer = struct.unpack_from(
            "<8sIIII", data, off
        )
        name_text = name.rstrip(b"\0").decode("ascii", "replace")
        section_data = data[raw_pointer : raw_pointer + raw_size]
        raw_end = max(raw_end, raw_pointer + raw_size)
        sections.append((virtual_address, virtual_size, raw_pointer, raw_size))
        print(
            f"section={name_text!r} va=0x{virtual_address:x} vsize={virtual_size} "
            f"raw=0x{raw_pointer:x}+{raw_size} entropy={entropy(section_data):.3f}"
        )
    print(f"overlay_offset=0x{raw_end:x} overlay_size={max(0, len(data)-raw_end)}")

    exports = pe_exports(data, pe_offset, opt_offset, magic, sections)
    print(f"exports={len(exports)}")
    for name in exports[:250]:
        print(f"export={name}")

    seen = set()
    matches = []
    for offset, value in printable_strings(data):
        if KEYWORDS.search(value) and value not in seen:
            seen.add(value)
            text = value.decode("utf-8", "replace")
            if len(text) > 300:
                text = text[:300] + "..."
            matches.append((offset, text))
    print(f"interesting_strings={len(matches)}")
    for offset, text in matches[:250]:
        print(f"0x{offset:x}: {text}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {sys.argv[0]} FILE")
    main(sys.argv[1])
