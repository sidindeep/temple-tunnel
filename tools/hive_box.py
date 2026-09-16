from __future__ import annotations

import argparse
import json
import struct
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any


TYPE_NULL = 0
TYPE_INT = 1
TYPE_DOUBLE = 2
TYPE_BOOL = 3
TYPE_STRING = 4
TYPE_STRING_LIST = 9
TYPE_LIST = 10
TYPE_MAP = 11


@dataclass
class Frame:
    offset: int
    length: int
    key: str | int
    type_id: int | None
    value: Any
    crc_ok: bool


class Cursor:
    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def take(self, size: int) -> bytes:
        if self.pos + size > len(self.data):
            raise ValueError("Unexpected end of value")
        value = self.data[self.pos : self.pos + size]
        self.pos += size
        return value

    def byte(self) -> int:
        return self.take(1)[0]

    def u32(self) -> int:
        return struct.unpack("<I", self.take(4))[0]

    def f64(self) -> float:
        return struct.unpack("<d", self.take(8))[0]

    def text(self) -> str:
        return self.take(self.u32()).decode("utf-8")


def read_key(cursor: Cursor) -> str | int:
    key_type = cursor.byte()
    if key_type == 0:
        return cursor.u32()
    if key_type == 1:
        return cursor.take(cursor.byte()).decode("utf-8")
    raise ValueError(f"Unsupported key type: {key_type}")


def read_value(cursor: Cursor, with_type: bool = True) -> tuple[int | None, Any]:
    type_id = cursor.byte() if with_type else None
    if type_id == TYPE_NULL:
        return type_id, None
    if type_id == TYPE_INT:
        return type_id, int(cursor.f64())
    if type_id == TYPE_DOUBLE:
        return type_id, cursor.f64()
    if type_id == TYPE_BOOL:
        return type_id, bool(cursor.byte())
    if type_id == TYPE_STRING:
        return type_id, cursor.text()
    if type_id == TYPE_STRING_LIST:
        return type_id, [cursor.text() for _ in range(cursor.u32())]
    if type_id == TYPE_LIST:
        values = []
        for _ in range(cursor.u32()):
            _, value = read_value(cursor)
            values.append(value)
        return type_id, values
    if type_id == TYPE_MAP:
        values = {}
        for _ in range(cursor.u32()):
            _, key = read_value(cursor)
            _, value = read_value(cursor)
            values[key] = value
        return type_id, values
    return type_id, f"<unsupported type {type_id}>"


def parse_frames(data: bytes) -> list[Frame]:
    frames = []
    offset = 0
    while offset < len(data):
        if offset + 4 > len(data):
            raise ValueError(f"Truncated length at 0x{offset:x}")
        length = struct.unpack_from("<I", data, offset)[0]
        if length < 8 or offset + length > len(data):
            raise ValueError(f"Invalid frame length {length} at 0x{offset:x}")
        raw = data[offset : offset + length]
        expected_crc = struct.unpack_from("<I", raw, length - 4)[0]
        actual_crc = zlib.crc32(raw[:-4]) & 0xFFFFFFFF
        cursor = Cursor(raw[4:-4])
        key = read_key(cursor)
        if cursor.pos == len(cursor.data):
            type_id, value = None, "<deleted>"
        else:
            type_id, value = read_value(cursor)
        frames.append(Frame(offset, length, key, type_id, value, actual_crc == expected_crc))
        offset += length
    return frames


def encode_key(key: str) -> bytes:
    raw = key.encode("utf-8")
    if len(raw) > 255:
        raise ValueError("Hive string key is longer than 255 bytes")
    return b"\x01" + bytes([len(raw)]) + raw


def encode_value(value: Any) -> bytes:
    if value is None:
        return bytes([TYPE_NULL])
    if isinstance(value, bool):
        return bytes([TYPE_BOOL, int(value)])
    if isinstance(value, str):
        raw = value.encode("utf-8")
        return bytes([TYPE_STRING]) + struct.pack("<I", len(raw)) + raw
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        parts = [bytes([TYPE_STRING_LIST]), struct.pack("<I", len(value))]
        for item in value:
            raw = item.encode("utf-8")
            parts.extend((struct.pack("<I", len(raw)), raw))
        return b"".join(parts)
    raise TypeError(f"Unsupported value: {type(value).__name__}")


def encode_frame(key: str, value: Any) -> bytes:
    body = encode_key(key) + encode_value(value)
    length = 4 + len(body) + 4
    without_crc = struct.pack("<I", length) + body
    return without_crc + struct.pack("<I", zlib.crc32(without_crc) & 0xFFFFFFFF)


def main() -> None:
    parser = argparse.ArgumentParser(description="Inspect or append primitive Hive CE box frames")
    parser.add_argument("path", type=Path)
    parser.add_argument("--keys", nargs="+")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    frames = parse_frames(args.path.read_bytes())
    bad_crc = [frame for frame in frames if not frame.crc_ok]
    print(f"frames={len(frames)} crc_errors={len(bad_crc)} size={args.path.stat().st_size}")
    if bad_crc:
        raise SystemExit("CRC validation failed")

    latest = {}
    for frame in frames:
        latest[frame.key] = frame
    for key in args.keys or []:
        frame = latest.get(key)
        if frame is None:
            print(f"{key}=<missing>")
        else:
            print(
                f"{key}: type={frame.type_id} value={json.dumps(frame.value, ensure_ascii=False)} "
                f"offset=0x{frame.offset:x}"
            )

    if args.self_test:
        tests = {
            "bool": True,
            "string": "include",
            "list": ["geosite:telegram", "geosite:openai"],
        }
        for key, value in tests.items():
            generated = encode_frame(key, value)
            parsed = parse_frames(generated)[0]
            if parsed.key != key or parsed.value != value or not parsed.crc_ok:
                raise SystemExit(f"Self-test failed for {key}")
        print("self_test=ok")


if __name__ == "__main__":
    main()
