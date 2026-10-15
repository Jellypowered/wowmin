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
  const context = { module: { exports: {} }, require, Buffer, console, setInterval, clearInterval };
  context.exports = context.module.exports;
  vm.runInNewContext(output, context);
  return context.module.exports;
}

const {
  TelemetryStream,
  parseBotDatagram, parseCombatEventDatagram, parseCreatureDatagram, parseDebuffDatagram, parseGameObjectDatagram, parseMarkerDatagram, parsePassengerDatagram, parsePathDatagram, parseStreamDatagram, parseUnitAuraDatagram,
} = loadModule('../src/telemetry-stream.ts');
const {
  LIVE_AURA_STALE_MS, LIVE_BOT_STALE_MS, LIVE_CREATURE_STALE_MS, LIVE_PATH_STALE_MS, LIVE_RENDER_DELAY_MS, LiveAuraStore, LiveBotStore,
  LiveCreatureBuffer,
  LivePathStore, LivePositionBuffer,
  creaturePathKey, lerpAngle, trimPathToPosition,
} = loadModule('../renderer/scripts/utils/live-positions.ts');
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-4, `${label}: ${actual} != ${expected}`);

// Builds a datagram exactly as BuildStreamDatagrams in WowMinTelemetry.cpp does.
function datagram({ version = 2, mapId = 601, instanceId = 7, sequence = 1, serverTimeMs = 5000, part = 0, partCount = 1, players }) {
  const header = Buffer.alloc(28);
  header.write('WMS1', 0, 'latin1');
  header.writeUInt8(version, 4);
  header.writeUInt8(part, 5);
  header.writeUInt8(partCount, 6);
  header.writeUInt32LE(mapId, 8);
  header.writeUInt32LE(instanceId, 12);
  header.writeUInt32LE(sequence, 16);
  header.writeUInt32LE(serverTimeMs, 20);
  header.writeUInt16LE(players.length, 24);
  const records = players.map((player) => {
    const name = Buffer.from(player.name, 'utf8');
    const record = Buffer.alloc(version >= 2 ? 31 : 30);
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
    if (version >= 2) {
      record.writeUInt8(player.roleMask ?? 0, 25);
      record.writeUInt8(name.length, 26);
      record.writeInt32LE(player.wmoGroupId, 27);
    } else {
      record.writeUInt8(name.length, 25);
      record.writeInt32LE(player.wmoGroupId, 26);
    }
    return Buffer.concat([record, name]);
  });
  return Buffer.concat([header, ...records]);
}

const tankard = { guid: 42, name: 'Tankard', x: 529.5, y: 652.25, z: 777.5, orientation: 1.5, healthPct: 87,
  powerPct: 30, powerType: 1, flags: 3, stateFlags: 2, roleMask: 2, wmoGroupId: 25050 };

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
  assert.equal(first.roleMask, 2);
  assert.equal(first.wmoGroupId, 25050);
  assert.equal(second.name, 'Wéb');
  assert.equal(second.alive, false);
  assert.equal(second.waitingForResurrect, true);
  assert.equal(second.wmoGroupId, -1);
});

test('keeps accepting version 1 stream players without a role mask', () => {
  const parsed = parseStreamDatagram(datagram({ version: 1, players: [tankard] }));
  assert.equal(parsed.players[0].name, 'Tankard');
  assert.equal(parsed.players[0].roleMask, undefined);
  assert.equal(parsed.players[0].wmoGroupId, 25050);
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
  assert.equal([...buffer.samples(1050 + LIVE_RENDER_DELAY_MS)].map((sample) => sample.name).join(','), 'Tankard');
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
    alive: true, inCombat: false, healthPct: 100, roleMask: 0, wmoGroupId: 1, mounted: false };
  const live = applyLiveSample(polled, { ...tankard, alive: false, inCombat: true, waitingForResurrect: true,
    roleMask: 4, stateFlags: 2 | 32 | 64 });
  assert.equal(live.class, 1);
  assert.equal(live.level, 80);
  near(live.position_x, 529.5, 'x');
  assert.equal(live.healthPct, 87);
  assert.equal(live.alive, false);
  assert.equal(live.inCombat, true);
  assert.equal(live.roleMask, 4);
  assert.equal(live.mounted, true);
  assert.equal(live.flagCarrier, true);
  assert.equal(live.flying, true);
  assert.equal(live.stunned, false);
  assert.equal(live.sitting, false);
  assert.equal(live.wmoGroupId, 25050);
  assert.equal(applyLiveSample(polled, { ...tankard, stateFlags: 128 }).sitting, true);
});

