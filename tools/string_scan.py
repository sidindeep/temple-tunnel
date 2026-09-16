from __future__ import annotations

import re
import sys
from pathlib import Path


def strings(data: bytes, minimum: int = 4):
    for match in re.finditer(rb"[\x20-\x7e]{%d,}" % minimum, data):
        yield match.start(), match.group().decode("ascii", "replace")
    for match in re.finditer(rb"(?:[\x20-\x7e]\x00){%d,}" % minimum, data):
        yield match.start(), match.group().decode("utf-16le", "replace")


def redact(value: str) -> str:
    value = re.sub(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "<jwt-redacted>", value)
    value = re.sub(
        r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
        "<uuid-redacted>",
        value,
    )
    return value


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit(f"usage: {sys.argv[0]} FILE REGEX")
    path = Path(sys.argv[1])
    pattern = re.compile(sys.argv[2], re.IGNORECASE)
    start = int(sys.argv[3], 0) if len(sys.argv) > 3 else 0
    seen = set()
    for offset, value in strings(path.read_bytes()):
        if offset >= start and pattern.search(value) and value not in seen:
            seen.add(value)
            print(f"0x{offset:x}: {redact(value[:500])}")


if __name__ == "__main__":
    main()
