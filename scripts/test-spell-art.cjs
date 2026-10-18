const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');

// Spell art (level 2): the M2 emitter and ribbon parser, track export, and
// the renderer's track and particle maths. No Blizzard files: buffers are
// built by hand in the documented 3.3.5 layouts.

const load = (file) => import(pathToFileURL(path.join(__dirname, 'scene', file)).href);

function loadModule(relativePath) {
  const output = esbuild.buildSync({
    entryPoints: [path.join(__dirname, relativePath)], bundle: true, write: false, platform: 'node', format: 'cjs',
  }).outputFiles[0].text;
  const context = { module: { exports: {} }, require, Math };
  context.exports = context.module.exports;
  vm.runInNewContext(output, context);
  return context.module.exports;
}

const tracks = loadModule('../renderer/scripts/utils/m2-tracks.ts');
const plain = (value) => JSON.parse(JSON.stringify(value));
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-4, `${label}: ${actual} != ${expected}`);

// A file with room for data after a header; `put` writes and returns offsets.
function m2Buffer(size = 4096) {
  const buffer = Buffer.alloc(size);
  let next = 1024;
  const alloc = (bytes) => {
    const at = next;
    next += Math.ceil(bytes / 4) * 4;
    return at;
  };
  return { buffer, alloc };
}

// An M2Track with one sequence of keys, written at `at`.
function writeTrack({ buffer, alloc }, at, { times, values, write, width, globalSequence = -1, interpolation = 1 }) {
  buffer.writeUInt16LE(interpolation, at);
  buffer.writeInt16LE(globalSequence, at + 2);
  const timeData = alloc(times.length * 4);
  times.forEach((time, index) => buffer.writeUInt32LE(time, timeData + index * 4));
  const timeList = alloc(8);
  buffer.writeUInt32LE(times.length, timeList);
  buffer.writeUInt32LE(timeData, timeList + 4);
  const valueData = alloc(values.length * width);
  values.forEach((value, index) => write(value, valueData + index * width));
  const valueList = alloc(8);
  buffer.writeUInt32LE(values.length, valueList);
  buffer.writeUInt32LE(valueData, valueList + 4);
  buffer.writeUInt32LE(1, at + 4);
  buffer.writeUInt32LE(timeList, at + 8);
  buffer.writeUInt32LE(1, at + 12);
  buffer.writeUInt32LE(valueList, at + 16);
}

function writeFBlock({ buffer, alloc }, at, times, values, write, width, components = 1) {
  const timeData = alloc(times.length * 2);
  times.forEach((time, index) => buffer.writeInt16LE(Math.round(time * 32767), timeData + index * 2));
  const valueData = alloc(values.length * width);
  values.forEach((value, index) => write(value, valueData + index * width));
  buffer.writeUInt32LE(times.length, at);
  buffer.writeUInt32LE(timeData, at + 4);
  buffer.writeUInt32LE(values.length / components, at + 8);
  buffer.writeUInt32LE(valueData, at + 12);
}

test('reads a particle emitter in the 3.3.5 layout', async () => {
  const { parseParticleEmitters, PARTICLE_SIZE } = await load('m2-effects.mjs');
  const file = m2Buffer();
  const { buffer } = file;
  const at = file.alloc(PARTICLE_SIZE);
  buffer.writeUInt32LE(1, 296);
  buffer.writeUInt32LE(at, 300);
  buffer.writeUInt32LE(0x20000 | 0x10, at + 0x04);
  buffer.writeFloatLE(0.5, at + 0x08);
  buffer.writeUInt16LE(3, at + 0x14);
  buffer.writeUInt16LE(2, at + 0x16);
  buffer.writeUInt8(4, at + 0x28);
  buffer.writeUInt8(2, at + 0x29);
  buffer.writeUInt16LE(4, at + 0x30);
  buffer.writeUInt16LE(8, at + 0x32);
  const float = (value, offset) => buffer.writeFloatLE(value, offset);
  writeTrack(file, at + 0x98, { times: [0], values: [0.6], write: float, width: 4 });
  buffer.writeFloatLE(0.1, at + 0xAC);
  writeTrack(file, at + 0xB0, { times: [0, 500], values: [60, 30], write: float, width: 4 });
  writeTrack(file, at + 0x84, { times: [0], values: [2], write: float, width: 4 });
  writeFBlock(file, at + 0x104, [0, 0.5, 1], [255, 0, 0, 0, 255, 0, 0, 0, 255], float, 4, 3);
  writeFBlock(file, at + 0x114, [0, 1], [1, 0], (value, offset) => buffer.writeInt16LE(Math.round(value * 32767), offset), 2);
  buffer.writeFloatLE(0.25, at + 0x15C);
  buffer.writeFloatLE(1.5, at + 0x174);

  const [emitter] = parseParticleEmitters(buffer);
  assert.equal(emitter.flags, 0x20010);
  near(emitter.position[0], 0.5, 'position');
  assert.equal(emitter.bone, 3);
  assert.equal(emitter.texture, 2);
  assert.equal(emitter.blendingType, 4);
  assert.equal(emitter.emitterType, 2);
  assert.deepEqual([emitter.rows, emitter.columns], [4, 8]);
  near(emitter.lifespan.sequences[0].values[0], 0.6, 'lifespan');
  near(emitter.lifespanVariation, 0.1, 'lifespan variation');
  assert.deepEqual(plain(emitter.emissionRate.sequences[0].times), [0, 500]);
  // Plain gravity is a pull down Z.
  assert.deepEqual(plain(emitter.gravity.sequences[0].values), [0, 0, -2]);
  assert.equal(emitter.color.values.length, 9);
  near(emitter.color.times[1], 0.5, 'colour mid time');
  near(emitter.alpha.values[0], 1, 'alpha');
  near(emitter.tailLength, 0.25, 'tail length');
  near(emitter.drag, 1.5, 'drag');
  // A count that runs past the file reads as none.
  buffer.writeUInt32LE(100, 296);
  assert.deepEqual(parseParticleEmitters(buffer), []);
});

test('reads a ribbon in the 3.3.5 layout', async () => {
  const { parseRibbons, RIBBON_SIZE } = await load('m2-effects.mjs');
  const file = m2Buffer();
  const { buffer } = file;
  const at = file.alloc(RIBBON_SIZE);
  buffer.writeUInt32LE(1, 288);
  buffer.writeUInt32LE(at, 292);
  buffer.writeUInt32LE(7, at + 0x04);
  const textures = file.alloc(2);
  buffer.writeUInt16LE(2, textures);
  buffer.writeUInt32LE(1, at + 0x14);
  buffer.writeUInt32LE(textures, at + 0x18);
  writeTrack(file, at + 0x4C, { times: [0], values: [0.22], write: (value, offset) => buffer.writeFloatLE(value, offset), width: 4 });
  buffer.writeFloatLE(10, at + 0x74);
  buffer.writeFloatLE(0.6, at + 0x78);
  const [ribbon] = parseRibbons(buffer);
  assert.equal(ribbon.bone, 7);
  assert.deepEqual(ribbon.textures, [2]);
  near(ribbon.heightAbove.sequences[0].values[0], 0.22, 'height above');
  near(ribbon.edgesPerSecond, 10, 'edges per second');
  near(ribbon.edgeLifetime, 0.6, 'edge lifetime');
});

