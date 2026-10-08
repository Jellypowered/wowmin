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

test('reads WDT tiles and only treats MODF as the map object on WMO-only maps', async () => {
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
    chunk('MODF', modfEntry({ uniqueId: 9, position: [17066.666, 10, 17066.666], doodadSet: 2 })),
  ]));
  assert.equal(wmoOnly.wmoOnly, true);
  assert.equal(wmoOnly.wmo.name, 'World\\wmo\\Dungeon\\Test.wmo');
  assert.equal(wmoOnly.wmo.doodadSet, 2);
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
  header.writeUInt32LE(24550, 0x38);
  const refs = Buffer.alloc(4);
  refs.writeUInt16LE(3, 0);
  refs.writeUInt16LE(9, 2);
  const group = Buffer.concat([chunk('MVER', Buffer.alloc(4)), chunk('MOGP', Buffer.concat([header, chunk('MODR', refs)]))]);
  assert.deepEqual(readGroupHeader(group), {
    flags: 0x2805,
    boundingBox: [-1, -2, -3, 4, 5, 6],
    transBatchCount: 3,
    groupId: 24550,
    doodadRefs: [3, 9],
  });
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

test('fixes WMO vertex colours after the last transparent batch, even when every batch is transparent', async () => {
  const { fixVertexColors } = await load('wmo.mjs');
  const bgra = Uint8Array.from([100, 100, 100, 64, 100, 100, 100, 64]);
  const batches = [{ lastVertex: 0 }, { lastVertex: 1 }];
  // Vertex 0 belongs to the transparent batch and is left alone; vertex 1 is fixed.
  assert.deepEqual([...fixVertexColors(bgra, batches, 1)], [100, 100, 100, 64, 100, 100, 100, 255]);
  // No transparent batches: everything is fixed. (100 + 100 * 64 / 64) / 2 = 100.
  assert.deepEqual([...fixVertexColors(Uint8Array.from([200, 0, 50, 0]), batches, 0)], [100, 0, 25, 255]);
  // All batches transparent: nothing to fix, and no out-of-range read.
  assert.deepEqual([...fixVertexColors(bgra, batches, 2)], [...bgra]);
  assert.deepEqual([...bgra], [100, 100, 100, 64, 100, 100, 100, 64], 'input is not mutated');
});
