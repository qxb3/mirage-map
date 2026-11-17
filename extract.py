#!/usr/bin/env python3
"""Extract the current Mirage Realms world from Mirage.jar into web assets.

The game ships a 1000x1000 world with several vertical layers. Each .map file
is a 14-byte header followed by one fixed-size record per tile:

    int32   format marker
    int32   timestamp
    uint16  width
    uint16  height
    uint16  layer count
    per tile:
        uint16 x 5   tile ids, ground first
        uint8        ground material/height selector
        float32      movement scale
        uint8        object type (0 none, 9 ladder, 10 lava, 1-8 lights)

The tile atlas and its PNG are XOR'd with 0x89. Tile ids index regions named
"tiles" in packed.atlas, and those region coordinates are top-left based.
"""

from __future__ import annotations

import argparse
import io
import json
import re
import struct
import zipfile
from pathlib import Path

from PIL import Image

XOR_KEY = 0x89
TILE = 16
WORLD_W = 1000
WORLD_H = 1000
LAYER_META = {
    0: ("overworld", "Overworld", "Surface"),
    -1: ("underground-1", "Underground 1", "B1"),
    -2: ("underground-2", "Underground 2", "B2"),
    -3: ("underground-3", "Underground 3", "B3"),
    -4: ("underground-4", "Underground 4", "B4"),
    -5: ("underground-5", "Underground 5", "B5"),
    -100: ("chaos", "Chaos", "Chaos"),
}
LAYER_ORDER = [0, -1, -2, -3, -4, -5, -100]

# Cyan pixels in Underground 1's world-map image that are not portals; the user
# confirmed these should not be drawn as portal orbs.
IGNORED_PORTALS = {
    (-1, 690, 569),
    (-1, 694, 567),
    (-1, 635, 623),
    (-1, 638, 621),
}

# Portal orbs to drop, each given as the spot on the map the user pointed at.
# Only the single detected portal nearest each spot is removed; neighbouring
# orbs are left alone.
IGNORED_PORTAL_POINTS = {
    -100: [(431, 260), (436, 294), (507, 395), (507, 429), (381, 507), (381, 541)],
}
IGNORED_PORTAL_SNAP = 8


def remove_ignored_portals(z: int, portals: list[dict]) -> list[dict]:
    remaining = [p for p in portals if (z, p["x"], p["y"]) not in IGNORED_PORTALS]
    for point in IGNORED_PORTAL_POINTS.get(z, ()):
        nearest = min(
            remaining,
            key=lambda p: max(abs(p["x"] - point[0]), abs(p["y"] - point[1])),
            default=None,
        )
        if nearest is None:
            continue
        distance = max(abs(nearest["x"] - point[0]), abs(nearest["y"] - point[1]))
        if distance <= IGNORED_PORTAL_SNAP:
            remaining.remove(nearest)
    return remaining


def decode(data: bytes) -> bytes:
    return bytes(b ^ XOR_KEY for b in data)


def parse_atlas(text: str) -> dict[int, tuple[int, int]]:
    regions: dict[int, tuple[int, int]] = {}
    cur: dict[str, object] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if line == "tiles":
            cur = {}
        elif line.startswith("xy:") and cur is not None:
            cur["xy"] = tuple(int(v) for v in line.split(":", 1)[1].replace(" ", "").split(","))
        elif line.startswith("size:") and "xy" in cur:
            cur["size"] = tuple(int(v) for v in line.split(":", 1)[1].replace(" ", "").split(","))
        elif line.startswith("index:"):
            regions[int(line.split(":", 1)[1])] = cur["xy"]  # type: ignore[assignment]
    return regions


def map_records(data: bytes) -> tuple[int, int, int, list[tuple[list[int], int, int]]]:
    width, height = struct.unpack(">HH", data[8:12])
    layers = struct.unpack(">H", data[12:14])[0]
    record_size = layers * 2 + 6
    records: list[tuple[list[int], int, int]] = []
    for i in range(width * height):
        off = 14 + i * record_size
        ids = list(struct.unpack(f">{layers}H", data[off : off + layers * 2]))
        material = data[off + layers * 2]
        scale_bits = data[off + layers * 2 + 1 : off + layers * 2 + 5]
        object_type = data[off + record_size - 1]
        records.append((ids, material, object_type))
    return width, height, layers, records


