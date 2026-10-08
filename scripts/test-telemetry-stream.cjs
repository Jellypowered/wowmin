const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

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

const { parseStreamDatagram } = loadModule('../src/telemetry-stream.ts');
const { LivePositionBuffer, LIVE_RENDER_DELAY_MS, lerpAngle } = loadModule('../renderer/scripts/utils/live-positions.ts');
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-4, `${label}: ${actual} != ${expected}`);

// Builds a datagram exactly as BuildStreamDatagrams in WowMinTelemetry.cpp does.
function datagram({ mapId = 601, instanceId = 7, sequence = 1, serverTimeMs = 5000, part = 0, partCount = 1, players }) {
  const header = Buffer.alloc(28);
  header.write('WMS1', 0, 'latin1');
  header.writeUInt8(1, 4);
  header.writeUInt8(part, 5);
  header.writeUInt8(partCount, 6);
  header.writeUInt32LE(mapId, 8);
  header.writeUInt32LE(instanceId, 12);
  header.writeUInt32LE(sequence, 16);
  header.writeUInt32LE(serverTimeMs, 20);
  header.writeUInt16LE(players.length, 24);
  const records = players.map((player) => {
    const name = Buffer.from(player.name, 'utf8');
    const record = Buffer.alloc(30);
    record.writeUInt32LE(player.guid, 0);
    record.writeFloatLE(player.x, 4);
    record.writeFloatLE(player.y, 8);
    record.writeFloatLE(player.z, 12);
    record.writeFloatLE(player.orientation, 16);
    record.writeUInt8(player.healthPct, 20);
    record.writeUInt8(player.powerPct, 21);
    record.writeInt8(player.powerType, 22);
    record.writeUInt8(player.flags, 23);
    record.writeUInt8(player.stateFlags, 24);
    record.writeUInt8(name.length, 25);
    record.writeInt32LE(player.wmoGroupId, 26);
    return Buffer.concat([record, name]);
  });
  return Buffer.concat([header, ...records]);
}

const tankard = { guid: 42, name: 'Tankard', x: 529.5, y: 652.25, z: 777.5, orientation: 1.5, healthPct: 87,
  powerPct: 30, powerType: 1, flags: 3, stateFlags: 2, wmoGroupId: 25050 };

test('parses a stream datagram into session and player state', () => {
  const parsed = parseStreamDatagram(datagram({ sequence: 9, players: [tankard, { ...tankard, guid: 7, name: 'Wéb', flags: 4, wmoGroupId: -1 }] }));
  assert.equal(parsed.mapId, 601);
  assert.equal(parsed.instanceId, 7);
  assert.equal(parsed.sequence, 9);
  assert.equal(parsed.partCount, 1);
  const [first, second] = parsed.players;
  assert.equal(first.name, 'Tankard');
  assert.equal(first.guid, 42);
  near(first.x, 529.5, 'x');
  near(first.orientation, 1.5, 'orientation');
  assert.equal(first.healthPct, 87);
  assert.equal(first.powerType, 1);
  assert.equal(first.alive, true);
  assert.equal(first.inCombat, true);
  assert.equal(first.waitingForResurrect, false);
  assert.equal(first.stateFlags, 2);
  assert.equal(first.wmoGroupId, 25050);
  assert.equal(second.name, 'Wéb');
  assert.equal(second.alive, false);
  assert.equal(second.waitingForResurrect, true);
  assert.equal(second.wmoGroupId, -1);
});

test('rejects foreign, truncated, and malformed datagrams', () => {
  const good = datagram({ players: [tankard] });
  assert.equal(parseStreamDatagram(Buffer.from('nonsense')), null);
  assert.equal(parseStreamDatagram(Buffer.concat([Buffer.from('XXXX'), good.subarray(4)])), null);
  assert.equal(parseStreamDatagram(good.subarray(0, good.length - 3)), null);
  assert.equal(parseStreamDatagram(datagram({ part: 2, partCount: 2, players: [] })), null);
});

test('interpolates between stream samples a little behind live', () => {
  const buffer = new LivePositionBuffer();
  const frame = (x, orientation) => ({ mapId: 601, instanceId: 7, sequence: 1, serverTimeMs: 0,
    players: [{ ...tankard, x, orientation, alive: true }] });
  buffer.push(frame(500, 0.2), 1000);
  buffer.push(frame(510, 0.4), 1100);
  near(buffer.sampleAt('Tankard', 1050 + LIVE_RENDER_DELAY_MS).x, 505, 'halfway');
  near(buffer.sampleAt('Tankard', 1050 + LIVE_RENDER_DELAY_MS).orientation, 0.3, 'facing');
  assert.equal(buffer.sampleAt('Tankard', 2000).x, 510, 'holds the newest sample');
  assert.equal(buffer.sampleAt('Tankard', 1100 + 2001), null, 'stale');
  assert.equal(buffer.sampleAt('Nobody', 1100), null);
});

test('snaps across teleports instead of sliding', () => {
  const buffer = new LivePositionBuffer();
  const frame = (x) => ({ mapId: 601, instanceId: 7, sequence: 1, serverTimeMs: 0, players: [{ ...tankard, x }] });
  buffer.push(frame(0), 1000);
  buffer.push(frame(400), 1100);
  assert.equal(buffer.sampleAt('Tankard', 1050 + LIVE_RENDER_DELAY_MS).x, 400);
});

test('turns the short way round when interpolating facing', () => {
  near(lerpAngle(6.2, 0.1, 0.5), 6.2 + (0.1 + Math.PI * 2 - 6.2) / 2, 'across zero');
  near(lerpAngle(0.1, 6.2, 0.5), 0.1 - (0.1 + Math.PI * 2 - 6.2) / 2, 'backwards across zero');
});

test('overlays live fields on the polled player record and keeps the rest', () => {
  const { applyLiveSample } = loadModule('../renderer/scripts/utils/live-positions.ts');
  const polled = { name: 'Tankard', class: 1, level: 80, position_x: 0, position_y: 0, position_z: 0, orientation: 0,
    alive: true, inCombat: false, healthPct: 100, wmoGroupId: 1, mounted: false };
  const live = applyLiveSample(polled, { ...tankard, alive: false, inCombat: true, waitingForResurrect: true, stateFlags: 2 | 32 });
  assert.equal(live.class, 1);
  assert.equal(live.level, 80);
  near(live.position_x, 529.5, 'x');
  assert.equal(live.healthPct, 87);
  assert.equal(live.alive, false);
  assert.equal(live.inCombat, true);
  assert.equal(live.mounted, true);
  assert.equal(live.flagCarrier, true);
  assert.equal(live.stunned, false);
  assert.equal(live.wmoGroupId, 25050);
});
