const assert = require('node:assert/strict');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const load = (file) => import(pathToFileURL(path.join(__dirname, 'scene', file)).href);
const near = (actual, expected, label, tolerance = 1e-3) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${label}: ${actual} != ${expected}`);

function chunk(id, data) {
  const header = Buffer.alloc(8);
  header.write(id.split('').reverse().join(''), 0, 'ascii');
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data]);
}

function modfEntry({ nameId = 0, uniqueId, position, rotation = [0, 0, 0], doodadSet = 0 }) {
  const entry = Buffer.alloc(64);
  entry.writeUInt32LE(nameId, 0);
  entry.writeUInt32LE(uniqueId, 4);
  position.forEach((value, index) => entry.writeFloatLE(value, 8 + index * 4));
  rotation.forEach((value, index) => entry.writeFloatLE(value, 20 + index * 4));
  entry.writeUInt16LE(doodadSet, 58);
  return entry;
}

test('converts placement space to server world coordinates (Azjol-Nerub WMO)', async () => {
  const { placementToWorld } = await load('placement.mjs');
  const { position, rotation } = placementToWorld([16532.86328125, 576.2404174804688, 16534.029296875], [0, 0, 0]);
  near(position[0], 532.637, 'x');
  near(position[1], 533.803, 'y');
  near(position[2], 576.240, 'z');
  // An unrotated placement turns the model 180 degrees about Z.
  near(Math.abs(rotation[2]), 1, 'quaternion z');
  near(rotation[3], 0, 'quaternion w');
});

test('reads WDT tiles and only treats MODF as the map object on WMO-only maps, placed without the map-centre offset', async () => {
  const { readWdt } = await load('placement.mjs');
  const main = Buffer.alloc(64 * 64 * 8);
  main.writeUInt32LE(1, (30 * 64 + 29) * 8);
  const terrainHeader = Buffer.alloc(32);
  const terrain = readWdt(Buffer.concat([chunk('MVER', Buffer.alloc(4)), chunk('MPHD', terrainHeader), chunk('MAIN', main), chunk('MWMO', Buffer.alloc(0))]));
  assert.equal(terrain.wmoOnly, false);
  assert.deepEqual(terrain.tiles, [{ x: 29, y: 30 }]);

  const wmoHeader = Buffer.alloc(32);
  wmoHeader.writeUInt32LE(1, 0);
  const wmoOnly = readWdt(Buffer.concat([
    chunk('MPHD', wmoHeader), chunk('MAIN', Buffer.alloc(64 * 64 * 8)),
    chunk('MWMO', Buffer.from('World\\wmo\\Dungeon\\Test.wmo\0', 'latin1')),
    chunk('MODF', modfEntry({ uniqueId: 9, position: [5, 10, 7], doodadSet: 2 })),
  ]));
  assert.equal(wmoOnly.wmoOnly, true);
  assert.equal(wmoOnly.wmo.name, 'World\\wmo\\Dungeon\\Test.wmo');
  assert.equal(wmoOnly.wmo.doodadSet, 2);
  // Placement (x, y up, z) becomes world (-z, -x, y), with no 17066.67 offset.
  near(wmoOnly.wmo.position[0], -7, 'x');
  near(wmoOnly.wmo.position[1], -5, 'y');
  near(wmoOnly.wmo.position[2], 10, 'z');
});

test('reads ADT building and doodad placements and dedupes shared buildings', async () => {
  const { dedupeByUniqueId, readAdtPlacements } = await load('placement.mjs');
  const names = Buffer.from('a.wmo\0b.wmo\0', 'latin1');
  const ids = Buffer.alloc(8);
  ids.writeUInt32LE(0, 0);
  ids.writeUInt32LE(6, 4);
  const doodadNames = Buffer.from('Doodads\\Torch.MDX\0', 'latin1');
  const mddf = Buffer.alloc(36);
  mddf.writeUInt32LE(0, 0);
  mddf.writeUInt32LE(77, 4);
  mddf.writeUInt16LE(2048, 32);
  const adt = Buffer.concat([
    chunk('MMDX', doodadNames), chunk('MMID', Buffer.alloc(4)),
    chunk('MWMO', names), chunk('MWID', ids),
    chunk('MDDF', mddf),
    chunk('MODF', Buffer.concat([
      modfEntry({ nameId: 1, uniqueId: 5, position: [0, 0, 0] }),
      modfEntry({ nameId: 0, uniqueId: 6, position: [0, 0, 0] }),
    ])),
  ]);
  const placements = readAdtPlacements(adt);
  assert.deepEqual(placements.wmos.map((wmo) => wmo.name), ['b.wmo', 'a.wmo']);
  assert.equal(placements.doodads[0].name, 'Doodads\\Torch.m2');
  assert.equal(placements.doodads[0].scale, 2);
  assert.deepEqual(dedupeByUniqueId([...placements.wmos, ...placements.wmos]).map((wmo) => wmo.uniqueId), [5, 6]);
});

test('reads the MOGP group ID, flags, and doodad references from a WMO group', async () => {
  const { readGroupHeader } = await load('wmo.mjs');
  const header = Buffer.alloc(0x44);
  header.writeUInt32LE(0x2805, 0x08);
  [-1, -2, -3, 4, 5, 6].forEach((value, index) => header.writeFloatLE(value, 0x0C + index * 4));
  header.writeUInt16LE(3, 0x28);
  header.writeUInt16LE(4, 0x2a);
  header.writeUInt16LE(5, 0x2c);
  header.writeUInt32LE(24550, 0x38);
  const refs = Buffer.alloc(4);
  refs.writeUInt16LE(3, 0);
  refs.writeUInt16LE(9, 2);
  // MOBR, the collision tree's triangles: listed once each, in order.
  const mobr = Buffer.from(Uint16Array.of(5, 2, 5, 7).buffer);
  const group = Buffer.concat([chunk('MVER', Buffer.alloc(4)), chunk('MOGP', Buffer.concat([header, chunk('MODR', refs), chunk('MOBR', mobr)]))]);
  assert.deepEqual(readGroupHeader(group), {
    flags: 0x2805,
    polyFlags: null,
    bspFaces: Uint32Array.of(2, 5, 7),
    renderBatches: [],
    boundingBox: [-1, -2, -3, 4, 5, 6],
    transBatchCount: 3,
    intBatchCount: 4,
    extBatchCount: 5,
    groupId: 24550,
    doodadRefs: [3, 9],
  });
});

test('lights a building\'s prop by the floor under it, as the client does', async () => {
  const { propFloor } = await load('wmo.mjs');
  // A floor square at height 0 (two triangles; the second a transition
  // face), vertex colours BGRA, and a ceiling at height 3 over it.
  const positions = Float32Array.from([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 3, 10, 0, 3, 10, 10, 3]);
  const colors = Uint8Array.from([
    20, 40, 60, 255, 20, 40, 60, 255, 20, 40, 60, 255, 20, 40, 60, 128,
    0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255,
  ]);
  const floor = {
    flags: 0x2000, doodadRefs: [0, 1], positions, colors,
    indices: Uint16Array.from([0, 1, 2, 0, 2, 3, 4, 5, 6]),
    polyFlags: Buffer.from([0x20, 0, 0x21, 0, 0x20, 0]),
  };
  const wmo = { rootFlags: 0x2, ambient: 0xff0a1428, groups: [{ flags: 0x8, doodadRefs: [2] }, floor] };
  const [r, g, b, share] = propFloor(wmo, 0, [8, 2, 0.5]);
  // Doubled plus the ambient (BGRA bytes 0x28, 0x14, 0x0a): (120 + 10, 80 + 20, 40 + 40) / 255.
  [130 / 255, 100 / 255, 80 / 255, 0].forEach((expected, index) => assert.ok(Math.abs([r, g, b, share][index] - expected) < 1e-6, `${index}`));
  // On the transition face, its share is the floor's alpha there.
  const onTransition = propFloor(wmo, 1, [1, 9, 0]);
  assert.ok(onTransition[3] > 0.5 && onTransition[3] < 1, `share ${onTransition[3]}`);
  // Under the ceiling only from above 1 yard: the floor, not the ceiling.
  assert.equal(propFloor(wmo, 0, [8, 2, 2.5])[0] < 1, true);
  assert.equal(propFloor(wmo, 2, [0, 0, 0]), 'outdoor');
  assert.equal(propFloor(wmo, 0, [8, 2, 20]), null, 'more than 12 yards above the floor');
  assert.equal(propFloor(wmo, 5, [0, 0, 0]), null, 'listed by no group');
});

test('finds a prop\'s floor among drawn and detail faces of the collision tree, never collision-only ones', async () => {
  const { propFloor, floorFaces } = await load('wmo.mjs');
  // Three squares' first triangles over the same spot: a drawn face at 0
  // (warm), a collision-only face at 0.5 (grey), and a drawn face at 0.8
  // the collision tree leaves out.
  const square = (z) => [0, 0, z, 10, 0, z, 10, 10, z];
  const positions = Float32Array.from([...square(0), ...square(0.5), ...square(0.8)]);
  const bgra = (b, g, r) => [b, g, r, 255, b, g, r, 255, b, g, r, 255];
  const colors = Uint8Array.from([...bgra(28, 40, 54), ...bgra(63, 63, 63), ...bgra(0, 0, 100)]);
  const group = {
    flags: 0x2000, doodadRefs: [0], positions, colors,
    indices: Uint16Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]),
    polyFlags: Buffer.from([0x24, 0, 0x08, 0xff, 0x20, 0]),
    bspFaces: Uint32Array.of(0, 1),
  };
  assert.deepEqual(floorFaces(group), { floor: [0], transition: [] });
  const [r, g, b] = propFloor({ rootFlags: 0, ambient: 0, groups: [group] }, 0, [8, 2, 0.9]);
  [108 / 255, 80 / 255, 56 / 255].forEach((expected, index) => assert.ok(Math.abs([r, g, b][index] - expected) < 1e-6, `${index}`));
  // Without a collision tree every face counts, the highest drawn one winning.
  const noTree = { ...group, bspFaces: null };
  assert.deepEqual(floorFaces(noTree), { floor: [0, 2], transition: [] });
  assert.ok(Math.abs(propFloor({ rootFlags: 0, ambient: 0, groups: [noTree] }, 0, [8, 2, 0.9])[0] - 200 / 255) < 1e-6);
});

test('selects the global doodad set plus the placement set', async () => {
  const { selectDoodadIndices } = await load('wmo.mjs');
  const sets = [{ start: 0, count: 2 }, { start: 2, count: 1 }, { start: 3, count: 2 }];
  assert.deepEqual([...selectDoodadIndices(sets, 0)], [0, 1]);
  assert.deepEqual([...selectDoodadIndices(sets, 2)], [0, 1, 3, 4]);
  assert.deepEqual([...selectDoodadIndices(sets, 9)], [0, 1]);
});

test('transforms WMO group bounds into world space', async () => {
  const { transformBoundingBox } = await load('export-scene.mjs');
  const halfTurn = [0, 0, 1, 0];
  const bounds = transformBoundingBox([-63, -359, 185, 242, -61, 289], { position: [532.637, 533.803, 576.24], rotation: halfTurn });
  near(bounds.minX, 290.637, 'minX');
  near(bounds.maxX, 595.637, 'maxX');
  near(bounds.minY, 594.803, 'minY');
  near(bounds.maxY, 892.803, 'maxY');
  near(bounds.minZ, 761.24, 'minZ');
  near(bounds.maxZ, 865.24, 'maxZ');
});

test('derives floor height ranges, splitting groups shared between floors', async () => {
  const { computeFloorHeights } = await load('export-scene.mjs');
  const groups = [
    { wmoGroupId: 24550, minZ: 420, maxZ: 644 },
    { wmoGroupId: 24879, minZ: -5, maxZ: 524 },
    { wmoGroupId: 24549, minZ: 761, maxZ: 865 },
    { wmoGroupId: 25050, minZ: 644, maxZ: 878 },
  ];
  const floors = [
    { id: 47, chunks: [{ wmoGroupId: 24550, minZ: -10000 }, { wmoGroupId: 24879, minZ: -10000 }] },
    { id: 48, chunks: [{ wmoGroupId: 25050, minZ: -10000 }] },
    { id: 49, chunks: [{ wmoGroupId: 24549, minZ: -10000 }, { wmoGroupId: 25050, minZ: 727 }] },
    { id: 50, chunks: [{ wmoGroupId: 1, minZ: -10000 }] },
  ];
  assert.deepEqual(computeFloorHeights(floors, groups), [
    { id: 47, minZ: -5, maxZ: 644 },
    { id: 48, minZ: 644, maxZ: 727 },
    { id: 49, minZ: 727, maxZ: 878 },
  ]);
});

test('expands M2 skin vertices into standalone arrays', async () => {
  const { expandSkinVertices } = await load('m2.mjs');
  const vertices = new ArrayBuffer(48 * 2);
  const view = new DataView(vertices);
  [1, 2, 3].forEach((value, index) => view.setFloat32(48 + index * 4, value, true));
  [0, 0, 1].forEach((value, index) => view.setFloat32(48 + 20 + index * 4, value, true));
  view.setFloat32(48 + 32, 0.25, true);
  view.setFloat32(48 + 36, 0.75, true);
  const expanded = expandSkinVertices(vertices, Uint16Array.from([1, 1, 0]));
  assert.deepEqual([...expanded.positions.slice(0, 3)], [1, 2, 3]);
  assert.deepEqual([...expanded.normals.slice(3, 6)], [0, 0, 1]);
  assert.deepEqual([...expanded.uvs.slice(0, 2)], [0.25, 0.75]);
  assert.deepEqual([...expanded.positions.slice(6, 9)], [0, 0, 0]);
});

test('folds M2 colour and texture-weight tracks into a static tint and opacity', async () => {
  const { staticBatchColor } = await load('m2.mjs');
  const track = (keys) => ({ sequenceKeys: keys });
  const model = {
    colors: [{ colorTrack: track([new Float32Array(0), Float32Array.from([1, 0.5, 0.25])]), alphaTrack: track([Int16Array.from([0x7FFF / 2])]) }],
    textureWeights: [{ weightTrack: track([Int16Array.from([0x7FFF / 2])]) }],
  };
  const color = staticBatchColor(model, 0, 0);
  assert.deepEqual(color.tint, [1, 0.5, 0.25]);
  near(color.opacity, 0.25, 'opacity', 1e-3);
  assert.deepEqual(staticBatchColor(model, 0xFFFF, 0xFFFF), { tint: [1, 1, 1], opacity: 1 });
});

test('picks the first mip level that fits the texture size cap', async () => {
  const { chooseMipLevel, hasTransparency } = await load('textures.mjs');
  assert.equal(chooseMipLevel(1024, 512, 11, 512), 1);
  assert.equal(chooseMipLevel(256, 256, 9, 512), 0);
  assert.equal(chooseMipLevel(4096, 4096, 2, 512), 1);
  assert.equal(hasTransparency(Uint8Array.from([1, 2, 3, 255, 4, 5, 6, 254])), true);
  assert.equal(hasTransparency(Uint8Array.from([1, 2, 3, 255])), false);
});

test('fixes WMO vertex colours as the client does, even when every batch is a transition batch', async () => {
  const { fixVertexColors } = await load('wmo.mjs');
  const bgra = Uint8Array.from([100, 100, 100, 64, 100, 100, 100, 64]);
  const batches = [{ lastVertex: 0 }, { lastVertex: 1 }];
  // Vertex 0 belongs to the transition batch: halved, alpha kept; vertex 1 is fixed.
  assert.deepEqual([...fixVertexColors(bgra, batches, 1)], [50, 50, 50, 64, 100, 100, 100, 255]);
  // No transition batches: everything is fixed. (100 + 100 * 64 / 64) / 2 = 100.
  assert.deepEqual([...fixVertexColors(Uint8Array.from([200, 0, 50, 0]), batches, 0)], [100, 0, 25, 255]);
  // All batches transition ones: all halved, and no out-of-range read.
  assert.deepEqual([...fixVertexColors(bgra, batches, 2)], [50, 50, 50, 64, 50, 50, 50, 64]);
  assert.deepEqual([...bgra], [100, 100, 100, 64, 100, 100, 100, 64], 'input is not mutated');
});

test('lays out a terrain chunk: 9 x 9 outer and 8 x 8 centre vertices running south and east', async () => {
  const { chunkPositions, CHUNK_SIZE, CHUNK_VERTEX_COUNT } = await load('terrain.mjs');
  const heights = new Float32Array(CHUNK_VERTEX_COUNT).fill(2);
  const positions = chunkPositions([100, 200, 10], heights);
  const unit = CHUNK_SIZE / 8;
  const at = (index) => [positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]];
  near(at(0)[0], 100, 'first outer x'); near(at(0)[1], 200, 'first outer y'); near(at(0)[2], 12, 'height added');
  near(at(8)[1], 200 - 8 * unit, 'last outer of row 0 is a chunk east');
  near(at(9)[0], 100 - unit / 2, 'first centre is half a step south');
  near(at(9)[1], 200 - unit / 2, 'and half a step east');
  near(at(144)[0], 100 - CHUNK_SIZE, 'last outer is a chunk south');
  near(at(144)[1], 200 - CHUNK_SIZE, 'and a chunk east');
});

test('builds four up-facing triangles per quad and leaves holes out', async () => {
  const { chunkIndices, chunkPositions, isHole, CHUNK_VERTEX_COUNT } = await load('terrain.mjs');
  assert.equal(chunkIndices(0).length, 8 * 8 * 4 * 3);
  // Bit 0 covers quads (0-1, 0-1); bit 5 covers rows 2-3, columns 2-3.
  assert.equal(chunkIndices(1).length, (64 - 4) * 12);
  assert.ok(isHole(1 << 5, 3, 2) && !isHole(1 << 5, 1, 2));
  const positions = chunkPositions([0, 0, 0], new Float32Array(CHUNK_VERTEX_COUNT));
  const indices = chunkIndices(0);
  const vertex = (index) => [positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]];
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const [a, b, c] = [vertex(indices[triangle]), vertex(indices[triangle + 1]), vertex(indices[triangle + 2])];
    const normalZ = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    assert.ok(normalZ > 0, `triangle ${triangle / 3} faces up`);
  }
});

test('crops terrain to the play area and spots placeholder tiles', async () => {
  const { chunkInArea, isPlaceholderArea, playArea, CHUNK_SIZE } = await load('terrain.mjs');
  // Floors are kept apart, each widened by the margin.
  const area = playArea([{ bounds: { minX: 0, maxX: 100, minY: -50, maxY: 50 } }, { bounds: { minX: 200, maxX: 300, minY: 0, maxY: 10 } }], null, 10);
  assert.deepEqual(area, [{ minX: -10, maxX: 110, minY: -60, maxY: 60 }, { minX: 190, maxX: 310, minY: -10, maxY: 20 }]);
  assert.deepEqual(playArea([], { minX: 1, maxX: 2, minY: 3, maxY: 4 }, 0), [{ minX: 1, maxX: 2, minY: 3, maxY: 4 }]);
  // Nothing to go by keeps no ground.
  assert.deepEqual(playArea([], null), []);
  assert.ok(!chunkInArea([0, 0], []));
  // Without floors or world map bounds, the area the buildings cover.
  assert.deepEqual(playArea([], null, 5, [{ minX: 0, maxX: 10, minY: 0, maxY: 10, minZ: 0, maxZ: 1 }, { minX: 20, maxX: 30, minY: -5, maxY: 0 }]),
    [{ minX: -5, maxX: 35, minY: -10, maxY: 15 }]);
  assert.deepEqual(playArea([], { minX: 1, maxX: 2, minY: 3, maxY: 4 }, 0, [{ minX: 0, maxX: 10, minY: 0, maxY: 10 }]), [{ minX: 1, maxX: 2, minY: 3, maxY: 4 }]);
  // A chunk spans [north - size, north] by [west - size, west].
  assert.ok(chunkInArea([0, 0], area));
  assert.ok(chunkInArea([-10 + CHUNK_SIZE - 1, 0], area));
  assert.ok(!chunkInArea([-11, 0], area));
  assert.ok(!chunkInArea([400 + CHUNK_SIZE, 0], area));
  // Between the two floors' boxes.
  assert.ok(!chunkInArea([150 + CHUNK_SIZE / 2, 0], area));
  assert.ok(chunkInArea([250, 0], area));
  // Props: a point inside one of the boxes.
  const { pointInArea } = await load('terrain.mjs');
  assert.ok(pointInArea([105, 0, 9], area));
  assert.ok(pointInArea([250, 15, 0], area));
  assert.ok(!pointInArea([150, 0, 0], area));
  assert.ok(!pointInArea([250, 25, 0], area));
  assert.ok(!pointInArea([0, 0, 0], []));
  assert.ok(chunkInArea([999, 999], null));
  const chunk = (z, heights, layers = []) => ({ position: [0, 0, z], vertexHeights: heights, layers });
  assert.ok(isPlaceholderArea({ chunks: [chunk(0, [0, 0]), chunk(0, [0, 0])] }));
  assert.ok(!isPlaceholderArea({ chunks: [chunk(0, [0, 0]), chunk(5, [0, 0])] }));
  assert.ok(!isPlaceholderArea({ chunks: [chunk(0, [0, 0], [{}])] }));
  const { isPlaceholderChunk } = await load('terrain.mjs');
  assert.ok(isPlaceholderChunk(chunk(0, [0, 0])));
  assert.ok(!isPlaceholderChunk(chunk(0, [0, 1])));
  assert.ok(!isPlaceholderChunk(chunk(5, [0, 0])));
  assert.ok(!isPlaceholderChunk(chunk(0, [0, 0], [{}])));
});

test('reads MCCV vertex shading as RGB bytes', async () => {
  const { readVertexShading, CHUNK_VERTEX_COUNT } = await load('terrain.mjs');
  const mccv = Buffer.alloc(8 + CHUNK_VERTEX_COUNT * 4);
  mccv.write('VCCM', 0, 'ascii');
  mccv.writeUInt32LE(CHUNK_VERTEX_COUNT * 4, 4);
  for (let index = 0; index < CHUNK_VERTEX_COUNT; index += 1) mccv.set([127, 254, 0, 127], 8 + index * 4);
  const header = Buffer.alloc(128);
  header.writeUInt32LE(8 + 128, 0x74);
  const data = Buffer.concat([header, mccv]);
  const mcnk = Buffer.concat([Buffer.from('KNCM', 'ascii'), Buffer.alloc(4), data]);
  mcnk.writeUInt32LE(data.length, 4);
  const [colors] = readVertexShading(mcnk);
  // BGRA (127, 254, 0) → RGB (0, 254, 127): ×0, ×2, ×1.
  assert.deepEqual([...colors.slice(0, 3)], [0, 254, 127]);
  assert.equal(readVertexShading(Buffer.concat([Buffer.from('KNCM', 'ascii'), Buffer.from([128, 0, 0, 0]), Buffer.alloc(128)]))[0], null);
});

test('packs a chunk\'s layer alphas and shadow into its cell of the tile atlas', async () => {
  const { packChunkSplats, ATLAS_SIZE, SPLAT_SIZE } = await load('terrain.mjs');
  const atlas = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4);
  const splat = (value) => new Uint8Array(SPLAT_SIZE * SPLAT_SIZE).fill(value);
  const shadow = new Uint8Array(SPLAT_SIZE * SPLAT_SIZE);
  shadow[SPLAT_SIZE + 2] = 1;
  packChunkSplats(atlas, 2, 3, [{}, { splat: splat(10) }, { splat: splat(20) }, null], shadow);
  const pixel = (x, y) => Array.from(atlas.subarray((y * ATLAS_SIZE + x) * 4, (y * ATLAS_SIZE + x) * 4 + 4));
  // Cell (row 2, column 3) starts at pixel (192, 128).
  assert.deepEqual(pixel(192, 128), [10, 20, 0, 255]);
  // The shadowed texel (row 1, column 2 in the chunk) is darker.
  assert.ok(pixel(194, 129)[3] < 255);
  assert.deepEqual(pixel(191, 128), [0, 0, 0, 0]);
});

test('reads MCSH shadows a bit per texel, least significant first', async () => {
  const { readShadows, SPLAT_SIZE } = await load('terrain.mjs');
  const mcsh = Buffer.alloc(8 + 512);
  mcsh.write('HSCM', 0, 'ascii');
  mcsh.writeUInt32LE(512, 4);
  mcsh[8 + 1 * 8 + 0] = 0b100;
  const header = Buffer.alloc(128);
  header.writeUInt32LE(0x1, 0x00);
  header.writeUInt32LE(8 + 128, 0x2C);
  const data = Buffer.concat([header, mcsh]);
  const mcnk = Buffer.concat([Buffer.from('KNCM', 'ascii'), Buffer.alloc(4), data]);
  mcnk.writeUInt32LE(data.length, 4);
  const [shadow] = readShadows(mcnk);
  assert.equal(shadow[1 * SPLAT_SIZE + 2], 1);
  assert.equal(shadow.reduce((sum, value) => sum + value, 0), 1);
  // Scenes carry it as the client keeps it: MCSH's own bytes.
  const { encodeShadow } = await load('terrain.mjs');
  assert.equal(encodeShadow(shadow), mcsh.subarray(8).toString('base64'));
  header.writeUInt32LE(0, 0x00);
  const noFlag = Buffer.concat([Buffer.from('KNCM', 'ascii'), Buffer.alloc(4), header, mcsh]);
  noFlag.writeUInt32LE(header.length + mcsh.length, 4);
  assert.equal(readShadows(noFlag)[0], null);
});

// A WMO group with an MLIQ of 3 x 2 vertices (heights 100-105, depth bytes
// 10, 20, ..., magma s, t = vertex x 64, -vertex), corner (10, 20, 5),
// material 7, and 2 x 1 tiles: the first wet (0x46), the second dry.
function wmoGroupWithLiquid() {
  const header = Buffer.alloc(0x44);
  header.writeUInt32LE(15, 0x34);
  const mliq = Buffer.alloc(0x1E + 6 * 8 + 2);
  [3, 2, 2, 1].forEach((value, index) => mliq.writeUInt32LE(value, index * 4));
  [10, 20, 5].forEach((value, index) => mliq.writeFloatLE(value, 0x10 + index * 4));
  mliq.writeUInt16LE(7, 0x1C);
  for (let vertex = 0; vertex < 6; vertex += 1) mliq.writeFloatLE(100 + vertex, 0x1E + vertex * 8 + 4);
  mliq.writeUInt8(0x46, 0x1E + 48);
  mliq.writeUInt8(0x0F, 0x1E + 49);
  return { header, mliq, group: () => Buffer.concat([chunk('MVER', Buffer.alloc(4)), chunk('MOGP', Buffer.concat([header, chunk('MLIQ', mliq)]))]) };
}

test('reads a WMO group liquid grid and builds triangles for its wet tiles only', async () => {
  const { readWmoLiquid, liquidSurface, LIQUID_UNIT } = await load('liquids.mjs');
  const { header, mliq, group } = wmoGroupWithLiquid();
  for (let vertex = 0; vertex < 6; vertex += 1) mliq.writeUInt8(10 * (vertex + 1), 0x1E + vertex * 8);
  const liquid = readWmoLiquid(group());
  assert.equal(liquid.groupLiquid, 15);
  assert.equal(liquid.materialId, 7);
  assert.deepEqual([liquid.xVerts, liquid.yVerts, liquid.xTiles, liquid.yTiles], [3, 2, 2, 1]);
  assert.deepEqual([...liquid.heights], [100, 101, 102, 103, 104, 105]);
  assert.deepEqual([...liquid.depths], [10, 20, 30, 40, 50, 60]);
  assert.deepEqual([...liquid.tiles], [0x46, 0x0F]);
  const surface = liquidSurface(liquid);
  // One tile: corners a (0, 0), b (1, 0), c (0, 1), d (1, 1), split along b-c.
  assert.deepEqual([...surface.indices], [0, 2, 1, 2, 1, 3]);
  near(surface.positions[3], 10 + LIQUID_UNIT, 'second vertex x');
  near(surface.positions[5], 101, 'second vertex height');
  near(surface.positions[7], 20 + LIQUID_UNIT, 'third vertex y');
  // Row 1 starts at vertex 3 (rows are three vertices wide).
  assert.deepEqual([...surface.depths], [10, 20, 40, 50]);
  // Water's ripples repeat every 1 / 0.24 yards from the corner.
  near(surface.uvs[2], LIQUID_UNIT * 0.24, 'b u');
  near(surface.uvs[5], LIQUID_UNIT * 0.24, 'c v');
  assert.equal(readWmoLiquid(Buffer.concat([chunk('MVER', Buffer.alloc(4)), chunk('MOGP', header)])), null);
});

test("takes a WMO's magma texture coordinates from its vertices, in 256ths", async () => {
  const { readWmoLiquid, liquidSurface } = await load('liquids.mjs');
  const { mliq, group } = wmoGroupWithLiquid();
  for (let vertex = 0; vertex < 6; vertex += 1) {
    mliq.writeInt16LE(vertex * 64, 0x1E + vertex * 8);
    mliq.writeInt16LE(-vertex, 0x1E + vertex * 8 + 2);
  }
  const liquid = readWmoLiquid(group());
  assert.deepEqual([...liquid.magmaUvs.slice(0, 4)], [0, 0, 64, -1]);
  const surface = liquidSurface(liquid, { magma: true });
  assert.deepEqual([...surface.uvs], [0, 0, 0.25, -1 / 256, 0.75, -3 / 256, 1, -4 / 256]);
});

test('resolves WMO liquid types: DBC ids, old kinds, green lava from its tiles, and interior water', async () => {
  const { drawnWmoLiquidType, isInteriorLiquid, wmoLiquidType } = await load('liquids.mjs');
  const INTERIOR = 0x2000;
  const OCEAN = 0x80000;
  // Slave Pens: the root says groupLiquid is a LiquidType ID (5, slow water).
  assert.equal(wmoLiquidType(5, 0x4, INTERIOR), 13);
  assert.equal(wmoLiquidType(5, 0x4, 0), 13);
  assert.equal(wmoLiquidType(21, 0x4, 0), 21);
  // Old WMOs: the kind in the low two bits, or the tiles' for green lava
  // (Molten Core's tiles say 6, magma).
  assert.equal(wmoLiquidType(15, 0, INTERIOR, 6), 19);
  assert.equal(wmoLiquidType(15, 0, 0, 4), 13);
  assert.equal(wmoLiquidType(3, 0, 0), 20);
  assert.equal(wmoLiquidType(0, 0, OCEAN), 14);
  assert.equal(wmoLiquidType(20, 0, 0), 21);
  // Interior unless the group is exterior (0x8) or outdoor-lit (0x40), or the
  // type is WMO ocean (flag 0x200); the 0x2000 flag plays no part.
  assert.equal(isInteriorLiquid(0), true);
  assert.equal(isInteriorLiquid(INTERIOR | 0x8), false);
  assert.equal(isInteriorLiquid(0x40), false);
  assert.equal(isInteriorLiquid(0, 0x20f), false);
  // Interior water of the first twenty types is drawn as type 17; ocean,
  // magma, slime and later types keep theirs.
  assert.equal(drawnWmoLiquidType(13, true), 17);
  assert.equal(drawnWmoLiquidType(13, false), 13);
  assert.equal(drawnWmoLiquidType(14, true), 14);
  assert.equal(drawnWmoLiquidType(19, true), 19);
  assert.equal(drawnWmoLiquidType(41, true), 41);
});

// LiquidType records as liquidTypeInfo reads them.
function liquidTypeRecord({ flags = 0, kind = 0, material = 1, texture = '', ramp = '', floats = [], ints = [] }) {
  const fields = { 2: flags, 3: kind, 14: material };
  floats.forEach((value, index) => { fields[23 + index] = value; });
  ints.forEach((value, index) => { fields[41 + index] = value; });
  return {
    uint: (field) => fields[field] ?? 0, int: (field) => fields[field] ?? 0, float: (field) => fields[field] ?? 0,
    string: (field) => (field === 15 ? texture : field === 16 ? ramp : ''),
  };
}

test("reads a liquid type's settings: water's ripples, depth table and ramp, magma's scroll", async () => {
  const { liquidTypeInfo } = await load('liquids.mjs');
  const materials = new Map([[1, { uint: () => 0 }], [2, { uint: () => 1 }]]);
  const types = new Map([
    [14, liquidTypeRecord({ flags: 0x20f, kind: 1, ramp: 'proceduralOceanDepthTex', floats: [0.25, 180, 1], ints: [1, 1250] })],
    [13, liquidTypeRecord({ ramp: 'proceduralWmoWaterTex', floats: [1, 0, 1], ints: [1, 0] })],
    [19, liquidTypeRecord({ kind: 2, material: 2, floats: [0, 0.1] })],
  ]);
  const ocean = liquidTypeInfo(types, 14, () => null, materials);
  assert.deepEqual([ocean.material, ocean.vertexFormat, ocean.ramp, ocean.rippleScale, ocean.rippleRotation, ocean.depthTable, ocean.period],
    [1, 0, 'ocean', 0.25, 180, 1, 1250]);
  assert.equal(ocean.flags, 0x20f);
  const wmo = liquidTypeInfo(types, 13, () => null, materials);
  assert.equal(wmo.ramp, 'wmo');
  assert.equal(wmo.period, 1250);
  const magma = liquidTypeInfo(types, 19, () => null, materials);
  assert.equal(magma.vertexFormat, 1);
  near(magma.scroll[1], 0.1, 'v scroll');
  assert.equal(magma.ramp, undefined);
  assert.equal(liquidTypeInfo(types, 99, () => null), null);
});

test("turns ripple uvs by the type's rotation, read as the client does, and scale", async () => {
  const { rippleTransform } = await load('liquids.mjs');
  // WMO Ocean: 180 x 57.29578 radians, about 145 degrees, at a quarter scale.
  const [u, v] = rippleTransform({ rippleScale: 0.25, rippleRotation: 180 })([1, 0]);
  near(Math.hypot(u, v), 0.25, 'scale');
  near(Math.atan2(v, u) * 180 / Math.PI, 145.148, 'angle', 1e-2);
  assert.deepEqual(rippleTransform({ rippleScale: 1, rippleRotation: 0 })([3, 4]), [3, 4]);
  assert.deepEqual(rippleTransform({ scroll: [0.025, 0] })([3, 4]), [3, 4]);
});

test('maps depth bytes to the ramp: river water deep at 42, ocean and WMO water at 255', async () => {
  const { depthCoord, liquidTexCoords } = await load('liquids.mjs');
  assert.deepEqual([0, 21, 42, 255].map((depth) => depthCoord(0, depth)), [0, 0.5, 1, 1]);
  assert.deepEqual([0, 21, 42, 255].map((depth) => depthCoord(1, depth)), [0, 21 / 255, 42 / 255, 1]);
  const surface = { uvs: Float32Array.from([1, 0, 0, 1]), depths: Uint8Array.from([21, 255]) };
  const river = { material: 1, vertexFormat: 0, rippleScale: 2, rippleRotation: 0, depthScale: 8.5, depthTable: 0 };
  const { ripple, ramp } = liquidTexCoords(surface, river);
  assert.deepEqual([...ripple], [2, 0, 0, 2]);
  assert.deepEqual([...ramp], [0, 4.25, 0, 8.5]);
  // Interior WMO water: u 1, its depth read by the group's own type's table.
  const interior = liquidTexCoords(surface, { ...river, depthScale: 1 }, { depthInfo: { ...river, depthTable: 1 }, interior: true });
  assert.deepEqual([...interior.ramp], [1, 21 / 255, 1, 1].map(Math.fround));
  assert.equal(liquidTexCoords(surface, { material: 2, scroll: [0, 0.1] }).ramp, null);
});

// An MCNK at `position` with flat ground at `ground` and an optional MCLQ.
function mcnkWithLiquid({ position, ground, flags = 0, mclq = null }) {
  const header = Buffer.alloc(128);
  header.writeUInt32LE(flags, 0x00);
  position.forEach((value, index) => header.writeFloatLE(value, 0x68 + index * 4));
  const mcvt = Buffer.alloc(145 * 4);
  for (let index = 0; index < 145; index += 1) mcvt.writeFloatLE(ground - position[2], index * 4);
  // Offsets count from the MCNK's own header (8 bytes before its data) to
  // each sub-chunk's header.
  header.writeUInt32LE(128 + 8, 0x14);
  const parts = [header, chunk('MCVT', mcvt)];
  if (mclq) {
    header.writeUInt32LE(128 + 8 + mcvt.length + 8, 0x60);
    header.writeUInt32LE(mclq.length + 8, 0x64);
    parts.push(chunk('MCLQ', mclq));
  }
  return chunk('MCNK', Buffer.concat(parts));
}

test('reads MCLQ chunk liquids as grids running south and east, dropping tiles under the ground', async () => {
  const { adtLiquidSurfaces, LIQUID_UNIT } = await load('liquids.mjs');
  const layer = Buffer.alloc(8 + 81 * 8 + 64 + 4 + 80);
  for (let vertex = 0; vertex < 81; vertex += 1) layer.writeFloatLE(10, 8 + vertex * 8 + 4);
  const tiles = 8 + 81 * 8;
  layer.fill(0x0F, tiles, tiles + 64);
  // Ocean's tiles have kind 1 in their low two bits (1, 5); a river tile
  // (4) in the ocean's layer is not the ocean's.
  layer[tiles] = 0x45;
  layer[tiles + 9] = 0x41;
  layer[tiles + 2] = 0x44;
  for (let vertex = 0; vertex < 81; vertex += 1) layer[8 + vertex * 8] = vertex;
  // Ocean (0x08) at height 10 over ground at 5: two wet tiles, two triangles each.
  const wet = adtLiquidSurfaces(Buffer.concat([chunk('MVER', Buffer.alloc(4)), mcnkWithLiquid({ position: [100, 200, 5], ground: 5, flags: 0x08, mclq: layer })]));
  assert.deepEqual([...wet.keys()], [2]);
  const surface = wet.get(2);
  assert.equal(surface.indices.length, 12);
  assert.deepEqual([...surface.positions.slice(0, 3)], [100, 200, 10]);
  near(surface.positions[4], 200 - LIQUID_UNIT, 'east along -Y');
  // Tile (1, 1) shares a corner with tile (0, 0); its next corner is one
  // row south (-X) and two columns east (-Y).
  assert.equal(surface.positions.length, 7 * 3);
  near(surface.positions[12], 100 - LIQUID_UNIT, 'second tile x');
  near(surface.positions[13], 200 - 2 * LIQUID_UNIT, 'second tile y');
  // Depth bytes by vertex (row 1, column 2 is vertex 11); uvs from the
  // world position, repeating every 1 / 0.06 yards.
  assert.deepEqual([...surface.depths], [0, 1, 9, 10, 11, 19, 20]);
  near(surface.uvs[0], 100 * 0.06, 'u');
  near(surface.uvs[3], (200 - LIQUID_UNIT) * 0.06, 'v');
  // The same sea under ground at 50 is hidden.
  const buried = adtLiquidSurfaces(Buffer.concat([mcnkWithLiquid({ position: [100, 200, 50], ground: 50, flags: 0x08, mclq: layer })]));
  assert.equal(buried.size, 0);
});

test("reads MCLQ magma with its own texture coordinates, Outland's as green lava", async () => {
  const { adtLiquidSurfaces } = await load('liquids.mjs');
  const layer = Buffer.alloc(8 + 81 * 8 + 64 + 4 + 80);
  for (let vertex = 0; vertex < 81; vertex += 1) {
    layer.writeUInt16LE(vertex * 2, 8 + vertex * 8);
    layer.writeUInt16LE(256, 8 + vertex * 8 + 2);
    layer.writeFloatLE(10, 8 + vertex * 8 + 4);
  }
  const tiles = 8 + 81 * 8;
  layer.fill(0x0F, tiles, tiles + 64);
  layer[tiles] = 0x06;
  const adt = Buffer.concat([mcnkWithLiquid({ position: [100, 200, 5], ground: 5, flags: 0x10, mclq: layer })]);
  const magma = adtLiquidSurfaces(adt).get(3);
  assert.deepEqual([...magma.uvs.slice(0, 4)], [0, 3, 2 * 3 / 256, 3]);
  assert.deepEqual([...magma.depths], [0, 0, 0, 0]);
  assert.deepEqual([...adtLiquidSurfaces(adt, { mapId: 530 }).keys()], [15]);
});

test('reads MH2O layers: their part of the chunk, exists mask, and flat depth-only surfaces', async () => {
  const { adtLiquidSurfaces, LIQUID_UNIT } = await load('liquids.mjs');
  const mh2o = Buffer.alloc(256 * 12 + 24 + 1 + 3 * 3 * 4);
  mh2o.writeUInt32LE(256 * 12, 0);
  mh2o.writeUInt32LE(1, 4);
  const layer = 256 * 12;
  mh2o.writeUInt16LE(5, layer);
  mh2o.writeUInt16LE(0, layer + 2);
  mh2o.writeFloatLE(7, layer + 4);
  [3, 1, 2, 2].forEach((value, index) => { mh2o[layer + 12 + index] = value; });
  mh2o.writeUInt32LE(layer + 24, layer + 16);
  mh2o[layer + 24] = 0b1001;
  mh2o.writeUInt32LE(layer + 25, layer + 20);
  for (let vertex = 0; vertex < 9; vertex += 1) mh2o.writeFloatLE(8 + vertex, layer + 25 + vertex * 4);
  const adt = Buffer.concat([chunk('MH2O', mh2o), mcnkWithLiquid({ position: [100, 200, 0], ground: 0 })]);
  const surface = adtLiquidSurfaces(adt).get(5);
  assert.equal(surface.indices.length, 12);
  // First tile: column 3, row 1 of the chunk, height from the first vertex.
  near(surface.positions[0], 100 - LIQUID_UNIT, 'row 1');
  near(surface.positions[1], 200 - 3 * LIQUID_UNIT, 'column 3');
  near(surface.positions[2], 8, 'height');
  // Format 0: the depth bytes follow the heights.
  assert.deepEqual([...surface.depths], [0, 0, 0, 0, 0, 0, 0]);
});

test('reads MH2O depth bytes, depth-only layers at height 0, and stored texture coordinates', async () => {
  const { adtLiquidSurfaces } = await load('liquids.mjs');
  // One 1 x 1 layer (four vertices) of `format`, its data at `data`.
  const read = (format, data) => {
    const layer = 256 * 12;
    const mh2o = Buffer.alloc(layer + 24 + data.length);
    mh2o.writeUInt32LE(layer, 0);
    mh2o.writeUInt32LE(1, 4);
    mh2o.writeUInt16LE(5, layer);
    mh2o.writeUInt16LE(format, layer + 2);
    mh2o.writeFloatLE(7, layer + 4);
    [0, 0, 1, 1].forEach((value, index) => { mh2o[layer + 12 + index] = value; });
    if (data.length) mh2o.writeUInt32LE(layer + 24, layer + 20);
    data.copy(mh2o, layer + 24);
    return adtLiquidSurfaces(Buffer.concat([chunk('MH2O', mh2o), mcnkWithLiquid({ position: [100, 200, -10], ground: -10 })])).get(5);
  };
  const heights = Buffer.alloc(16);
  [8, 9, 10, 11].forEach((value, index) => heights.writeFloatLE(value, index * 4));
  const water = read(0, Buffer.concat([heights, Buffer.from([1, 2, 3, 4])]));
  assert.deepEqual([...water.depths], [1, 2, 3, 4]);
  near(water.positions[2], 8, 'height');
  // Format 2: depth bytes alone, and the surface at height 0; deep
  // everywhere without data.
  const depthOnly = read(2, Buffer.from([5, 6, 7, 8]));
  assert.deepEqual([...depthOnly.depths], [5, 6, 7, 8]);
  assert.ok([...depthOnly.positions].filter((_, index) => index % 3 === 2).every((z) => z === 0));
  assert.deepEqual([...read(2, Buffer.alloc(0)).depths], [255, 255, 255, 255]);
  // Format 1: u16 texture coordinate pairs after the heights, in 256ths of a third.
  const uvs = Buffer.alloc(16);
  [0, 256, 512, 0, 0, 0, 0, 0].forEach((value, index) => uvs.writeUInt16LE(value, index * 2));
  const lava = read(1, Buffer.concat([heights, uvs]));
  assert.deepEqual([...lava.uvs.slice(0, 4)], [0, 3, 6, 0]);
  assert.deepEqual([...lava.depths], [0, 0, 0, 0]);
});

test('takes the box the buildings in the play area fill', async () => {
  const { buildingReach } = await load('export-scene.mjs');
  const group = (x, minZ, maxZ) => ({ minX: x, maxX: x + 10, minY: 0, maxY: 10, minZ, maxZ });
  const groups = [group(0, -5, 20), group(50, 0, 40), group(500, -100, 300)];
  // The far group (a distant tower) is outside the area.
  assert.deepEqual(buildingReach(groups, [{ minX: -10, maxX: 100, minY: -10, maxY: 20 }]),
    { minX: 0, maxX: 60, minY: 0, maxY: 10, minZ: -5, maxZ: 40 });
  assert.deepEqual(buildingReach(groups, []), { minX: 0, maxX: 510, minY: 0, maxY: 10, minZ: -100, maxZ: 300 });
  assert.equal(buildingReach([], []), null);
  assert.equal(buildingReach(groups, [{ minX: 1000, maxX: 1100, minY: 0, maxY: 10 }]), null);
  // Graveyards and start points count, and so do buildings near them (a
  // start platform outside the world map).
  const area = [{ minX: -10, maxX: 100, minY: -10, maxY: 20 }];
  assert.deepEqual(buildingReach(groups, area, [[300, 5, 50]]), { minX: 0, maxX: 300, minY: 0, maxY: 10, minZ: -5, maxZ: 50 });
  assert.deepEqual(buildingReach(groups, area, [[450, 5, 0]]), { minX: 0, maxX: 510, minY: 0, maxY: 10, minZ: -100, maxZ: 300 });
  assert.deepEqual(buildingReach([], [], [[1, 2, 3]]), { minX: 1, maxX: 1, minY: 2, maxY: 2, minZ: 3, maxZ: 3 });
});

test('draws copies of one prop under one parent as a single instanced node', async () => {
  const { DoodadBatches } = await load('export-scene.mjs');
  const { Document } = require('@gltf-transform/core');
  const document = new Document();
  const buffer = document.createBuffer();
  const builder = { document, accessor: (type, array) => document.createAccessor().setType(type).setArray(array).setBuffer(buffer) };
  const root = document.createNode('root');
  const building = document.createNode('building');
  const tree = document.createMesh('tree');
  const rock = document.createMesh('rock');
  const batches = new DoodadBatches(builder);
  batches.add(root, tree, { position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: 1 });
  batches.add(root, tree, { position: [4, 5, 6], rotation: [0, 0, 1, 0], scale: 2 });
  batches.add(root, rock, { position: [7, 8, 9], rotation: [0, 0, 0, 1], scale: 0.5 });
  // The same model under a building is a separate batch.
  batches.add(building, tree, { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: 1 });
  assert.equal(batches.write(), 1);

  const [trees, rocks] = root.listChildren();
  assert.equal(trees.getMesh(), tree);
  const instances = trees.getExtension('EXT_mesh_gpu_instancing');
  assert.deepEqual([...instances.getAttribute('TRANSLATION').getArray()], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...instances.getAttribute('ROTATION').getArray()], [0, 0, 0, 1, 0, 0, 1, 0]);
  assert.deepEqual([...instances.getAttribute('SCALE').getArray()], [1, 1, 1, 2, 2, 2]);
  // A lone copy stays a plain node.
  assert.equal(rocks.getExtension('EXT_mesh_gpu_instancing'), null);
  assert.deepEqual(rocks.getTranslation(), [7, 8, 9]);
  assert.deepEqual(rocks.getScale(), [0.5, 0.5, 0.5]);
  assert.equal(building.listChildren().length, 1);
});

test('crops an icon to its visible pixels', async () => {
  const { cropToVisible } = await load('icons.mjs');
  const width = 4;
  const rgba = new Uint8Array(width * 3 * 4);
  // Two opaque pixels: (1, 0) and (2, 1).
  rgba[(0 * width + 1) * 4 + 3] = 255;
  rgba[(1 * width + 2) * 4 + 3] = 200;
  rgba[(1 * width + 2) * 4] = 9;
  const cropped = cropToVisible({ width, height: 3, rgba });
  assert.equal(cropped.width, 2);
  assert.equal(cropped.height, 2);
  assert.equal(cropped.rgba[3], 255);
  assert.equal(cropped.rgba[(1 * 2 + 1) * 4], 9);
  // Nothing visible keeps the whole image.
  assert.equal(cropToVisible({ width: 2, height: 2, rgba: new Uint8Array(16) }).width, 2);
});
