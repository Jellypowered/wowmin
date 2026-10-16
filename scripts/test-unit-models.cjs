const assert = require('node:assert/strict');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

// Unit models: the M2 skeleton and animation converter, character dressing,
// the appearance stream, and how the renderer picks models and animations.
// None of these use Blizzard files; inputs are built by hand.

const load = (file) => import(pathToFileURL(path.join(__dirname, 'scene', file)).href);
const near = (actual, expected, label, tolerance = 1e-4) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${label}: ${actual} != ${expected}`);

function loadModule(relativePath) {
  const output = esbuild.buildSync({
    entryPoints: [path.join(__dirname, relativePath)],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
  }).outputFiles[0].text;
  const context = { module: { exports: {} }, require, Buffer };
  context.exports = context.module.exports;
  vm.runInNewContext(output, context);
  return context.module.exports;
}

const animation = loadModule('../renderer/scripts/utils/unit-animation.ts');
const live = loadModule('../renderer/scripts/utils/live-positions.ts');
const { parseAppearanceDatagram } = loadModule('../src/telemetry-stream.ts');
const { parseUnitModelPath } = loadModule('../src/unit-models.ts');

const NO_WEAPONS = { mainHandType: 0, mainHandSubclass: 0, offHandType: 0, rangedSubclass: 0 };

function track(sequenceTimes, sequenceKeys, { trackType = 1, loopIndex = 0xFFFF } = {}) {
  return { trackType, loopIndex, sequenceTimes, sequenceKeys };
}
const emptyTrack = () => track([], []);

// M2 vertices: position, 4 weights, 4 bone indices, normal, two UV sets.
function m2Vertices(vertices) {
  const buffer = new ArrayBuffer(vertices.length * 48);
  const view = new DataView(buffer);
  vertices.forEach(({ position, weights, bones, uv = [0, 0] }, index) => {
    const base = index * 48;
    position.forEach((value, axis) => view.setFloat32(base + axis * 4, value, true));
    weights.forEach((value, influence) => view.setUint8(base + 12 + influence, value));
    bones.forEach((value, influence) => view.setUint8(base + 16 + influence, value));
    view.setFloat32(base + 28, 1, true);
    view.setFloat32(base + 32, uv[0], true);
    view.setFloat32(base + 36, uv[1], true);
  });
  return buffer;
}

test('decompresses M2 rotations (identity is 32767, 32767, 32767, -1)', async () => {
  const { decompressQuaternions } = await load('m2-skinned.mjs');
  const [x, y, z, w] = decompressQuaternions(Int16Array.of(32767, 32767, 32767, -1));
  near(x, 0, 'x'); near(y, 0, 'y'); near(z, 0, 'z'); near(w, 1, 'w');
});

test('expands skinned vertices with weights normalised to one', async () => {
  const { expandSkinnedVertices } = await load('m2-skinned.mjs');
  const vertices = m2Vertices([
    { position: [1, 2, 3], weights: [200, 55, 0, 0], bones: [3, 7, 9, 9] },
    { position: [4, 5, 6], weights: [0, 0, 0, 0], bones: [5, 0, 0, 0] },
  ]);
  const expanded = expandSkinnedVertices(vertices, Uint16Array.of(1, 0));
  assert.deepEqual([...expanded.positions], [4, 5, 6, 1, 2, 3]);
  // No weights at all: bound fully to the first influence.
  assert.deepEqual([...expanded.weights.slice(0, 4)], [1, 0, 0, 0]);
  near(expanded.weights[4], 200 / 255, 'weight 0');
  near(expanded.weights[5], 55 / 255, 'weight 1');
  // Unweighted influences point at bone 0, not stray indices.
  assert.deepEqual([...expanded.joints.slice(4, 8)], [3, 7, 0, 0]);
});

test('selects the first variation of each wanted animation, skipping ones stored in .anim files', async () => {
  const { selectSequences } = await load('m2-skinned.mjs');
  const sequences = [
    { id: 0, variationIndex: 0, flags: 0x20, duration: 2000, moveSpeed: 0 },
    { id: 0, variationIndex: 1, flags: 0x20, duration: 1000, moveSpeed: 0 },
    { id: 5, variationIndex: 0, flags: 0x20, duration: 667, moveSpeed: 7 },
    { id: 4, variationIndex: 0, flags: 0, duration: 1000, moveSpeed: 2.5 },
  ];
  const selected = selectSequences(sequences, { Stand: 0, Walk: 4, Run: 5, Death: 1 });
  assert.deepEqual(selected.map(({ name, index, moveSpeed }) => [name, index, moveSpeed]), [['Stand', 0, 0], ['Run', 2, 7]]);
});

test('offsets bone translation keys by the pivot and holds global-sequence tracks at their first key', async () => {
  const { boneChannels } = await load('m2-skinned.mjs');
  const bone = {
    pivot: Float32Array.of(1, 2, 3),
    translationTrack: track([Uint32Array.of(), Uint32Array.of(0, 100)], [Float32Array.of(), Float32Array.of(0, 0, 0, 0.5, 0, 0)]),
    rotationTrack: track([Uint32Array.of(0, 50)], [Int16Array.of(32767, 32767, 32767, -1, 32767, 32767, 32767, -1)], { loopIndex: 0 }),
    scaleTrack: emptyTrack(),
  };
  const channels = boneChannels(bone, Float32Array.of(1, 0, 0), 1);
  assert.deepEqual([...channels.translation.values], [0, 2, 3, 0.5, 2, 3]);
  assert.equal(channels.rotation.step, true);
  assert.deepEqual([...channels.rotation.times], [0]);
  assert.equal(channels.scale, undefined);
  // Sequence 0 has no translation keys; the global rotation still applies.
  const first = boneChannels(bone, null, 0);
  assert.equal(first.translation, undefined);
  assert.ok(first.rotation);
});

test('converts key times to seconds and drops repeated times', async () => {
  const { keyframeTimes } = await load('unit-model.mjs');
  const { input, output } = keyframeTimes(Uint32Array.of(0, 500, 500, 1000), Float32Array.of(1, 2, 3, 4), 1);
  assert.deepEqual([...input], [0, 0.5, 1]);
  assert.deepEqual([...output], [1, 2, 4]);
});

test('builds a skinned GLB document: joints at pivots, every animated channel in every clip, items on bones', async () => {
  const { buildUnitDocument } = await load('unit-model.mjs');
  const model = {
    positions: Float32Array.of(0, 0, 0, 0, 0, 1, 0, 1, 0),
    normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1),
    uvs: new Float32Array(6),
    joints: new Uint16Array(12),
    weights: Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0),
    indices: Uint16Array.of(0, 1, 2),
    bones: [{ parentIndex: -1, pivot: [0, 0, 0] }, { parentIndex: 0, pivot: [0, 0, 1.5] }],
    textures: [],
    batches: [{ textureIndex: -1, indexStart: 0, indexCount: 3, blend: 0, materialFlags: 0, tint: [1, 1, 1], opacity: 1 }],
    clips: [
      { name: 'Stand', duration: 1000, moveSpeed: 0, bones: [{}, { rotation: { times: Uint32Array.of(0, 500), values: Float32Array.of(0, 0, 0, 1, 0, 0, 0.7071, 0.7071) } }] },
      { name: 'Run', duration: 600, moveSpeed: 7, bones: [{ translation: { times: Uint32Array.of(0), values: Float32Array.of(0, 0, 0.1) } }, {}] },
    ],
  };
  const sword = {
    positions: new Float32Array(9), normals: new Float32Array(9), uvs: new Float32Array(6), indices: Uint16Array.of(0, 1, 2),
    batches: [{ indexStart: 0, indexCount: 3, blend: 0, materialFlags: 0, tint: [1, 1, 1], opacity: 1, textureType: 0, texture: null, textureFlags: 0 }],
  };
  const document = buildUnitDocument(model, {
    name: 'test',
    textureFor: () => null,
    scale: 1.5,
    attachments: [{
      bone: 1, position: [0.2, 0, 1.5], mesh: sword, textureFor: () => null, role: 'mainHand', sheath: 'drawn',
      trail: { bottom: [0, 0, 0.1], top: [0, 0, 1.2] },
    }],
    points: [{ attachment: 22, bone: 1, position: [0.1, -0.4, 1.2] }, { attachment: 18, bone: 9, position: [0, 0, 2] }],
  });
  const root = document.getRoot();
  const skin = root.listSkins()[0];
  assert.equal(skin.listJoints().length, 2);
  assert.deepEqual(skin.listJoints()[1].getTranslation(), [0, 0, 1.5]);
  assert.deepEqual([...skin.getInverseBindMatrices().getArray().slice(16 + 12, 16 + 15)], [-0, -0, -1.5]);
  const animations = Object.fromEntries(root.listAnimations().map((clip) => [clip.getName(),
    clip.listChannels().map((channel) => `${channel.getTargetNode().getName()}.${channel.getTargetPath()}`).sort()]));
  // Both clips set bone0 translation and bone1 rotation, so switching never strands a bone.
  assert.deepEqual(animations.Stand, ['bone0.translation', 'bone1.rotation']);
  assert.deepEqual(animations.Run, ['bone0.translation', 'bone1.rotation']);
  const modelRoot = root.listScenes()[0].listChildren()[0];
  assert.deepEqual(modelRoot.getScale(), [1.5, 1.5, 1.5]);
  assert.deepEqual(modelRoot.getExtras().wowClipDurations, { Stand: 1, Run: 0.6 });
  assert.deepEqual(modelRoot.getExtras().wowClipSpeeds, { Run: 7 });
  const item = skin.listJoints()[1].listChildren()[0];
  assert.deepEqual(item.getTranslation(), [0.2, 0, 0]);
  assert.deepEqual(item.getExtras(), { wowItem: 'mainHand', wowSheath: 'drawn' });
  // A drawn weapon carries its blade's bottom and top for swing trails.
  assert.deepEqual(item.listChildren().map((child) => [child.getExtras().wowTrail, child.getTranslation()]),
    [['bottom', [0, 0, 0.1]], ['top', [0, 0, 1.2]]]);
  // Effect points ride on their bone too; one on a missing bone is skipped.
  const hand = skin.listJoints()[1].listChildren()[1];
  assert.deepEqual(hand.getExtras(), { wowAttachment: 22 });
  [0.1, -0.4, -0.3].forEach((value, axis) => near(hand.getTranslation()[axis], value, `hand ${axis}`));
  assert.equal(root.listNodes().filter((node) => node.getExtras().wowAttachment !== undefined).length, 1);
});

test('keeps every attachment and release event as an effect point, the first of each', async () => {
  const { effectPoints } = await load('unit-model.mjs');
  const point = (id, bone) => ({ id, bone, position: [id, 0, 0] });
  assert.deepEqual(effectPoints([point(1, 10), point(22, 12), point(22, 13)], [
    { name: '$CSL', bone: 4, position: [0, 1, 0] }, { name: '$CSL', bone: 5, position: [0, 2, 0] },
  ]), [
    { attachment: 1, bone: 10, position: [1, 0, 0] },
    { attachment: 22, bone: 12, position: [22, 0, 0] },
    { event: '$CSL', bone: 4, position: [0, 1, 0] },
  ]);
  // Spiders and the like have no attachment points at all.
  assert.deepEqual(effectPoints([]), []);
});

test('reads WDBC records, strings, and records by ID', async () => {
  const { readDbc } = await load('dbc.mjs');
  const strings = Buffer.from('\0Human\0Orc\0', 'latin1');
  const header = Buffer.alloc(20);
  header.write('WDBC', 0, 'latin1');
  header.writeUInt32LE(2, 4); header.writeUInt32LE(2, 8); header.writeUInt32LE(8, 12); header.writeUInt32LE(strings.length, 16);
  const records = Buffer.alloc(16);
  records.writeUInt32LE(1, 0); records.writeUInt32LE(1, 4);
  records.writeUInt32LE(2, 8); records.writeUInt32LE(7, 12);
  const dbc = readDbc(Buffer.concat([header, records, strings]));
  assert.equal(dbc.recordCount, 2);
  assert.equal(dbc.byId().get(2).string(1), 'Orc');
  assert.equal(dbc.record(0).string(1), 'Human');
  assert.throws(() => readDbc(Buffer.from('nope')), /WDBC/);
});

test('reads M2 attachment points from the header', async () => {
  const { readM2Attachments } = await load('character.mjs');
  const buffer = Buffer.alloc(400);
  buffer.writeUInt32LE(2, 240);
  buffer.writeUInt32LE(300, 244);
  buffer.writeUInt32LE(1, 300); buffer.writeUInt16LE(42, 304); buffer.writeFloatLE(0.5, 308);
  buffer.writeUInt32LE(11, 340); buffer.writeUInt16LE(7, 344); buffer.writeFloatLE(2, 356);
  assert.deepEqual(readM2Attachments(buffer), [
    { id: 1, bone: 42, position: [0.5, 0, 0] },
    { id: 11, bone: 7, position: [0, 0, 2] },
  ]);
  // A count that runs past the file reads as none.
  buffer.writeUInt32LE(50, 240);
  assert.deepEqual(readM2Attachments(buffer), []);
});

test('reads the M2 events asked for from the header', async () => {
  const { readM2Events } = await load('character.mjs');
  const buffer = Buffer.alloc(400);
  buffer.writeUInt32LE(2, 256);
  buffer.writeUInt32LE(300, 260);
  buffer.write('$CSR', 300, 'latin1'); buffer.writeUInt16LE(9, 308); buffer.writeFloatLE(1.5, 316);
  buffer.write('$FSD', 336, 'latin1'); buffer.writeUInt16LE(3, 344);
  assert.deepEqual(readM2Events(buffer, ['$CSR', '$CSL']), [{ name: '$CSR', bone: 9, position: [0, 1.5, 0] }]);
  buffer.writeUInt32LE(50, 256);
  assert.deepEqual(readM2Events(buffer, ['$CSR']), []);
});

test('chooses character geosets: body, hair by ID, groups by value, and gear overrides', async () => {
  const { applyItemGeosets, defaultGeosets, geosetVisible, SLOT } = await load('character.mjs');
  const geosets = defaultGeosets();
  geosets.hair = 4;
  assert.ok(geosetVisible(geosets, 0));
  assert.ok(geosetVisible(geosets, 4));
  assert.ok(!geosetVisible(geosets, 3));
  assert.ok(geosetVisible(geosets, 401));
  assert.ok(geosetVisible(geosets, 702), 'ears');
  assert.ok(!geosetVisible(geosets, 701));
  const item = (geosetGroups) => ({ geosetGroups });
  applyItemGeosets(geosets, {
    [SLOT.chest]: item([1, 0, 2]),
    [SLOT.hands]: item([2, 0, 0]),
    [SLOT.feet]: item([1, 0, 0]),
    [SLOT.back]: item([3, 0, 0]),
  });
  assert.equal(geosets.groups[4], 3, 'gloves');
  assert.equal(geosets.groups[8], 1, 'cuffed gloves hide sleeves');
  assert.equal(geosets.groups[13], 3, 'robe');
  assert.equal(geosets.groups[5], 1, 'a robe hides boots');
  assert.equal(geosets.groups[15], 4, 'cape');
});

test('reads what a helmet hides from per-race bitmasks', async () => {
  const { helmetHides } = await load('character.mjs');
  // Hair hidden for every race but tauren (6); ears for humans (1) only.
  const vis = [-65 >>> 0, 0, 0, 0, 1 << 1];
  assert.deepEqual([...helmetHides(vis, 1)], ['hair', 'ears']);
  assert.deepEqual([...helmetHides(vis, 6)], []);
  assert.deepEqual([...helmetHides(null, 1)], []);
});

test('paints a texture region with bilinear scaling and alpha blending', async () => {
  const { drawImage } = await load('textures.mjs');
  const target = { width: 4, height: 2, rgba: new Uint8Array(4 * 2 * 4).fill(10) };
  const source = { width: 1, height: 1, rgba: Uint8Array.of(200, 100, 50, 255) };
  drawImage(target, source, 2, 0, 2, 2);
  assert.deepEqual([...target.rgba.slice(8, 12)], [200, 100, 50, 255]);
  assert.deepEqual([...target.rgba.slice(0, 4)], [10, 10, 10, 10], 'outside the region is untouched');
  const clear = { width: 1, height: 1, rgba: Uint8Array.of(255, 255, 255, 0) };
  drawImage(target, clear, 0, 0, 2, 2);
  assert.deepEqual([...target.rgba.slice(0, 4)], [10, 10, 10, 10], 'transparent pixels leave the base');
});

test('round-trips a character look through its cache key, and rejects malformed keys', async () => {
  const { characterKey, parseCharacterKey } = await load('unit-model.mjs');
  const look = {
    race: 4, gender: 1, skin: 3, face: 1, hairStyle: 2, hairColor: 4, facialStyle: 0, helmHidden: true, cloakHidden: false,
    items: { 4: 40463, 6: 1184, 17: 2461 },
  };
  const key = characterKey(look);
  assert.equal(key, '4-1-3-1-2-4-0-1-0.0.0.40463.0.1184.0.0.0.0.0.0.2461.0');
  assert.deepEqual(parseCharacterKey(key), look);
  assert.throws(() => parseCharacterKey('4-1-3'), /Malformed/);
  assert.throws(() => parseCharacterKey(key.replace('40463', 'x')), /Malformed/);
});

test('builds the same character key in the renderer as the converter, hiding a hidden helm', async () => {
  const { characterKey } = await load('unit-model.mjs');
  const items = new Array(19).fill(0);
  Object.assign(items, { 0: 1128, 4: 9674, 14: 13963, 15: 2806, 16: 32558 });
  const appearance = {
    guid: 1, creature: false, helmHidden: true, cloakHidden: false, race: 1, gender: 0, classId: 1, skin: 2, face: 1,
    hairStyle: 3, hairColor: 2, facialStyle: 2, sheathState: 1, scale: 1, displayId: 49, nativeDisplayId: 49,
    mountDisplayId: 0, items, mainHandType: 13, mainHandSubclass: 7, offHandType: 14, rangedSubclass: 0,
  };
  const url = live.getUnitModelUrl(appearance);
  const expected = characterKey({
    race: 1, gender: 0, skin: 2, face: 1, hairStyle: 3, hairColor: 2, facialStyle: 2, helmHidden: true,
    items: { 4: 9674, 14: 13963, 15: 2806, 16: 32558 },
  });
  assert.equal(url, `assets/models/character/${expected}.glb`);
  // Shapeshifted (a druid form): the form's creature display, without weapons.
  assert.equal(live.getUnitModelUrl({ ...appearance, displayId: 892 }), 'assets/models/creature/892.glb');
  // Creatures carry their weapons in the key.
  const creatureItems = new Array(19).fill(0);
  creatureItems[15] = 2806;
  assert.equal(live.getUnitModelUrl({ ...appearance, creature: true, displayId: 23561, items: creatureItems }),
    'assets/models/creature/23561-2806.0.0.glb');
  assert.equal(live.getUnitModelUrl({ ...appearance, creature: true, displayId: 23561, items: new Array(19).fill(0) }),
    'assets/models/creature/23561.glb');
  assert.equal(live.getUnitModelUrl(null), null);
  // A rider's mount, only while mounted.
  assert.equal(live.getMountModelUrl({ ...appearance, mountDisplayId: 2410 }, true), 'assets/models/creature/2410.glb');
  assert.equal(live.getMountModelUrl({ ...appearance, mountDisplayId: 2410 }, false), null);
  assert.equal(live.getMountModelUrl({ ...appearance, mountDisplayId: 0 }, true), null);
});

test('parses model URLs into build requests, rejecting anything else', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(parseUnitModelPath('/assets/models/creature/23561.glb'))),
    { kind: 'creature', key: '23561', params: { displayId: 23561, weapons: {} } });
  assert.deepEqual(JSON.parse(JSON.stringify(parseUnitModelPath('/assets/models/creature/23561-2806.0.5.glb').params.weapons)),
    { 15: 2806, 16: 0, 17: 5 });
  assert.equal(parseUnitModelPath('/assets/models/character/1-0-2-1-3-2-2-0-0.0.0.0.0.0.0.0.0.0.0.0.0.0.glb').kind, 'character');
  assert.deepEqual(JSON.parse(JSON.stringify(parseUnitModelPath('/assets/models/effect/4807.glb'))),
    { kind: 'effect', key: '4807', params: { effectId: 4807 } });
  assert.deepEqual(JSON.parse(JSON.stringify(parseUnitModelPath('/assets/models/visual/116.json'))),
    { kind: 'visual', key: '116', params: { spellId: 116 } });
  assert.equal(parseUnitModelPath('/assets/models/visual/116.glb'), null);
  assert.deepEqual(JSON.parse(JSON.stringify(parseUnitModelPath('/assets/models/spell/116.json'))),
    { kind: 'spell', key: '116', params: { spellId: 116 } });
  assert.equal(parseUnitModelPath('/assets/models/spell/116.glb'), null);
  assert.deepEqual(JSON.parse(JSON.stringify(parseUnitModelPath('/assets/models/icon/spell-116.png'))),
    { kind: 'icon', key: 'spell-116', params: { spellId: 116 } });
  assert.deepEqual(JSON.parse(JSON.stringify(parseUnitModelPath('/assets/models/icon/faction-horde.png'))),
    { kind: 'icon', key: 'faction-horde', params: { faction: 'horde' } });
  assert.equal(parseUnitModelPath('/assets/models/icon/faction-scourge.png'), null);
  assert.deepEqual(JSON.parse(JSON.stringify(parseUnitModelPath('/assets/models/icon/marker-8.png'))),
    { kind: 'icon', key: 'marker-8', params: { marker: 8 } });
  assert.equal(parseUnitModelPath('/assets/models/icon/marker-9.png'), null);
  assert.deepEqual(JSON.parse(JSON.stringify(parseUnitModelPath('/assets/models/icon/chain-736.png'))),
    { kind: 'icon', key: 'chain-736', params: { chain: 736 } });
  assert.deepEqual(JSON.parse(JSON.stringify(parseUnitModelPath('/assets/models/light/489.json'))),
    { kind: 'light', key: '489', params: { mapId: 489 } });
  assert.deepEqual(JSON.parse(JSON.stringify(parseUnitModelPath('/assets/models/gameobject/6251.glb'))),
    { kind: 'gameobject', key: '6251', params: { displayId: 6251 } });
  assert.equal(parseUnitModelPath('/assets/models/icon/../x.png'), null);
  assert.equal(parseUnitModelPath('/assets/models/creature/../../.env.glb'), null);
  assert.equal(parseUnitModelPath('/assets/models/character/../x.glb'), null);
  assert.equal(parseUnitModelPath('/assets/models/other/1.glb'), null);
});

// Builds an appearance datagram exactly as BuildAppearanceDatagrams in WowMinTelemetry.cpp does.
function appearanceDatagram(units) {
  const header = Buffer.alloc(24);
  header.write('WMA1', 0, 'latin1');
  header.writeUInt8(1, 4);
  header.writeUInt32LE(601, 8); header.writeUInt32LE(7, 12); header.writeUInt32LE(5000, 16);
  header.writeUInt16LE(units.length, 20);
  return Buffer.concat([header, ...units.map((unit) => {
    const entry = Buffer.alloc(108);
    entry.writeUInt32LE(unit.guid, 0);
    entry.writeUInt8(unit.flags, 4);
    [unit.race, unit.gender, unit.classId, ...unit.look, unit.sheath].forEach((value, index) => entry.writeUInt8(value, 5 + index));
    entry.writeUInt16LE(unit.scale, 14);
    entry.writeUInt32LE(unit.display, 16); entry.writeUInt32LE(unit.native, 20); entry.writeUInt32LE(unit.mount, 24);
    Object.entries(unit.items).forEach(([slot, display]) => entry.writeUInt32LE(display, 28 + Number(slot) * 4));
    [unit.mainHandType, unit.mainHandSubclass, unit.offHandType, unit.rangedSubclass].forEach((value, index) => entry.writeUInt8(value, 104 + index));
    return entry;
  })]);
}

test('parses an appearance datagram', () => {
  const buffer = appearanceDatagram([
    { guid: 9, flags: 2, race: 4, gender: 1, classId: 11, look: [3, 1, 2, 4, 0], sheath: 1, scale: 1000, display: 892, native: 55,
      mount: 0, items: { 4: 40463, 15: 2806 }, mainHandType: 13, mainHandSubclass: 7, offHandType: 0, rangedSubclass: 0 },
    { guid: 101, flags: 1, race: 0, gender: 0, classId: 1, look: [0, 0, 0, 0, 0], sheath: 0, scale: 1800, display: 23561,
      native: 23561, mount: 0, items: {}, mainHandType: 0, mainHandSubclass: 0, offHandType: 0, rangedSubclass: 0 },
  ]);
  const update = parseAppearanceDatagram(buffer);
  assert.equal(update.units.length, 2);
  const [druid, boss] = update.units;
  assert.equal(druid.creature, false);
  assert.equal(druid.helmHidden, true);
  assert.equal(druid.cloakHidden, false);
  assert.deepEqual([druid.race, druid.gender, druid.classId, druid.skin, druid.face, druid.hairStyle, druid.hairColor, druid.facialStyle],
    [4, 1, 11, 3, 1, 2, 4, 0]);
  assert.equal(druid.sheathState, 1);
  assert.equal(druid.displayId, 892);
  assert.equal(druid.nativeDisplayId, 55);
  assert.equal(druid.items[4], 40463);
  assert.equal(druid.items[15], 2806);
  assert.equal(druid.items.length, 19);
  assert.equal(druid.mainHandType, 13);
  assert.equal(boss.creature, true);
  assert.equal(boss.scale, 1.8);
  assert.equal(parseAppearanceDatagram(buffer.subarray(0, buffer.length - 1)), null, 'truncated');
});

test('keeps appearances per unit kind and drops ones not re-sent', () => {
  const store = new live.LiveAppearanceStore();
  const unit = (guid, creature) => ({ guid, creature, displayId: guid });
  store.push({ mapId: 601, instanceId: 7, serverTimeMs: 0, units: [unit(5, false), unit(5, true)] }, 1000);
  assert.equal(store.get(false, 5, 2000).creature, false);
  assert.equal(store.get(true, 5, 2000).creature, true);
  assert.equal(store.get(true, 5, 1000 + live.LIVE_APPEARANCE_STALE_MS + 1), null);
  assert.equal(store.size, 1);
});

test('chooses a stance: dead, then moving, then fighting by style', () => {
  const { chooseUnitStance } = animation;
  assert.equal(chooseUnitStance({ alive: false, speed: 7, inCombat: true, style: 'melee' }), 'dead');
  assert.equal(chooseUnitStance({ alive: true, speed: 7, inCombat: true, style: 'melee' }), 'run');
  assert.equal(chooseUnitStance({ alive: true, speed: 2.5, inCombat: false, style: null }), 'walk');
  assert.equal(chooseUnitStance({ alive: true, speed: 0.1, inCombat: true, style: 'cast' }), 'cast');
  assert.equal(chooseUnitStance({ alive: true, speed: 0, inCombat: false, style: 'melee' }), 'stand');
});

test('works out how a player fights from class, gear, form, and bot strategies', () => {
  const { getPlayerCombatStyle } = animation;
  assert.equal(getPlayerCombatStyle(1, NO_WEAPONS), 'melee');
  assert.equal(getPlayerCombatStyle(8, NO_WEAPONS), 'cast');
  assert.equal(getPlayerCombatStyle(3, { ...NO_WEAPONS, rangedSubclass: 2 }), 'ranged');
  assert.equal(getPlayerCombatStyle(3, NO_WEAPONS), 'melee');
  assert.equal(getPlayerCombatStyle(7, { ...NO_WEAPONS, mainHandType: 13, offHandType: 13 }), 'melee', 'dual-wield shaman');
  assert.equal(getPlayerCombatStyle(7, NO_WEAPONS), 'cast');
  assert.equal(getPlayerCombatStyle(11, NO_WEAPONS, { shapeshifted: true }), 'melee', 'cat or bear');
  assert.equal(getPlayerCombatStyle(11, NO_WEAPONS), 'cast');
  assert.equal(getPlayerCombatStyle(2, NO_WEAPONS, { strategies: ['heal', 'buff'] }), 'cast', 'healing paladin bot');
  assert.equal(getPlayerCombatStyle(11, NO_WEAPONS, { strategies: ['tank', 'bear'] }), 'melee');
});

test('a creature strikes in reach and casts beyond it when it can', () => {
  const { getCreatureCombatStyle } = animation;
  assert.equal(getCreatureCombatStyle(3, true), 'melee');
  assert.equal(getCreatureCombatStyle(null, true), 'melee');
  assert.equal(getCreatureCombatStyle(20, true), 'cast');
  assert.equal(getCreatureCombatStyle(20, false), 'melee');
});

test('picks clips by weapon, falling back to what the model has', () => {
  // Plain copies, as the module runs in its own realm.
  const getStanceClips = (...args) => JSON.parse(JSON.stringify(animation.getStanceClips(...args)));
  const all = new Set(['Stand', 'Death', 'Walk', 'Run', 'AttackUnarmed', 'Attack1H', 'Attack2H', 'Attack2HL', 'ReadyUnarmed',
    'Ready1H', 'Ready2H', 'Ready2HL', 'ReadyBow', 'AttackBow', 'ReadyRifle', 'AttackRifle', 'ReadySpellDirected', 'SpellCastDirected']);
  const polearm = { ...NO_WEAPONS, mainHandType: 17, mainHandSubclass: 6 };
  assert.deepEqual(getStanceClips('melee', polearm, all), { loop: 'Ready2HL', strike: 'Attack2HL' });
  assert.deepEqual(getStanceClips('melee', { ...NO_WEAPONS, mainHandType: 13 }, all), { loop: 'Ready1H', strike: 'Attack1H' });
  assert.deepEqual(getStanceClips('melee', NO_WEAPONS, all), { loop: 'ReadyUnarmed', strike: 'AttackUnarmed' });
  assert.deepEqual(getStanceClips('ranged', { ...NO_WEAPONS, rangedSubclass: 3 }, all), { loop: 'ReadyRifle', strike: 'AttackRifle' });
  assert.deepEqual(getStanceClips('cast', NO_WEAPONS, all), { loop: 'ReadySpellDirected', strike: 'SpellCastDirected' });
  assert.deepEqual(getStanceClips('dead', NO_WEAPONS, all), { loop: 'Death', strike: null, holdLastFrame: true });
  // A spider: no weapons, no casting, no Death clip.
  const spider = new Set(['Stand', 'Walk', 'AttackUnarmed', 'Dead']);
  assert.deepEqual(getStanceClips('melee', polearm, spider), { loop: 'Stand', strike: 'AttackUnarmed' });
  assert.deepEqual(getStanceClips('cast', NO_WEAPONS, spider), { loop: 'Stand', strike: 'AttackUnarmed' });
  assert.deepEqual(getStanceClips('run', NO_WEAPONS, spider), { loop: 'Walk', strike: null });
  assert.deepEqual(getStanceClips('dead', NO_WEAPONS, spider), { loop: 'Dead', strike: null });
});

test('paces strikes and movement clips', () => {
  const { getMoveTimeScale, getStrikeInterval } = animation;
  near(getStrikeInterval('melee', 0), 1.6, 'melee fastest');
  near(getStrikeInterval('cast', 1), 3.2, 'cast slowest');
  near(getStrikeInterval('melee', 5), 2.2, 'jitter clamps');
  near(getMoveTimeScale(7, 7), 1, 'matched');
  near(getMoveTimeScale(28, 7), 2, 'capped');
  near(getMoveTimeScale(2, undefined), 1, 'unknown clip speed');
});

test('shows weapons in hand or sheathed by sheath state', () => {
  const { isItemShown } = animation;
  assert.equal(isItemShown('mainHand', 'drawn', 1), true);
  assert.equal(isItemShown('mainHand', 'sheathed', 1), false);
  assert.equal(isItemShown('mainHand', 'sheathed', 0), true);
  assert.equal(isItemShown('mainHand', 'sheathed', 2), true, 'bow out, sword away');
  assert.equal(isItemShown('ranged', 'drawn', 2), true);
  assert.equal(isItemShown('ranged', 'drawn', 1), false);
});

test('keeps spell art in its own versioned folder and clears only stale cache folders', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { UnitModels, UNIT_MODEL_CACHE_VERSION, SPELL_ART_CACHE_VERSION } = loadModule('../src/unit-models.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wowmin-models-'));
  const unit = `v${UNIT_MODEL_CACHE_VERSION}`;
  const art = `art-v${SPELL_ART_CACHE_VERSION}`;
  for (const folder of ['creature', `v${UNIT_MODEL_CACHE_VERSION - 1}`, `${unit}/character`, `${unit}/visual`, `${unit}/effect`,
    `art-v${SPELL_ART_CACHE_VERSION - 1}`, `${art}/visual`, 'unrelated']) {
    fs.mkdirSync(path.join(root, folder), { recursive: true });
  }
  const models = new UnitModels(root, '/nonexistent-worker.mjs');
  const left = (folder) => fs.existsSync(path.join(root, folder));
  assert.deepEqual(['creature', `v${UNIT_MODEL_CACHE_VERSION - 1}`, `${unit}/visual`, `${unit}/effect`, `art-v${SPELL_ART_CACHE_VERSION - 1}`].filter(left), []);
  assert.ok(left(`${unit}/character`) && left(`${art}/visual`) && left('unrelated'));
  assert.equal(models.pathFor({ kind: 'visual', key: '10', params: {} }), path.join(root, art, 'visual', '10.json'));
  assert.equal(models.pathFor({ kind: 'effect', key: '398', params: {} }), path.join(root, art, 'effect', '398.glb'));
  assert.equal(models.pathFor({ kind: 'creature', key: '892', params: {} }), path.join(root, unit, 'creature', '892.glb'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('reads when a sequence first releases a spell, from the model or its .anim file', async () => {
  const { releaseTimeMs } = await load('m2-skinned.mjs');
  // Two events at 300 and 336: a footstep, and $CSR. Its track's times for
  // sequence 1 are at 600 (one time, at 700: 250 ms).
  const model = Buffer.alloc(800);
  model.writeUInt32LE(2, 256);
  model.writeUInt32LE(300, 260);
  model.write('$FSD', 300, 'latin1');
  model.write('$CSR', 336, 'latin1');
  model.writeInt16LE(-1, 336 + 26);
  model.writeUInt32LE(2, 336 + 28);
  model.writeUInt32LE(600, 336 + 32);
  model.writeUInt32LE(1, 608);
  model.writeUInt32LE(700, 612);
  model.writeUInt32LE(250, 700);
  const bytes = new Uint8Array(model.buffer, model.byteOffset, model.byteLength);
  assert.equal(releaseTimeMs(bytes, null, 1), 250);
  assert.equal(releaseTimeMs(bytes, null, 0), null);
  // An external sequence's times are in its .anim file.
  const anim = Buffer.alloc(800);
  anim.writeUInt32LE(90, 700);
  assert.equal(releaseTimeMs(bytes, new Uint8Array(anim.buffer, anim.byteOffset, anim.byteLength), 1), 90);
});