def flip_rows(records: list[tuple[list[int], int, int]], width: int, height: int) -> list[tuple[list[int], int, int]]:
    """Map files store rows bottom-up (LibGDX y-up); the site draws top-down."""
    return [records[(height - 1 - y) * width + x] for y in range(height) for x in range(width)]


def parse_worldmap_atlas(text: str) -> dict[int, tuple[str, int, int, int, int]]:
    regions: dict[int, tuple[str, int, int, int, int]] = {}
    for page, body in re.findall(r"(?m)^(\S+\.png)\r?\n(.*?)(?=\r?\n\S+\.png\r?\n|\Z)", text, re.S):
        for match in re.finditer(
            r"(?m)^(-?\d+)\r?\n  rotate: false\r?\n  xy: (\d+), (\d+)\r?\n  size: (\d+), (\d+)", body
        ):
            z, x, y, w, h = (int(value) for value in match.groups())
            regions[z] = (page, x, y, w, h)
    return regions


def parse_stair_tiles(tsx: str) -> dict[int, str]:
    stairs: dict[int, str] = {}
    tile_id = None
    for line in tsx.splitlines():
        match = re.search(r'<tile id="(\d+)"', line)
        if match:
            tile_id = int(match.group(1))
        match = re.search(r'<property name="stairs" value="([^"]+)"', line)
        if match and tile_id is not None:
            stairs[tile_id] = match.group(1)
    return stairs


def parse_animations(tsx: str) -> dict[int, list[tuple[int, int]]]:
    """Tiled <animation> blocks: tile id -> [(frame tile id, duration ms), ...]."""
    animations: dict[int, list[tuple[int, int]]] = {}
    for match in re.finditer(r'<tile id="(\d+)">(.*?)</tile>', tsx, re.S):
        tile_id = int(match.group(1))
        block = re.search(r"<animation>(.*?)</animation>", match.group(2), re.S)
        if block is None:
            continue
        frames = [
            (int(frame), int(duration))
            for frame, duration in re.findall(
                r'<frame tileid="(\d+)" duration="(\d+)"', block.group(1)
            )
        ]
        if frames:
            animations[tile_id] = frames
    return animations


def cluster_stairs(entries: list[tuple[int, int, str]]) -> list[dict[str, object]]:
    """Collapse multi-tile staircases into one marker per connected flight."""
    result: list[dict[str, object]] = []
    by_direction: dict[str, set[tuple[int, int]]] = {}
    for x, y, direction in entries:
        by_direction.setdefault(direction, set()).add((x, y))
    for direction, points in by_direction.items():
        unseen = set(points)
        while unseen:
            seed = unseen.pop()
            group = [seed]
            stack = [seed]
            while stack:
                px, py = stack.pop()
                for nx in range(px - 1, px + 2):
                    for ny in range(py - 1, py + 2):
                        if (nx, ny) in unseen:
                            unseen.remove((nx, ny))
                            stack.append((nx, ny))
                            group.append((nx, ny))
            result.append(
                {
                    "x": round(sum(p[0] for p in group) / len(group)),
                    "y": round(sum(p[1] for p in group) / len(group)),
                    "dir": direction,
                }
            )
    result.sort(key=lambda item: (item["y"], item["x"]))
    return result


PORTAL_MARKER = (0, 255, 178)

# Mirror of the client's light enum: tile/object light name -> (width px,
# colour, intensity). Widths come from the client's SMALL/MEDIUM/LARGE/
# EXTRA_LARGE light sizes (60.8 / 96 / 240 / 320 world pixels).
LIGHT_TYPES = {
    "small": (60.8, "#ffffff", 1.0),
    "white-torch": (320.0, "#ffa152", 1.0),
    "white-candle": (60.8, "#ffa152", 1.0),
    "blue-torch": (320.0, "#63d1ff", 1.0),
    "blue-candle": (60.8, "#63d1ff", 1.0),
    "red-torch": (320.0, "#ff6363", 1.0),
    "red-candle": (60.8, "#ff6363", 1.0),
    "green-torch": (320.0, "#88ff63", 1.0),
    "green-candle": (60.8, "#88ff63", 1.0),
    "light-ladder": (60.8, "#ffffff", 0.2),
    "light-lava": (60.8, "#ffa500", 0.2),
}

# Map object byte -> light type (the client uses the light enum ordinal).
OBJECT_LIGHTS = {
    1: "white-torch",
    2: "white-candle",
    3: "blue-torch",
    4: "blue-candle",
    5: "red-torch",
    6: "red-candle",
    7: "green-torch",
    8: "green-candle",
}


