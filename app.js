(() => {
  "use strict";

  window.addEventListener('message', (event) => {
    if (event.origin !== 'https://qxb3.is-a.dev') return

    if (event.data.type === 'SET_HASH') {
      window.location.hash = event.data.hash
    }
  })

  window.parent.postMessage(
    {
      type: 'UPDATE_HASH',
      hash: window.location.hash
    },
    'https://qxb3.is-a.dev'
  )

  const canvas = document.getElementById("map");
  const ctx = canvas.getContext("2d", { alpha: false });
  const layersEl = document.getElementById("layers");
  const coordEl = document.getElementById("coord");
  const depthEl = document.getElementById("depth");
  const zoomEl = document.getElementById("zoom-label");
  const lightDarkEl = document.getElementById("light-dark");
  const roofToggleEl = document.getElementById("roof-toggle");
  const tooltipEl = document.getElementById("tooltip");

  // Tiles take over from the overview image at this px-per-tile zoom. Small
  // screens keep the cheap overview further in, large screens switch earlier.
  const LOD_MIN = 5;
  const LOD_MAX = 8;
  const CHUNK_TILES = 16;
  const CHUNK_PX = CHUNK_TILES * 16;
  // A chunk canvas is CHUNK_PX x CHUNK_PX RGBA pixels; the cache is capped by a
  // memory budget instead of a fixed count, because large desktop windows show
  // far more chunks than phones.
  const CHUNK_BYTES = CHUNK_PX * CHUNK_PX * 4;
  const CHUNK_CACHE_BUDGET = 64 * 1024 * 1024;
  const CHUNK_POOL_MAX = 48;
  // How long the roofs take to fade in or out when the toggle is pressed.
  const ROOF_FADE_MS = 180;
  // Route search settings, taken from the mod loader's PathFinder.
  const PATH_START_RADIUS = 2;
  const PATH_END_RADIUS = 3;
  const PATH_MAX_EXPANSIONS = 40000;
  const PATH_DX = [1, -1, 0, 0];
  const PATH_DY = [0, 0, 1, -1];
  const MAX_ZOOM = 64;

  const state = {
    meta: null,
    tileMap: null,
    atlas: null,
    arrowUp: null,
    arrowDown: null,
    portal: null,
    animations: null,
    animNow: 0,
    animFrames: {},
    animating: false,
    animTimer: 0,
    lighting: null,
    lightImage: null,
    lightCanvas: null,
    lightRect: null,
    lightKey: "",
    lightScale: 0,
    detailZoom: 6,
    lightTints: new Map(),
    lavaGlow: new Map(),
    dark: false,
    layers: new Map(),
    active: null,
    activeZ: 0,
    loadToken: 0,
    width: 0,
    height: 0,
    dpr: 1,
    cx: 500,
    cy: 500,
    scale: 1,
    chunkCache: new Map(),
    chunkPool: [],
    blocked: null,
    walkable: null,
    walkableZ: null,
    path: null,
    selection: null,
    hashPath: null,
    hashApplied: false,
    frame: 0,
    pointerMap: new Map(),
    drag: null,
    pinch: null,
    suppressClick: false,
    dragging: false,
    hover: null,
    roofsVisible: false,
    roofAlpha: 0,
    roofFadeFrame: 0,
    roofFadeAt: 0,
    cursorTile: null,
    pointer: null,
    lastTap: null,
    hashTimer: 0,
  };

  function entryFor(z) {
    return state.meta ? state.meta.layers.find((layer) => layer.z === z) : null;
  }

  function fitScale() {
    return Math.max(0.22, Math.min(state.width / 1060, state.height / 1060));
  }

  function fitForLayer(entry) {
    const bounds = entry.bounds || [0, 0, entry.width, entry.height];
    const padding = 48;
    const width = Math.max(80, bounds[2] - bounds[0]);
    const height = Math.max(80, bounds[3] - bounds[1]);
    return {
      scale: Math.max(0.22, Math.min(state.width / (width + padding), state.height / (height + padding))),
      x: (bounds[0] + bounds[2]) / 2,
      y: (bounds[1] + bounds[3]) / 2,
    };
  }

  function clampScale(value) {
    return Math.min(MAX_ZOOM, Math.max(fitScale() * 0.82, value));
  }

  function clampCenter() {
    if (!state.meta) return;
    state.cx = Math.min(state.meta.width, Math.max(0, state.cx));
    state.cy = Math.min(state.meta.height, Math.max(0, state.cy));
  }

  const screenX = (tileX) => (tileX - state.cx) * state.scale + state.width / 2;
  const screenY = (tileY) => (tileY - state.cy) * state.scale + state.height / 2;

  function screenToTile(x, y) {
    return {
      x: (x - state.width / 2) / state.scale + state.cx,
      y: (y - state.height / 2) / state.scale + state.cy,
    };
  }

  function requestDraw() {
    if (state.frame) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = 0;
      draw();
    });
  }

  function resize() {
    state.width = window.innerWidth;
    state.height = window.innerHeight;
    state.dpr = Math.min(window.devicePixelRatio || 1, 2);
    state.detailZoom = Math.min(
      LOD_MAX,
      Math.max(LOD_MIN, 8 - Math.min(state.width, state.height) / 300)
    );
    canvas.width = Math.round(state.width * state.dpr);
    canvas.height = Math.round(state.height * state.dpr);
    canvas.style.width = `${state.width}px`;
    canvas.style.height = `${state.height}px`;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    state.scale = clampScale(state.scale || 1);
    requestDraw();
  }

  function draw() {
    if (!state.active) return;
    state.animNow = performance.now();
    updateAnimFrames();
    state.animating = false;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.fillStyle = state.active.entry.background || "#090b10";
    ctx.fillRect(0, 0, state.width, state.height);

    if (state.scale < state.detailZoom) {
      drawOverview();
    } else {
      drawChunks();
    }
    drawLighting();
    drawPath();
    drawSelection();
    drawMarkers();
    drawHoverArrow();
    drawCursorTile();
    updateReadout();
  }

  function drawOverview() {
    const overview = state.active.overview;
    const size = state.meta.width * state.scale;
    ctx.imageSmoothingEnabled = state.scale < 3;
    ctx.drawImage(overview, screenX(0), screenY(0), size, size);
    ctx.imageSmoothingEnabled = false;
  }

  // Returns the atlas id to draw for an animated tile at this instant.
  function animationFrame(def, time) {
    const t = time % def.total;
    let lo = 0;
    let hi = def.cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (t < def.cum[mid]) hi = mid;
      else lo = mid + 1;
    }
    return def.frames[lo][0];
  }

  // One frame lookup per animated tile id per draw, shared by every chunk.
  function updateAnimFrames() {
    if (!state.animations) return;
    for (const id in state.animations) {
      state.animFrames[id] = animationFrame(state.animations[id], state.animNow);
    }
  }

  function animStamp(ids) {
    let stamp = 0;
    for (let i = 0; i < ids.length; i++) {
      stamp = (stamp * 33 + state.animFrames[ids[i]]) % 2147483647;
    }
    return stamp;
  }

  // Draws one 16 px cell of a chunk, in layer order. Returns true when the cell
  // holds an animated tile, so the chunk can remember which cells to refresh.
  function drawChunkCell(g, roofG, chunkX, chunkY, lx, ly, clear) {
    const width = state.active.entry.width;
    const height = state.active.entry.height;
    const tx = chunkX * CHUNK_TILES + lx;
    const ty = chunkY * CHUNK_TILES + ly;
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) return false;

    if (clear) {
      g.clearRect(lx * 16, ly * 16, 16, 16);
      if (roofG) roofG.clearRect(lx * 16, ly * 16, 16, 16);
    }
    const index = ty * width + tx;
    const layers = state.active.tiles;
    const animations = state.animations;
    const roofLayer = layers.length - 1;
    let animated = false;
    for (let layer = 0; layer < layers.length; layer++) {
      let id = layers[layer][index];
      if (id === 0xffff) continue;
      const def = animations ? animations[id] : null;
      if (def) {
        animated = true;
        id = state.animFrames[id] ?? animationFrame(def, state.animNow);
      }
      const region = state.tileMap[id];
      if (!region) continue;
      const target = layer === roofLayer && roofG ? roofG : g;
      target.drawImage(state.atlas, region[0], region[1], 16, 16, lx * 16, ly * 16, 16, 16);
    }
    return animated;
  }

  // True when any tile of the overhead (roof) layer falls inside this chunk.
  function chunkHasRoof(chunkX, chunkY) {
    const width = state.active.entry.width;
    const height = state.active.entry.height;
    const roofs = state.active.tiles[state.active.tiles.length - 1];
    for (let ly = 0; ly < CHUNK_TILES; ly++) {
      const ty = chunkY * CHUNK_TILES + ly;
      if (ty >= height) break;
      for (let lx = 0; lx < CHUNK_TILES; lx++) {
        const tx = chunkX * CHUNK_TILES + lx;
        if (tx >= width) break;
        if (roofs[ty * width + tx] !== 0xffff) return true;
      }
    }
    return false;
  }

  function paintChunk(chunk, chunkX, chunkY) {
    const g = chunk.getContext("2d");
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, CHUNK_PX, CHUNK_PX);

    // Surface roofs live on their own canvas per chunk, so the toggle can fade
    // the whole roof layer out without repainting the map underneath.
    let roofG = null;
    if (state.activeZ === 0 && chunkHasRoof(chunkX, chunkY)) {
      if (!chunk.__roof) {
        chunk.__roof = document.createElement("canvas");
        chunk.__roof.width = CHUNK_PX;
        chunk.__roof.height = CHUNK_PX;
      }
      roofG = chunk.__roof.getContext("2d");
      roofG.imageSmoothingEnabled = false;
      roofG.clearRect(0, 0, CHUNK_PX, CHUNK_PX);
    } else {
      chunk.__roof = null;
    }

    const animIds = [];
    const seenIds = new Set();
    const animCells = [];

    for (let ly = 0; ly < CHUNK_TILES; ly++) {
      for (let lx = 0; lx < CHUNK_TILES; lx++) {
        if (!drawChunkCell(g, roofG, chunkX, chunkY, lx, ly, false)) continue;
        animCells.push(lx, ly);
        const index = (chunkY * CHUNK_TILES + ly) * state.active.entry.width + chunkX * CHUNK_TILES + lx;
        for (let layer = 0; layer < state.active.tiles.length; layer++) {
          const id = state.active.tiles[layer][index];
          if (state.animations && state.animations[id] && !seenIds.has(id)) {
            seenIds.add(id);
            animIds.push(id);
          }
        }
      }
    }

    chunk.__cx = chunkX;
    chunk.__cy = chunkY;
    chunk.__animIds = animIds;
    chunk.__animCells = animCells;
    chunk.__stamp = animStamp(animIds);
    if (animIds.length) state.animating = true;
  }

  // Repaints only the animated cells of a cached chunk when their frame changes.
  function refreshChunk(chunk) {
    const ids = chunk.__animIds;
    if (!ids || !ids.length) return;
    // Visible animated tiles keep the frame timer alive even between frames.
    state.animating = true;
    if (animStamp(ids) === chunk.__stamp) return;
    // Animations are invisible during a drag or pinch; catch up on release.
    if (state.dragging || state.pinch || state.pointerMap.size) return;
    const g = chunk.getContext("2d");
    g.imageSmoothingEnabled = false;
    const cells = chunk.__animCells;
    const roofG = chunk.__roof ? chunk.__roof.getContext("2d") : null;
    if (roofG) roofG.imageSmoothingEnabled = false;
    for (let i = 0; i < cells.length; i += 2) {
      drawChunkCell(g, roofG, chunk.__cx, chunk.__cy, cells[i], cells[i + 1], true);
    }
    chunk.__stamp = animStamp(ids);
  }

  function getChunk(chunkX, chunkY) {
    const key = `${chunkX},${chunkY}`;
    const cached = state.chunkCache.get(key);
    if (cached) {
      state.chunkCache.delete(key);
      state.chunkCache.set(key, cached);
      refreshChunk(cached);
      return cached;
    }

    // Re-using an evicted canvas avoids allocating (and later collecting) a new
    // 256x256 buffer every time a zoom step exposes a band of fresh chunks.
    let chunk = state.chunkPool.pop();
    if (chunk) {
      chunk.__roof = null;
    } else {
      chunk = document.createElement("canvas");
      chunk.width = CHUNK_PX;
      chunk.height = CHUNK_PX;
    }
    paintChunk(chunk, chunkX, chunkY);

    state.chunkCache.set(key, chunk);
    // Hold the whole visible set plus a ring, otherwise a desktop-sized window
    // evicts chunks that are still on screen and repaints them every frame.
    const span = CHUNK_TILES * Math.max(state.scale, 1);
    const visible = Math.ceil(state.width / span + 1) * Math.ceil(state.height / span + 1);
    const limit = Math.max(24, Math.min(Math.floor(CHUNK_CACHE_BUDGET / CHUNK_BYTES), visible * 2));
    while (state.chunkCache.size > limit) {
      const oldestKey = state.chunkCache.keys().next().value;
      const oldest = state.chunkCache.get(oldestKey);
      state.chunkCache.delete(oldestKey);
      if (oldest && state.chunkPool.length < CHUNK_POOL_MAX) state.chunkPool.push(oldest);
    }
    return chunk;
  }

  function drawChunks() {
    const topLeft = screenToTile(0, 0);
    const bottomRight = screenToTile(state.width, state.height);
    const minChunkX = Math.max(0, Math.floor(Math.floor(topLeft.x) / CHUNK_TILES));
    const maxChunkX = Math.max(0, Math.floor(Math.ceil(bottomRight.x) / CHUNK_TILES));
    const minChunkY = Math.max(0, Math.floor(Math.floor(topLeft.y) / CHUNK_TILES));
    const maxChunkY = Math.max(0, Math.floor(Math.ceil(bottomRight.y) / CHUNK_TILES));
    const maxTileChunk = Math.floor((state.meta.width - 1) / CHUNK_TILES);
    const maxTileChunkY = Math.floor((state.meta.height - 1) / CHUNK_TILES);
    const size = CHUNK_TILES * state.scale;
    const roofs = [];

    ctx.imageSmoothingEnabled = false;
    for (let cy = minChunkY; cy <= Math.min(maxChunkY, maxTileChunkY); cy++) {
      for (let cx = minChunkX; cx <= Math.min(maxChunkX, maxTileChunk); cx++) {
        const chunk = getChunk(cx, cy);
        const dx = Math.floor(screenX(cx * CHUNK_TILES));
        const dy = Math.floor(screenY(cy * CHUNK_TILES));
        const dw = Math.ceil(size) + 1;
        const dh = Math.ceil(size) + 1;
        ctx.drawImage(chunk, dx, dy, dw, dh);
        if (chunk.__roof) roofs.push(chunk.__roof, dx, dy, dw, dh);
      }
    }

    // Roofs go on top of every chunk so no neighbouring chunk paints over them.
    if (roofs.length && state.roofAlpha > 0.004) {
      ctx.globalAlpha = state.roofAlpha;
      for (let i = 0; i < roofs.length; i += 5) {
        ctx.drawImage(roofs[i], roofs[i + 1], roofs[i + 2], roofs[i + 3], roofs[i + 4]);
      }
      ctx.globalAlpha = 1;
    }
  }

  function lightTint(colour) {
    const cached = state.lightTints.get(colour);
    if (cached) return cached;
    const tint = document.createElement("canvas");
    tint.width = 160;
    tint.height = 160;
    const g = tint.getContext("2d");
    g.drawImage(state.lightImage, 0, 0, 160, 160);
    g.globalCompositeOperation = "source-in";
    g.fillStyle = colour;
    g.fillRect(0, 0, 160, 160);
    state.lightTints.set(colour, tint);
    return tint;
  }

  // Bakes the lava glow of one chunk (plus a margin for the light radius) at
  // 2 px per tile, so the dense lava fields cost one drawImage.
  function lavaChunkGlow(chunkX, chunkY, pad) {
    const key = `${state.activeZ}:${chunkX}:${chunkY}`;
    const cached = state.lavaGlow.get(key);
    if (cached) return cached;

    const tiles = state.active.tiles;
    const width = state.active.entry.width;
    const height = state.active.entry.height;
    const tileLights = state.lighting.tiles;
    const px = 2;
    const canvas = document.createElement("canvas");
    canvas.width = CHUNK_TILES * px;
    canvas.height = CHUNK_TILES * px;
    const g = canvas.getContext("2d");
    g.globalCompositeOperation = "lighter";

    // Sources just outside the chunk still bleed in, but the canvas itself only
    // covers the chunk: the neighbour's copy of the same light is not added.
    const originX = chunkX * CHUNK_TILES;
    const originY = chunkY * CHUNK_TILES;
    let found = false;
    for (let y = originY - pad; y < originY + CHUNK_TILES + pad; y++) {
      if (y < 0 || y >= height) continue;
      for (let x = originX - pad; x < originX + CHUNK_TILES + pad; x++) {
        if (x < 0 || x >= width) continue;
        const index = y * width + x;
        for (let layer = 0; layer < tiles.length; layer++) {
          const def = tileLights[tiles[layer][index]];
          if (!def || def.name !== "light-lava") continue;
          found = true;
          const size = (def.width / 16) * px;
          g.globalAlpha = def.intensity;
          g.drawImage(
            lightTint(def.colour),
            (x - originX + 0.5) * px - size / 2,
            (y - originY + 0.5) * px - size / 2,
            size,
            size
          );
        }
      }
    }

    if (!found) {
      state.lavaGlow.set(key, null);
      return null;
    }
    if (state.lavaGlow.size > 512) state.lavaGlow.clear();
    state.lavaGlow.set(key, canvas);
    return canvas;
  }

  // The lightmap is anchored in world space and painted for a rect larger than
  // the view, so panning only re-blits it. Its canvas is half-resolution.
  function lightViewRect() {
    const viewW = state.width / state.scale;
    const viewH = state.height / state.scale;
    return {
      x0: state.cx - viewW,
      y0: state.cy - viewH,
      w: viewW * 2,
      h: viewH * 2,
    };
  }

  function paintLightmap(ambient, rect) {
    const w = Math.max(1, Math.ceil((rect.w * state.scale) / 2));
    const h = Math.max(1, Math.ceil((rect.h * state.scale) / 2));
    if (!state.lightCanvas) state.lightCanvas = document.createElement("canvas");
    const c = state.lightCanvas;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const g = c.getContext("2d", { alpha: false });
    const value = Math.round(ambient * 255);
    g.globalCompositeOperation = "source-over";
    g.fillStyle = `rgb(${value},${value},${value})`;
    g.fillRect(0, 0, w, h);

    if (!state.lighting || state.scale < state.detailZoom) return;
    g.globalCompositeOperation = "lighter";

    const half = state.scale / 2;
    const toX = (worldX) => (worldX - rect.x0) * half;
    const toY = (worldY) => (worldY - rect.y0) * half;
    const drawLight = (tileX, tileY, def) => {
      const sx = toX(tileX + 0.5);
      const sy = toY(tileY + 0.5);
      // Light widths are world pixels (16 per tile); the map draws at state.scale px/tile.
      const size = def.width * half / 16;
      if (sx < -size || sy < -size || sx > w + size || sy > h + size) return;
      g.globalAlpha = def.intensity;
      g.drawImage(lightTint(def.colour), sx - size / 2, sy - size / 2, size, size);
    };

    const x0 = Math.max(0, Math.floor(rect.x0));
    const y0 = Math.max(0, Math.floor(rect.y0));
    const x1 = Math.min(state.meta.width - 1, Math.ceil(rect.x0 + rect.w));
    const y1 = Math.min(state.meta.height - 1, Math.ceil(rect.y0 + rect.h));
    const layers = state.active.tiles;
    const width = state.active.entry.width;
    const tileLights = state.lighting.tiles;

    // Lava covers thousands of tiles, so its additive glow is cached per chunk
    // instead of being redrawn light by light on every pan.
    const pad = Math.ceil(60.8 / 16 / 2);
    const cx0 = Math.floor((x0 - pad) / CHUNK_TILES);
    const cx1 = Math.floor((x1 + pad) / CHUNK_TILES);
    const cy0 = Math.floor((y0 - pad) / CHUNK_TILES);
    const cy1 = Math.floor((y1 + pad) / CHUNK_TILES);
    const chunkSize = CHUNK_TILES * half;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const glow = lavaChunkGlow(cx, cy, pad);
        if (!glow) continue;
        // Each glow covers exactly its own chunk, so neighbouring canvases never
        // overlap and the shared light is counted once.
        g.globalAlpha = 1;
        g.drawImage(glow, toX(cx * CHUNK_TILES), toY(cy * CHUNK_TILES), chunkSize, chunkSize);
      }
    }

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const index = y * width + x;
        for (let layer = 0; layer < layers.length; layer++) {
          const def = tileLights[layers[layer][index]];
          if (def && def.name !== "light-lava") drawLight(x, y, def);
        }
      }
    }

    for (const [x, y, name] of state.active.entry.lights || []) {
      const def = state.lighting.objects[name];
      if (def) drawLight(x, y, def);
    }
    g.globalAlpha = 1;
  }

  function drawLighting() {
    if (!state.lighting || !state.lightImage) return;
    const outdoor = state.activeZ === 0;
    // The client's night is 0.08 outdoors and a fixed 0.06 in the caves/Chaos;
    // the caves get a dim floor here so the map stays readable. Light mode
    // simply leaves every layer undimmed.
    let ambient = state.dark ? (outdoor ? 0.08 : 0.28) : 1;
    const detail = state.scale >= state.detailZoom;
    // Zoomed out, Dark dims the overview evenly; caves and Chaos included.
    if (!detail && state.dark) ambient = 0.5;
    // Light mode leaves nothing to darken and the additive glows clamp to white.
    if (ambient >= 0.999) return;

    // The painted rect covers twice the view; only its age in zoom or a pan
    // past its edges forces a repaint. Blitting rescales it while zooming.
    const key = `${state.activeZ}|${state.dark}|${detail}|${state.width}x${state.height}`;
    const rect = state.lightRect;
    const viewW = state.width / state.scale;
    const viewH = state.height / state.scale;
    const left = state.cx - viewW / 2;
    const top = state.cy - viewH / 2;
    const ratio = state.lightScale ? state.scale / state.lightScale : 0;
    const covered =
      rect &&
      left >= rect.x0 &&
      top >= rect.y0 &&
      left + viewW <= rect.x0 + rect.w &&
      top + viewH <= rect.y0 + rect.h &&
      ratio >= 0.75 &&
      ratio <= 1.3;
    if (key !== state.lightKey || !covered) {
      state.lightKey = key;
      state.lightRect = lightViewRect();
      state.lightScale = state.scale;
      paintLightmap(ambient, state.lightRect);
    }

    const map = state.lightRect;
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      state.lightCanvas,
      screenX(map.x0),
      screenY(map.y0),
      map.w * state.scale,
      map.h * state.scale
    );
    ctx.restore();
  }

  function buildMarkers(entry) {
    const markers = [];
    for (const [x, y] of entry.ladders || []) {
      markers.push({ kind: "ladder", x, y, to: entry.climbTo, toX: x, toY: y });
    }
    for (const stair of entry.stairs || []) markers.push({ kind: "stair", ...stair });
    for (const portal of entry.portals || []) markers.push({ kind: "portal", ...portal });
    return markers;
  }

  function drawMarkers() {
    for (const marker of state.active.markers) {
      if (marker.kind !== "portal") continue;
      const sx = screenX(marker.x + 0.5);
      const sy = screenY(marker.y + 0.5);
      if (sx < -40 || sy < -40 || sx > state.width + 40 || sy > state.height + 40) continue;

      ctx.save();
      ctx.translate(sx, sy);
      if (state.scale < state.detailZoom) {
        drawPortalDot();
      } else {
        // The portal orb animates, so keep requesting frames while one is visible.
        state.animating = true;
        drawPortalMarker();
      }
      ctx.restore();
    }
  }

  function drawHoverArrow() {
    const marker = state.hover && state.hover.marker;
    if (!marker || (marker.kind !== "ladder" && marker.kind !== "stair")) return;
    const up = marker.kind === "ladder" || (marker.dir || "").startsWith("up");
    const image = up ? state.arrowUp : state.arrowDown;
    if (!image) return;

    const size = Math.max(20, Math.min(36, state.scale * 2.4));
    const sx = screenX(marker.x + 0.5);
    const sy = screenY(marker.y + 0.5);
    const bottom = sy - Math.max(7, state.scale * 0.8);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, Math.round(sx - size / 2), Math.round(bottom - size), size, size);
    ctx.restore();
  }

  function drawCursorTile() {
    if (!state.cursorTile || !state.meta) return;
    // While a route is being previewed the endpoint box already marks the
    // cursor tile, so a second box would just be in the way.
    const route = state.path;
    if (route && route.z === state.activeZ && !route.locked) return;
    const { x, y } = state.cursorTile;
    if (x < 0 || y < 0 || x >= state.meta.width || y >= state.meta.height) return;
    const size = state.scale;
    ctx.save();
    ctx.strokeStyle = "#12BE05";
    ctx.lineWidth = Math.max(1.5, Math.min(3, size * 0.12));
    ctx.strokeRect(Math.floor(screenX(x)) + 0.5, Math.floor(screenY(y)) + 0.5, Math.ceil(size), Math.ceil(size));
    ctx.restore();
  }

  // The client animates portals with the 18x18 PORTAL effect frames from
  // graphics.png (6 frames at 18px each in data/portal.png).
  const PORTAL_FRAME = 18;
  const PORTAL_FRAMES = 6;
  const PORTAL_FRAME_MS = 100;

  function drawPortalDot() {
    ctx.fillStyle = "#8bd4ff";
    ctx.fillRect(0, 0, 1, 1);
  }

  function drawPortalMarker() {
    if (!state.portal) return;
    const frame = Math.floor(performance.now() / PORTAL_FRAME_MS) % PORTAL_FRAMES;
    const size = Math.max(5, state.scale * 1.125);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 0.9;
    ctx.drawImage(
      state.portal,
      frame * PORTAL_FRAME,
      0,
      PORTAL_FRAME,
      PORTAL_FRAME,
      -size / 2,
      -size / 2,
      size,
      size
    );
    ctx.restore();
  }

  function markerAtTile(tileX, tileY) {
    if (!state.active) return null;
    const priority = { ladder: 0, stair: 1 };
    let closest = null;
    let best = Infinity;
    for (const marker of state.active.markers) {
      // Portals are drawn as scenery only: no hover feedback, no tooltip, no click.
      if (marker.kind === "portal") continue;
      if (marker.x !== tileX || marker.y !== tileY) continue;
      const score = priority[marker.kind] ?? 2;
      if (score < best) {
        best = score;
        closest = marker;
      }
    }
    return closest;
  }

  // The tooltip only names the layer the marker leads to.
  function markerTooltip(marker) {
    const destination = marker.to == null ? null : entryFor(marker.to);
    return destination ? destination.name : "Sealed";
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function updateReadout() {
    if (!state.active) return;
    const tile = state.cursorTile || screenToTile(state.width / 2, state.height / 2);
    setText(coordEl, `x ${Math.floor(tile.x)} y ${Math.floor(tile.y)}`);
    setText(depthEl, state.active.entry.short);
    setText(zoomEl, `${state.scale.toFixed(1)} px / tile`);
  }

  // Mirrors the mod loader's map grid: a tile can be walked unless any of its
  // layers carries a blocked or line-of-sight-blocked id.
  function walkableGrid() {
    const width = state.active.entry.width;
    const height = state.active.entry.height;
    const size = width * height;
    if (state.walkable && state.walkableZ === state.activeZ && state.walkable.length === size) {
      return state.walkable;
    }
    const walkable = new Uint8Array(size).fill(1);
    const blocked = state.blocked;
    if (blocked) {
      const layers = state.active.tiles;
      for (let layer = 0; layer < layers.length; layer++) {
        const ids = layers[layer];
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          if (id !== 0xffff && blocked[id]) walkable[i] = 0;
        }
      }
    }
    state.walkable = walkable;
    state.walkableZ = state.activeZ;
    return walkable;
  }

  // The loader nudges a click off a wall onto the nearest walkable tile (2 tiles
  // for the start, 3 for the goal) before routing, and so does this.
  function nearestWalkable(walkable, width, height, tileX, tileY, radius) {
    for (let distance = 0; distance <= radius; distance++) {
      for (let dx = -distance; dx <= distance; dx++) {
        for (let dy = -distance; dy <= distance; dy++) {
          if (distance > 0 && Math.abs(dx) !== distance && Math.abs(dy) !== distance) continue;
          const x = tileX + dx;
          const y = tileY + dy;
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          if (walkable[y * width + x]) return { x, y };
        }
      }
    }
    return null;
  }

  // Four-direction A* over the walkable grid, matching the game's route finder.
  function findPath(startX, startY, endX, endY) {
    if (!state.active) return null;
    const width = state.active.entry.width;
    const height = state.active.entry.height;
    const walkable = walkableGrid();
    const start = nearestWalkable(walkable, width, height, startX, startY, PATH_START_RADIUS);
    const end = nearestWalkable(walkable, width, height, endX, endY, PATH_END_RADIUS);
    if (!start || !end) return null;

    const size = width * height;
    const startIndex = start.y * width + start.x;
    const endIndex = end.y * width + end.x;
    const route = [{ x: start.x, y: start.y }];
    if (startIndex === endIndex) return { start, end, route };

    const cost = new Float32Array(size).fill(Infinity);
    const parent = new Int32Array(size).fill(-1);
    const done = new Uint8Array(size);
    const heapIndex = [];
    const heapScore = [];

    const push = (index, score) => {
      let at = heapIndex.length;
      heapIndex.push(index);
      heapScore.push(score);
      while (at > 0) {
        const up = (at - 1) >> 1;
        if (heapScore[up] <= heapScore[at]) break;
        [heapIndex[up], heapIndex[at]] = [heapIndex[at], heapIndex[up]];
        [heapScore[up], heapScore[at]] = [heapScore[at], heapScore[up]];
        at = up;
      }
    };
    const pop = () => {
      const top = heapIndex[0];
      const lastIndex = heapIndex.pop();
      const lastScore = heapScore.pop();
      if (heapIndex.length) {
        heapIndex[0] = lastIndex;
        heapScore[0] = lastScore;
        let at = 0;
        for (;;) {
          const left = at * 2 + 1;
          const right = left + 1;
          let smallest = at;
          if (left < heapIndex.length && heapScore[left] < heapScore[smallest]) smallest = left;
          if (right < heapIndex.length && heapScore[right] < heapScore[smallest]) smallest = right;
          if (smallest === at) break;
          [heapIndex[smallest], heapIndex[at]] = [heapIndex[at], heapIndex[smallest]];
          [heapScore[smallest], heapScore[at]] = [heapScore[at], heapScore[smallest]];
          at = smallest;
        }
      }
      return top;
    };

    cost[startIndex] = 0;
    push(startIndex, Math.abs(start.x - end.x) + Math.abs(start.y - end.y));
    let expansions = 0;
    while (heapIndex.length && expansions++ < PATH_MAX_EXPANSIONS) {
      const current = pop();
      if (done[current]) continue;
      done[current] = 1;
      if (current === endIndex) break;
      const cx = current % width;
      const cy = (current - cx) / width;
      for (let dir = 0; dir < 4; dir++) {
        const nx = cx + PATH_DX[dir];
        const ny = cy + PATH_DY[dir];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const nextIndex = ny * width + nx;
        if (!walkable[nextIndex]) continue;
        const nextCost = cost[current] + 1;
        if (nextCost >= cost[nextIndex]) continue;
        cost[nextIndex] = nextCost;
        parent[nextIndex] = current;
        push(nextIndex, nextCost + Math.abs(nx - end.x) + Math.abs(ny - end.y));
      }
    }

    if (!done[endIndex]) return { start, end, route: null };
    const tiles = [];
    for (let node = endIndex; node !== -1; node = parent[node]) {
      const x = node % width;
      tiles.push({ x, y: (node - x) / width });
      if (node === startIndex) break;
    }
    tiles.reverse();
    return { start, end, route: tiles };
  }

  // Right click drops the start; the route then follows the mouse until a left
  // click fixes the destination.
  function setPathStart(tileX, tileY) {
    if (!state.active) return;
    // Routes may only begin on a tile the player could stand on.
    if (!tileWalkable({ x: tileX, y: tileY })) return;
    state.selection = null;
    state.path = {
      z: state.activeZ,
      start: { x: tileX, y: tileY },
      end: null,
      route: null,
      previewTile: null,
      locked: false,
    };
    requestDraw();
    scheduleHash();
  }

  function setPathEnd(tileX, tileY) {
    const path = state.path;
    if (!path || path.z !== state.activeZ) return;
    updatePathPreview({ x: tileX, y: tileY });
    path.locked = true;
    requestDraw();
    scheduleHash();
  }

  function tileWalkable(tile) {
    const width = state.active.entry.width;
    const height = state.active.entry.height;
    if (tile.x < 0 || tile.y < 0 || tile.x >= width || tile.y >= height) return false;
    return walkableGrid()[tile.y * width + tile.x] === 1;
  }

  // Recomputes the route to the tile under the cursor while the start is set
  // but no destination has been chosen yet. Over a wall the endpoint box stays
  // on the last walkable tile instead of jumping to a snapped neighbour.
  function updatePathPreview(tile) {
    const path = state.path;
    if (!path || path.z !== state.activeZ || path.locked || !tile) return;
    if (path.previewTile && path.previewTile.x === tile.x && path.previewTile.y === tile.y) return;
    path.previewTile = { x: tile.x, y: tile.y };
    if (!tileWalkable(tile)) return;
    path.end = { x: tile.x, y: tile.y };
    const found = findPath(path.start.x, path.start.y, tile.x, tile.y);
    path.route = found ? found.route : null;
    requestDraw();
  }

  function pathTileRect(tile) {
    const size = Math.ceil(state.scale);
    return {
      x: Math.floor(screenX(tile.x)),
      y: Math.floor(screenY(tile.y)),
      size,
    };
  }

  function pathTileCenter(tile) {
    const rect = pathTileRect(tile);
    return { x: rect.x + rect.size / 2, y: rect.y + rect.size / 2 };
  }

  // Where a line leaving the tile centre towards a point crosses its box.
  function pathBoxEdge(tile, toward) {
    const rect = pathTileRect(tile);
    const center = pathTileCenter(tile);
    const dx = toward.x - center.x;
    const dy = toward.y - center.y;
    let t = Infinity;
    if (dx > 0) t = Math.min(t, (rect.x + rect.size - center.x) / dx);
    else if (dx < 0) t = Math.min(t, (rect.x - center.x) / dx);
    if (dy > 0) t = Math.min(t, (rect.y + rect.size - center.y) / dy);
    else if (dy < 0) t = Math.min(t, (rect.y - center.y) / dy);
    if (!Number.isFinite(t)) return center;
    return { x: center.x + dx * t, y: center.y + dy * t };
  }

  function drawTileBox(tile, colour) {
    const rect = pathTileRect(tile);
    const width = Math.max(1.5, Math.min(3, state.scale * 0.12));
    ctx.save();
    // Same dark halo the route line uses, so the box reads on bright tiles.
    ctx.strokeStyle = "rgba(8, 10, 15, 0.6)";
    ctx.lineWidth = width + 2;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.size, rect.size);
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.size, rect.size);
    ctx.restore();
  }

  function drawPath() {
    const path = state.path;
    if (!path || path.z !== state.activeZ) return;
    const route = path.route;
    const endTile = path.end;
    if (route && route.length > 1 && endTile) {
      const first = route[0];
      const last = route[route.length - 1];
      const points = [];
      // Leave the start box and enter the end box at their edges, even when the
      // endpoint tile itself is a wall and the route starts a tile away.
      const startTarget = first.x === path.start.x && first.y === path.start.y
        ? route[1]
        : first;
      points.push(pathBoxEdge(path.start, pathTileCenter(startTarget)));
      for (let i = 0; i < route.length; i++) {
        const tile = route[i];
        const isStartTile = tile.x === path.start.x && tile.y === path.start.y;
        const isEndTile = tile.x === endTile.x && tile.y === endTile.y;
        if (isStartTile || isEndTile) continue;
        points.push(pathTileCenter(tile));
      }
      const endTarget = last.x === endTile.x && last.y === endTile.y
        ? route[route.length - 2]
        : last;
      points.push(pathBoxEdge(endTile, pathTileCenter(endTarget)));

      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(8, 10, 15, 0.6)";
      ctx.lineWidth = Math.max(3, Math.min(6, state.scale * 0.45));
      ctx.stroke();
      ctx.strokeStyle = "#12BE05";
      ctx.lineWidth = Math.max(1.5, Math.min(3, state.scale * 0.22));
      ctx.stroke();
    }
    drawTileBox(path.start, "#12BE05");
    if (path.end) drawTileBox(path.end, "#12BE05");
  }

  // A plain left click drops a persistent box on that tile, so the link can
  // point someone at a spot on the map.
  function drawSelection() {
    const selection = state.selection;
    if (!selection || selection.z !== state.activeZ) return;
    const rect = pathTileRect(selection);
    ctx.save();
    ctx.fillStyle = "rgba(255, 205, 0, 0.18)";
    ctx.fillRect(rect.x, rect.y, rect.size, rect.size);
    ctx.restore();
    drawTileBox(selection, "#FFCD00");
  }

  function toggleSelection(tileX, tileY) {
    const selection = state.selection;
    if (selection && selection.z === state.activeZ
        && selection.x === tileX && selection.y === tileY) {
      state.selection = null;
    } else {
      state.selection = { x: tileX, y: tileY, z: state.activeZ };
    }
    requestDraw();
    scheduleHash();
  }

  function updateHover(event) {
    if (event.pointerType === "touch" || state.dragging || state.pinch) {
      clearHover();
      state.cursorTile = null;
      return;
    }
    state.pointer = { x: event.clientX, y: event.clientY };
    const point = screenToTile(event.clientX, event.clientY);
    state.cursorTile = { x: Math.floor(point.x), y: Math.floor(point.y) };
    updatePathPreview(state.cursorTile);
    requestDraw();
    const marker = markerAtTile(state.cursorTile.x, state.cursorTile.y);
    if (!marker) {
      clearHover();
      return;
    }
    state.hover = { marker, x: event.clientX, y: event.clientY };
    canvas.classList.add("is-over-marker");
    tooltipEl.textContent = markerTooltip(marker);
    tooltipEl.style.left = `${Math.min(state.width - 80, Math.max(80, event.clientX))}px`;
    tooltipEl.style.top = `${Math.min(state.height - 46, event.clientY)}px`;
    tooltipEl.classList.add("is-visible");
    requestDraw();
  }

  function clearHover() {
    if (!state.hover) return;
    state.hover = null;
    canvas.classList.remove("is-over-marker");
    tooltipEl.classList.remove("is-visible");
    requestDraw();
  }

  function refreshHover() {
    clearHover();
    state.hover = null;
    canvas.classList.remove("is-over-marker");
    tooltipEl.classList.remove("is-visible");
    if (!state.pointer || state.pointerMap.size || state.dragging || state.pinch) return;
    updateHover({ clientX: state.pointer.x, clientY: state.pointer.y, pointerType: "mouse" });
  }

  function syncHash() {
    if (!state.meta) return;
    let hash = `layer=${state.activeZ}&x=${state.cx.toFixed(1)}&y=${state.cy.toFixed(1)}&scale=${state.scale.toFixed(2)}`;
    const path = state.path;
    if (path && path.z === state.activeZ && path.locked && path.start && path.end) {
      hash += `&sx=${path.start.x}&sy=${path.start.y}&ex=${path.end.x}&ey=${path.end.y}`;
    }
    const selection = state.selection;
    if (selection && selection.z === state.activeZ) {
      hash += `&tx=${selection.x}&ty=${selection.y}`;
    }
    history.replaceState(null, "", `#${hash}`);
  }

  function scheduleHash() {
    window.clearTimeout(state.hashTimer);
    state.hashTimer = window.setTimeout(syncHash, 240);
  }

  function readHash() {
    if (!location.hash) return false;
    const params = new URLSearchParams(location.hash.slice(1));
    // URLSearchParams hands back null for missing keys, which Number() turns
    // into 0, so absent values must be rejected before conversion.
    const readNumber = (name) => {
      const raw = params.get(name);
      if (raw === null || raw.trim() === "") return NaN;
      return Number(raw);
    };
    const z = readNumber("layer");
    if (!Number.isFinite(z) || !entryFor(z)) return false;
    const x = readNumber("x");
    const y = readNumber("y");
    const scale = readNumber("scale");
    state.activeZ = z;
    if (Number.isFinite(x)) state.cx = x;
    if (Number.isFinite(y)) state.cy = y;
    if (Number.isFinite(scale) && scale > 0) state.scale = clampScale(scale);
    const sx = readNumber("sx");
    const sy = readNumber("sy");
    const ex = readNumber("ex");
    const ey = readNumber("ey");
    if ([sx, sy, ex, ey].every((value) => Number.isFinite(value))) {
      state.hashPath = {
        z,
        start: { x: Math.floor(sx), y: Math.floor(sy) },
        end: { x: Math.floor(ex), y: Math.floor(ey) },
      };
    }
    const tx = readNumber("tx");
    const ty = readNumber("ty");
    if (Number.isFinite(tx) && Number.isFinite(ty)) {
      state.selection = { x: Math.floor(tx), y: Math.floor(ty), z };
    }
    state.hashApplied = true;
    return true;
  }

  function zoomAt(anchorX, anchorY, factor) {
    const before = screenToTile(anchorX, anchorY);
    const next = clampScale(state.scale * factor);
    if (next === state.scale) return;
    state.scale = next;
    state.cx = before.x - (anchorX - state.width / 2) / next;
    state.cy = before.y - (anchorY - state.height / 2) / next;
    clampCenter();
    requestDraw();
  }

  function fitView() {
    if (!state.active) {
      state.scale = fitScale();
      state.cx = state.meta.width / 2;
      state.cy = state.meta.height / 2;
    } else {
      const fit = fitForLayer(state.active.entry);
      state.scale = clampScale(fit.scale);
      state.cx = fit.x;
      state.cy = fit.y;
    }
    requestDraw();
    scheduleHash();
  }

  async function useMarker(marker) {
    if (!marker) return;
    const destination = marker.to == null ? null : entryFor(marker.to);
    if (!destination) return;
    const x = marker.toX == null ? marker.x : marker.toX;
    const y = marker.toY == null ? marker.y : marker.toY;
    await setLayer(marker.to, {
      x: x + 0.5,
      y: y + 0.5,
      scale: Math.max(state.scale, 8),
    });
  }

  async function loadTileImage(src) {
    const image = await loadImage(src);
    const layerCanvas = document.createElement("canvas");
    layerCanvas.width = state.meta.width;
    layerCanvas.height = state.meta.height;
    const g = layerCanvas.getContext("2d", { willReadFrequently: true });
    g.drawImage(image, 0, 0);
    const data = g.getImageData(0, 0, state.meta.width, state.meta.height).data;
    const ids = new Uint16Array(state.meta.width * state.meta.height);
    for (let i = 0, p = 0; i < ids.length; i++, p += 4) {
      ids[i] = data[p] | (data[p + 1] << 8);
    }
    return ids;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Could not load ${src}`));
      image.src = src;
    });
  }

  async function loadLayer(z) {
    const cached = state.layers.get(z);
    if (cached) {
      state.layers.delete(z);
      state.layers.set(z, cached);
      return cached;
    }

    const entry = entryFor(z);
    if (!entry) throw new Error(`Unknown layer ${z}`);
    if (!state.atlas) throw new Error("Tile atlas has not loaded");

    const images = await Promise.all(entry.tiles.map((src) => loadTileImage(`data/${src}`)));
    const overview = await loadImage(`data/${entry.overview}`);
    const data = { entry, overview, tiles: images, markers: buildMarkers(entry) };

    state.layers.set(z, data);
    while (state.layers.size > 3) {
      const oldest = state.layers.keys().next().value;
      if (oldest === z) break;
      state.layers.delete(oldest);
    }
    return data;
  }

  // The surface talks about day and night; the caves and Chaos about light.
  function updateLightButton() {
    const outdoor = state.activeZ === 0;
    lightDarkEl.textContent = state.dark
      ? outdoor
        ? "Night"
        : "Dark"
      : outdoor
        ? "Day"
        : "Light";
    lightDarkEl.title = outdoor ? "Toggle day and night" : "Toggle light and dark";
  }

  // Roofs only exist on the surface, so the toggle hides with the button.
  function updateRoofButton() {
    roofToggleEl.hidden = state.activeZ !== 0;
    roofToggleEl.textContent = state.roofsVisible ? "Roofs" : "No roofs";
    roofToggleEl.setAttribute("aria-pressed", String(!state.roofsVisible));
    roofToggleEl.title = state.roofsVisible ? "Hide house roofs" : "Show house roofs";
  }

  // Fades the roof layer between fully visible and hidden; the chunk canvases
  // already hold the roofs separately, so only the alpha has to change.
  function startRoofFade() {
    const goal = state.roofsVisible ? 1 : 0;
    if (state.roofAlpha === goal) return;
    if (state.roofFadeFrame) return;
    state.roofFadeAt = performance.now();
    const step = (now) => {
      const dt = Math.max(0, now - state.roofFadeAt);
      state.roofFadeAt = now;
      const target = state.roofsVisible ? 1 : 0;
      const delta = dt / ROOF_FADE_MS;
      state.roofAlpha = target > state.roofAlpha
        ? Math.min(target, state.roofAlpha + delta)
        : Math.max(target, state.roofAlpha - delta);
      requestDraw();
      if (state.roofAlpha !== target) {
        state.roofFadeFrame = requestAnimationFrame(step);
      } else {
        state.roofFadeFrame = 0;
      }
    };
    state.roofFadeFrame = requestAnimationFrame(step);
  }

  async function setLayer(z, options = {}) {
    const entry = entryFor(z);
    if (!entry) return;
    const token = ++state.loadToken;
    const firstLoad = !state.active;

    try {
      const data = await loadLayer(z);
      if (token !== state.loadToken) return;

      state.active = data;
      state.activeZ = z;
      state.path = null;
      // A route embedded in the link is restored once its layer is loaded.
      if (state.hashPath && state.hashPath.z === z) {
        state.path = {
          z,
          start: state.hashPath.start,
          end: state.hashPath.end,
          route: null,
          previewTile: null,
          locked: true,
        };
        state.hashPath = null;
      }
      state.chunkCache.clear();
      state.lavaGlow.clear();
      updateLightButton();
      updateRoofButton();
      if (Number.isFinite(options.x)) state.cx = options.x;
      if (Number.isFinite(options.y)) state.cy = options.y;
      if (Number.isFinite(options.scale)) state.scale = clampScale(options.scale);
      clampCenter();
      if (state.path && !state.path.route) {
        const found = findPath(state.path.start.x, state.path.start.y, state.path.end.x, state.path.end.y);
        state.path.route = found ? found.route : null;
      }
      refreshHover();

      for (const button of layersEl.querySelectorAll(".layer-btn")) {
        const active = Number(button.dataset.z) === z;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-selected", String(active));
      }

      if (firstLoad) {
        if (!state.hashApplied) {
          const fit = fitForLayer(entry);
          state.scale = clampScale(fit.scale);
          state.cx = fit.x;
          state.cy = fit.y;
        }
      }

      requestDraw();
      syncHash();
    } catch (error) {
      fail(error);
    }
  }

  function buildLayerButtons() {
    layersEl.innerHTML = "";
    for (const layer of state.meta.layers) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "layer-btn";
      button.dataset.z = String(layer.z);
      button.setAttribute("role", "tab");
      button.setAttribute("aria-label", layer.name);
      button.title = layer.name;
      const short = document.createElement("span");
      short.className = "layer-short";
      short.textContent = layer.short;
      // "Chaos" has no separate short name, so it would otherwise render twice.
      if (layer.name !== layer.short) {
        const full = document.createElement("span");
        full.className = "layer-name";
        full.textContent = layer.name;
        button.append(short, full);
      } else {
        button.append(short);
      }
      button.addEventListener("click", () => setLayer(layer.z));
      layersEl.append(button);
    }
  }

  function pointerPosition(event) {
    return { x: event.clientX, y: event.clientY };
  }

  function startDrag(point) {
    state.drag = {
      startX: point.x,
      startY: point.y,
      lastX: point.x,
      lastY: point.y,
      startedAt: performance.now(),
      moved: 0,
    };
  }

  function beginPinch() {
    const points = [...state.pointerMap.values()];
    if (points.length !== 2) return;
    const [a, b] = points;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    state.pinch = {
      distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      scale: state.scale,
      lastMid: mid,
    };
    state.suppressClick = true;
    state.drag = null;
    clearHover();
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== undefined && event.button !== 0 && event.pointerType === "mouse") return;
    canvas.setPointerCapture(event.pointerId);
    const point = pointerPosition(event);
    state.pointerMap.set(event.pointerId, point);

    if (state.pointerMap.size === 1) {
      startDrag(point);
      state.dragging = false;
      canvas.classList.add("is-dragging");
      clearHover();
    } else if (state.pointerMap.size === 2) {
      beginPinch();
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!state.pointerMap.has(event.pointerId)) {
      updateHover(event);
      return;
    }
    state.pointerMap.set(event.pointerId, pointerPosition(event));

    if (state.pointerMap.size >= 2 && state.pinch) {
      state.cursorTile = null;
      const points = [...state.pointerMap.values()];
      const [a, b] = points;
      const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const factor = (state.pinch.scale * (distance / state.pinch.distance)) / state.scale;
      zoomAt(mid.x, mid.y, factor);
      state.cx -= (mid.x - state.pinch.lastMid.x) / state.scale;
      state.cy -= (mid.y - state.pinch.lastMid.y) / state.scale;
      state.pinch.lastMid = mid;
      clampCenter();
      requestDraw();
      return;
    }

    if (state.drag) {
      const dx = event.clientX - state.drag.lastX;
      const dy = event.clientY - state.drag.lastY;
      state.drag.lastX = event.clientX;
      state.drag.lastY = event.clientY;
      state.drag.moved += Math.abs(dx) + Math.abs(dy);
      if (state.drag.moved > 4) state.dragging = true;
      state.cx -= dx / state.scale;
      state.cy -= dy / state.scale;
      clampCenter();
      if (event.pointerType !== "touch") {
        const point = screenToTile(event.clientX, event.clientY);
        state.cursorTile = { x: Math.floor(point.x), y: Math.floor(point.y) };
      }
      requestDraw();
    }
  });

  function endPointer(event) {
    state.pointerMap.delete(event.pointerId);

    if (state.pointerMap.size === 0) {
      const drag = state.drag;
      const wasDragging = state.dragging;
      const shouldClick =
        !state.suppressClick &&
        !wasDragging &&
        drag &&
        performance.now() - drag.startedAt < 650 &&
        Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 10;

      state.drag = null;
      state.pinch = null;
      state.dragging = false;
      canvas.classList.remove("is-dragging");

      if (shouldClick) {
        const point = screenToTile(event.clientX, event.clientY);
        const tileX = Math.floor(point.x);
        const tileY = Math.floor(point.y);
        const path = state.path;
        const marker = markerAtTile(tileX, tileY);
        if (path && path.z === state.activeZ && path.start
            && path.start.x === tileX && path.start.y === tileY) {
          // Clicking the start again turns route mode off.
          state.path = null;
          requestDraw();
          scheduleHash();
        } else if (path && path.z === state.activeZ && !path.locked) {
          // A left click while a route is pending fixes its destination.
          setPathEnd(tileX, tileY);
        } else if (marker) {
          useMarker(marker);
        } else {
          const now = performance.now();
          const doubleTap =
            state.lastTap &&
            now - state.lastTap.time < 330 &&
            Math.hypot(event.clientX - state.lastTap.x, event.clientY - state.lastTap.y) < 28;
          if (doubleTap) {
            zoomAt(event.clientX, event.clientY, 2);
            state.lastTap = null;
          } else {
            toggleSelection(tileX, tileY);
            state.lastTap = { time: now, x: event.clientX, y: event.clientY };
          }
        }
      }

      state.suppressClick = false;
      state.lastTap = shouldClick ? state.lastTap : null;
      scheduleHash();
      // Animations paused during the gesture need one frame to catch up.
      requestDraw();
      if (event.pointerType !== "touch") updateHover(event);
    } else if (state.pointerMap.size === 1) {
      const remaining = [...state.pointerMap.values()][0];
      startDrag(remaining);
      state.pinch = null;
      state.suppressClick = true;
      state.dragging = false;
    }
  }

  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", () => {
    if (!state.pointerMap.size) {
      state.pointer = null;
      clearHover();
      state.cursorTile = null;
      requestDraw();
    }
  });

  // Right click places the route start; the preview then follows the mouse.
  canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (!state.active) return;
    const point = screenToTile(event.clientX, event.clientY);
    setPathStart(Math.floor(point.x), Math.floor(point.y));
  });

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY;
      const factor = Math.exp(-delta * 0.00165);
      zoomAt(event.clientX, event.clientY, factor);
      scheduleHash();
    },
    { passive: false }
  );

  window.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key;
    if (key === "+" || key === "=") {
      zoomAt(state.width / 2, state.height / 2, 1.4);
      event.preventDefault();
    } else if (key === "-" || key === "_") {
      zoomAt(state.width / 2, state.height / 2, 1 / 1.4);
      event.preventDefault();
    } else if (key === "0") {
      fitView();
      event.preventDefault();
    } else if (key >= "1" && key <= "7") {
      const layer = state.meta.layers[Number(key) - 1];
      if (layer) setLayer(layer.z);
      event.preventDefault();
    } else if (key.startsWith("Arrow")) {
      const step = 80 / state.scale;
      if (key === "ArrowLeft") state.cx -= step;
      if (key === "ArrowRight") state.cx += step;
      if (key === "ArrowUp") state.cy -= step;
      if (key === "ArrowDown") state.cy += step;
      clampCenter();
      requestDraw();
      scheduleHash();
      event.preventDefault();
    }
  });

  window.addEventListener("resize", resize);

  async function fetchJSON(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`Could not load ${path}`);
    return response.json();
  }

  async function init() {
    resize();
    try {
      const [meta, tiles, animations, lighting, blocked] = await Promise.all([
        fetchJSON("data/layers.json"),
        fetchJSON("data/tiles.json"),
        fetchJSON("data/animations.json"),
        fetchJSON("data/lighting.json"),
        fetchJSON("data/blocked.json"),
      ]);
      const maxTileId = Object.keys(tiles).reduce((max, id) => Math.max(max, Number(id)), 0);
      state.blocked = new Uint8Array(maxTileId + 1);
      for (const id of blocked) state.blocked[id] = 1;
      state.meta = meta;
      state.tileMap = [];
      for (const [id, xy] of Object.entries(tiles)) {
        state.tileMap[Number(id)] = xy;
      }
      state.animations = {};
      for (const [id, frames] of Object.entries(animations)) {
        const cum = [];
        let total = 0;
        for (const [, duration] of frames) {
          total += duration;
          cum.push(total);
        }
        state.animations[Number(id)] = { frames, cum, total };
      }
      const lightDefs = {};
      for (const [name, def] of Object.entries(lighting.types)) {
        lightDefs[name] = { ...def, name };
      }
      state.lighting = { tiles: {}, objects: {} };
      for (const [id, name] of Object.entries(lighting.tiles)) {
        if (lightDefs[name]) state.lighting.tiles[Number(id)] = lightDefs[name];
      }
      for (const [, name] of Object.entries(lighting.objects)) {
        if (lightDefs[name]) state.lighting.objects[name] = lightDefs[name];
      }

      state.scale = fitScale();
      state.cx = meta.width / 2;
      state.cy = meta.height / 2;

      buildLayerButtons();
      const hashLayer = readHash();
      const [atlas, arrowUp, arrowDown, portal, light] = await Promise.all([
        loadImage("data/atlas.png"),
        loadImage("data/worldmap-up.png"),
        loadImage("data/worldmap-down.png"),
        loadImage("data/portal.png"),
        loadImage("data/light.png"),
      ]);
      state.atlas = atlas;
      state.arrowUp = arrowUp;
      state.arrowDown = arrowDown;
      state.portal = portal;
      state.lightImage = light;
      startAnimation();
      lightDarkEl.addEventListener("click", () => {
        state.dark = !state.dark;
        updateLightButton();
        lightDarkEl.setAttribute("aria-pressed", String(state.dark));
        requestDraw();
      });
      roofToggleEl.addEventListener("click", () => {
        state.roofsVisible = !state.roofsVisible;
        updateRoofButton();
        startRoofFade();
      });
      updateRoofButton();
      await setLayer(hashLayer ? state.activeZ : meta.layers[0].z);
      if (hashLayer) requestDraw();
    } catch (error) {
      fail(error);
    }
  }

  function startAnimation() {
    if (state.animTimer) return;
    state.animTimer = window.setInterval(() => {
      if (document.hidden || !state.active || !state.animating) return;
      requestDraw();
    }, PORTAL_FRAME_MS);
  }

  function fail(error) {
    console.error(error);
  }

  init();
})();
