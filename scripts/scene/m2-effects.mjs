// Reads an M2's particle emitters and ribbons (3.3.5, version 264), which
// @wowserhq/format leaves unparsed. Layouts from wowdev.wiki's M2 page
// (M2ParticleOld and M2Ribbon, Wrath branch). Everything stays in M2 model
// space: Z up, facing +X.

// Header offsets of the ribbon and particle emitter arrays.
const M2_RIBBONS_OFFSET = 288;
const M2_PARTICLES_OFFSET = 296;
export const PARTICLE_SIZE = 476;
export const RIBBON_SIZE = 176;
const FIXED16_ONE = 32767;

const reader = (width, read) => ({ width, read });
export const FLOAT = reader(4, (buffer, at) => buffer.readFloatLE(at));
const FIXED16 = reader(2, (buffer, at) => buffer.readInt16LE(at) / FIXED16_ONE);
const UINT16 = reader(2, (buffer, at) => buffer.readUInt16LE(at));
const UINT8 = reader(1, (buffer, at) => buffer.readUInt8(at));
const UINT32 = reader(4, (buffer, at) => buffer.readUInt32LE(at));
const VEC2 = { ...FLOAT, components: 2 };
export const VEC3 = { ...FLOAT, components: 3 };

function m2Array(buffer, at) {
  const count = buffer.readUInt32LE(at);
  const offset = buffer.readUInt32LE(at + 4);
  return { count, offset };
}

function readValues(buffer, { count, offset }, type) {
  const components = type.components ?? 1;
  const size = type.width * components;
  if (!count || offset + count * size > buffer.length) return [];
  const values = [];
  for (let index = 0; index < count; index += 1) {
    for (let component = 0; component < components; component += 1) {
      values.push(type.read(buffer, offset + index * size + component * type.width));
    }
  }
  return values;
}

// An M2Track (20 bytes): interpolation, global sequence, then per sequence a
// list of key times (ms) and values. Values are flat, `components` per key.
export function readTrack(buffer, at, type) {
  const interpolation = buffer.readUInt16LE(at);
  const globalSequence = buffer.readInt16LE(at + 2);
  const times = m2Array(buffer, at + 4);
  const values = m2Array(buffer, at + 12);
  const sequences = [];
  const count = Math.min(times.count, values.count);
  if (times.offset + count * 8 <= buffer.length && values.offset + count * 8 <= buffer.length) {
    for (let index = 0; index < count; index += 1) {
      sequences.push({
        times: readValues(buffer, m2Array(buffer, times.offset + index * 8), UINT32),
        values: readValues(buffer, m2Array(buffer, values.offset + index * 8), type),
      });
    }
  }
  return { interpolation, globalSequence, sequences };
}

// A "fake" animation block (16 bytes): key times as fractions of a
// particle's life (fixed16), and their values. It never changes with the
// animation playing.
export function readFBlock(buffer, at, type) {
  const times = readValues(buffer, m2Array(buffer, at), FIXED16);
  const values = readValues(buffer, m2Array(buffer, at + 8), type);
  return { times, values };
}

function readString(buffer, at) {
  const { count, offset } = m2Array(buffer, at);
  if (!count || offset + count > buffer.length) return null;
  const end = buffer.indexOf(0, offset);
  return buffer.toString('latin1', offset, end < 0 || end > offset + count ? offset + count : end) || null;
}

// Gravity keys as vectors down Z. The 3.3.5 client reads gravity as a plain
// float whatever the flags say; compressed gravity came later.
function readGravity(buffer, at) {
  const track = readTrack(buffer, at, FLOAT);
  return { ...track, sequences: track.sequences.map(({ times, values }) => ({ times, values: values.flatMap((value) => [0, 0, -value]) })) };
}