test('exports tracks for the clips kept, or a loop\'s keys', async () => {
  const { exportTrack } = await load('effect-model.mjs');
  const track = { interpolation: 1, globalSequence: -1, sequences: [{ times: [0, 100], values: [1, 2] }, { times: [0], values: [9] }] };
  // A clip past the track's last sequence takes the first one's keys, as
  // the client reads them.
  assert.deepEqual(exportTrack(track, [{ name: 'Stand', index: 0 }, { name: 'Death', index: 2 }]),
    { g: -1, s: false, k: { Stand: [[0, 100], [1, 2]], Death: [[0, 100], [1, 2]] } });
  // A sequence there but without keys stays the default.
  const empty = { ...track, sequences: [track.sequences[0], { times: [], values: [] }] };
  assert.deepEqual(exportTrack(empty, [{ name: 'Stand', index: 0 }, { name: 'Hold', index: 1 }]),
    { g: -1, s: false, k: { Stand: [[0, 100], [1, 2]] } });
  assert.deepEqual(exportTrack({ ...track, globalSequence: 1, interpolation: 0 }, []),
    { g: 1, s: true, k: { global: [[0, 100], [1, 2]] } });
  assert.equal(exportTrack({ ...track, sequences: [] }, [{ name: 'Stand', index: 0 }]), null);
});

test('builds the models particles are drawn as beside the effect, their names prefixed', async () => {
  const { buildEffectDocument } = await load('effect-model.mjs');
  const curve = { times: [], values: [] };
  const emitter = { texture: 0, bone: 0, particleModel: 0, childEmitters: 0, color: curve, alpha: curve, scale: curve, headCell: curve, tailCell: curve };
  const effect = (name, emitters) => ({
    name, loops: [], clips: [{ name: 'Stand', index: 0, duration: 1000, bones: [{}] }], globalClips: [],
    bones: [{ parentIndex: -1, pivot: [0, 0, 0], flags: 0 }], textures: [], materials: [], geometry: null, batches: [],
    emitters, ribbons: [],
  });
  const document = buildEffectDocument(effect('Base', [emitter]), {
    name: 'Base', textureFor: () => null, particleModels: [{ effect: effect('Geo', []), textureFor: () => null }],
  });
  const roots = document.getRoot().listScenes()[0].listChildren();
  assert.deepEqual(roots.map((root) => root.getName()), ['Base', 'p0:Geo']);
  assert.equal(roots[1].getExtras().wowParticleModel, 0);
  assert.deepEqual(roots[1].listChildren().map((node) => node.getName()), ['p0:bone0']);
  const exported = roots[0].getExtras().wowEffect.emitters[0];
  assert.equal(exported.particleModel, 0);
  assert.equal(exported.childEmitters, 0);
});

test('evaluates tracks by clip time, and loops by elapsed time', () => {
  const clock = { clip: 'Stand', timeMs: 50, elapsedMs: 1250, loops: [1000] };
  const track = { g: -1, s: false, k: { Stand: [[0, 100], [0, 10, 100, 110]] } };
  assert.deepEqual(plain(tracks.evalTrack(track, 2, clock, [7, 7])), [50, 60]);
  assert.deepEqual(plain(tracks.evalTrack({ ...track, s: true }, 2, clock, [7, 7])), [0, 10]);
  assert.deepEqual(plain(tracks.evalTrack(null, 2, clock, [7, 7])), [7, 7]);
  // A clip without keys takes the default, not Stand's keys.
  assert.deepEqual(plain(tracks.evalTrack(track, 2, { ...clock, clip: 'Hold' }, [7, 7])), [7, 7]);
  // A loop of 1000 ms, 1250 ms in: 250 ms into its keys.
  const loop = { g: 0, s: false, k: { global: [[0, 1000], [0, 4]] } };
  assert.deepEqual(plain(tracks.evalTrack(loop, 1, clock, [0])), [1]);
  // Past the last key holds it.
  assert.deepEqual(plain(tracks.interpolate([0, 100], [1, 2], 1, 500)), [2]);
});

test('evaluates life curves and texture cells', () => {
  const curve = { t: [0, 0.5, 1], v: [0, 10, 0] };
  assert.deepEqual(plain(tracks.evalLifeCurve(curve, 1, 0.25, [9])), [5]);
  assert.deepEqual(plain(tracks.evalLifeCurve({ t: [], v: [] }, 1, 0.25, [9])), [9]);
  assert.deepEqual(plain(tracks.cellUv(0, 4, 4)), [0, 0, 0.25, 0.25]);
  assert.deepEqual(plain(tracks.cellUv(5, 4, 4)), [0.25, 0.25, 0.5, 0.5]);
  // Rounded to the nearest cell; a sheet that isn't a power of two is one cell.
  assert.deepEqual(plain(tracks.cellUv(1.6, 4, 4)), [0.5, 0, 0.75, 0.25]);
  assert.deepEqual(plain(tracks.cellUv(2, 3, 3)), [0, 0, 1, 1]);
});

test('writes tracks, curves and cells in place as the allocating versions give them', () => {
  const clock = { clip: 'Stand', timeMs: 50, elapsedMs: 1250, loops: [1000] };
  const into = (call) => {
    const out = [-1, -1, -1, -1];
    return call(out) ? plain(out) : null;
  };
  const curves = [
    { times: [0], values: [3, 4] },
    { times: [0, 100], values: [0, 10, 100, 110] },
    { times: [10, 20, 40], values: [1, 2, 5, 6, 9, 10] },
  ];
  for (const { times, values } of curves) {
    for (const time of [-5, 0, 15, 20, 30, 50, 100, 500]) {
      for (const step of [false, true]) {
        const expected = plain(tracks.interpolate(times, values, 2, time, step));
        assert.deepEqual(into((out) => tracks.interpolateInto(times, values, 2, time, step, out))?.slice(0, 2), expected, `${times} at ${time} ${step}`);
      }
    }
  }
  assert.equal(into((out) => tracks.interpolateInto([], [], 2, 5, false, out)), null);
  const track = { g: -1, s: false, k: { Stand: [[0, 100], [0, 10, 100, 110]] } };
  for (const candidate of [track, { ...track, s: true }, { g: 0, s: false, k: { global: [[0, 1000], [0, 4, 8, 12]] } }]) {
    assert.deepEqual(into((out) => tracks.evalTrackInto(candidate, 2, clock, out)).slice(0, 2), plain(tracks.evalTrack(candidate, 2, clock, [7, 7])));
  }
  // Where the allocating version gives the fallback, nothing is written.
  assert.equal(into((out) => tracks.evalTrackInto(null, 2, clock, out)), null);
  assert.equal(into((out) => tracks.evalTrackInto(track, 2, { ...clock, clip: 'Hold' }, out)), null);
  const curve = { t: [0, 0.5, 1], v: [0, 10, 0] };
  for (const fraction of [-1, 0, 0.25, 0.5, 0.9, 1, 2]) {
    assert.deepEqual(into((out) => tracks.evalLifeCurveInto(curve, 1, fraction, out)).slice(0, 1), plain(tracks.evalLifeCurve(curve, 1, fraction, [9])));
  }
  assert.equal(into((out) => tracks.evalLifeCurveInto({ t: [], v: [] }, 1, 0.25, out)), null);
  for (const [cell, rows, columns] of [[0, 4, 4], [5, 4, 4], [1.6, 4, 4], [2, 3, 3], [3, 2, 8]]) {
    assert.deepEqual(plain(tracks.cellUvInto(cell, rows, columns, [9, 9, 9, 9])), plain(tracks.cellUv(cell, rows, columns)));
  }
});