// Builds a path datagram exactly as BuildPathDatagrams in WowMinTelemetry.cpp does.
function pathDatagram({ mapId = 601, instanceId = 7, serverTimeMs = 5000, paths }) {
  const header = Buffer.alloc(24);
  header.write('WMP1', 0, 'latin1');
  header.writeUInt8(1, 4);
  header.writeUInt32LE(mapId, 8);
  header.writeUInt32LE(instanceId, 12);
  header.writeUInt32LE(serverTimeMs, 16);
  header.writeUInt16LE(paths.length, 20);
  const entries = paths.map((path) => {
    const entry = Buffer.alloc(12 + path.points.length * 12);
    entry.writeUInt32LE(path.guid, 0);
    entry.writeUInt32LE(path.splineId, 4);
    entry.writeUInt8(path.points.length, 8);
    entry.writeUInt8((path.truncated ? 1 : 0) | (path.creature ? 2 : 0), 9);
    path.points.forEach((point, index) => point.forEach((value, axis) => entry.writeFloatLE(value, 12 + index * 12 + axis * 4)));
    return entry;
  });
  return Buffer.concat([header, ...entries]);
}

test('parses a path datagram, including cleared and truncated paths', () => {
  const parsed = parsePathDatagram(pathDatagram({ paths: [
    { guid: 42, splineId: 9, truncated: true, points: [[1, 2, 3], [4.5, 5.5, 6.5]] },
    { guid: 43, splineId: 0, truncated: false, creature: true, points: [] },
  ] }));
  assert.equal(parsed.mapId, 601);
  assert.equal(parsed.instanceId, 7);
  assert.equal(parsed.serverTimeMs, 5000);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.paths)), [
    { guid: 42, splineId: 9, truncated: true, creature: false, points: [[1, 2, 3], [4.5, 5.5, 6.5]] },
    { guid: 43, splineId: 0, truncated: false, creature: true, points: [] },
  ]);
});

test('rejects truncated path datagrams and position datagrams', () => {
  const good = pathDatagram({ paths: [{ guid: 1, splineId: 2, points: [[1, 2, 3]] }] });
  assert.equal(parsePathDatagram(good.subarray(0, good.length - 1)), null);
  assert.equal(parsePathDatagram(datagram({ players: [] })), null);
  assert.equal(parseStreamDatagram(good), null);
});

test('keeps the latest path per player until it is cleared or goes stale', () => {
  const store = new LivePathStore();
  const path = (name, points) => ({ guid: 1, name, splineId: 3, truncated: false, creature: false, points });
  store.push({ paths: [path('Bot', [[1, 1, 1]])] }, 1000);
  assert.deepEqual(store.get('Bot', 1500).points, [[1, 1, 1]]);
  store.push({ paths: [path('Bot', [])] }, 1600);
  assert.equal(store.get('Bot', 1700), null);
  store.push({ paths: [path('Bot', [[2, 2, 2]])] }, 2000);
  assert.equal(store.get('Bot', 2000 + LIVE_PATH_STALE_MS + 1), null);
});

test('trims the waypoints a player has already walked past', () => {
  const points = [[10, 0, 0], [20, 0, 0], [20, 10, 0]];
  // Still heading for the first waypoint.
  assert.deepEqual(trimPathToPosition(points, [2, 0, 0]), points);
  // Past the first waypoint, on the way to the second.
  assert.deepEqual(trimPathToPosition(points, [15, 0, 0]), points.slice(1));
  // Round the corner, on the last leg.
  assert.deepEqual(trimPathToPosition(points, [20, 5, 0]), points.slice(2));
  assert.deepEqual(trimPathToPosition([[1, 1, 1]], [0, 0, 0]), [[1, 1, 1]]);
});

test('keys creature paths by guid, apart from players with the same guid', () => {
  const store = new LivePathStore();
  store.push({ paths: [
    { guid: 5, name: 'Bot', splineId: 1, truncated: false, creature: false, points: [[1, 1, 1]] },
    { guid: 5, name: '', splineId: 2, truncated: false, creature: true, points: [[2, 2, 2]] },
  ] }, 0);
  assert.deepEqual(store.get('Bot', 0).points, [[1, 1, 1]]);
  assert.deepEqual(store.get(creaturePathKey(5), 0).points, [[2, 2, 2]]);
});