export function parseParticleEmitter(buffer, at) {
  const flags = buffer.readUInt32LE(at + 0x04);
  return {
    flags,
    position: readValues(buffer, { count: 1, offset: at + 0x08 }, VEC3),
    bone: buffer.readUInt16LE(at + 0x14),
    texture: buffer.readUInt16LE(at + 0x16),
    modelFilename: readString(buffer, at + 0x18),
    childEmittersFilename: readString(buffer, at + 0x20),
    blendingType: buffer.readUInt8(at + 0x28),
    emitterType: buffer.readUInt8(at + 0x29),
    particleColorIndex: buffer.readUInt16LE(at + 0x2A),
    particleType: buffer.readUInt8(at + 0x2C),
    headOrTail: buffer.readUInt8(at + 0x2D),
    priorityPlane: buffer.readInt16LE(at + 0x2E),
    rows: buffer.readUInt16LE(at + 0x30),
    columns: buffer.readUInt16LE(at + 0x32),
    emissionSpeed: readTrack(buffer, at + 0x34, FLOAT),
    speedVariation: readTrack(buffer, at + 0x48, FLOAT),
    verticalRange: readTrack(buffer, at + 0x5C, FLOAT),
    horizontalRange: readTrack(buffer, at + 0x70, FLOAT),
    // As vectors (x, y, z) per key, pointing down Z.
    gravity: readGravity(buffer, at + 0x84),
    lifespan: readTrack(buffer, at + 0x98, FLOAT),
    lifespanVariation: buffer.readFloatLE(at + 0xAC),
    emissionRate: readTrack(buffer, at + 0xB0, FLOAT),
    emissionRateVariation: buffer.readFloatLE(at + 0xC4),
    emissionAreaWidth: readTrack(buffer, at + 0xC8, FLOAT),
    emissionAreaLength: readTrack(buffer, at + 0xDC, FLOAT),
    zSource: readTrack(buffer, at + 0xF0, FLOAT),
    // Over each particle's life; colour in 0-255.
    color: readFBlock(buffer, at + 0x104, VEC3),
    alpha: readFBlock(buffer, at + 0x114, FIXED16),
    scale: readFBlock(buffer, at + 0x124, VEC2),
    scaleVary: readValues(buffer, { count: 1, offset: at + 0x134 }, VEC2),
    headCell: readFBlock(buffer, at + 0x13C, UINT16),
    tailCell: readFBlock(buffer, at + 0x14C, UINT16),
    tailLength: buffer.readFloatLE(at + 0x15C),
    twinkleSpeed: buffer.readFloatLE(at + 0x160),
    twinklePercent: buffer.readFloatLE(at + 0x164),
    twinkleScale: readValues(buffer, { count: 1, offset: at + 0x168 }, VEC2),
    inheritVelocityScale: buffer.readFloatLE(at + 0x170),
    drag: buffer.readFloatLE(at + 0x174),
    baseSpin: buffer.readFloatLE(at + 0x178),
    baseSpinVariation: buffer.readFloatLE(at + 0x17C),
    spin: buffer.readFloatLE(at + 0x180),
    spinVariation: buffer.readFloatLE(at + 0x184),
    tumble: readValues(buffer, { count: 2, offset: at + 0x188 }, VEC3),
    wind: readValues(buffer, { count: 1, offset: at + 0x1A0 }, VEC3),
    windTime: buffer.readFloatLE(at + 0x1AC),
    followSpeed1: buffer.readFloatLE(at + 0x1B0),
    followScale1: buffer.readFloatLE(at + 0x1B4),
    followSpeed2: buffer.readFloatLE(at + 0x1B8),
    followScale2: buffer.readFloatLE(at + 0x1BC),
    splinePoints: readValues(buffer, m2Array(buffer, at + 0x1C0), VEC3),
    enabled: readTrack(buffer, at + 0x1C8, UINT8),
  };
}

export function parseRibbon(buffer, at) {
  return {
    // A uint16 and padding, as the client reads it.
    bone: buffer.readUInt16LE(at + 0x04),
    position: readValues(buffer, { count: 1, offset: at + 0x08 }, VEC3),
    textures: readValues(buffer, m2Array(buffer, at + 0x14), UINT16),
    materials: readValues(buffer, m2Array(buffer, at + 0x1C), UINT16),
    color: readTrack(buffer, at + 0x24, VEC3),
    alpha: readTrack(buffer, at + 0x38, FIXED16),
    heightAbove: readTrack(buffer, at + 0x4C, FLOAT),
    heightBelow: readTrack(buffer, at + 0x60, FLOAT),
    edgesPerSecond: buffer.readFloatLE(at + 0x74),
    edgeLifetime: buffer.readFloatLE(at + 0x78),
    gravity: buffer.readFloatLE(at + 0x7C),
    rows: buffer.readUInt16LE(at + 0x80),
    columns: buffer.readUInt16LE(at + 0x82),
    textureSlot: readTrack(buffer, at + 0x84, UINT16),
    visibility: readTrack(buffer, at + 0x98, UINT8),
    priorityPlane: buffer.readInt16LE(at + 0xAC),
  };
}

function readRecords(buffer, headerOffset, size, parse) {
  if (!buffer || buffer.length < headerOffset + 8) return [];
  const { count, offset } = m2Array(buffer, headerOffset);
  if (!count || offset + count * size > buffer.length) return [];
  return Array.from({ length: count }, (_, index) => parse(buffer, offset + index * size));
}

export function parseParticleEmitters(buffer) {
  return readRecords(buffer, M2_PARTICLES_OFFSET, PARTICLE_SIZE, parseParticleEmitter);
}

export function parseRibbons(buffer) {
  return readRecords(buffer, M2_RIBBONS_OFFSET, RIBBON_SIZE, parseRibbon);
}