test('moves, scales and turns textures about their middle as the client does', () => {
  const apply = (m, [u, v]) => [m[0] * u + m[1] * v + m[2], m[3] * u + m[4] * v + m[5]];
  const quarter = [0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)];
  const same = (actual, expected, label) => actual.forEach((value, index) => near(value, expected[index], label));
  same(tracks.uvMatrix([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]), [1, 0, 0, 0, 1, 0, 0, 0, 1], 'identity');
  // A quarter turn about the middle, anticlockwise: (1, 0.5) goes to (0.5, 1).
  same(apply(tracks.uvMatrix([0, 0, 0], quarter, [1, 1, 1]), [1, 0.5]), [0.5, 1], 'turn');
  same(apply(tracks.uvMatrix([0, 0, 0], quarter, [1, 1, 1]), [0.5, 0.5]), [0.5, 0.5], 'middle stays');
  // Scaled about the middle.
  same(apply(tracks.uvMatrix([0, 0, 0], [0, 0, 0, 1], [2, 3, 1]), [1, 1]), [1.5, 2], 'scale');
  // Moved first, then scaled and turned: the move is scaled too.
  same(apply(tracks.uvMatrix([0.25, 0, 0], [0, 0, 0, 1], [2, 1, 1]), [0.5, 0.5]), [1, 0.5], 'move then scale');
  same(apply(tracks.uvMatrix([0.25, 0, 0], quarter, [1, 1, 1]), [0.5, 0.5]), [0.5, 0.75], 'move then turn');
});

test('splits long frames into the client\'s steps and thins far emitters', () => {
  const sum = (steps) => steps.reduce((total, step) => total + step, 0);
  assert.deepEqual(plain(tracks.particleSteps(0.05, 2)), [0.05]);
  assert.deepEqual(plain(tracks.particleSteps(0.1, 2)), [0.1]);
  const long = tracks.particleSteps(0.35, 2);
  assert.equal(long.length, 4);
  near(sum(long), 0.35, 'whole frame');
  near(long[3], 0.05, 'remainder');
  // No more whole steps than fit in a particle's life; the rest is dropped.
  const capped = tracks.particleSteps(5, 0.25);
  assert.equal(capped.length, 3);
  near(sum(capped), 0.2, 'capped');
  assert.equal(tracks.distanceThinning(20), 1);
  assert.equal(tracks.distanceThinning(50), 1);
  near(tracks.distanceThinning(75), 0.5, 'halfway');
  assert.equal(tracks.distanceThinning(200), 0.25);
  // The client's camera shows a view about as tall as it stands back.
  near(tracks.cameraDistanceFor(50), 50 / (2 * Math.tan(Math.PI * 0.15)), 'camera distance');
});

test('spawns particles as the client\'s emitters do, and counts emission', () => {
  const fixed = (...values) => { let index = 0; return () => values[index++ % values.length]; };
  // Plane: draws y, x, speed variation, latitude, longitude. x spans the
  // width (0xC8), y the length (0xDC).
  const plane = tracks.spawnParticle({ emitterType: 1, areaWidth: 4, areaLength: 2, verticalRange: 0, horizontalRange: 0,
    speed: 3, speedVariation: 0, zSource: 0 }, fixed(-1, 1, 0, 0, 0));
  assert.deepEqual(plain(plane.velocity), [0, 0, 3]);
  assert.deepEqual(plain(plane.position), [2, -1, 0]);
  // Sphere: draws radius (from width to length), latitude, longitude, speed.
  const sphere = tracks.spawnParticle({ emitterType: 2, areaWidth: 1, areaLength: 3, verticalRange: Math.PI / 2,
    horizontalRange: 0, speed: 2, speedVariation: 0, zSource: 0 }, fixed(1, 1, 0, 0));
  near(Math.hypot(...sphere.position), 3, 'radius');
  near(sphere.velocity[2], 2, 'outward, straight up at the top');
  // A narrow sphere points forward (+X), fanned by the longitude.
  const breath = (latitude, longitude) => tracks.spawnParticle({ emitterType: 2, areaWidth: 0, areaLength: 0,
    verticalRange: 0.1, horizontalRange: 1, speed: 10, speedVariation: 0, zSource: 0 }, fixed(-1, latitude, longitude, 0));
  near(breath(0, 0).velocity[0], 10, 'straight ahead');
  near(Math.atan2(breath(0, 1).velocity[1], breath(0, 1).velocity[0]), 1, 'fanned sideways');
  near(Math.asin(breath(1, 0).velocity[2] / 10), 0.1, 'tilted up');
  // Flagged upward, a sphere's particles fly straight up.
  const upward = tracks.spawnParticle({ emitterType: 2, areaWidth: 1, areaLength: 1, verticalRange: 0, horizontalRange: 1,
    speed: 4, speedVariation: 0, zSource: 0, upward: true }, fixed(0, 0, 1, 0));
  assert.deepEqual(plain(upward.velocity), [0, 0, 4]);
  // zSource: away from a point that far up the axis.
  const source = tracks.spawnParticle({ emitterType: 1, areaWidth: 0, areaLength: 0, verticalRange: 0, horizontalRange: 0,
    speed: 5, speedVariation: 0, zSource: 2 }, fixed(0));
  assert.deepEqual(plain(source.velocity), [0, 0, -5]);
  // Spline: a point along its stretch, by length, flying up.
  const spline = tracks.spawnParticle({ emitterType: 3, areaWidth: 0, areaLength: 1, verticalRange: 0, horizontalRange: 0,
    speed: 2, speedVariation: 0, zSource: 0, splinePoints: [0, 0, 0, 2, 0, 0, 2, 2, 0] }, fixed(-0.5, 0));
  assert.deepEqual(plain(spline.position), [1, 0, 0]);
  assert.deepEqual(plain(spline.velocity), [0, 0, 2]);
  // Emission rounds to the nearest, carrying the rest (which may go below 0).
  const emitted = tracks.emitCount(0.5, 10, 0.12);
  assert.equal(emitted.count, 2);
  near(emitted.carry, -0.3, 'carry');
  // Blends by the client's tables.
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(tracks.particleBlend),
    ['opaque', 'alphaKey', 'alpha', 'addColor', 'add', 'mod', 'mod2x', 'opaque']);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(tracks.materialBlend), ['opaque', 'alphaKey', 'alpha', 'addColor', 'add', 'mod', 'mod2x']);
  // Lit unless unlit (0x1) or modulating; mod and mod2x draw white (mod2x
  // at half) whatever their colour; depth by the flags (0x8, 0x10).
  const light = (blend, flags) => JSON.parse(JSON.stringify(tracks.m2MaterialLight(tracks.materialBlend(blend), flags)));
  assert.deepEqual(light(0, 0), { lit: true, color: null, depthTest: true, depthWrite: true });
  assert.deepEqual(light(0, 0x1), { lit: false, color: null, depthTest: true, depthWrite: true });
  assert.deepEqual(light(1, 0x10), { lit: true, color: null, depthTest: true, depthWrite: false });
  assert.deepEqual(light(3, 0), { lit: true, color: null, depthTest: true, depthWrite: false });
  assert.deepEqual(light(4, 0x8), { lit: true, color: null, depthTest: false, depthWrite: false });
  assert.deepEqual(light(5, 0), { lit: false, color: 1, depthTest: true, depthWrite: false });
  assert.deepEqual(light(6, 0), { lit: false, color: 0.5, depthTest: true, depthWrite: false });
  assert.deepEqual([0, 0x1, 0x8, 0x9].map(tracks.particlesLit), [true, false, true, false]);
  // Twinkle reads a fixed table of 128 numbers in [0, 1).
  assert.equal(tracks.TWINKLE_TABLE.length, 128);
  assert.ok(tracks.TWINKLE_TABLE.every((value) => value >= 0 && value < 1));
  assert.equal(tracks.twinkleEntry(0, 10, 3), tracks.TWINKLE_TABLE[3]);
  assert.equal(tracks.twinkleEntry(0.25, 10, 3), tracks.TWINKLE_TABLE[6]);
});