// Builds a creature datagram exactly as BuildCreatureDatagrams in WowMinTelemetry.cpp does.
function creatureDatagram({ mapId = 601, instanceId = 7, serverTimeMs = 5000, creatures }) {
  const header = Buffer.alloc(24);
  header.write('WMC1', 0, 'latin1');
  header.writeUInt8(1, 4);
  header.writeUInt32LE(mapId, 8);
  header.writeUInt32LE(instanceId, 12);
  header.writeUInt32LE(serverTimeMs, 16);
  header.writeUInt16LE(creatures.length, 20);
  return Buffer.concat([header, ...creatures.map((creature) => {
    const entry = Buffer.alloc(36);
    entry.writeUInt32LE(creature.guid, 0);
    entry.writeUInt32LE(creature.entry, 4);
    [creature.x, creature.y, creature.z, creature.orientation].forEach((value, index) => entry.writeFloatLE(value, 8 + index * 4));
    entry.writeUInt8(creature.healthPct, 24);
    entry.writeUInt8(creature.flags, 25);
    entry.writeUInt32LE(creature.targetGuid, 28);
    entry.writeInt32LE(creature.wmoGroupId, 32);
    return entry;
  })]);
}

test('parses a creature datagram and its state flags', () => {
  const parsed = parseCreatureDatagram(creatureDatagram({ creatures: [
    { guid: 900, entry: 29120, x: 550, y: 250, z: 224, orientation: 1.5, healthPct: 64, flags: 1 | 2 | 4 | 8 | 32, targetGuid: 42, wmoGroupId: 24879 },
    { guid: 901, entry: 28684, x: 1, y: 2, z: 3, orientation: 0, healthPct: 0, flags: 16 | 64, targetGuid: 0, wmoGroupId: -1 },
  ] }));
  assert.equal(parsed.mapId, 601);
  assert.equal(parsed.instanceId, 7);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.creatures)), [
    { guid: 900, entry: 29120, x: 550, y: 250, z: 224, orientation: 1.5, healthPct: 64, alive: true, inCombat: true,
      hostile: true, boss: true, playerControlled: false, targetIsPlayer: true, scenery: false, targetGuid: 42, wmoGroupId: 24879 },
    { guid: 901, entry: 28684, x: 1, y: 2, z: 3, orientation: 0, healthPct: 0, alive: false, inCombat: false,
      hostile: false, boss: false, playerControlled: true, targetIsPlayer: false, scenery: true, targetGuid: 0, wmoGroupId: -1 },
  ]);
  const good = creatureDatagram({ creatures: [{ guid: 1, entry: 2, x: 0, y: 0, z: 0, orientation: 0, healthPct: 1, flags: 1, targetGuid: 0, wmoGroupId: -1 }] });
  assert.equal(parseCreatureDatagram(good.subarray(0, good.length - 1)), null);
  assert.equal(parsePathDatagram(good), null);
});

// Builds a datagram as BuildCombatEventDatagrams in WowMinTelemetry.cpp does.
function combatDatagram({ mapId = 601, instanceId = 7, serverTimeMs = 5000, dropped = 0, events }) {
  const header = Buffer.alloc(24);
  header.write('WME1', 0, 'latin1');
  header.writeUInt8(1, 4);
  header.writeUInt32LE(mapId, 8);
  header.writeUInt32LE(instanceId, 12);
  header.writeUInt32LE(serverTimeMs, 16);
  header.writeUInt16LE(events.length, 20);
  header.writeUInt16LE(dropped, 22);
  return Buffer.concat([header, ...events.map((event) => {
    const entry = Buffer.alloc(44);
    entry.writeUInt8(event.kind, 0);
    entry.writeUInt8(event.flags ?? 0, 1);
    entry.writeUInt8(event.schoolMask ?? 0, 2);
    entry.writeUInt8(event.auraCategory ?? 0, 3);
    entry.writeUInt32LE(event.sourceGuid ?? 0, 4);
    entry.writeUInt32LE(event.targetGuid ?? 0, 8);
    entry.writeUInt32LE(event.spellId ?? 0, 12);
    entry.writeUInt32LE(event.value ?? 0, 16);
    entry.writeFloatLE(event.missileSpeed ?? 0, 20);
    entry.writeFloatLE(event.radius ?? 0, 24);
    (event.point ?? [0, 0, 0]).forEach((value, index) => entry.writeFloatLE(value, 28 + index * 4));
    entry.writeUInt16LE(event.ageMs ?? 0, 40);
    entry.writeUInt16LE(event.extraFlags ?? 0, 42);
    return entry;
  })]);
}

