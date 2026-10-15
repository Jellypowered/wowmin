import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  MapBattlegroundState,
  MapInstanceDeath,
  MapInstanceState,
  MapPlayerPosition,
  MapPlayerSnapshot,
  MapSessionEvent,
  RecordedSessionEvent,
  SessionIndexEntry,
  SessionRecord,
  SessionRoutePoint,
  SessionTotals,
} from './types/api';
import { formatBattlegroundOutcome } from './session-outcome';

export { formatBattlegroundOutcome };

export interface SessionRecorderOptions {
  dataDir: string;
  mapAssetIndexPath?: string;
  routeIntervalMs?: number;
  completionGraceMs?: number;
  checkpointIntervalMs?: number;
  maxEventsPerSession?: number;
  maxRoutePointsPerSession?: number;
  recordingEnabledDefault?: boolean;
}

interface ActiveSession {
  record: SessionRecord;
  runtimeKey: string;
  lastSeenAt: number;
  missingSince: number | null;
  lastRouteAt: number;
  lastCheckpointAt: number;
  seenEventIds: Set<string>;
  worldStates: Map<number, number>;
  bossStates: Map<number, number>;
  allianceScore: number | null;
  hordeScore: number | null;
}

const EMPTY_TOTALS: SessionTotals = {
  kills: 0,
  deaths: 0,
  lootItems: 0,
  levelUps: 0,
  objectives: 0,
  flagCaptures: 0,
};

function cloneTotals(): SessionTotals {
  return { ...EMPTY_TOTALS };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : fallback;
}

function sessionRuntimeKey(mapId: number, instanceId: number): string {
  return `${mapId}:${instanceId}`;
}

const SESSION_MAP_ABBREVIATIONS: Record<number, string> = {
  30: 'AV',
  33: 'SFK',
  34: 'Stocks',
  43: 'WC',
  47: 'RFK',
  48: 'BFD',
  70: 'Uld',
  90: 'Gnomer',
  109: 'ST',
  129: 'RFD',
  189: 'SM',
  209: 'ZF',
  229: 'BRS',
  230: 'BRD',
  249: 'Ony',
  269: 'BM',
  289: 'Scholo',
  309: 'ZG',
  329: 'Strat',
  349: 'Mara',
  389: 'RFC',
  409: 'MC',
  429: 'DM',
  469: 'BWL',
  489: 'WSG',
  509: 'AQ20',
  529: 'AB',
  531: 'AQ40',
  532: 'Kara',
  533: 'Naxx',
  534: 'Hyjal',
  540: 'SHH',
  542: 'BF',
  543: 'Ramps',
  544: 'Mags',
  545: 'SV',
  546: 'UB',
  547: 'SP',
  548: 'SSC',
  550: 'TK',
  552: 'Arc',
  553: 'BOT',
  554: 'Mech',
  555: 'SL',
  556: 'SH',
  557: 'MT',
  558: 'AC',
  559: 'Nagrand',
  560: 'OHB',
  562: 'BEA',
  564: 'BT',
  565: 'Gruuls',
  566: 'EOTS',
  568: 'ZA',
  572: 'RoL',
  574: 'UK',
  575: 'UP',
  576: 'Nexus',
  578: 'Oculus',
  580: 'SWP',
  585: 'MGT',
  595: 'CoS',
  599: 'HoS',
  600: 'DTK',
  601: 'AN',
  602: 'HoL',
  603: 'Ulduar',
  604: 'Gundrak',
  607: 'Sota',
  608: 'VH',
  615: 'OS',
  616: 'EoE',
  617: 'DS',
  618: 'RoV',
  619: 'OK',
  624: 'VoA',
  628: 'IoC',
  631: 'ICC',
  632: 'FoS',
  649: 'ToC',
  650: 'ToC5',
  658: 'PoS',
  668: 'HoR',
  724: 'RS',
};