test('picks the kit a cast plays, its body slots, and the animations it names', () => {
  const kits = loadModule('../renderer/scripts/utils/spell-kits.ts');
  const kit = (anim) => ({ anim, effects: [] });
  const visual = { missile: null, kits: { precast: kit(51), cast: kit(53), channel: kit(124) } };
  assert.equal(kits.castKit(visual, { release: false, channeled: false }).anim, 51);
  assert.equal(kits.castKit(visual, { release: true, channeled: false }).anim, 53);
  assert.equal(kits.castKit(visual, { release: false, channeled: true }).anim, 124);
  // A channel without its own kit keeps the precast one.
  assert.equal(kits.castKit({ missile: null, kits: { precast: kit(52) } }, { release: false, channeled: true }).anim, 52);
  assert.equal(kits.castKit({ missile: null, kits: {} }, { release: true, channeled: false }), undefined);
  // Slots sit on the client's attachments; the world effect on none.
  assert.equal(kits.slotAttachment('head'), 20);
  assert.equal(kits.slotAttachment('chest'), 34);
  assert.equal(kits.slotAttachment('base'), 19);
  assert.equal(kits.slotAttachment('special2'), 24);
  assert.equal(kits.slotAttachment('rightWeapon'), 1);
  assert.equal(kits.slotAttachment('world'), null);
  // At a ground point only the world and base effects stand there, the
  // head effect goes on the caster, and the rest are skipped.
  assert.equal(kits.groundSlot('world'), 'ground');
  assert.equal(kits.groundSlot('base'), 'ground');
  assert.equal(kits.groundSlot('head'), 'caster');
  assert.equal(kits.groundSlot('chest'), null);
  assert.deepEqual(plain(kits.kitClips({ ...kit(124), animClips: ['ChannelCastDirected', 'ReadySpellOmni'] })), ['ChannelCastDirected', 'ReadySpellOmni']);
  assert.equal(kits.kitClips(undefined), null);
});

test('rains the area model procedure 9 names in a lasting area, at its rate, more near the middle', () => {
  const kits = loadModule('../renderer/scripts/utils/spell-kits.ts');
  const kit = (procs) => ({ anim: -1, effects: [], procs });
  const rainOfFire = { missile: null, kits: { persistentArea: kit([{ code: 9, params: [1, 7, 0, 0] }]) } };
  assert.deepEqual(plain(kits.areaRain(rainOfFire)), { model: 1, rate: 7 });
  // No rate: the default.
  assert.deepEqual(plain(kits.areaRain({ missile: null, kits: { persistentArea: kit([{ code: 9, params: [0, 0, 0, 0] }]) } })), { model: 0, rate: 5 });
  assert.equal(kits.areaRain({ missile: null, kits: { persistentArea: kit([{ code: 3, params: [0, 5, 0, 0] }]) } }), null);
  // Only a lasting area rains.
  assert.equal(kits.areaRain({ missile: null, kits: { impactArea: kit([{ code: 9, params: [0, 5, 0, 0] }]) } }), null);
  assert.deepEqual(plain(kits.rainPoint([10, 20, 3], 8, 1, 0)), [18, 20, 3]);
  // Half way out by the first number, not by its square root.
  assert.deepEqual(plain(kits.rainPoint([10, 20, 3], 8, 0.5, 0)), [14, 20, 3]);
  assert.deepEqual(plain(kits.rainPoint([10, 20, 3], 8, 0, 0.5)), [10, 20, 3]);
});

test('finds a missile\'s points in the client\'s effect attachments, offsets with Y flipped', () => {
  const kits = loadModule('../renderer/scripts/utils/spell-kits.ts');
  // Index 1 is the chest, 4 the right spell hand; 13 the weapon (its hand).
  assert.equal(kits.missileAttachment(1), 34);
  assert.equal(kits.missileAttachment(4), 22);
  assert.equal(kits.missileAttachment(13), 22);
  assert.equal(kits.missileAttachment(-1), null);
  assert.equal(kits.missileAttachment(undefined), null);
  // Raw: the M2 attachment itself.
  assert.equal(kits.missileAttachment(18, true), 18);
  assert.deepEqual(plain(kits.missileOffset([1, 2, 3])), [1, -2, 3]);
  assert.deepEqual(plain(kits.missileOffset(undefined)), [0, 0, 0]);
});

test('plays the art of the cast\'s school for a spell with art by school', () => {
  const { artForSchool } = loadModule('../renderer/scripts/utils/spell-kits.ts');
  const frost = { missile: { id: 4807, scale: 1 }, kits: {} };
  const shoot = { missile: null, kits: {}, bySchool: { 16: frost, 32: { missile: { id: 3493, scale: 1 }, kits: {} } } };
  assert.equal(artForSchool(shoot, 16), frost);
  assert.equal(artForSchool(shoot, 1), null);
  assert.equal(artForSchool(frost, 1), frost);
});

// A WDBC table of `fieldCount` fields from records given as { field: value }:
// strings go to the string block, float(x) is written as a float, and other
// numbers as integers.
const float = (value) => ({ float: value });
function dbc(fieldCount, records) {
  const strings = ['\0'];
  let stringBytes = 1;
  const body = Buffer.alloc(records.length * fieldCount * 4);
  records.forEach((record, index) => {
    for (const [field, value] of Object.entries(record)) {
      const at = (index * fieldCount + Number(field)) * 4;
      if (typeof value === 'string') {
        body.writeUInt32LE(stringBytes, at);
        strings.push(`${value}\0`);
        stringBytes += Buffer.byteLength(`${value}\0`);
      } else if (typeof value === 'object') body.writeFloatLE(value.float, at);
      else body.writeInt32LE(value, at);
    }
  });
  const block = Buffer.from(strings.join(''));
  const header = Buffer.alloc(20);
  header.write('WDBC');
  header.writeUInt32LE(records.length, 4);
  header.writeUInt32LE(fieldCount, 8);
  header.writeUInt32LE(fieldCount * 4, 12);
  header.writeUInt32LE(block.length, 16);
  return Buffer.concat([header, body, block]);
}

// A kit with no animation and no effects, plus `fields`.
const kitRecord = (id, fields = {}) => ({ 0: id, 1: -1, 2: -1, 17: -1, 18: -1, 19: -1, 20: -1, ...fields });

