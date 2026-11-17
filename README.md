# Mirage Atlas

An interactive browser map of the current Mirage Realms world, extracted directly from the game's `Mirage.jar`.

- Real tile art for the Overworld, Underground 1–5, and Chaos.
- Drag to pan, mouse wheel to zoom, and pinch/drag on touch screens.
- Click ladders and stairs to travel; portal orbs are decorative and ignore hover and clicks.
- A light toggle in the top-left corner switches every layer between undimmed light and the game's dark lighting; it reads Day/Night on the surface and Light/Dark in the caves and Chaos.
- Beside it, a `Roofs` / `No roofs` toggle (surface only) fades the house roofs in and out; roofs start hidden so building interiors are visible by default.
- A green outline follows the tile under the cursor.
- Right-click a walkable tile to drop a green route start; the route then follows the mouse (four-direction A* around walls and sight-blocking tiles, using the same blocked ids as the mod loader) and a left click fixes the destination. Left-clicking the start again cancels the route.
- A plain left click (outside route mode) marks that tile with a yellow box; clicking it again removes it.
- Shareable URL keeps the layer, position and zoom, plus the marked tile (`tx`/`ty`) and any fixed route (`sx`/`sy`/`ex`/`ey`), which is routed again on load.
- Keyboard shortcuts: `1`–`7` switch layers, `+`/`-` zoom, `0` fits the world, arrow keys pan.

## Run

The site is static, but it must be served over HTTP so the browser can load the map data:

```sh
cd mirage-map
./serve.sh          # http://localhost:8080
```

Or:

```sh
python3 -m http.server 8080
```

## Regenerate the data

The generated files in `data/` are already checked in. To refresh them from the game:

```sh
cd mirage-map
python3 extract.py                 # uses ../Mirage.jar
python3 extract.py --jar /path/to/Mirage.jar
```

The extractor reads the current 1000×1000 world map files, decodes the packed tile atlas, writes per-layer tile IDs, official overview images, ladders, stairs, portals, and atlas regions.

## Markers

Ladders are stored directly in the map objects. They have no permanent marker; hovering one outlines its tile, floats the game's own up arrow above it, and shows only the name of the layer it leads to. Stairs come from the `stairs` properties in the game's tileset, use the matching up/down arrow on hover, and are paired with the nearest matching stair on the target layer. Portal positions are read from the cyan markers already drawn on the game's own world-map images, and the orbs themselves are the client's animated 18×18 PORTAL effect frames (`effect-48` in `graphics.png`), written to `data/portal.png`. Portals are drawn as scenery only: they show no tooltip, highlight, or click action. Cyan marks that are not real portals are dropped by tile coordinate (`IGNORED_PORTALS`), and a handful of Mirage orbs are dropped individually by pointing at them (`IGNORED_PORTAL_POINTS` removes only the nearest orb, not its neighbours).

Ladder and stair destinations are not stored in the client map files. Portals between the three Mirage realms and B2/B3/B4 follow the entrance destinations documented by the official Realm Wiki; other portal destinations are sent by the game server only, so those orbs are shown in their correct locations but report that the destination is unavailable.

## Lighting

Light removes all darkening; Dark reproduces the game's dark lighting. The surface follows the client's realm clock at its night extreme (0.08 grey). The caves (B1-B5) and the Chaos layer (the game's Mirage realm) do not follow the realm clock in the client — they render against a fixed 0.06 base — so in Dark they use a dim 0.28 floor that still lets the map be read. Zoomed out, Dark dims the overview evenly on every layer; Light always shows the plain, fully lit overview art.

The overview/tile switch happens at a px-per-tile zoom that depends on the screen: small screens keep the cheap overview further in (up to 8 px/tile), large screens switch to real tiles earlier (from 5 px/tile).

Light sources come from the tileset `light` properties and from map object bytes 1-8, using the client's own radial `light` texture (`data/light.png`) with the client's sizes, colours and intensities: 60.8 px candles/ladders/lava up to 320 px coloured torches. Every lava tile lights its surroundings just like in the game, which makes lava fields glow bright orange; those glows are baked per 16-tile chunk at 2 px per tile and cached so a pan stays at one draw per chunk. Torches, candles and ladders are drawn per visible tile and map object. Lighting is only composited at detail zoom; below that the whole map is dimmed uniformly.

## Rendering

Zoomed in, the map is rasterised into 16-tile chunk canvases that are cached and re-used across pans, so only newly exposed chunks cost tile work. The top tile layer holds house roofs and other overhead art. On the surface it is painted into a separate per-chunk canvas so the `Roofs` / `No roofs` button next to the day-night toggle can fade the whole roof layer out (180 ms) and reveal the building interiors. That button only appears on the Surface layer; the zoomed-out overview uses the game's world-map art, where roofs are always baked in. Animated tiles (sea, torches, lava) are re-drawn cell by cell when their frame changes, and animation refresh pauses during a drag or pinch. The lightmap is anchored in world space and painted for twice the viewport, so panning only re-blits it; it is repainted when the layer, the ambient level or the zoom changes or the view leaves the painted rect. The chunk cache is sized to hold the whole visible set plus a ring (bounded by a 64 MB canvas budget), so a large desktop window does not evict chunks that are still on screen and repaint them every frame, while a phone keeps only a few dozen canvases. Evicted chunk canvases are pooled and reused, which keeps zooming out from allocating a fresh buffer per newly exposed chunk.

The viewer does not use any third-party or historical map terrain. Map tiles, overview images, ladders, stairs, and portal locations all come from the bundled current game JAR; only the Mirage entrance pairing is documented from the official Realm Wiki.