def parse_tile_lights(tsx: str) -> dict[int, str]:
    lights: dict[int, str] = {}
    for match in re.finditer(r'<tile id="(\d+)">(.*?)</tile>', tsx, re.S):
        light = re.search(r'<property name="light" value="([^"]+)"', match.group(2))
        if light is not None:
            lights[int(match.group(1))] = light.group(1)
    return lights


def parse_tile_blocked(tsx: str) -> list[int]:
    """Tile ids the client treats as obstacles: blocked or sight-blocking.

    The mod loader's map grid refuses both kinds when it plots a route, so the
    map viewer uses the same rule.
    """
    ids: list[int] = []
    for match in re.finditer(r'<tile id="(\d+)">(.*?)</tile>', tsx, re.S):
        if re.search(r'name="(?:blocked|line-of-sight-blocked)"[^>]*value="true"', match.group(2)):
            ids.append(int(match.group(1)))
    return sorted(ids)


def find_portals(image: Image.Image) -> list[dict[str, int]]:
    """Portals are pre-marked on the game's own world-map images in cyan."""
    width, height = image.size
    pixels = image.load()
    points = {(x, y) for y in range(height) for x in range(width) if pixels[x, y] == PORTAL_MARKER}
    result: list[dict[str, int]] = []
    while points:
        seed = points.pop()
        group = [seed]
        stack = [seed]
        while stack:
            px, py = stack.pop()
            for nx in range(px - 2, px + 3):
                for ny in range(py - 2, py + 3):
                    if (nx, ny) in points:
                        points.remove((nx, ny))
                        stack.append((nx, ny))
                        group.append((nx, ny))
        result.append(
            {
                "x": round(sum(p[0] for p in group) / len(group)),
                "y": round(sum(p[1] for p in group) / len(group)),
            }
        )
    result.sort(key=lambda item: (item["y"], item["x"]))
    return result


EMPTY_TILE = 0xFFFF


def tile_id_from_gid(gid: int) -> int:
    """Map files store Tiled GIDs; the tile set uses ids starting at zero."""
    return gid - 1 if gid else -1


def write_tile_images(
    out_dir: Path, z: int, width: int, height: int, layers: int, records: list[tuple[list[int], int, int]]
) -> list[str]:
    layer_dir = out_dir / "tiles" / str(z)
    layer_dir.mkdir(parents=True, exist_ok=True)
    paths: list[str] = []
    for layer in range(layers):
        rgb = bytearray(width * height * 3)
        for i, (ids, _material, _object_type) in enumerate(records):
            gid = ids[layer] if layer < len(ids) else 0
            tile_id = tile_id_from_gid(gid) if gid else EMPTY_TILE
            p = i * 3
            rgb[p] = tile_id & 0xFF
            rgb[p + 1] = (tile_id >> 8) & 0xFF
        img = Image.frombytes("RGB", (width, height), bytes(rgb))
        rel = f"tiles/{z}/{layer}.png"
        img.save(out_dir / rel, optimize=True)
        paths.append(rel)
    return paths


def content_bounds(image: Image.Image) -> list[int]:
    """Find the playable content in an overview by ignoring its dominant colour."""
    width, height = image.size
    pixels = image.load()
    counts: dict[tuple[int, int, int], int] = {}
    for y in range(0, height, 2):
        for x in range(0, width, 2):
            color = pixels[x, y]
            counts[color] = counts.get(color, 0) + 1
    background = max(counts, key=counts.get)
    min_x, min_y, max_x, max_y = width, height, -1, -1
    for y in range(height):
        for x in range(width):
            color = pixels[x, y]
            if sum((color[i] - background[i]) ** 2 for i in range(3)) > 28 * 28:
                min_x = min(min_x, x)
                min_y = min(min_y, y)
                max_x = max(max_x, x)
                max_y = max(max_y, y)
    if max_x < 0:
        return [0, 0, width, height]
    pad = 24
    return [
        max(0, min_x - pad),
        max(0, min_y - pad),
        min(width, max_x + pad + 1),
        min(height, max_y + pad + 1),
    ]