test('exports a spell\'s chain, the area its aura keeps casting round its bearer, and a wand\'s art by school', async () => {
  const { SpellVisuals, WAND_VISUALS } = await load('spell-visuals.mjs');
  const files = {
    'DBFilesClient\\Spell.dbc': dbc(234, [
      { 0: 55459, 131: 3659 },
      { 0: 48505, 131: 11571, 95: 23, 116: 50286, 225: 64 },
      { 0: 50286, 86: 22, 92: 9 },
      { 0: 5019 },
    ]),
    'DBFilesClient\\SpellRadius.dbc': dbc(4, [{ 0: 9, 1: float(30) }]),
    'DBFilesClient\\SpellVisual.dbc': dbc(32, [
      { 0: 3659, 2: 3169 },
      { 0: 11571, 4: 10695 },
      { 0: WAND_VISUALS[32], 8: 3493 },
    ]),
    'DBFilesClient\\SpellVisualKit.dbc': dbc(38, [
      kitRecord(3169, { 2: 53, 17: 0, 21: float(736), 25: float(1) }),
      kitRecord(10695, { 5: 4477 }),
    ]),
    'DBFilesClient\\SpellVisualEffectName.dbc': dbc(8, [
      { 0: 4477, 2: 'Spells\\Starfall_Caster.mdx', 4: float(1) },
      { 0: 3493, 2: 'Spells\\Shadowbolt_Missile.mdx', 4: float(1) },
    ]),
    // Bytes 156-159 are its alpha, red, green, blue (written as one field);
    // the combo string (field 47 here) is moved to its byte offset, 161.
    'DBFilesClient\\SpellChainEffects.dbc': (() => {
      const table = dbc(48, [
        {
          0: 736, 1: float(0.3), 2: float(0.2), 3: float(0.001), 4: float(1.66), 5: 999, 6: 200, 7: 'Textures\\SpellChainEffects\\HealBeam.blp',
          8: 0x20, 31: float(50), 36: float(100), 39: 0x40ff8020, 47: '\x61\x03\x01\x13',
        },
        { 0: 737, 2: float(0.5), 7: 'Textures\\SpellChainEffects\\Beam_WaterGreen.blp' },
      ]);
      table.writeUInt32LE(table.readUInt32LE(20 + 47 * 4), 20 + 161);
      table.writeUInt8(3, 20 + 160);
      return table;
    })(),
  };
  const present = new Set(['spells\\starfall_caster.m2', 'spells\\shadowbolt_missile.m2', 'textures\\spellchaineffects\\healbeam.blp',
    'textures\\spellchaineffects\\beam_watergreen.blp']);
  const visuals = new SpellVisuals((name) => files[name] ?? (present.has(name.toLowerCase()) ? Buffer.alloc(1) : null));

  const chainHeal = visuals.forSpell(55459);
  assert.deepEqual(plain(chainHeal.kits.cast.procs), [{ code: 0, params: [736, 1, 0, 0] }]);
  const { stage, persist, reverse, effects } = chainHeal.chain;
  assert.deepEqual([stage, persist, reverse], ['cast', false, false]);
  // The chain, then the one its combo adds.
  assert.deepEqual(effects.map((effect) => effect.id), [736, 737]);
  const [heal] = effects;
  near(heal.width, 0.2, 'width');
  near(heal.scrollSpeed, 1.66, 'scroll');
  assert.deepEqual([heal.segmentMs, heal.delayMs, heal.linkDelayMs, heal.flags, heal.pulseSpeed], [999, 200, 50, 0x20, 100]);
  // Little-endian: alpha 0x20, red 0x80, green 0xff, blue 0x40.
  assert.deepEqual([heal.color, heal.alpha, heal.blendMode, heal.combo], [0x80ff40, 0x20 / 255, 3, [737]]);
  assert.deepEqual(plain(chainHeal.chain.points.castOffset), [0, 0, 0]);
  assert.equal(visuals.chainTexture(736), 'Textures\\SpellChainEffects\\HealBeam.blp');

  assert.deepEqual(plain(visuals.forSpell(48505).bearerArea), { radius: 30, triggers: [50286], schoolMask: 64 });
  assert.equal(visuals.forSpell(55459).bearerArea, undefined);

  const shoot = visuals.forSpell(5019);
  assert.deepEqual(Object.keys(shoot.bySchool), ['32']);
  assert.equal(shoot.bySchool[32].missile.id, 3493);
});

test('exports a missile\'s points and offsets, the missile targeting kit, roots, chain effects, and rain models', async () => {
  const { SpellVisuals } = await load('spell-visuals.mjs');
  const files = {
    'DBFilesClient\\Spell.dbc': dbc(234, [
      { 0: 116, 131: 13, 95: 26 },
      { 0: 421, 131: 37 },
    ]),
    'DBFilesClient\\SpellVisual.dbc': dbc(32, [
      { 0: 13, 8: 3493, 10: 1, 13: 0x200, 16: 18, 22: 500, 26: float(0.5), 27: float(1), 28: float(-2), 30: float(3) },
      { 0: 37, 3: 600 },
    ]),
    'DBFilesClient\\SpellVisualKit.dbc': dbc(38, [
      kitRecord(500, { 5: 3493 }),
      kitRecord(600, { 17: 12, 21: float(5) }),
    ]),
    'DBFilesClient\\SpellVisualEffectName.dbc': dbc(8, [{ 0: 3493, 2: 'Spells\\Frostbolt.mdx', 4: float(1) }]),
    'DBFilesClient\\SpellVisualKitAreaModel.dbc': dbc(3, [
      { 0: 1, 1: 'Spells\\Blizzard_Impact_Base.mdx' },
      { 0: 2, 1: 'Spells\\RainOfFire_Impact_Base.mdx' },
    ]),
  };
  const present = new Set(['spells\\frostbolt.m2', 'spells\\blizzard_impact_base.m2', 'spells\\rainoffire_impact_base.m2']);
  const visuals = new SpellVisuals((name) => files[name] ?? (present.has(name.toLowerCase()) ? Buffer.alloc(1) : null));

  const frostbolt = visuals.forSpell(116);
  assert.deepEqual(plain(frostbolt.missile), {
    id: 3493, scale: 1, areaSize: 0, minScale: 0, maxScale: 0, attachment: 18, destinationAttachment: 1, rawAttachments: true,
    castOffset: [0.5, 1, -2], impactOffset: [0, 3, 0], waitsForRelease: false,
  });
  assert.equal(frostbolt.kits.missileTargeting.id, 500);
  assert.equal(frostbolt.rootsUnit, true);
  assert.equal(frostbolt.chainEffect, undefined);
  // A chain procedure (12 as well as 0) in an impact kit counts.
  assert.equal(visuals.forSpell(421).chainEffect, true);
  // Rain models by row, counted from 0; a row past the end falls back to the first.
  assert.equal(visuals.areaModel(1), 'Spells\\RainOfFire_Impact_Base.m2');
  assert.equal(visuals.areaModel(9), 'Spells\\Blizzard_Impact_Base.m2');
});

test('exports a kit\'s flags and animation clips with their fallbacks, and whether a spell is harmful', async () => {
  const { SpellVisuals } = await load('spell-visuals.mjs');
  const files = {
    'DBFilesClient\\Spell.dbc': dbc(234, [{ 0: 116, 131: 13, 86: 6 }, { 0: 139, 131: 14, 16: 0x100, 86: 6 }]),
    'DBFilesClient\\SpellVisual.dbc': dbc(32, [{ 0: 13, 1: 800, 2: 801 }, { 0: 14, 2: 802 }]),
    'DBFilesClient\\SpellVisualKit.dbc': dbc(38, [
      kitRecord(800, { 1: 51, 2: 53, 37: 0x1 }),
      kitRecord(801, { 2: 53, 37: 0x4 }),
      kitRecord(802, { 2: 124 }),
    ]),
    'DBFilesClient\\AnimationData.dbc': dbc(8, [
      { 0: 51, 1: 'ReadySpellDirected', 5: 52 }, { 0: 52, 1: 'ReadySpellOmni', 5: 0 },
      { 0: 53, 1: 'SpellCastDirected', 5: 54 }, { 0: 54, 1: 'SpellCastOmni', 5: 33 }, { 0: 33, 1: 'Stop', 5: 0 },
      { 0: 124, 1: 'ChannelCastDirected', 5: 124 },
    ]),
  };
  const visuals = new SpellVisuals((name) => files[name] ?? null);
  const frostbolt = visuals.forSpell(116);
  assert.equal(frostbolt.kits.precast.flags, 0x1);
  assert.deepEqual(plain(frostbolt.kits.precast.animClips), ['SpellCastDirected', 'SpellCastOmni', 'Stop']);
  assert.deepEqual(plain(frostbolt.kits.precast.startClips), ['ReadySpellDirected', 'ReadySpellOmni']);
  // Raw (flag 0x4): no fallback.
  assert.deepEqual(plain(frostbolt.kits.cast.animClips), ['SpellCastDirected']);
  assert.equal(frostbolt.harmful, true);
  // Its own fallback ends the chain; a helpful target flag wins over an enemy target.
  const renew = visuals.forSpell(139);
  assert.deepEqual(plain(renew.kits.cast.animClips), ['ChannelCastDirected']);
  assert.equal(renew.harmful, undefined);
});