const SESSION_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function deriveMapAbbreviation(mapId: number, mapName: string): string {
  const known = SESSION_MAP_ABBREVIATIONS[mapId];
  if (known) return known;
  const words = mapName.match(/[A-Za-z0-9]+/g)?.filter((word) => !['the', 'of'].includes(word.toLowerCase())) ?? [];
  if (words.length > 1) return words.map((word) => word[0]).join('').slice(0, 8).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 12);
  return `Map${mapId}`;
}

export function readableSessionId(
  mapId: number,
  mapName: string,
  instanceId: number,
  startedAt: number,
  mapType = 0,
  difficulty = 0,
): string {
  const baseAbbreviation = deriveMapAbbreviation(mapId, mapName);
  const abbreviation = mapType === 1 && difficulty > 0 ? `${baseAbbreviation}(H)` : baseAbbreviation;
  const date = new Date(startedAt);
  const month = SESSION_MONTHS[date.getUTCMonth()] ?? 'Date';
  const day = String(date.getUTCDate()).padStart(2, '0');
  const year = String(date.getUTCFullYear()).slice(-2);
  return `${abbreviation}-${instanceId}-${month}${day}-${year}`;
}

function eventDescription(event: MapSessionEvent): string {
  switch (event.type) {
    case 'kill':
      return `${event.actorName} killed ${event.targetName || `target ${event.targetGuid}`}`;
    case 'loot':
      return `${event.actorName} looted ${event.amount}× ${event.valueName || `item ${event.valueId}`}`;
    case 'level':
      return `${event.actorName} reached level ${event.valueId}`;
    default:
      return `${event.actorName}: ${event.type}`;
  }
}

function deathDescription(death: MapInstanceDeath): string {
  return death.killerName
    ? `${death.victimName} died to ${death.killerName}`
    : `${death.victimName} died`;
}

function worldStateDescription(mapId: number, stateId: number, value: number): string {
  const knownNames: Record<number, Record<number, string>> = {
    489: { 2338: 'Horde flag', 2339: 'Alliance flag' },
    529: { 1778: 'Horde bases', 1779: 'Alliance bases' },
    566: { 2752: 'Alliance bases', 2753: 'Horde bases', 2769: 'Alliance flag', 2770: 'Horde flag' },
    30: { 3127: 'Alliance reinforcements', 3128: 'Horde reinforcements' },
  };
  return `${knownNames[mapId]?.[stateId] ?? `Objective ${stateId}`} changed to ${value}`;
}

function createIndexEntry(record: SessionRecord, bytes: number): SessionIndexEntry {
  return {
    id: record.id,
    mapId: record.mapId,
    mapName: record.mapName,
    mapType: record.mapType,
    difficulty: record.difficulty,
    instanceId: record.instanceId,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    elapsedMs: record.elapsedMs,
    participantCount: record.participants.length,
    eventCount: record.events.length,
    routePointCount: record.routes.length,
    battleground: record.battleground ? { ...record.battleground } : undefined,
    totals: { ...record.totals },
    bytes,
  };
}

function incrementTotals(totals: SessionTotals, event: RecordedSessionEvent): void {
  if (event.type === 'kill') totals.kills += 1;
  else if (event.type === 'death') totals.deaths += 1;
  else if (event.type === 'loot') totals.lootItems += event.amount;
  else if (event.type === 'level') totals.levelUps += 1;
  else if (event.type === 'objective') totals.objectives += 1;
  else if (event.type === 'flag-capture') totals.flagCaptures += 1;
}

export class SessionRecorder {
  private readonly sessionDir: string;
  private readonly activeDir: string;
  private readonly indexPath: string;
  private readonly settingsPath: string;
  private readonly mapAssetIndexPath?: string;
  private readonly routeIntervalMs: number;
  private readonly completionGraceMs: number;
  private readonly checkpointIntervalMs: number;
  private readonly maxEventsPerSession: number;
  private readonly maxRoutePointsPerSession: number;
  private readonly recordingEnabledDefault: boolean;
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly mapNames = new Map<number, string>();
  private index: SessionIndexEntry[] = [];
  private recordingEnabled = false;
  private initialized: Promise<void> | null = null;
  private operationChain: Promise<void> = Promise.resolve();