test('parses combat events, their flags, and the dropped count', () => {
  const parsed = parseCombatEventDatagram(combatDatagram({ dropped: 3, events: [
    { kind: 2, flags: 2 | 4 | 16 | 128, schoolMask: 16, sourceGuid: 42, targetGuid: 900, spellId: 10, value: 0,
      missileSpeed: 20, radius: 8, point: [550, 250, 224], ageMs: 35 },
    { kind: 4, flags: 1 | 64, schoolMask: 2, auraCategory: 2, sourceGuid: 901, targetGuid: 43, spellId: 48066, value: 30000 },
    { kind: 7, flags: 2 | 32, schoolMask: 32, sourceGuid: 42, targetGuid: 900, spellId: 48125, value: 812 },
    { kind: 2, sourceGuid: 2, spellId: 26573, schoolMask: 2, value: 8000, extraFlags: 1 },
    { kind: 99 },
    { kind: 6, flags: 1, schoolMask: 1, sourceGuid: 900, targetGuid: 42 },
  ] }));
  assert.equal(parsed.mapId, 601);
  assert.equal(parsed.serverTimeMs, 5000);
  assert.equal(parsed.dropped, 3);
  const events = JSON.parse(JSON.stringify(parsed.events));
  assert.deepEqual(events.map((event) => event.kind), ['castGo', 'auraApply', 'damage', 'castGo', 'swing']);
  assert.equal(events[3].persistentArea, true);
  assert.equal(events[3].value, 8000);
  assert.deepEqual(events[0], {
    kind: 'castGo', sourceCreature: false, targetCreature: true, area: true, channeled: false, periodic: false,
    helpful: false, triggered: true, schoolMask: 16, auraCategory: null, sourceGuid: 42, targetGuid: 900, spellId: 10,
    value: 0, missileSpeed: 20, radius: 8, point: [550, 250, 224], ageMs: 35, persistentArea: false,
  });
  assert.equal(events[1].auraCategory, 'shield');
  assert.equal(events[1].sourceCreature, true);
  assert.equal(events[1].helpful, true);
  assert.equal(events[1].point, null);
  assert.equal(events[2].periodic, true);
  assert.equal(events[2].value, 812);
  const good = combatDatagram({ events: [{ kind: 6 }] });
  assert.equal(parseCombatEventDatagram(good.subarray(0, good.length - 1)), null);
  assert.equal(parseCreatureDatagram(good), null);
});

// Builds a datagram as BuildUnitAuraDatagrams in WowMinTelemetry.cpp does.
function unitAuraDatagram(units) {
  const header = Buffer.alloc(24);
  header.write('WMU1', 0, 'latin1');
  header.writeUInt8(1, 4);
  header.writeUInt32LE(601, 8);
  header.writeUInt32LE(7, 12);
  header.writeUInt32LE(5000, 16);
  header.writeUInt16LE(units.length, 20);
  return Buffer.concat([header, ...units.map((unit) => {
    const entry = Buffer.alloc(8 + unit.spellIds.length * 4);
    entry.writeUInt32LE(unit.guid, 0);
    entry.writeUInt8(unit.creature ? 1 : 0, 4);
    entry.writeUInt8(unit.spellIds.length, 5);
    unit.spellIds.forEach((spellId, index) => entry.writeUInt32LE(spellId, 8 + index * 4));
    return entry;
  })]);
}

test('parses unit aura lists and keeps each unit\'s latest until it goes stale or empties', () => {
  const parsed = parseUnitAuraDatagram(unitAuraDatagram([
    { guid: 1, creature: false, spellIds: [48066, 48068] },
    { guid: 900, creature: true, spellIds: [] },
  ]));
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.units)), [
    { guid: 1, creature: false, spellIds: [48066, 48068] },
    { guid: 900, creature: true, spellIds: [] },
  ]);
  const good = unitAuraDatagram([{ guid: 1, creature: false, spellIds: [17] }]);
  assert.equal(parseUnitAuraDatagram(good.subarray(0, good.length - 1)), null);
  assert.equal(parseCreatureDatagram(good), null);

  const store = new LiveAuraStore();
  store.push(parsed, 1000);
  store.push({ units: [{ guid: 900, creature: true, spellIds: [853] }] }, 1000);
  assert.deepEqual(JSON.parse(JSON.stringify([...store.all(1000)])), [['p1', [48066, 48068]], ['c900', [853]]]);
  // An empty list clears the unit; silence past the stale time drops it.
  store.push({ units: [{ guid: 900, creature: true, spellIds: [] }] }, 2000);
  assert.deepEqual([...store.all(2000).keys()], ['p1']);
  assert.equal(store.all(1000 + LIVE_AURA_STALE_MS + 1).size, 0);
});