test('exports a kit\'s model attachments as effects, and reads their offset and turn as the client does', async () => {
  const { SpellVisuals } = await load('spell-visuals.mjs');
  const files = {
    'DBFilesClient\\Spell.dbc': dbc(234, [{ 0: 120, 131: 13 }]),
    'DBFilesClient\\SpellVisual.dbc': dbc(32, [{ 0: 13, 2: 900 }]),
    'DBFilesClient\\SpellVisualKit.dbc': dbc(38, [kitRecord(900)]),
    'DBFilesClient\\SpellVisualEffectName.dbc': dbc(8, [{ 0: 1345, 2: 'Spells\\ConeOfCold_Hand.mdx', 4: float(1) }]),
    'DBFilesClient\\SpellVisualKitModelAttach.dbc': dbc(10, [
      { 0: 141, 1: 900, 2: 1345, 3: 17, 4: float(1), 5: float(2), 6: float(3), 7: float(0.5) },
      { 0: 142, 1: 900, 2: 1345, 3: -1 },
      { 0: 143, 1: 901, 2: 1345, 3: 22 },
    ]),
  };
  const visuals = new SpellVisuals((name) => files[name] ?? (name.toLowerCase() === 'spells\\coneofcold_hand.m2' ? Buffer.alloc(1) : null));
  const effects = visuals.forSpell(120).kits.cast.effects;
  assert.deepEqual(effects.map(({ slot, attachment }) => [slot, attachment]), [['attach', 17], ['attach', -1]]);
  assert.deepEqual(plain(effects[0].offset), [1, 2, 3]);
  near(effects[0].yaw, 0.5, 'yaw');

  const { attachOffset, attachTurn, groundSlot } = loadModule('../renderer/scripts/utils/spell-kits.ts');
  assert.deepEqual(plain(attachOffset(effects[0])), [1, -2, 3]);
  assert.deepEqual(plain(attachTurn({ yaw: 0.5, pitch: 0, roll: 0 })), { yaw: -0.5, pitch: 0, roll: 0 });
  assert.equal(attachTurn({}), null);
  assert.equal(groundSlot('attach'), 'ground');
});

test('sizes effects as the client does: world effects by the model\'s footprint, attached ones by its scale, within limits', () => {
  const { limitScale, unitEffectScale } = loadModule('../renderer/scripts/utils/spell-kits.ts');
  const effect = { slot: 'chest', id: 1, scale: 2, minScale: 0.1, maxScale: 10 };
  assert.equal(limitScale(20, effect), 10);
  assert.equal(limitScale(0.01, effect), 0.1);
  assert.equal(limitScale(3, effect), 3);
  // A zero maximum leaves nothing, so 1; older art without limits is left alone.
  assert.equal(limitScale(3, { minScale: 0, maxScale: 0 }), 1);
  assert.equal(limitScale(3, {}), 3);
  const scales = { world: 0.5, attached: 1.5, footprint: 4 };
  // World: unit 1.2 x world 0.5 x footprint 4 x effect 2.
  near(unitEffectScale(effect, 1.2, scales, true), 4.8, 'world');
  // Attached: unit 1.2 x attached 1.5 x effect 2.
  near(unitEffectScale(effect, 1.2, scales, false), 3.6, 'attached');
  // A small footprint counts as 1.
  near(unitEffectScale(effect, 1, { ...scales, footprint: 0.4 }, true), 1, 'small footprint');
  near(unitEffectScale(effect, 1.2, null, false), 2.4, 'no model scales');
});

test('exports how a missile flies: its release, ground following, motion script, and gravity arc', async () => {
  const { SpellVisuals } = await load('spell-visuals.mjs');
  const files = {
    'DBFilesClient\\Spell.dbc': dbc(234, [{ 0: 6544, 131: 70, 227: 621 }, { 0: 75, 131: 71 }]),
    'DBFilesClient\\SpellVisual.dbc': dbc(32, [
      // Cast kit 800 plays SpellCastDirected (behaviour 53); follows the
      // ground 500 thousandths up; motion script 13.
      { 0: 70, 2: 800, 8: 3493, 17: float(500), 18: float(250), 19: float(800), 20: 1 | 8, 21: 13 },
      // Released at once (flag 4), though its cast kit casts.
      { 0: 71, 2: 800, 8: 3493, 13: 0x4 },
    ]),
    'DBFilesClient\\SpellVisualKit.dbc': dbc(38, [kitRecord(800, { 2: 53 })]),
    'DBFilesClient\\SpellVisualEffectName.dbc': dbc(8, [{ 0: 3493, 2: 'Spells\\Arrow.mdx', 4: float(1) }]),
    'DBFilesClient\\AnimationData.dbc': dbc(8, [{ 0: 53, 1: 'SpellCastDirected', 6: 53 }]),
    'DBFilesClient\\SpellMissileMotion.dbc': dbc(5, [{ 0: 13, 1: 'Parabola', 2: 'transMag = progress * 2', 4: 3 }]),
    'DBFilesClient\\SpellMissile.dbc': dbc(15, [{ 0: 621, 1: 1, 2: float(0.5), 3: float(0.7), 4: float(22), 5: float(24), 12: float(19.29) }]),
  };
  const visuals = new SpellVisuals((name) => files[name] ?? (name.toLowerCase() === 'spells\\arrow.m2' ? Buffer.alloc(1) : null));
  const leap = visuals.forSpell(6544).missile;
  assert.equal(leap.waitsForRelease, true);
  assert.deepEqual(plain(leap.followGround), { height: 0.5, dropSpeed: 0.25, approach: 0.8, flags: 9 });
  assert.equal(leap.motion.count, 3);
  assert.deepEqual(plain(leap.motion.script), [['set', 'transMag', ['op', '*', ['var', 'progress'], ['num', 2]], false]]);
  near(leap.trajectory.gravity, 19.29, 'gravity');
  near(leap.trajectory.pitch[1], 0.7, 'pitch');
  assert.deepEqual(plain(leap.trajectory.speed), [22, 24]);
  const shot = visuals.forSpell(75).missile;
  assert.equal(shot.waitsForRelease, false);
  assert.equal(shot.trajectory, undefined);
});

test('parses the Lua the client\'s motion scripts use', async () => {
  const { parseMotionScript } = await load('missile-motion.mjs');
  assert.deepEqual(parseMotionScript('local a = -2 ^ 2 -- comment\nb = 1 + 2 * 3'), [
    ['set', 'a', ['neg', ['op', '^', ['num', 2], ['num', 2]]], true],
    ['set', 'b', ['op', '+', ['num', 1], ['op', '*', ['num', 2], ['num', 3]]], false],
  ]);
  const first = [['op', 'and', ['op', '<', ['var', 'x'], ['num', 1]], ['op', '>=', ['var', 'y'], ['num', 2]]], [['set', 'z', ['num', 1], false]]];
  const second = [['op', '==', ['var', 'x'], ['num', 2]], [['set', 'z', ['num', 2], false]]];
  const otherwise = [['set', 'z', ['call', 'math.fmod', [['var', 'x'], ['num', 3]]], false]];
  assert.deepEqual(parseMotionScript('local slope\nif (x < 1 and y >= 2) then z = 1 elseif x == 2 then z = 2 else z = math.fmod(x, 3) end'), [
    ['set', 'slope', ['nil'], true],
    ['if', [first, second], otherwise],
  ]);
  assert.throws(() => parseMotionScript('while true do end'), /motion script/);
});

