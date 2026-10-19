const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');

// World lighting: the map's lights as served (scripts/scene/lights.mjs) and
// the renderer's colour at a time and blend at a point (map-light.ts).

function loadModule(relativePath) {
  const output = esbuild.buildSync({
    entryPoints: [path.join(__dirname, relativePath)], bundle: true, write: false, platform: 'node', format: 'cjs',
  }).outputFiles[0].text;
  const context = { module: { exports: {} }, Math, Date, atob };
  context.exports = context.module.exports;
  vm.runInNewContext(output, context);
  return context.module.exports;
}

const light = loadModule('../renderer/scripts/utils/map-light.ts');
const plain = (value) => JSON.parse(JSON.stringify(value));
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`);
const rgb = (color) => [(color >> 16) & 255, (color >> 8) & 255, color & 255].map((value) => value / 255);

// A WDBC table from records given as { field: value }; float(x) is written as a float.
const float = (value) => ({ float: value });
function dbc(fieldCount, records) {
  const body = Buffer.alloc(records.length * fieldCount * 4);
  records.forEach((record, index) => {
    for (const [field, value] of Object.entries(record)) {
      const at = (index * fieldCount + Number(field)) * 4;
      if (typeof value === 'object') body.writeFloatLE(value.float, at);
      else body.writeUInt32LE(value >>> 0, at);
    }
  });
  const header = Buffer.alloc(20);
  header.write('WDBC');
  header.writeUInt32LE(records.length, 4);
  header.writeUInt32LE(fieldCount, 8);
  header.writeUInt32LE(fieldCount * 4, 12);
  header.writeUInt32LE(1, 16);
  return Buffer.concat([header, body, Buffer.alloc(1)]);
}

test("reads each light's water: its colour bands, the sun's colour on clouds, and LightParams' alphas", async () => {
  const { mapLights } = await import(pathToFileURL(path.join(__dirname, 'scene', 'lights.mjs')).href);
  const band = (id, color) => ({ 0: id, 1: 1, 2: 1440, 18: color });
  // LightParams 2's bands are 19 + band.
  const files = {
    'DBFilesClient\\Light.dbc': dbc(15, [{ 0: 1, 1: 0, 7: 2 }]),
    'DBFilesClient\\LightIntBand.dbc': dbc(34, [
      band(19 + 9, 0xffeedd), band(19 + 14, 0x112233), band(19 + 15, 0x223344), band(19 + 16, 0x334455), band(19 + 17, 0x445566),
    ]),
    'DBFilesClient\\LightParams.dbc': dbc(9, [{ 0: 2, 5: float(0.5), 6: float(1), 7: float(0.75), 8: float(1) }]),
  };
  const [only] = mapLights((name) => files[name] ?? null, 489).lights;
  assert.deepEqual(only.water, {
    oceanShallow: [[1440, 0x112233]], oceanDeep: [[1440, 0x223344]],
    riverShallow: [[1440, 0x334455]], riverDeep: [[1440, 0x445566]],
    sunCloud: [[1440, 0xffeedd]], alphas: [0.5, 1, 0.75, 1],
  });
  // Without LightParams the alphas are zero.
  delete files['DBFilesClient\\LightParams.dbc'];
  assert.deepEqual(mapLights((name) => files[name] ?? null, 489).lights[0].water.alphas, [0, 0, 0, 0]);
});

test('reads a map\'s lights in server coordinates with their keys, falling back to the default light', async () => {
  const { mapLights, lightPosition } = await import(pathToFileURL(path.join(__dirname, 'scene', 'lights.mjs')).href);
  // Warsong Gulch's Alliance base light.
  const [x, y, z] = lightPosition([561214, 9634, 562009]);
  assert.deepEqual([Math.round(x), Math.round(y), Math.round(z)], [1455, 1477, 268]);
  const band = (id, keys) => ({ 0: id, 1: keys.length, ...Object.fromEntries(keys.flatMap(([time, color], index) => [[2 + index, time], [18 + index, color]])) });
  const files = {
    'DBFilesClient\\Light.dbc': dbc(15, [
      { 0: 1, 1: 0, 7: 1 },
      { 0: 324, 1: 489, 2: float(561214), 3: float(9634), 4: float(562009), 5: float(7668), 6: float(10368), 7: 2 },
      { 0: 400, 1: 618, 7: 2 },
    ]),
    'DBFilesClient\\LightIntBand.dbc': dbc(34, [
      band(1, [[0, 0x6182a2], [1440, 0xff8800]]), band(2, [[1440, 0x68829a]]),
      band(19, [[1440, 0xbff5ff]]), band(20, [[1440, 0x4863a6]]),
    ]),
  };
  const lights = mapLights((name) => files[name] ?? null, 489);
  assert.equal(lights.lights.length, 2);
  const [base, fallback] = lights.lights;
  assert.equal(base.defaultLight, false);
  near(base.inner, 213, 'inner');
  near(base.outer, 288, 'outer');
  assert.deepEqual(base.direct, [[1440, 0xbff5ff]]);
  assert.equal(fallback.id, 1);
  assert.equal(fallback.defaultLight, true);
  assert.equal(fallback.position, null);
  assert.deepEqual(fallback.direct, [[0, 0x6182a2], [1440, 0xff8800]]);
  assert.equal(lights.timeOfDay, undefined);
  // Map.dbc's time-of-day override (minutes; -1 for the clock): the
  // Orgrimmar arena is always lit at noon.
  const maps = dbc(66, [{ 0: 489, 62: -1 }, { 0: 618, 62: 720 }]);
  const withMaps = (name) => (name === 'DBFilesClient\\Map.dbc' ? maps : files[name] ?? null);
  assert.equal(mapLights(withMaps, 489).timeOfDay, undefined);
  assert.equal(mapLights(withMaps, 618).timeOfDay, 1440);
});

test('a band\'s colour at a time runs between its keys and wraps past midnight', () => {
  const keys = [[720, 0x000000], [1440, 0xffffff], [2520, 0x000000]];
  assert.deepEqual(plain(light.keyColor(keys, 1440)), [1, 1, 1]);
  near(light.keyColor(keys, 1080)[0], 0.5, 'halfway up');
  // From 2520 round midnight to 720 it stays black.
  assert.deepEqual(plain(light.keyColor(keys, 100)), [0, 0, 0]);
  assert.deepEqual(plain(light.keyColor([[1440, 0x336699]], 0)), rgb(0x336699));
  assert.deepEqual(plain(light.keyColor([], 0)), [0, 0, 0]);
  assert.equal(light.timeOfDay(new Date(2026, 9, 12, 12, 0, 0)), 1440);
});

test('area lights count in full inside their inner radius and fade out to their outer, mixed over the default light', () => {
  const area = { id: 2, defaultLight: false, position: [0, 0, 0], inner: 10, outer: 20, direct: [[0, 0xffffff]], ambient: [[0, 0x000000]] };
  const fallback = { id: 1, defaultLight: true, position: null, inner: 0, outer: 0, direct: [[0, 0x000000]], ambient: [[0, 0xffffff]] };
  const map = { mapId: 1, lights: [area, fallback] };
  assert.equal(light.lightWeight(area, [5, 0, 0]), 1);
  near(light.lightWeight(area, [15, 0, 0]), 0.5, 'half way out');
  assert.equal(light.lightWeight(area, [25, 0, 0]), 0);
  assert.deepEqual(plain(light.lightAt(map, [0, 0, 0], 0)), { direct: [1, 1, 1], ambient: [0, 0, 0] });
  const between = light.lightAt(map, [15, 0, 0], 0);
  near(between.direct[0], 0.5, 'direct');
  near(between.ambient[0], 0.5, 'ambient');
  assert.deepEqual(plain(light.lightAt(map, [100, 0, 0], 0)), { direct: [0, 0, 0], ambient: [1, 1, 1] });
  // Overlapping lights are mixed in turn, the farthest first, not averaged:
  // the nearer light (red, weight 0.5) over the farther (white, in full).
  const nearer = { ...area, id: 3, position: [8, 0, 0], inner: 1, outer: 5, direct: [[0, 0xff0000]] };
  const both = light.lightAt({ mapId: 1, lights: [nearer, area, fallback] }, [5, 0, 0], 0);
  assert.equal(light.lightWeight(nearer, [5, 0, 0]), 0.5);
  assert.deepEqual(plain(both.direct), [1, 0.5, 0.5]);
  assert.deepEqual(plain(both.ambient), [0, 0, 0]);
  // A nearer light in full hides the farther one.
  const hidden = light.lightAt({ mapId: 1, lights: [area, { ...nearer, inner: 20, outer: 30 }, fallback] }, [5, 0, 0], 0);
  assert.deepEqual(plain(hidden.direct), [1, 0, 0]);
});

test('a lit surface takes the ambient plus the direct light by N.L, capped at 1', () => {
  const colors = { direct: [1, 0.5, 0], ambient: [0.2, 0.3, 0.4] };
  const lit = light.litColor(colors, 0.5);
  [0.7, 0.55, 0.4].forEach((expected, channel) => near(lit[channel], expected, `channel ${channel}`));
  assert.deepEqual(plain(light.litColor(colors, -1)), [0.2, 0.3, 0.4]);
  assert.deepEqual(plain(light.litColor({ direct: [3, 1, 1], ambient: [0.5, 0.5, 0.5] }, 0.25)), [0.75, 0.75, 0.75]);
  assert.deepEqual(plain(light.litColor({ direct: [1, 1, 1], ambient: [0.5, 0.9, 1.4] }, 1)), [1, 1, 1]);
});

test('reads models\' point lights from their own bytes, without fade distances', async () => {
  const { readM2Lights } = await import(pathToFileURL(path.join(__dirname, 'scene', 'lights.mjs')).href);
  // An M2 with one point light: tracks hold one sequence of one key each.
  const m2 = Buffer.alloc(1024);
  m2.writeUInt32LE(1, 0x108);
  m2.writeUInt32LE(0x200, 0x10c);
  const light = 0x200;
  m2.writeUInt16LE(1, light);
  [0, 0.25, 1].forEach((value, axis) => m2.writeFloatLE(value, light + 4 + axis * 4));
  let next = 0x300;
  // One sequence of one key: its time (0) and its value.
  const track = (at, values) => {
    const times = next;
    const time = next + 8;
    const keys = next + 12;
    const data = next + 20;
    next += 20 + values.length * 4;
    m2.writeUInt32LE(1, at + 4);
    m2.writeUInt32LE(times, at + 8);
    m2.writeUInt32LE(1, times);
    m2.writeUInt32LE(time, times + 4);
    m2.writeUInt32LE(1, at + 12);
    m2.writeUInt32LE(keys, at + 16);
    m2.writeUInt32LE(1, keys);
    m2.writeUInt32LE(data, keys + 4);
    values.forEach((value, index) => m2.writeFloatLE(value, data + index * 4));
  };
  track(light + 56, [1, 0.5, 0]);
  track(light + 76, [2]);
  track(light + 96, [0.5]);
  track(light + 116, [1.5]);
  assert.deepEqual(JSON.parse(JSON.stringify(readM2Lights(m2))), [{ position: [0, 0.25, 1], color: 0xff8000, intensity: 2 }]);
  assert.deepEqual(readM2Lights(Buffer.alloc(16)), []);
});

test('places a light by its building\'s turn, scale, and position', async () => {
  const { placePoint } = await import(pathToFileURL(path.join(__dirname, 'scene', 'lights.mjs')).href);
  // A quarter turn about Z takes +X to +Y.
  const quarter = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  const placed = placePoint({ position: [100, 200, 10], rotation: quarter, scale: 2 }, [1, 0, 3]);
  [100, 202, 16].forEach((expected, axis) => near(placed[axis], expected, `axis ${axis}`));
});

test('picks the object lights nearest the view', () => {
  const at = (x) => ({ position: [x, 0, 0], color: 0xffffff, intensity: 1 });
  const lights = [at(50), at(5), at(300), at(20)];
  assert.deepEqual(plain(light.nearestObjectLights(lights, [0, 0, 0], 2).map((entry) => entry.position[0])), [5, 20]);
  assert.deepEqual(plain(light.nearestObjectLights(lights, [0, 0, 0], 8).map((entry) => entry.position[0])), [5, 20, 50, 300]);
});

test('a point light falls off as the client\'s fixed curve, by how squarely it shines on the surface', () => {
  near(light.pointLightShare(1, 1), 1 / 0.73, 'one yard, head on');
  near(light.pointLightShare(10, 0.5), 0.5 / 10, 'ten yards, at 60 degrees');
  assert.equal(light.pointLightShare(4, -0.5), 0);
});

test('the sun shines from a fixed bearing, highest at noon and midnight and lowest at six', () => {
  const degrees = (radians) => (radians * 180) / Math.PI;
  const elevation = (time) => degrees(Math.asin(-light.sunDirection(time)[2]));
  near(elevation(1440), 37, 'noon');
  near(elevation(0), 37, 'midnight');
  near(elevation(720), 20, 'six in the morning');
  near(elevation(2160), 20, 'six in the evening');
  near(elevation(1080), 28.5, 'nine, halfway');
  near(elevation(1440 + 2880), 37, 'a day later');
  for (const time of [0, 600, 1440, 2000]) {
    const [x, y, z] = light.sunDirection(time);
    near(Math.hypot(x, y, z), 1, `unit length at ${time}`);
    near(x, y, `bearing at ${time}`);
    assert.ok(x < 0 && z < 0, 'travels down, away from +x and +y');
  }
});

// A chunk as stored: its ID reversed, its size, its bytes.
const chunkBytes = (id, data) => Buffer.concat([Buffer.from(id.split('').reverse().join('')), Buffer.from(Uint32Array.of(data.length).buffer), data]);

test('lists interior groups with the building\'s ambient and outdoor-lit groups', async () => {
  const { interiorGroups } = await import(pathToFileURL(path.join(__dirname, 'scene', 'lights.mjs')).href);
  const root = (flags, groups) => {
    const mohd = Buffer.alloc(64);
    mohd.writeUInt32LE(groups, 4);
    mohd.writeUInt32LE(0xff4b4021, 0x1c);
    mohd.writeUInt16LE(flags, 0x3c);
    return chunkBytes('MOHD', mohd);
  };
  const group = (flags, groupId) => {
    const mogp = Buffer.alloc(0x44);
    mogp.writeUInt32LE(flags, 0x08);
    mogp.writeUInt32LE(groupId, 0x38);
    return chunkBytes('MOGP', mogp);
  };
  const files = {
    'adds.wmo': root(0x2 | 0x1, 3),
    'adds_000.wmo': group(0x2000, 101),
    'adds_001.wmo': group(0x8, 102),
    'adds_002.wmo': group(0x2000 | 0x40, 103),
    'plain.wmo': root(0x5, 2),
    'plain_000.wmo': group(0x2000, 201),
    'plain_001.wmo': group(0x2000 | 0x40, 202),
  };
  assert.deepEqual(plain(interiorGroups((name) => files[name] ?? null, ['adds.wmo', 'plain.wmo', 'adds.wmo', 'missing.wmo'])), {
    101: { ambient: 0x4b4021 },
    103: { ambient: 0x4b4021, outdoor: true },
    202: { outdoor: true },
  });
});

test('the floor colour a unit is lit by indoors is doubled, plus the building\'s ambient', () => {
  const lit = light.floorLight([0.2, 0.3, 0.6], 0x4b4021);
  [0.4 + 0x4b / 255, 0.6 + 0x40 / 255, 1].forEach((expected, channel) => near(lit[channel], expected, `channel ${channel}`));
  assert.deepEqual(plain(light.floorLight([0.25, 0.5, 0.75])), [0.5, 1, 1]);
});

test('finds a group\'s transition faces by render batch', async () => {
  const { transitionTriangles } = await import(pathToFileURL(path.join(__dirname, 'scene', 'lights.mjs')).href);
  const { readGroupHeader } = await import(pathToFileURL(path.join(__dirname, 'scene', 'wmo.mjs')).href);
  // Five triangles: batch 0 has 0-1, batch 1 has 2-4; triangles 1 and 3 are transition faces.
  const mopy = Buffer.from([0x20, 0, 0x21, 0, 0x20, 0, 0x01, 0, 0x08, 0]);
  const moba = Buffer.alloc(48);
  moba.writeUInt32LE(0, 0x0c);
  moba.writeUInt16LE(6, 0x10);
  moba.writeUInt32LE(6, 24 + 0x0c);
  moba.writeUInt16LE(9, 24 + 0x10);
  const group = (chunks) => chunkBytes('MOGP', Buffer.concat([Buffer.alloc(0x44), ...chunks]));
  assert.deepEqual(plain(transitionTriangles(readGroupHeader(group([chunkBytes('MOPY', mopy), chunkBytes('MOBA', moba)])))), [[1], [1]]);
  const none = Buffer.from([0x20, 0, 0x20, 0, 0x20, 0, 0, 0, 0x08, 0]);
  assert.deepEqual(plain(transitionTriangles(readGroupHeader(group([chunkBytes('MOPY', none), chunkBytes('MOBA', moba)])))), []);
});

test('picks the zone\'s ambient multiplier for a map', async () => {
  const { zoneAmbientMultiplier } = await import(pathToFileURL(path.join(__dirname, 'scene', 'lights.mjs')).href);
  const record = (id, map, parent, multiplier) => ({ uint: (field) => [id, map, parent][field], float: () => multiplier });
  const areas = { records: () => [record(9, 574, 0, 0.4), record(206, 574, 0, 0.7), record(5, 574, 206, 0.9), record(1, 1, 0, 0.2)] };
  near(zoneAmbientMultiplier(areas, 574), 0.4, 'lowest top-level area');
  assert.equal(zoneAmbientMultiplier(areas, 999), 0);
});

test('characters\' ambient scales by the zone, and transition faces blend towards the outdoor light', () => {
  near(light.characterAmbientScale(0.7), 2.4, 'scale');
  assert.equal(light.characterAmbientScale(), 1);
  const scaled = light.scaleAmbient([0.2, 0.5, 0.1], 2.4);
  [0.48, 1, 0.24].forEach((expected, channel) => near(scaled[channel], expected, `ambient ${channel}`));
  const blended = light.blendLight({ direct: [1, 0, 0], ambient: [0, 0, 0] }, { direct: [0, 1, 0], ambient: [1, 1, 1] }, 0.25);
  [0.75, 0.25, 0].forEach((expected, channel) => near(blended.direct[channel], expected, `direct ${channel}`));
  [0.25, 0.25, 0.25].forEach((expected, channel) => near(blended.ambient[channel], expected, `ambient ${channel}`));
});

test('lights a building\'s batches as the client\'s two render paths do', () => {
  const counts = [2, 3, 4];
  // Older path: transition, then interior (vertex colours only), then exterior (the map's light).
  assert.deepEqual([0, 1, 2, 4, 5, 8].map((batch) => light.buildingBatchLight(batch, counts, false, 0x2000, 0)),
    ['transition', 'transition', 'unlit', 'unlit', 'lit', 'lit']);
  // Newer path: by the group, not the batch counts; windows and unlit materials.
  assert.equal(light.buildingBatchLight(3, counts, true, 0x2000, 0), 'own');
  assert.equal(light.buildingBatchLight(8, counts, true, 0x2000, 0), 'own');
  assert.equal(light.buildingBatchLight(3, counts, true, 0x2000, 0x20), 'lit');
  assert.equal(light.buildingBatchLight(3, counts, true, 0x8, 0), 'lit');
  assert.equal(light.buildingBatchLight(3, counts, true, 0x40, 0x1), 'unlit');
  assert.equal(light.buildingBatchLight(0, counts, true, 0x8, 0), 'transition');
});

test('a unit\'s light eases: ambient at two a second, its direct scale at 3.33 a second and never above 1', () => {
  const eased = light.easeLight({ ambient: [0, 0.5, 1], directScale: 1 }, { ambient: [1, 0.5, 0], directScale: light.DIRECT_SCALE_SHADOWED }, 0.1);
  [0.2, 0.5, 0.8].forEach((expected, channel) => near(eased.ambient[channel], expected, `ambient ${channel}`));
  near(eased.directScale, 1 - 1 / 3, 'scale down');
  near(light.easeLight({ ambient: [0, 0, 0], directScale: 0.5 }, { ambient: [0, 0, 0], directScale: 1 }, 0.06).directScale, 0.7, 'rising');
  // Never above 1, whatever it aims at.
  near(light.easeLight({ ambient: [0, 0, 0], directScale: 0.9 }, { ambient: [0, 0, 0], directScale: 2.5 }, 1).directScale, 1, 'capped');
});

test('finds the shadow texel under a point as the client does, by its tile\'s corner', () => {
  const shadow = loadModule('../renderer/scripts/utils/terrain-shadow.ts');
  const chunk = 1600 / 3 / 16;
  const origin = [1000, 2000];
  assert.equal(shadow.shadowTexel(origin, 1000, 2000), 0);
  // One chunk south and half a chunk east: row 64, column 32.
  assert.equal(shadow.shadowTexel(origin, 1000 - chunk - 0.01, 2000 - chunk / 2 - 0.01), 64 * 1024 + 32);
  assert.equal(shadow.shadowTexel(origin, 1001, 2000), null, 'north of the tile');
  assert.equal(shadow.shadowTexel(origin, 1000, 2000 - 1600 / 3 - 0.01), null, 'east of the tile');
  const tiles = new shadow.TerrainShadows();
  let reads = 0;
  tiles.addTile(origin, () => {
    reads += 1;
    const alpha = new Uint8Array(1024 * 1024).fill(255);
    alpha[64 * 1024 + 32] = 150;
    return alpha;
  });
  assert.equal(tiles.isShadowed(1000 - chunk - 0.01, 2000 - chunk / 2 - 0.01), true);
  assert.equal(tiles.isShadowed(999, 1999), false);
  assert.equal(tiles.isShadowed(5000, 5000), false, 'off the tiles');
  assert.equal(reads, 1, 'read once');
  // A scene's own chunk shadows: chunk 17 (row 1, column 1), texel (2, 3)
  // in it.
  const bytes = new Uint8Array(512);
  const bit = 2 * 64 + 3;
  bytes[bit >> 3] |= 1 << (bit & 7);
  const chunks = new Array(256).fill(null);
  chunks[17] = Buffer.from(bytes).toString('base64');
  const byChunk = new shadow.TerrainShadows();
  byChunk.addChunks(origin, chunks);
  const texel = chunk / 64;
  assert.equal(byChunk.isShadowed(1000 - chunk - 2.5 * texel, 2000 - chunk - 3.5 * texel), true);
  assert.equal(byChunk.isShadowed(1000 - chunk - 2.5 * texel, 2000 - chunk - 4.5 * texel), false);
  assert.equal(byChunk.isShadowed(999, 1999), false, 'a chunk without shadow');
});

test("blends water's colours and alphas across area lights as the light's own colours", () => {
  const water = (color, alpha) => ({
    oceanShallow: [[0, color]], oceanDeep: [[0, color]], riverShallow: [[0, color]], riverDeep: [[0, color]], sunCloud: [[0, color]],
    alphas: [alpha, 1, alpha, 1],
  });
  const map = {
    mapId: 1,
    lights: [
      { id: 1, defaultLight: true, position: null, inner: 0, outer: 0, direct: [], ambient: [], water: water(0x000000, 0.5) },
      { id: 2, defaultLight: false, position: [0, 0, 0], inner: 10, outer: 30, direct: [], ambient: [], water: water(0xff0000, 0.75) },
    ],
  };
  // Halfway through the area light's falloff: half of each.
  const half = plain(light.lightAt(map, [20, 0, 0], 0).water);
  near(half.riverDeep[0], 0.5, 'river deep red');
  near(half.oceanShallow[0], 0.5, 'ocean shallow red');
  near(half.sunCloud[0], 0.5, 'sun on clouds red');
  near(half.alphas[0], 0.625, 'water shallow alpha');
  near(half.alphas[1], 1, 'water deep alpha');
  assert.deepEqual(plain(light.lightAt(map, [100, 0, 0], 0).water.alphas), [0.5, 1, 0.5, 1]);
  // Light files from before water's colours have none.
  assert.equal(light.lightAt({ mapId: 1, lights: [{ ...map.lights[0], water: undefined }] }, [0, 0, 0], 0).water, undefined);
});

const liquids = loadModule('../renderer/scripts/utils/liquid-light.ts');

test("builds water's depth ramps as the client does: 64 rows from shallow to deep, WMO water's white half, the ocean's darker last row", () => {
  const water = {
    oceanShallow: rgb(0x204060), oceanDeep: rgb(0x000000), riverShallow: rgb(0x000000), riverDeep: rgb(0x40ff80), sunCloud: [0, 0, 0],
    alphas: [0.5, 1, 0.75, 1],
  };
  const texel = (texels, row, column) => [...texels.slice((row * 8 + column) * 4, (row * 8 + column) * 4 + 4)];
  const river = liquids.waterRampTexels('river', water);
  assert.deepEqual(texel(river, 0, 0), [0, 0, 0, 128]);
  // Each row a 64th of the way; the last stops a step short of the deep.
  assert.deepEqual(texel(river, 32, 7), [32, 127, 64, 191]);
  assert.deepEqual(texel(river, 63, 0), [63, 251, 126, 253]);
  const ocean = liquids.waterRampTexels('ocean', water);
  assert.deepEqual(texel(ocean, 0, 3), [32, 64, 96, 191]);
  assert.deepEqual(texel(ocean, 62, 0), [1, 2, 3, 253]);
  // The last row is a tenth darker, and opaque.
  assert.deepEqual(texel(ocean, 63, 0), [0, 1, 1, 255]);
  const wmo = liquids.waterRampTexels('wmo', water);
  assert.deepEqual(texel(wmo, 10, 3), [64, 255, 128, 147]);
  assert.deepEqual(texel(wmo, 10, 4), [255, 255, 255, 147]);
});

test("picks an animated sheet's frame as the client does: 30 frames in 1250 ms", () => {
  assert.equal(liquids.liquidFrameIndex(0, 1250, 30), 0);
  assert.equal(liquids.liquidFrameIndex(41, 1250, 30), 0);
  assert.equal(liquids.liquidFrameIndex(42, 1250, 30), 1);
  assert.equal(liquids.liquidFrameIndex(1249, 1250, 30), 29);
  assert.equal(liquids.liquidFrameIndex(1250 * 7 + 625, 1250, 30), 15);
  assert.equal(liquids.liquidFrameIndex(500, 1250, 0), 0);
});

test("scrolls magma's sheet as the client does: whole-millisecond periods of 1000 / speed", () => {
  // Terrain magma: 0.025 widths a second, once round every 40 s.
  near(liquids.liquidScrollOffset(10000, 0.025), 0.25, 'quarter way');
  near(liquids.liquidScrollOffset(40000, 0.025), 0, 'wrapped');
  // WMO magma: 0.1 a second along v, every 10 s.
  near(liquids.liquidScrollOffset(12500.9, 0.1), 0.25, 'whole milliseconds');
  assert.equal(liquids.liquidScrollOffset(12345, 0), 0);
});