test('interpolates creatures and drops ones that stop being sent', () => {
  const buffer = new LiveCreatureBuffer();
  const creature = (x) => ({ guid: 9, entry: 1, x, y: 0, z: 0, orientation: 0, alive: true });
  buffer.push({ creatures: [creature(0)] }, 1000);
  buffer.push({ creatures: [creature(10)] }, 1100);
  const [sample] = buffer.samples(1100 + LIVE_RENDER_DELAY_MS - 50);
  near(sample.x, 5, 'halfway');
  assert.equal(buffer.samples(1100 + LIVE_CREATURE_STALE_MS + 1).length, 0);
});

function botDatagram({ mapId = 601, instanceId = 7, serverTimeMs = 5000, bots }) {
  const header = Buffer.alloc(24);
  header.write('WMB1', 0, 'latin1');
  header.writeUInt8(1, 4);
  header.writeUInt32LE(mapId, 8);
  header.writeUInt32LE(instanceId, 12);
  header.writeUInt32LE(serverTimeMs, 16);
  header.writeUInt16LE(bots.length, 20);
  return Buffer.concat([header, ...bots.map((bot) => {
    const strategies = Buffer.from(bot.strategies, 'utf8');
    const entry = Buffer.alloc(36);
    entry.writeUInt32LE(bot.guid, 0);
    entry.writeUInt8(bot.state, 4);
    entry.writeUInt8(bot.motionType, 5);
    entry.writeUInt8(bot.movePriority, 6);
    entry.writeUInt8(bot.flags, 7);
    [bot.moveX, bot.moveY, bot.moveZ].forEach((value, index) => entry.writeFloatLE(value, 8 + index * 4));
    entry.writeUInt32LE(bot.moveAgeMs, 20);
    entry.writeUInt32LE(bot.motionTargetGuid, 24);
    entry.writeUInt32LE(bot.targetGuid, 28);
    entry.writeUInt16LE(strategies.length, 32);
    entry.writeUInt8(bot.actions.length, 34);
    return Buffer.concat([entry, strategies, ...bot.actions.map((action) => {
      const name = Buffer.from(action.name, 'utf8');
      const head = Buffer.alloc(12);
      head.writeUInt8(name.length, 0);
      head.writeUInt16LE(action.repeats, 2);
      head.writeFloatLE(action.relevance, 4);
      head.writeUInt32LE(action.ageMs, 8);
      return Buffer.concat([head, name]);
    })]);
  })]);
}

const healerBot = {
  guid: 42, state: 0, motionType: 14, movePriority: 3, flags: 1 | 2, moveX: 530, moveY: 650.5, moveZ: 777.25,
  moveAgeMs: 1200, motionTargetGuid: 43, targetGuid: 900, strategies: 'dps assist,heal,racials',
  actions: [{ name: 'flash heal', repeats: 3, relevance: 40, ageMs: 100 }, { name: 'follow', repeats: 1, relevance: 1.5, ageMs: 4000 }],
};

test('parses a bot decision datagram with strategies and actions', () => {
  const parsed = parseBotDatagram(botDatagram({ bots: [
    healerBot,
    { guid: 44, state: 2, motionType: 255, movePriority: 0, flags: 4, moveX: 0, moveY: 0, moveZ: 0, moveAgeMs: 0,
      motionTargetGuid: 0, targetGuid: 42, strategies: '', actions: [] },
  ] }));
  assert.equal(parsed.mapId, 601);
  assert.equal(parsed.instanceId, 7);
  assert.equal(parsed.serverTimeMs, 5000);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.bots)), [
    { guid: 42, state: 'combat', motionType: 14, movePriority: 3,
      moveTarget: { x: 530, y: 650.5, z: 777.25, ageMs: 1200 }, motionTargetGuid: 43, motionTargetIsPlayer: true,
      targetGuid: 900, targetIsPlayer: false, strategies: ['dps assist', 'heal', 'racials'],
      actions: [{ repeats: 3, relevance: 40, ageMs: 100, name: 'flash heal' }, { repeats: 1, relevance: 1.5, ageMs: 4000, name: 'follow' }] },
    { guid: 44, state: 'dead', motionType: null, movePriority: 0, moveTarget: null, motionTargetGuid: 0,
      motionTargetIsPlayer: false, targetGuid: 42, targetIsPlayer: true, strategies: [], actions: [] },
  ]);
});