test('runs a motion script as the client does: degrees for sin and cos, unset outputs 0, nil arithmetic fails', () => {
  const { runMotionScript } = loadModule('../renderer/scripts/utils/missile-motion.ts');
  const inputs = {
    progress: 0.5, time: 1, missileIndex: 2, missileCount: 4, distanceToFirePos: 5, distanceToImpactPos: 5, startDistance: 10,
    totalDistance: 10, rand1: 0.1, rand2: 0.2, rand3: 0.3, spellID: 1,
  };
  // Spiral Vortex's angle: each missile its share of the circle, turning.
  const out = runMotionScript([
    ['set', 'transAngle', ['op', '+', ['op', '*', ['op', '/', ['var', 'missileIndex'], ['var', 'missileCount']], ['num', 360]], ['num', 0]], false],
    ['set', 'transMag', ['call', 'sin', [['num', 90]]], false],
    ['if', [[['op', '>', ['var', 'progress'], ['num', 0.4]], [['set', 'local1', ['num', 3], true], ['set', 'scale', ['var', 'local1'], false]]]], null],
  ], inputs);
  assert.equal(out.transAngle, 180);
  near(out.transMag, 1, 'sin of 90 degrees');
  assert.equal(out.scale, 3);
  assert.equal(out.transUp, 0);
  assert.throws(() => runMotionScript([['set', 'speedAbs', ['op', '*', ['var', 'speedAbs'], ['num', 0.5]], false]], inputs), /non-number/);
});

test('flies a missile: sped up to land on time, along a gravity arc, bent by its script', () => {
  const { MissileFlight, trajectoryVelocity } = loadModule('../renderer/scripts/utils/missile-flight.ts');
  // Released half a second after the cast, 20 yards out at 20 yards a
  // second: it has half a second left, so it flies twice as fast.
  const flight = new MissileFlight({ launch: [0, 0, 0], casterAt: [0, 0, 0], releaseAt: 500, castAt: 0, arriveAt: 1000, speed: 20 }, [20, 0, 0]);
  assert.equal(flight.currentSpeed, 40);
  near(flight.step(750, [20, 0, 0]).position[0], 10, 'half way');
  assert.equal(flight.step(1000, [20, 0, 0]).arrived, true);
  // Never faster than twice its speed.
  const late = new MissileFlight({ launch: [0, 0, 0], casterAt: [0, 0, 0], releaseAt: 2000, castAt: 0, arriveAt: 1000, speed: 20 }, [20, 0, 0]);
  assert.equal(late.currentSpeed, 40);

  // A 45 degree arc 20 yards out on level ground under 19.29 gravity.
  const arc = trajectoryVelocity(Math.PI / 4, [20, 0, 0], 19.29);
  near(arc.velocity[0], arc.velocity[2], 'as fast up as along');
  near(arc.velocity[0] * arc.time, 20, 'lands 20 yards on');
  const lobbed = new MissileFlight({
    launch: [0, 0, 0], casterAt: [0, 0, 0], releaseAt: 0, castAt: 0, arriveAt: arc.time * 1000, speed: 20,
    trajectory: { gravity: 19.29, pitch: [Math.PI / 4, Math.PI / 4], speed: [20, 20] },
  }, [20, 0, 0]);
  const top = lobbed.step(arc.time * 500, [20, 0, 0]);
  near(top.position[0], 10, 'half way along');
  assert.ok(top.position[2] > 4, 'high in the middle');

  // Parabola: up by its height at the middle, through an angle of 0.
  const curved = new MissileFlight({
    launch: [0, 0, 0], casterAt: [0, 0, 0], releaseAt: 0, castAt: 0, arriveAt: 1000, speed: 20,
    motion: { count: 1, script: [['set', 'transMag', ['num', 3], false]] },
  }, [20, 0, 0]);
  curved.step(0, [20, 0, 0]);
  const frame = curved.step(500, [20, 0, 0]);
  near(frame.position[0], 10, 'along');
  near(frame.position[2], 3, 'lifted');
});

test('decodes the chain IDs a combo packs', async () => {
  const { decodeChainId } = await load('spell-visuals.mjs');
  // Drain Life's and Chain Heal's combos, as the client data packs them.
  assert.equal(decodeChainId(0x03010351), 720);
  assert.equal(decodeChainId(0x1301035b), 731);
  assert.equal(decodeChainId(0x13010361), 737);
});

test('kits colour their unit as the client does: procedure 1 while they play, 13 as a flash fading to white', () => {
  const { DEFAULT_ALPHA_FADE_MS, flashColor, kitAlpha, kitColor, kitColorFlash } = loadModule('../renderer/scripts/utils/spell-kits.ts');
  const kit = (procs) => ({ id: 1, anim: -1, effects: [], procs });
  // Frostbolt's slow: only the colour counts.
  assert.equal(kitColor(kit([{ code: 1, params: [3947775, 0, 0, 3] }])), 0x3c3cff);
  assert.equal(kitColor(kit([{ code: 9, params: [0, 5, 0, 0] }])), null);
  const flash = kitColorFlash(kit([{ code: 13, params: [0xff0000, 0.5, 1, 0] }]));
  assert.deepEqual(plain(flash), { color: 0xff0000, holdMs: 500, fadeMs: 1000 });
  assert.equal(flashColor(flash, 100), 0xff0000);
  assert.equal(flashColor(flash, 1000), 0xff8080);
  assert.equal(flashColor(flash, 1500), null);
  assert.equal(kitColorFlash(kit([])), null);
  // Shadowform: dark purple, and 0.65 opaque reached over two seconds.
  const shadowform = kit([{ code: 1, params: [2555970, 0.2, 2, 0] }, { code: 14, params: [0.65, 0, 2, 0] }]);
  assert.equal(kitColor(shadowform), 0x270042);
  assert.deepEqual(plain(kitAlpha(shadowform)), { alpha: 0.65, fadeMs: 2000 });
  assert.equal(kitAlpha(kit([{ code: 14, params: [0.5, 0, 0, 0] }])).fadeMs, DEFAULT_ALPHA_FADE_MS);
  // Fully see-through, as the client allows; past 1 is ignored.
  assert.deepEqual(plain(kitAlpha(kit([{ code: 14, params: [0, 0, 1, 0] }]))), { alpha: 0, fadeMs: 1000 });
  assert.equal(kitAlpha(kit([{ code: 14, params: [1.5, 0, 1, 0] }])), null);
});