  constructor(options: SessionRecorderOptions) {
    this.sessionDir = path.join(options.dataDir, 'sessions');
    this.activeDir = path.join(this.sessionDir, '.active');
    this.indexPath = path.join(this.sessionDir, 'index.json');
    this.settingsPath = path.join(options.dataDir, 'session-recording.json');
    this.mapAssetIndexPath = options.mapAssetIndexPath;
    this.routeIntervalMs = positiveInteger(options.routeIntervalMs, 5000);
    this.completionGraceMs = positiveInteger(options.completionGraceMs, 15000);
    this.checkpointIntervalMs = positiveInteger(options.checkpointIntervalMs, 10000);
    this.maxEventsPerSession = positiveInteger(options.maxEventsPerSession, 10000);
    this.maxRoutePointsPerSession = positiveInteger(options.maxRoutePointsPerSession, 50000);
    this.recordingEnabledDefault = options.recordingEnabledDefault ?? false;
    this.recordingEnabled = this.recordingEnabledDefault;
  }

  ingest(snapshot: MapPlayerSnapshot): Promise<void> {
    const run = async (): Promise<void> => {
      await this.ensureInitialized();
      await this.ingestSnapshot(snapshot);
    };
    const result = this.operationChain.then(run, run);
    this.operationChain = result.catch(() => undefined);
    return result;
  }

  async isEnabled(): Promise<boolean> {
    await this.ensureInitialized();
    await this.operationChain;
    return this.recordingEnabled;
  }