test('rejects truncated bot datagrams and other kinds', () => {
  const good = botDatagram({ bots: [healerBot] });
  assert.ok(parseBotDatagram(good));
  for (const cut of [good.length - 1, good.length - 8, 24 + 36 + 5, 24 + 10]) {
    assert.equal(parseBotDatagram(good.subarray(0, cut)), null, `cut at ${cut}`);
  }
  assert.equal(parseCreatureDatagram(good), null);
  assert.equal(parseBotDatagram(pathDatagram({ paths: [] })), null);
});

test('keeps the latest decisions per bot, ageing them until they go stale', () => {
  const store = new LiveBotStore();
  const decision = (action) => ({ name: 'Healbot', guid: 42, moveTarget: { x: 1, y: 2, z: 3, ageMs: 500 },
    actions: [{ name: action, repeats: 1, relevance: 1, ageMs: 100 }] });
  store.push({ bots: [decision('follow')] }, 1000);
  store.push({ bots: [decision('flash heal')] }, 2000);
  const current = store.get('Healbot', 2600);
  assert.equal(current.actions[0].name, 'flash heal');
  assert.equal(current.actions[0].ageMs, 700);
  assert.equal(current.moveTarget.ageMs, 1100);
  assert.equal(store.get('Healbot', 2000).actions[0].ageMs, 100);
  assert.equal(store.get('Nobody', 2000), null);
  assert.equal(store.get('Healbot', 2000 + LIVE_BOT_STALE_MS + 1), null);
  assert.equal(store.size, 0);
});

test('looks up streamed players and creatures by guid', () => {
  const positions = new LivePositionBuffer();
  positions.push({ players: [{ ...tankard }] }, 1000);
  assert.equal(positions.nameOf(42), 'Tankard');
  assert.equal(positions.nameOf(7), null);
  const creatures = new LiveCreatureBuffer();
  creatures.push({ creatures: [{ guid: 9, entry: 1, x: 0, y: 0, z: 0, orientation: 0, alive: true }] }, 1000);
  assert.equal(creatures.latest(9).entry, 1);
  assert.equal(creatures.latest(10), null);
});

// Builds a datagram as BuildPassengerDatagrams in WowMinTelemetry.cpp does.
function passengerDatagram(passengers) {
  const header = Buffer.alloc(24);
  header.write('WMV1', 0, 'latin1');
  header.writeUInt8(1, 4);
  header.writeUInt32LE(603, 8);
  header.writeUInt32LE(9, 12);
  header.writeUInt32LE(5000, 16);
  header.writeUInt16LE(passengers.length, 20);
  return Buffer.concat([header, ...passengers.map((passenger) => {
    const entry = Buffer.alloc(12);
    entry.writeUInt32LE(passenger.guid, 0);
    entry.writeUInt32LE(passenger.vehicle, 4);
    entry.writeUInt8(passenger.flags, 8);
    entry.writeInt8(passenger.seat, 9);
    return entry;
  })]);
}

test('parses vehicle passengers and forgets them when they stop coming', () => {
  const parsed = parsePassengerDatagram(passengerDatagram([
    { guid: 1, vehicle: 900, flags: 1 | 2 | 4, seat: 0 },
    { guid: 2, vehicle: 3, flags: 0, seat: 1 },
  ]));
  assert.equal(parsed.mapId, 603);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.passengers)), [
    { guid: 1, vehicleGuid: 900, vehicleCreature: true, hidden: true, driver: true, seat: 0 },
    { guid: 2, vehicleGuid: 3, vehicleCreature: false, hidden: false, driver: false, seat: 1 },
  ]);
  const good = passengerDatagram([{ guid: 1, vehicle: 900, flags: 1, seat: 0 }]);
  assert.equal(parsePassengerDatagram(good.subarray(0, good.length - 1)), null);

  const { LivePassengerStore, LIVE_PASSENGER_STALE_MS } = loadModule('../renderer/scripts/utils/live-positions.ts');
  const store = new LivePassengerStore();
  store.push(parsed, 1000);
  assert.equal(store.get(1, 1500).hidden, true);
  // Only creature vehicles are vehicles to draw.
  assert.deepEqual([...store.vehicles(1500)], [900]);
  assert.equal(store.get(1, 1000 + LIVE_PASSENGER_STALE_MS + 1), null);
});

