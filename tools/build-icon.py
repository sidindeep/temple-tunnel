from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "build"
SIZE = 1024


def make_icon() -> Image.Image:
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle((126, 150, 898, 922), radius=236, fill=(37, 126, 58, 135))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(54)))

    tile = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    tile_draw = ImageDraw.Draw(tile)
    for y in range(128, 896):
        progress = (y - 128) / 768
        color = (
            round(163 + (82 - 163) * progress),
            round(239 + (185 - 239) * progress),
            round(169 + (100 - 169) * progress),
            255,
        )
        tile_draw.line((128, y, 896, y), fill=color, width=2)
    mask = Image.new("L", canvas.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((128, 128, 896, 896), radius=224, fill=255)
    tile.putalpha(mask)
    canvas.alpha_composite(tile)

    mark = ImageDraw.Draw(canvas)
    mark.rounded_rectangle((302, 304, 722, 414), radius=44, fill=(9, 29, 13, 255))
    mark.rounded_rectangle((458, 366, 566, 724), radius=45, fill=(9, 29, 13, 255))
    return canvas


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    icon = make_icon()
    icon.save(OUTPUT / "icon.png", optimize=True)
    icon.save(
        OUTPUT / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )


if __name__ == "__main__":
    main()