  setEnabled(enabled: boolean): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      await this.ensureInitialized();
      this.recordingEnabled = enabled;
      await this.writeJsonAtomic(this.settingsPath, { schemaVersion: 1, enabled });
      if (!enabled) {
        const activeRecords = [...this.activeSessions.values()];
        this.activeSessions.clear();
        await Promise.all(activeRecords.map((active) =>
          fs.rm(path.join(this.activeDir, `${active.record.id}.json`), { force: true })));
      }
      return this.recordingEnabled;
    };
    const result = this.operationChain.then(run, run);
    this.operationChain = result.then(() => undefined, () => undefined);
    return result;
  }

  async list(): Promise<SessionIndexEntry[]> {
    await this.ensureInitialized();
    await this.operationChain;
    return this.index.map((entry) => ({
      ...entry,
      battleground: entry.battleground ? { ...entry.battleground } : undefined,
      totals: { ...entry.totals },
    }));
  }

  async get(id: string): Promise<SessionRecord | null> {
    await this.ensureInitialized();
    await this.operationChain;
    if (!this.index.some((entry) => entry.id === id)) return null;
    try {
      return JSON.parse(await fs.readFile(path.join(this.sessionDir, `${id}.json`), 'utf8')) as SessionRecord;
    } catch {
      return null;
    }
  }

  purgeCompleted(): Promise<number> {
    const run = async (): Promise<number> => {
      await this.ensureInitialized();
      const completedFiles = (await fs.readdir(this.sessionDir))
        .filter((fileName) => fileName.endsWith('.json') && fileName !== 'index.json');
      await Promise.all(completedFiles.map((fileName) =>
        fs.rm(path.join(this.sessionDir, fileName), { force: true })));
      this.index = [];
      await this.writeJsonAtomic(this.indexPath, { schemaVersion: 1, sessions: this.index });
      return completedFiles.length;
    };
    const result = this.operationChain.then(run, run);
    this.operationChain = result.then(() => undefined, () => undefined);
    return result;
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initialized) this.initialized = this.initialize();
    return this.initialized;
  }

  private async initialize(): Promise<void> {
    await fs.mkdir(this.activeDir, { recursive: true });
    try {
      const stored = JSON.parse(await fs.readFile(this.settingsPath, 'utf8')) as { enabled?: unknown };
      this.recordingEnabled = typeof stored.enabled === 'boolean'
        ? stored.enabled
        : this.recordingEnabledDefault;
    } catch {
      this.recordingEnabled = this.recordingEnabledDefault;
    }
    await this.writeJsonAtomic(this.settingsPath, { schemaVersion: 1, enabled: this.recordingEnabled });

    try {
      const stored = JSON.parse(await fs.readFile(this.indexPath, 'utf8')) as { sessions?: SessionIndexEntry[] };
      this.index = Array.isArray(stored.sessions) ? stored.sessions : [];
    } catch {
      this.index = await this.rebuildIndex();
    }
    await this.writeJsonAtomic(this.indexPath, { schemaVersion: 1, sessions: this.index });

    if (this.mapAssetIndexPath) {
      try {
        const assets = JSON.parse(await fs.readFile(this.mapAssetIndexPath, 'utf8')) as {
          maps?: Array<{ mapId: number; label?: string }>;
          missingMaps?: Array<{ mapId: number; label?: string }>;
        };
        for (const map of [...(assets.maps ?? []), ...(assets.missingMaps ?? [])]) {
          if (map.label) this.mapNames.set(map.mapId, map.label);
        }
      } catch {
        // Asset names are optional; map IDs remain stable fallback labels.
      }
    }

    await Promise.all((await fs.readdir(this.activeDir)).map((fileName) =>
      fs.rm(path.join(this.activeDir, fileName), { recursive: true, force: true })));
    await Promise.all((await fs.readdir(this.sessionDir))
      .filter((fileName) => fileName.endsWith('.tmp'))
      .map((fileName) => fs.rm(path.join(this.sessionDir, fileName), { force: true })));
  }

  private uniqueSessionId(baseId: string): string {
    const usedIds = new Set([
      ...this.index.map((entry) => entry.id),
      ...[...this.activeSessions.values()].map((active) => active.record.id),
    ]);
    if (!usedIds.has(baseId)) return baseId;
    let suffix = 2;
    while (usedIds.has(`${baseId}-${suffix}`)) suffix += 1;
    return `${baseId}-${suffix}`;
  }

  private createActive(record: SessionRecord, now: number): ActiveSession {
    return {
      record,
      runtimeKey: sessionRuntimeKey(record.mapId, record.instanceId),
      lastSeenAt: record.endedAt || now,
      missingSince: null,
      lastRouteAt: record.routes.at(-1)?.occurredAt ?? 0,
      lastCheckpointAt: 0,
      seenEventIds: new Set(record.events.map((event) => event.id)),
      worldStates: new Map(),
      bossStates: new Map(),
      allianceScore: null,
      hordeScore: null,
    };
  }

  private async ingestSnapshot(snapshot: MapPlayerSnapshot): Promise<void> {
    if (snapshot.source !== 'worldserver' || !this.recordingEnabled) return;
    const now = snapshot.capturedAt;
    const playersBySession = new Map<string, MapPlayerPosition[]>();
    for (const player of snapshot.players) {
      if (player.instanceId <= 0) continue;
      const key = sessionRuntimeKey(player.map, player.instanceId);
      const players = playersBySession.get(key) ?? [];
      players.push(player);
      playersBySession.set(key, players);
    }

    for (const [runtimeKey, players] of playersBySession) {
      const representative = players[0];
      const startedAt = (representative.sessionStartedAt ?? Math.floor(now / 1000)) * 1000;
      let active = this.activeSessions.get(runtimeKey);
      if (active && active.record.startedAt !== startedAt) {
        await this.finalize(active);
        active = undefined;
      }
      if (!active) {
        const mapId = representative.map;
        const mapName = this.mapNames.get(mapId) ?? `Map ${mapId}`;
        const mapType = representative.mapType ?? 0;
        const difficulty = representative.difficulty ?? 0;
        const baseId = readableSessionId(mapId, mapName, representative.instanceId, startedAt, mapType, difficulty);
        const record: SessionRecord = {
          schemaVersion: 1,
          id: this.uniqueSessionId(baseId),
          mapId,
          mapName,
          mapType,
          difficulty,
          instanceId: representative.instanceId,
          startedAt,
          endedAt: now,
          elapsedMs: Math.max(0, now - startedAt),
          completed: false,
          participants: [],
          events: [],
          routes: [],
          totals: cloneTotals(),
        };
        active = this.createActive(record, now);
        this.activeSessions.set(runtimeKey, active);
      }

      active.lastSeenAt = now;
      active.missingSince = null;
      active.record.endedAt = now;
      active.record.elapsedMs = Math.max(0, now - active.record.startedAt);
      this.updateParticipants(active.record, players);
      this.recordRoutes(active, players, now);
      this.recordServerEvents(active, snapshot.events.filter((event) =>
        event.mapId === active?.record.mapId && event.instanceId === active.record.instanceId));
      this.recordDeaths(active, snapshot.deaths.filter((death) =>
        death.mapId === active?.record.mapId && death.instanceId === active.record.instanceId));
      this.recordBossTransitions(active, snapshot.instances.find((instance) =>
        instance.mapId === active?.record.mapId && instance.instanceId === active.record.instanceId), now);
      this.recordBattlegroundTransitions(active, snapshot.battlegrounds.find((battleground) =>
        battleground.mapId === active?.record.mapId && battleground.instanceId === active.record.instanceId), now);
      if (now - active.lastCheckpointAt >= this.checkpointIntervalMs) await this.checkpoint(active, now);
    }

    for (const active of [...this.activeSessions.values()]) {
      if (playersBySession.has(active.runtimeKey)) continue;
      this.recordServerEvents(active, snapshot.events.filter((event) =>
        event.mapId === active.record.mapId && event.instanceId === active.record.instanceId));
      this.recordDeaths(active, snapshot.deaths.filter((death) =>
        death.mapId === active.record.mapId && death.instanceId === active.record.instanceId));
      this.recordBossTransitions(active, snapshot.instances.find((instance) =>
        instance.mapId === active.record.mapId && instance.instanceId === active.record.instanceId), now);
      this.recordBattlegroundTransitions(active, snapshot.battlegrounds.find((battleground) =>
        battleground.mapId === active.record.mapId && battleground.instanceId === active.record.instanceId), now);
      if (now - active.lastCheckpointAt >= this.checkpointIntervalMs) await this.checkpoint(active, now);
      active.missingSince ??= now;
      if (now - active.missingSince >= this.completionGraceMs) await this.finalize(active);
    }
  }

  private updateParticipants(record: SessionRecord, players: MapPlayerPosition[]): void {
    for (const player of players) {
      let participant = record.participants.find((entry) => entry.name === player.name);
      if (!participant) {
        participant = {
          name: player.name,
          isBot: player.isBot,
          teamId: player.teamId,
          classId: player.class,
          raceId: player.race,
          gender: player.gender,
          levelStart: player.level,
          levelEnd: player.level,
        };
        record.participants.push(participant);
      }
      participant.levelEnd = player.level;
      participant.teamId = player.teamId;
      participant.raceId = player.race;
      participant.gender = player.gender;
    }
  }

  private recordRoutes(active: ActiveSession, players: MapPlayerPosition[], now: number): void {
    if (now - active.lastRouteAt < this.routeIntervalMs
      || active.record.routes.length >= this.maxRoutePointsPerSession) return;
    const available = this.maxRoutePointsPerSession - active.record.routes.length;
    const points: SessionRoutePoint[] = players.slice(0, available).map((player) => ({
      occurredAt: now,
      elapsedMs: Math.max(0, now - active.record.startedAt),
      name: player.name,
      isBot: player.isBot,
      teamId: player.teamId,
      x: player.position_x,
      y: player.position_y,
      z: player.position_z,
      orientation: player.orientation,
      wmoGroupId: player.wmoGroupId,
      alive: player.alive,
      inCombat: player.inCombat,
      onTaxi: player.onTaxi,
      mounted: player.mounted,
      sapped: player.sapped,
      stunned: player.stunned,
      spiritForm: player.spiritForm,
      flagCarrier: player.flagCarrier,
      waitingForResurrect: player.waitingForResurrect,
    }));
    active.record.routes.push(...points);
    active.lastRouteAt = now;
  }

  private recordServerEvents(active: ActiveSession, events: MapSessionEvent[]): void {
    for (const event of events) {
      const id = `event:${event.eventId}`;
      if (active.seenEventIds.has(id)) continue;
      this.addEvent(active, {
        id,
        source: 'worldserver',
        sourceEventId: event.eventId,
        type: event.type === 'kill' || event.type === 'loot' || event.type === 'level' ? event.type : 'objective',
        occurredAt: event.occurredAt * 1000,
        elapsedMs: Math.max(0, event.occurredAt * 1000 - active.record.startedAt),
        actorGuid: event.actorGuid,
        actorName: event.actorName,
        targetGuid: event.targetGuid,
        targetType: event.targetType,
        targetName: event.targetName,
        valueId: event.valueId,
        valueName: event.valueName,
        amount: event.amount,
        description: eventDescription(event),
      });
    }
  }

  private recordDeaths(active: ActiveSession, deaths: MapInstanceDeath[]): void {
    for (const death of deaths) {
      const id = `death:${death.eventId}`;
      if (active.seenEventIds.has(id)) continue;
      this.addEvent(active, {
        id,
        source: 'worldserver',
        sourceEventId: death.eventId,
        type: 'death',
        occurredAt: death.occurredAt * 1000,
        elapsedMs: Math.max(0, death.occurredAt * 1000 - active.record.startedAt),
        actorGuid: death.victimGuid,
        actorName: death.victimName,
        targetGuid: death.killerGuid,
        targetType: death.killerType,
        targetName: death.killerName,
        valueId: 0,
        valueName: '',
        amount: 1,
        description: deathDescription(death),
      });
    }
  }

  private recordBossTransitions(active: ActiveSession, instance: MapInstanceState | undefined, now: number): void {
    if (!instance) return;
    for (const boss of instance.bosses) {
      const previous = active.bossStates.get(boss.id);
      active.bossStates.set(boss.id, boss.state);
      if (previous === undefined || previous === boss.state) continue;
      this.addSnapshotEvent(active, 'boss', now, boss.id, boss.name, boss.state,
        `${boss.name} changed from state ${previous} to ${boss.state}`);
    }
  }

  private recordBattlegroundTransitions(
    active: ActiveSession,
    battleground: MapBattlegroundState | undefined,
    now: number,
  ): void {
    if (!battleground) return;
    const previousStatus = active.record.battleground?.status;
    active.record.battleground = {
      mapId: battleground.mapId,
      battlegroundTypeId: battleground.battlegroundTypeId,
      status: battleground.status,
      winner: battleground.winner,
      allianceScore: battleground.allianceScore,
      hordeScore: battleground.hordeScore,
    };
    if (battleground.status === 4 && previousStatus !== 4) {
      const description = formatBattlegroundOutcome(active.record.battleground);
      if (description) this.addSnapshotEvent(active, 'match-result', now, battleground.winner, '', 1, description);
    }
    for (const state of battleground.worldStates) {
      const previous = active.worldStates.get(state.id);
      active.worldStates.set(state.id, state.value);
      if (previous === undefined || previous === state.value) continue;
      this.addSnapshotEvent(active, 'objective', now, state.id, '', state.value,
        worldStateDescription(active.record.mapId, state.id, state.value));
    }
    this.recordScoreTransition(active, 'Alliance', battleground.allianceScore, active.allianceScore, now);
    this.recordScoreTransition(active, 'Horde', battleground.hordeScore, active.hordeScore, now);
    active.allianceScore = battleground.allianceScore;
    active.hordeScore = battleground.hordeScore;
  }

  private recordScoreTransition(
    active: ActiveSession,
    team: string,
    score: number,
    previous: number | null,
    now: number,
  ): void {
    if (previous === null || score <= previous) return;
    const flagCapture = active.record.mapId === 489;
    this.addSnapshotEvent(active, flagCapture ? 'flag-capture' : 'objective', now, 0, team, score - previous,
      `${team} ${flagCapture ? 'captured a flag' : 'score'} (${score})`);
  }

  private addSnapshotEvent(
    active: ActiveSession,
    type: 'boss' | 'objective' | 'flag-capture' | 'match-result',
    now: number,
    valueId: number,
    valueName: string,
    amount: number,
    description: string,
  ): void {
    const id = `snapshot:${type}:${now}:${valueId}:${valueName}`;
    this.addEvent(active, {
      id,
      source: 'snapshot',
      type,
      occurredAt: now,
      elapsedMs: Math.max(0, now - active.record.startedAt),
      actorGuid: 0,
      actorName: '',
      targetGuid: 0,
      targetType: 0,
      targetName: '',
      valueId,
      valueName,
      amount,
      description,
    });
  }

  private addEvent(active: ActiveSession, event: RecordedSessionEvent): void {
    if (active.seenEventIds.has(event.id) || active.record.events.length >= this.maxEventsPerSession) return;
    active.seenEventIds.add(event.id);
    active.record.events.push(event);
    incrementTotals(active.record.totals, event);
  }

  private async checkpoint(active: ActiveSession, now: number): Promise<void> {
    active.lastCheckpointAt = now;
    await this.writeJsonAtomic(path.join(this.activeDir, `${active.record.id}.json`), active.record);
  }

  private async finalize(active: ActiveSession): Promise<void> {
    active.record.completed = true;
    active.record.endedAt = active.lastSeenAt;
    active.record.elapsedMs = Math.max(0, active.record.endedAt - active.record.startedAt);
    active.record.events.sort((left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id));
    active.record.routes.sort((left, right) => left.occurredAt - right.occurredAt || left.name.localeCompare(right.name));
    const recordPath = path.join(this.sessionDir, `${active.record.id}.json`);
    await this.writeJsonAtomic(recordPath, active.record);
    const stats = await fs.stat(recordPath);
    const entry = createIndexEntry(active.record, stats.size);
    this.index = [entry, ...this.index.filter((candidate) => candidate.id !== entry.id)]
      .sort((left, right) => right.startedAt - left.startedAt);
    this.activeSessions.delete(active.runtimeKey);
    await fs.rm(path.join(this.activeDir, `${active.record.id}.json`), { force: true });
    await this.writeJsonAtomic(this.indexPath, { schemaVersion: 1, sessions: this.index });
  }

  private async rebuildIndex(): Promise<SessionIndexEntry[]> {
    const entries: SessionIndexEntry[] = [];
    for (const fileName of await fs.readdir(this.sessionDir)) {
      if (!fileName.endsWith('.json') || fileName === 'index.json') continue;
      try {
        const filePath = path.join(this.sessionDir, fileName);
        const [record, stats] = await Promise.all([
          fs.readFile(filePath, 'utf8').then((content) => JSON.parse(content) as SessionRecord),
          fs.stat(filePath),
        ]);
        if (record.schemaVersion === 1 && record.completed) entries.push(createIndexEntry(record, stats.size));
      } catch {
        // Ignore unrelated or damaged files while rebuilding the derived index.
      }
    }
    return entries.sort((left, right) => right.startedAt - left.startedAt);
  }

  private async writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryPath, filePath);
  }
}