// Builds a datagram as BuildGameObjectDatagrams in WowMinTelemetry.cpp does.
function gameObjectDatagram(objects) {
  const header = Buffer.alloc(24);
  header.write('WMG1', 0, 'latin1');
  header.writeUInt8(1, 4);
  header.writeUInt32LE(529, 8);
  header.writeUInt32LE(7, 12);
  header.writeUInt32LE(5000, 16);
  header.writeUInt16LE(objects.length, 20);
  return Buffer.concat([header, ...objects.map((object) => {
    const entry = Buffer.alloc(48);
    entry.writeUInt32LE(object.guid, 0);
    entry.writeUInt32LE(object.entry, 4);
    entry.writeUInt32LE(object.display, 8);
    [object.x, object.y, object.z, ...object.rotation].forEach((value, index) => entry.writeFloatLE(value, 12 + index * 4));
    entry.writeUInt16LE(object.scale * 1000, 40);
    entry.writeUInt8(object.type, 42);
    entry.writeUInt8(object.state, 43);
    entry.writeUInt8(object.gone ? 1 : 0, 44);
    return entry;
  })]);
}

test('parses game objects and forgets despawned ones', () => {
  const banner = { guid: 50, entry: 180058, display: 6251, x: 1166.5, y: 1200.5, z: -56.5, rotation: [0, 0, 0.5, 0.75], scale: 1, type: 1, state: 1 };
  const parsed = parseGameObjectDatagram(gameObjectDatagram([banner, { ...banner, guid: 51, display: 6271, type: 0, state: 0 }]));
  assert.equal(parsed.mapId, 529);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.objects[0])), {
    guid: 50, entry: 180058, displayId: 6251, x: 1166.5, y: 1200.5, z: -56.5, rotation: [0, 0, 0.5, 0.75], scale: 1,
    type: 1, state: 1, gone: false,
  });
  assert.equal(parsed.objects[1].state, 0);
  const good = gameObjectDatagram([banner]);
  assert.equal(parseGameObjectDatagram(good.subarray(0, good.length - 1)), null);

  const { LiveGameObjectStore, LIVE_GAMEOBJECT_STALE_MS } = loadModule('../renderer/scripts/utils/live-positions.ts');
  const store = new LiveGameObjectStore();
  store.push(parsed, 1000);
  assert.equal(store.all(1500).length, 2);
  // The node changes hands: the Alliance banner despawns.
  store.push(parseGameObjectDatagram(gameObjectDatagram([{ ...banner, gone: true }])), 2000);
  assert.deepEqual(JSON.parse(JSON.stringify(store.all(2500).map((object) => object.guid))), [51]);
  assert.equal(store.all(1000 + LIVE_GAMEOBJECT_STALE_MS + 1).length, 0);
});

// Builds a WMD1/WMR1 datagram as WowMinTelemetry.cpp does.
function entriesDatagram(magic, entries) {
  const header = Buffer.alloc(24);
  header.write(magic, 0, 'latin1');
  header.writeUInt8(1, 4);
  header.writeUInt32LE(533, 8);
  header.writeUInt32LE(3, 12);
  header.writeUInt32LE(5000, 16);
  header.writeUInt16LE(entries.length, 20);
  return Buffer.concat([header, ...entries]);
}

test('parses debuffs and counts their time down', () => {
  const unit = Buffer.alloc(8 + 32);
  unit.writeUInt32LE(900, 0);
  unit.writeUInt8(1, 4);
  unit.writeUInt8(2, 5);
  // Corruption, 5 s left of 18, from a player; a lasting debuff, 3 stacks.
  unit.writeUInt32LE(47813, 8); unit.writeUInt32LE(5000, 12); unit.writeUInt32LE(18000, 16); unit.writeUInt8(1, 20); unit.writeUInt8(1, 21);
  unit.writeUInt32LE(58567, 24); unit.writeUInt32LE(0, 28); unit.writeUInt32LE(0, 32); unit.writeUInt8(3, 36);
  const parsed = parseDebuffDatagram(entriesDatagram('WMD1', [unit]));
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.units[0])), { guid: 900, creature: true, debuffs: [
    { spellId: 47813, remainingMs: 5000, durationMs: 18000, stacks: 1, fromPlayer: true },
    { spellId: 58567, remainingMs: 0, durationMs: 0, stacks: 3, fromPlayer: false },
  ] });
  assert.equal(parseDebuffDatagram(entriesDatagram('WMD1', [unit.subarray(0, 20)])), null);

  const { LiveDebuffStore } = loadModule('../renderer/scripts/utils/live-positions.ts');
  const store = new LiveDebuffStore();
  store.push(parsed, 1000);
  assert.deepEqual(JSON.parse(JSON.stringify(store.get('c900', 4000))), [
    { spellId: 47813, remainingMs: 2000, stacks: 1, fromPlayer: true },
    { spellId: 58567, remainingMs: null, stacks: 3, fromPlayer: false },
  ]);
  // Run out: only the lasting one is left.
  assert.equal(store.get('c900', 7000).length, 1);
});