test('kits trail weapons, freeze a unit, and fade it for a moment', () => {
  const { fadeAlpha, kitClips, kitFade, kitFreeze, kitWeaponTrail } = loadModule('../renderer/scripts/utils/spell-kits.ts');
  const kit = (procs, extra = {}) => ({ id: 1, anim: -1, effects: [], procs, ...extra });
  // Heroic Strike's trail: colour, 1000 ms, opacity 100 of 255.
  assert.deepEqual(plain(kitWeaponTrail(kit([{ code: 8, params: [14355216, 20, 1000, 100] }]))),
    { color: 14355216, alpha: 100 / 255, durationMs: 1000 });
  assert.equal(kitWeaponTrail(kit([{ code: 8, params: [14355216, 20, 0, 100] }])), null);
  assert.deepEqual(plain(kitFreeze(kit([{ code: 11, params: [0.5, 0, 0, 0] }]))), { atMs: 500 });
  assert.deepEqual(plain(kitFreeze(kit([{ code: 11, params: [0, 0, 0, 0] }]))), { atMs: null });
  const fade = kitFade(kit([{ code: 15, params: [0.6, 2, 500, 1000] }]));
  assert.deepEqual(plain(fade), { alpha: 0.6, holdMs: 1000, backMs: 500 });
  near(fadeAlpha(fade, 250), 0.8, 'fading out');
  near(fadeAlpha(fade, 1000), 0.6, 'held');
  near(fadeAlpha(fade, 1750), 0.8, 'fading back');
  assert.equal(fadeAlpha(fade, 2000), null);
  assert.equal(kitFade(kit([{ code: 15, params: [0.6, 12, 500, 1000] }])), null);
  assert.deepEqual(plain(kitClips(kit([], { animClips: ['SpellCastDirected', 'SpellCastOmni'] }))), ['SpellCastDirected', 'SpellCastOmni']);
  assert.equal(kitClips(kit([])), null);
});

// A chain with nothing set but these, for the bolt tests.
function chainOf(fields) {
  return {
    id: 1, segmentLength: 1, width: 0.5, noise: 0, scrollSpeed: 0, segmentMs: 1000, delayMs: 0, linkDelayMs: 0, flags: 0,
    jointCount: 0, jointOffsetRadius: 0, jointsPerMinorJoint: 0, minorJointsPerMajorJoint: 0, minorJointScale: 0, majorJointScale: 0,
    jointMoveSpeed: 0, jointSmoothness: 0, minJointJump: 0, maxJointJump: 0, waveHeight: 0, waveFrequency: 0, waveSpeed: 0,
    minWaveAngle: 0, maxWaveAngle: 0, minWaveSpin: 0, maxWaveSpin: 0, wavePhase: 0, arcHeight: 0, minArcAngle: 0, maxArcAngle: 0,
    minArcSpin: 0, maxArcSpin: 0, minFlickerOn: 0, maxFlickerOn: 0, minFlickerOff: 0, maxFlickerOff: 0, pulseSpeed: 0,
    pulseOnLength: 0, pulseFadeLength: 0, color: 0xffffff, alpha: 1, blendMode: 3, renderLayer: 0, textureLength: 1, ...fields,
  };
}
const half = () => 0.5;
// Looking down the Z axis, so the strip lies across Y.
const DOWN_VIEW = [0, 0, -1];

test('builds a straight bolt pinched at its ends, as wide as twice its width', () => {
  const { LightningBolt } = loadModule('../renderer/scripts/utils/lightning.ts');
  const bolt = new LightningBolt(chainOf({}), half);
  bolt.update(0.016, [0, 0, 0], [10, 0, 0]);
  // A joint each segment length, two more, and one for the end.
  assert.equal(bolt.jointCount, 13);
  const strip = bolt.build(DOWN_VIEW);
  const vertex = (index) => [...strip.positions.slice(index * 3, index * 3 + 3)];
  assert.deepEqual(vertex(0), [0, 0, 0]);
  assert.deepEqual(vertex(1), [0, 0, 0]);
  assert.deepEqual(vertex(25), [10, 0, 0]);
  // A middle joint's pair straddles the line, a width each side.
  near(vertex(12)[0], 5, 'along');
  near(Math.abs(vertex(12)[1] - vertex(13)[1]), 1, 'across');
  assert.deepEqual([strip.start, strip.count], [0, 26]);
  // Texture: 0 to 1 along it, the ends at its middle row.
  assert.deepEqual([...strip.uvs.slice(0, 2)], [-0.5, 0.5]);
  near(strip.uvs[24 * 2], 1 - 0.5, 'end u');

  const fixed = new LightningBolt(chainOf({ flags: 0x1, jointCount: 27 }), half);
  fixed.update(0.016, [0, 0, 0], [10, 0, 0]);
  assert.equal(fixed.jointCount, 28);
});

test('jitters joints off the line, bends with an arc, and stretches the texture by length', () => {
  const { LightningBolt } = loadModule('../renderer/scripts/utils/lightning.ts');
  const jittered = new LightningBolt(chainOf({ jointOffsetRadius: 0.5 }), () => 1);
  jittered.update(0.016, [0, 0, 0], [10, 0, 0]);
  const strip = jittered.build(DOWN_VIEW);
  // Every joint pushed the full radius across (y) and up (z).
  near(strip.positions[12 * 3 + 2], 0.5, 'up');
  const arced = new LightningBolt(chainOf({ arcHeight: 2 }), half);
  arced.update(0.016, [0, 0, 0], [10, 0, 0]);
  // At the middle the arc's whole height, straight up with angle 0.
  near(arced.build(DOWN_VIEW).positions[12 * 3 + 2], 2, 'arc');
  const long = new LightningBolt(chainOf({ flags: 0x100, textureLength: 2.5 }), half);
  long.update(0.016, [0, 0, 0], [10, 0, 0]);
  near(long.build(DOWN_VIEW).uvs[24 * 2], 4 - 0.5, 'four texture lengths');
});

test('a pulse lights only the stretch it has reached, and a flicker turns the bolt off', () => {
  const { LightningBolt } = loadModule('../renderer/scripts/utils/lightning.ts');
  const pulse = new LightningBolt(chainOf({ flags: 0x20, pulseSpeed: 10, pulseOnLength: 2, pulseFadeLength: 1 }), half);
  pulse.update(0.55, [0, 0, 0], [10, 0, 0]);
  // The pulse's head is 5.5 yards along: fading in from 1.5 to 2.5 yards,
  // lit to 4.5, fading out to 5.5, and nothing ahead. Joints are 10/12
  // yards apart.
  const strip = pulse.build(DOWN_VIEW);
  near(strip.alphas[2 * 2], 2 * 10 / 12 - 1.5, 'fading in');
  assert.equal(strip.alphas[4 * 2], 1);
  near(strip.alphas[6 * 2], 5.5 - 5, 'fading out');
  // Drawing stops at the joint past the head, 5.8 yards along.
  assert.equal(strip.alphas[7 * 2], 0);
  assert.equal(strip.start + strip.count, 7 * 2 + 1);
  const flicker = new LightningBolt(chainOf({ flags: 0x10, minFlickerOn: 0.1, maxFlickerOn: 0.1, minFlickerOff: 1, maxFlickerOff: 1 }), half);
  flicker.update(0.2, [0, 0, 0], [10, 0, 0]);
  assert.equal(flicker.build(DOWN_VIEW), null);
  flicker.update(1.1, [0, 0, 0], [10, 0, 0]);
  assert.ok(flicker.build(DOWN_VIEW));
});

test('places joints in a hierarchy of major and minor joints', () => {
  const { LightningBolt } = loadModule('../renderer/scripts/utils/lightning.ts');
  const bolt = new LightningBolt(chainOf({
    flags: 0x2, jointOffsetRadius: 0.1, jointsPerMinorJoint: 3, minorJointsPerMajorJoint: 4, minorJointScale: 3.7, majorJointScale: 8.45,
  }), () => 1);
  bolt.update(0.016, [0, 0, 0], [30, 0, 0]);
  const strip = bolt.build(DOWN_VIEW);
  assert.ok([...strip.positions].every(Number.isFinite));
  // Major joints (every 12th) sit their scale times the radius up off the line.
  near(strip.positions[12 * 2 * 3 + 2], 0.845, 'major joint up');
  near(strip.positions[24 * 2 * 3 + 2], 0.845, 'second major joint up');
});