def main() -> None:
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jar", type=Path, default=root.parent / "Mirage.jar")
    parser.add_argument("--out", type=Path, default=root / "data")
    args = parser.parse_args()

    out_dir: Path = args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(args.jar) as jar:
        atlas_text = decode(jar.read("world/tileset/packed.atlas")).decode("utf-8")
        atlas_png = decode(jar.read("world/tileset/packed.png"))
        regions = parse_atlas(atlas_text)
        (out_dir / "atlas.png").write_bytes(atlas_png)

        graphics_atlas = decode(jar.read("graphics/graphics.atlas")).decode("utf-8")
        graphics_image = Image.open(io.BytesIO(decode(jar.read("graphics/graphics.png")))).convert("RGBA")
        for name in ("worldmap-up", "worldmap-down"):
            match = re.search(
                rf"(?m)^{re.escape(name)}\r?\n  rotate: false\r?\n  xy: (\d+), (\d+)\r?\n  size: (\d+), (\d+)",
                graphics_atlas,
            )
            if match is None:
                raise SystemExit(f"graphics atlas has no {name}")
            x, y, w, h = (int(value) for value in match.groups())
            graphics_image.crop((x, y, x + w, y + h)).save(out_dir / f"{name}.png", optimize=True)

        # The client draws portal entities with the PORTAL animated effect, which
        # maps to the 18x18 "effect-48" frames in graphics.png (18px tall row).
        portal_match = re.search(
            r"(?m)^effect-48\r?\n  rotate: false\r?\n  xy: (\d+), (\d+)\r?\n  size: (\d+), (\d+)",
            graphics_atlas,
        )
        if portal_match is None:
            raise SystemExit("graphics atlas has no effect-48 portal frames")
        px, py, pw, ph = (int(value) for value in portal_match.groups())
        graphics_image.crop((px, py, px + pw, py + ph)).save(out_dir / "portal.png", optimize=True)

        # Soft radial gradient the client uses for every light source.
        light_match = re.search(
            r"(?m)^light\r?\n  rotate: false\r?\n  xy: (\d+), (\d+)\r?\n  size: (\d+), (\d+)",
            graphics_atlas,
        )
        if light_match is None:
            raise SystemExit("graphics atlas has no light region")
        lx, ly, lw, lh = (int(value) for value in light_match.groups())
        graphics_image.crop((lx, ly, lx + lw, ly + lh)).save(out_dir / "light.png", optimize=True)

        tiles_tsx = decode(jar.read("world/tiles.tsx")).decode("utf-8")
        stair_tiles = parse_stair_tiles(tiles_tsx)
        animations = parse_animations(tiles_tsx)
        tile_lights = parse_tile_lights(tiles_tsx)
        (out_dir / "lighting.json").write_text(
            json.dumps(
                {
                    "types": {
                        name: {"width": width, "colour": colour, "intensity": intensity}
                        for name, (width, colour, intensity) in LIGHT_TYPES.items()
                    },
                    "tiles": {str(tile): light for tile, light in sorted(tile_lights.items())},
                    "objects": {str(obj): light for obj, light in sorted(OBJECT_LIGHTS.items())},
                },
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
        (out_dir / "blocked.json").write_text(
            json.dumps(parse_tile_blocked(tiles_tsx), separators=(",", ":")),
            encoding="utf-8",
        )
        (out_dir / "animations.json").write_text(
            json.dumps(
                {str(tile): frames for tile, frames in sorted(animations.items())},
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )

        worldmap_regions = parse_worldmap_atlas(decode(jar.read("worldmap/worldmap.atlas")).decode("utf-8"))
        world_pages = {
            page: Image.open(io.BytesIO(decode(jar.read(f"worldmap/{page}")))).convert("RGB")
            for page in ("worldmap.png", "worldmap2.png")
        }
        (out_dir / "overview").mkdir(parents=True, exist_ok=True)

        layer_entries = []
        for z in LAYER_ORDER:
            data = jar.read(f"world/{z}.map")
            width, height, layers, raw_records = map_records(data)
            if (width, height) != (WORLD_W, WORLD_H):
                raise SystemExit(f"unexpected map size for {z}: {width}x{height}")
            records = flip_rows(raw_records, width, height)

            tile_paths = write_tile_images(out_dir, z, width, height, layers, records)

            overview = f"overview/{z}.png"
            region = worldmap_regions.get(z)
            if region is None:
                raise SystemExit(f"world map has no image for layer {z}")
            page, x, y, w, h = region
            world_pages[page].crop((x, y, x + w, y + h)).save(out_dir / overview, optimize=True)
            overview_image = Image.open(out_dir / overview).convert("RGB")

            bounds = content_bounds(overview_image)
            background = "#%02x%02x%02x" % overview_image.getpixel((0, 0))
            ladders = [[i % width, i // width] for i, (_ids, _mat, obj) in enumerate(records) if obj == 9]
            lights = [
                [i % width, i // width, OBJECT_LIGHTS[obj]]
                for i, (_ids, _mat, obj) in enumerate(records)
                if obj in OBJECT_LIGHTS
            ]

            stairs_raw: list[tuple[int, int, str]] = []
            for i, (ids, _mat, _obj) in enumerate(records):
                x_pos, y_pos = i % width, i // width
                for raw_id in ids:
                    tile_id = tile_id_from_gid(raw_id)
                    if tile_id in stair_tiles:
                        stairs_raw.append((x_pos, y_pos, stair_tiles[tile_id]))
            stairs = cluster_stairs(stairs_raw)
            portals = remove_ignored_portals(z, find_portals(overview_image))

            key, name, short = LAYER_META[z]
            has_above = (z + 1) in LAYER_META
            has_below = (z - 1) in LAYER_META
            layer_entries.append(
                {
                    "z": z,
                    "id": key,
                    "name": name,
                    "short": short,
                    "width": width,
                    "height": height,
                    "bounds": bounds,
                    "background": background,
                    "tiles": tile_paths,
                    "overview": overview,
                    "ladders": ladders,
                    "lights": lights,
                    "stairs": stairs,
                    "portals": portals,
                    "climbTo": (z + 1) if has_above else None,
                    "descendTo": (z - 1) if has_below else None,
                }
            )
            print(
                f"{name:14s} ladders={len(ladders):3d} stairs={len(stairs):3d} "
                f"portals={len(portals):2d} tiles={len(tile_paths)}"
            )

    by_layer = {layer["z"]: layer for layer in layer_entries}

    # The wiki documents the three Mirage entrances: Fury from Caverns of Spite
    # (B2, northmost portal), Wrath from Halls of Sorrow (B3), and Loss from The
    # Abyss (B4). The client only sends destination data at runtime, so these are
    # the documented portal room coordinates.
    mirage_routes = [
        (-2, 361, 623, 420, 240, 460, 310),
        (-3, 556, 692, 490, 380, 525, 440),
        (-4, 549, 469, 365, 495, 400, 555),
    ]
    for source_z, source_x, source_y, min_x, min_y, max_x, max_y in mirage_routes:
        source_layer = by_layer[source_z]
        mirage_layer = by_layer[-100]
        source = min(
            source_layer["portals"],
            key=lambda p: (p["x"] - source_x) ** 2 + (p["y"] - source_y) ** 2,
        )
        realm = [
            p for p in mirage_layer["portals"] if min_x <= p["x"] <= max_x and min_y <= p["y"] <= max_y
        ]
        if not realm:
            continue
        source["to"] = -100
        source["toX"] = realm[0]["x"]
        source["toY"] = realm[0]["y"]
        for portal in realm:
            portal["to"] = source_z
            portal["toX"] = source["x"]
            portal["toY"] = source["y"]

    # Link each staircase to the nearest matching staircase on the target layer.
    for layer in layer_entries:
        for stair in layer["stairs"]:
            going_up = stair["dir"].startswith("up")
            target_z = layer["z"] + (1 if going_up else -1)
            target = by_layer.get(target_z)
            stair["to"] = target_z if target else None
            if target and target["stairs"]:
                wanted = "down" if going_up else "up"
                candidates = [s for s in target["stairs"] if s["dir"].startswith(wanted)] or target["stairs"]
                nearest = min(
                    candidates,
                    key=lambda s: (s["x"] - stair["x"]) ** 2 + (s["y"] - stair["y"]) ** 2,
                )
                stair["toX"] = nearest["x"]
                stair["toY"] = nearest["y"]

    (out_dir / "tiles.json").write_text(
        json.dumps({str(k): v for k, v in sorted(regions.items())}, separators=(",", ":")),
        encoding="utf-8",
    )
    (out_dir / "layers.json").write_text(
        json.dumps(
            {
                "width": WORLD_W,
                "height": WORLD_H,
                "tileSize": TILE,
                "layers": layer_entries,
            },
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    print(f"Wrote {out_dir}")


if __name__ == "__main__":
    main()