test('parses raid markers, and an empty list clears them', () => {
  const marker = (icon, creature, guid) => {
    const entry = Buffer.alloc(8);
    entry.writeUInt8(icon, 0); entry.writeUInt8(creature ? 1 : 0, 1); entry.writeUInt32LE(guid, 4);
    return entry;
  };
  const parsed = parseMarkerDatagram(entriesDatagram('WMR1', [marker(7, true, 900), marker(6, false, 3)]));
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.markers)), [
    { icon: 7, creature: true, guid: 900 }, { icon: 6, creature: false, guid: 3 },
  ]);
  const { LiveMarkerStore, LIVE_MARKER_STALE_MS } = loadModule('../renderer/scripts/utils/live-positions.ts');
  const store = new LiveMarkerStore();
  store.push(parsed, 1000);
  assert.equal(store.get('c900', 1500), 7);
  assert.equal(store.get('p3', 1500), 6);
  store.push(parseMarkerDatagram(entriesDatagram('WMR1', [])), 2000);
  assert.equal(store.get('c900', 2500), null);
  store.push(parsed, 3000);
  assert.equal(store.get('c900', 3000 + LIVE_MARKER_STALE_MS + 1), null);
});

test('passes a watched session\'s datagrams to its listeners, naming paths from the latest frame', async () => {
  const dgram = require('node:dgram');
  const probe = dgram.createSocket('udp4');
  await new Promise((resolve) => probe.bind(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const stream = new TelemetryStream(async () => ({ success: true, message: 'WSTREAM|ok' }), '127.0.0.1', port);
  const seen = { frames: [], paths: [], creatures: [], markers: [] };
  const listeners = (into) => ({
    onStatus: () => {}, onFrame: (frame) => into.frames.push(frame), onPaths: (update) => into.paths.push(update),
    onCreatures: (update) => into.creatures.push(update), onMarkers: (update) => into.markers.push(update),
  });
  const marked = { frames: [], paths: [], creatures: [], markers: [] };
  const unwatch = stream.watch(601, 7, listeners(seen));
  const unwatchMarkers = stream.watch(533, 3, listeners(marked));
  const sender = dgram.createSocket('udp4');
  const send = (buffer) => new Promise((resolve) => sender.send(buffer, port, '127.0.0.1', resolve));
  const creature = { guid: 900, entry: 29120, x: 1, y: 2, z: 3, orientation: 0, healthPct: 50, flags: 0, targetGuid: 0, wmoGroupId: -1 };
  try {
    await send(datagram({ players: [tankard] }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await send(pathDatagram({ paths: [
      { guid: 42, splineId: 1, points: [[1, 2, 3]] },
      // Not in a frame yet: dropped.
      { guid: 77, splineId: 2, points: [[4, 5, 6]] },
      { guid: 900, splineId: 3, creature: true, points: [[7, 8, 9]] },
    ] }));
    // Another instance, not watched: ignored.
    await send(creatureDatagram({ instanceId: 8, creatures: [creature] }));
    await send(creatureDatagram({ creatures: [creature] }));
    // Nothing to pass on: no call.
    await send(creatureDatagram({ creatures: [] }));
    // An empty marker list still goes out: it clears the markers.
    await send(entriesDatagram('WMR1', []));
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    sender.close();
    unwatch();
    unwatchMarkers();
  }
  assert.equal(seen.frames.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(seen.paths.map((update) => update.paths.map(({ guid, name }) => [guid, name])))), [[[42, 'Tankard'], [900, '']]]);
  assert.equal(seen.creatures.length, 1);
  assert.equal(seen.creatures[0].instanceId, 7);
  assert.equal(marked.markers.length, 1);
  assert.equal(marked.markers[0].markers.length, 0);
  assert.equal(seen.markers.length, 0);
});
