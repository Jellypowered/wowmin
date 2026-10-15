// ── Database Types ────────────────────────────────────────────────────────

export interface DbConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

export interface DbConnectionState {
  connected: boolean;
  database: string | null;
  error: string | null;
}

export type ManagedServiceName = 'soap' | 'worldDatabase' | 'mapDatabase' | 'economyDatabase';
export type ManagedServicePhase = 'disconnected' | 'connecting' | 'connected' | 'degraded';

export interface ManagedServiceStatus {
  phase: ManagedServicePhase;
  error: string | null;
  retryAt: number | null;
}

export interface BackendConnectionStatus {
  managed: boolean;
  updatedAt: number;
  services: Record<ManagedServiceName, ManagedServiceStatus>;
}

export interface FieldInfo {
  name: string;
  type: string;
  length?: number;
  nullable?: boolean;
}

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  fields: FieldInfo[];
  affectedRows?: number;
  insertId?: number;
}

export interface OnlinePlayerRow {
  name: string;
  account: string;
  ip: string;
  mapId: number;
  zoneId: number;
  expansion: number;
  gmLevel: number;
  level: number;
  raceId: number;
  classId: number;
  gender?: number;
}

export interface MapOnlineCounts {
  players: number;
  bots: number;
  total: number;
}

export interface MapPlayerPosition {
  name: string;
  map: number;
  instanceId: number;
  position_x: number;
  position_y: number;
  position_z: number;
  orientation: number;
  level: number;
  race: number;
  class: number;
  account: string;
  accountId: number;
  isBot: boolean;
  alive: boolean;
  inCombat: boolean;
  mapType?: number;
  difficulty?: number;
  sessionStartedAt?: number;
  groupId?: number;
  isRaidGroup?: boolean;
  subgroup?: number;
  teamId?: number;
  healthPct?: number;
  powerType?: number;
  powerPct?: number;
  targetGuid?: number;
  targetType?: number;
  targetName?: string;
  roleMask?: number;
  waitingForResurrect?: boolean;
  battlegroundRole?: number;
  wmoGroupId?: number;
  gender?: number;
  onTaxi?: boolean;
  mounted?: boolean;
  sapped?: boolean;
  stunned?: boolean;
  spiritForm?: boolean;
  flagCarrier?: boolean;
  flying?: boolean;
  sitting?: boolean;
}

export interface MapBattlegroundWorldState {
  id: number;
  value: number;
}

export interface MapBattlegroundState {
  mapId: number;
  instanceId: number;
  battlegroundTypeId: number;
  status: number;
  elapsedMs: number;
  remainingMs: number;
  winner: number;
  allianceScore: number;
  hordeScore: number;
  alliancePlayers: number;
  hordePlayers: number;
  allianceAlive: number;
  hordeAlive: number;
  nextResurrectMs: number;
  allianceStrategy: number;
  hordeStrategy: number;
  worldStates: MapBattlegroundWorldState[];
}

export interface MapInstanceBossState {
  id: number;
  state: number;
  name: string;
}

export interface MapInstanceState {
  mapId: number;
  instanceId: number;
  completedEncounterMask: number;
  bosses: MapInstanceBossState[];
}

export interface MapInstanceDeath {
  mapId: number;
  instanceId: number;
  eventId: number;
  occurredAt: number;
  victimGuid: number;
  victimName: string;
  killerGuid: number;
  killerType: number;
  killerName: string;
}

export interface MapSessionEvent {
  mapId: number;
  instanceId: number;
  eventId: number;
  occurredAt: number;
  type: 'kill' | 'loot' | 'level' | string;
  actorGuid: number;
  actorName: string;
  targetGuid: number;
  targetType: number;
  targetName: string;
  valueId: number;
  valueName: string;
  amount: number;
}

// Live position stream (mod-wowmin-telemetry UDP stream, relayed by the web
// service). Carries only fast-changing per-player state; the once-a-second
// snapshot remains the source for everything else.
export interface StreamPlayerSample {
  guid: number;
  name: string;
  x: number;
  y: number;
  z: number;
  orientation: number;
  healthPct: number;
  powerPct: number;
  powerType: number;
  alive: boolean;
  inCombat: boolean;
  waitingForResurrect: boolean;
  stateFlags: number;
  // Core LFG role mask. Added in live stream protocol v2; absent on v1.
  roleMask?: number;
  wmoGroupId: number;
}

export interface StreamFrame {
  mapId: number;
  instanceId: number;
  sequence: number;
  serverTimeMs: number;
  players: StreamPlayerSample[];
}

export type StreamStatus = 'starting' | 'streaming' | 'unavailable';

// A player's or creature's server-driven movement path: the waypoints still
// ahead, ending at the destination. No points means it is no longer on a path.
export interface StreamPath {
  guid: number;
  // The player's name; empty for a creature's path (see `creature`).
  name: string;
  creature: boolean;
  splineId: number;
  // The middle of a long path was dropped; the last point is the destination.
  truncated: boolean;
  points: Array<[number, number, number]>;
}

export interface StreamCreatureSample {
  guid: number;
  entry: number;
  x: number;
  y: number;
  z: number;
  orientation: number;
  healthPct: number;
  alive: boolean;
  inCombat: boolean;
  hostile: boolean;
  boss: boolean;
  // A player's pet, guardian, or charmed creature.
  playerControlled: boolean;
  // 0 for no target; a player's guid when targetIsPlayer, else a creature's.
  targetGuid: number;
  targetIsPlayer: boolean;
  // Scenery by its live flags: players can't select it, or (outside a fight)
  // can neither attack nor talk to it. The module sends no path for it.
  // Absent from older modules.
  scenery?: boolean;
  wmoGroupId: number;
}

export interface StreamCreatureUpdate {
  mapId: number;
  instanceId: number;
  serverTimeMs: number;
  creatures: StreamCreatureSample[];
}

// An action a playerbot carried out; a run of the same action is one entry.
export interface StreamBotAction {
  name: string;
  // How often it ran in a row, and the relevance it last ran with.
  repeats: number;
  relevance: number;
  // Since it last ran, as of the update's serverTimeMs.
  ageMs: number;
}

// What a playerbot is deciding (mod-playerbots only).
export interface StreamBotDecision {
  guid: number;
  name: string;
  state: 'combat' | 'idle' | 'dead';
  // The core's MovementGeneratorType; null for none.
  motionType: number | null;
  // 0 idle, 1 wander, 2 normal, 3 combat, 4 forced.
  movePriority: number;
  // Where it last chose to move, and how long ago; null if nowhere on this map.
  moveTarget: { x: number; y: number; z: number; ageMs: number } | null;
  // Whom it follows or chases; 0 for none.
  motionTargetGuid: number;
  motionTargetIsPlayer: boolean;
  targetGuid: number;
  targetIsPlayer: boolean;
  // Strategies of its current state, sorted by name.
  strategies: string[];
  // Newest first.
  actions: StreamBotAction[];
}

// How a player or creature looks, for drawing its model.
export interface StreamAppearance {
  guid: number;
  creature: boolean;
  helmHidden: boolean;
  cloakHidden: boolean;
  race: number;
  gender: number;
  classId: number;
  skin: number;
  face: number;
  hairStyle: number;
  hairColor: number;
  facialStyle: number;
  // 0 sheathed, 1 melee weapons drawn, 2 ranged weapon drawn.
  sheathState: number;
  // Object scale (1 is normal size), on top of the display's own scale.
  scale: number;
  displayId: number;
  nativeDisplayId: number;
  mountDisplayId: number;
  // Item display IDs by equipment slot (0 head ... 18 tabard); 0 is empty.
  items: number[];
  // InventoryType and weapon subclass of the main hand, InventoryType of the
  // off hand, and subclass of the ranged weapon (0: none), for attack poses.
  mainHandType: number;
  mainHandSubclass: number;
  offHandType: number;
  rangedSubclass: number;
}

export interface StreamAppearanceUpdate {
  mapId: number;
  instanceId: number;
  serverTimeMs: number;
  units: StreamAppearance[];
}

export type StreamCombatEventKind =
  | 'castStart' | 'castGo' | 'castCancel' | 'auraApply' | 'auraRemove' | 'swing' | 'damage' | 'heal';
// Notable auras, as the module classes them.
export type StreamAuraCategory = 'crowdControl' | 'shield' | 'defensive' | 'offensive';

// A cast, notable aura, auto-attack swing, damage, or heal. Guids are players'
// unless the matching creature flag is set; 0 is none.
export interface StreamCombatEvent {
  kind: StreamCombatEventKind;
  sourceGuid: number;
  sourceCreature: boolean;
  targetGuid: number;
  targetCreature: boolean;
  // 0 for none, e.g. a white hit.
  spellId: number;
  // Spell school bits: 1 physical, 2 holy, 4 fire, 8 nature, 16 frost,
  // 32 shadow, 64 arcane; 0 unknown.
  schoolMask: number;
  auraCategory: StreamAuraCategory | null;
  // castStart: cast time in ms; castGo: channel duration in ms; auraApply:
  // duration in ms (0 permanent); damage and heal: the final amount.
  value: number;
  // Yards per second; 0 is instant.
  missileSpeed: number;
  // Yards; 0 when the spell has no area.
  radius: number;
  // The spell's ground point, if it has one.
  point: [number, number, number] | null;
  area: boolean;
  channeled: boolean;
  periodic: boolean;
  helpful: boolean;
  triggered: boolean;
  // The spell leaves a lasting area on the ground (Consecration); its
  // castGo carries the area's duration in value.
  persistentArea: boolean;
  // How long before the update's serverTimeMs it happened.
  ageMs: number;
}

export interface StreamCombatEventUpdate {
  mapId: number;
  instanceId: number;
  serverTimeMs: number;
  // Events the module dropped since the last update because there were too many.
  dropped: number;
  events: StreamCombatEvent[];
}

// The auras with spell art a unit wears (spell IDs), from the module's
// unit aura lists.
export interface StreamUnitAuras {
  guid: number;
  creature: boolean;
  spellIds: number[];
}

export interface StreamUnitAuraUpdate {
  mapId: number;
  instanceId: number;
  serverTimeMs: number;
  units: StreamUnitAuras[];
}

// A player riding a vehicle (Ulduar's demolishers, a mammoth's passenger
// seat), from the module's passenger lists.
export interface StreamPassenger {
  guid: number;
  vehicleGuid: number;
  // The vehicle is a creature (else a player, such as a mammoth's rider).
  vehicleCreature: boolean;
  // The seat hides its passenger (the client doesn't draw them).
  hidden: boolean;
  // The seat drives the vehicle.
  driver: boolean;
  seat: number;
}

export interface StreamPassengerUpdate {
  mapId: number;
  instanceId: number;
  serverTimeMs: number;
  passengers: StreamPassenger[];
}

// A harmful aura on a unit, for its nameplate.
export interface StreamDebuff {
  spellId: number;
  // At the time it was sent; 0 when it lasts until removed.
  remainingMs: number;
  durationMs: number;
  stacks: number;
  // Cast by a player (else by a creature).
  fromPlayer: boolean;
}

export interface StreamUnitDebuffs {
  guid: number;
  creature: boolean;
  debuffs: StreamDebuff[];
}

export interface StreamDebuffUpdate {
  mapId: number;
  instanceId: number;
  serverTimeMs: number;
  units: StreamUnitDebuffs[];
}

// A raid marker a group has set: 0 star, 1 circle, 2 diamond, 3 triangle,
// 4 moon, 5 square, 6 cross, 7 skull.
export interface StreamMarker {
  icon: number;
  creature: boolean;
  guid: number;
}

// Every marker set (empty when all are cleared).
export interface StreamMarkerUpdate {
  mapId: number;
  instanceId: number;
  serverTimeMs: number;
  markers: StreamMarker[];
}

// A spawned game object with a model (a battleground banner or flag, a
// door, a chest), from the module's game object lists.
export interface StreamGameObject {
  guid: number;
  entry: number;
  displayId: number;
  x: number;
  y: number;
  z: number;
  // A quaternion (x, y, z, w).
  rotation: [number, number, number, number];
  scale: number;
  // GameobjectTypes (0 a door, 10 a goober, 24 a flag stand...).
  type: number;
  // GOState: 0 active (a door open), 1 ready, 2 alternative.
  state: number;
  // Despawned: forget it.
  gone: boolean;
}

export interface StreamGameObjectUpdate {
  mapId: number;
  instanceId: number;
  serverTimeMs: number;
  objects: StreamGameObject[];
}

export interface StreamBotUpdate {
  mapId: number;
  instanceId: number;
  serverTimeMs: number;
  bots: StreamBotDecision[];
}

export interface StreamListeners {
  onFrame: (frame: StreamFrame) => void;
  onStatus: (status: StreamStatus) => void;
  onPaths?: (update: StreamPathUpdate) => void;
  onCreatures?: (update: StreamCreatureUpdate) => void;
  onBots?: (update: StreamBotUpdate) => void;
  onAppearances?: (update: StreamAppearanceUpdate) => void;
  onCombatEvents?: (update: StreamCombatEventUpdate) => void;
  onUnitAuras?: (update: StreamUnitAuraUpdate) => void;
  onPassengers?: (update: StreamPassengerUpdate) => void;
  onGameObjects?: (update: StreamGameObjectUpdate) => void;
  onDebuffs?: (update: StreamDebuffUpdate) => void;
  onMarkers?: (update: StreamMarkerUpdate) => void;
}

// creature_template details for labelling streamed creatures.
export interface CreatureInfo {
  entry: number;
  name: string;
  subname: string;
  minLevel: number;
  maxLevel: number;
  // 0 normal, 1 elite, 2 rare elite, 3 boss, 4 rare.
  rank: number;
  // creature_template's unit_flags, flags_extra, npcflag, and type (10 not
  // specified, 11 totem, 12 non-combat pet), for telling scenery and
  // summoned objects from units worth a nameplate.
  unitFlags: number;
  flagsExtra: number;
  npcFlags: number;
  creatureType: number;
}

export interface StreamPathUpdate {
  mapId: number;
  instanceId: number;
  serverTimeMs: number;
  paths: StreamPath[];
}

export interface MapPlayerSnapshot {
  players: MapPlayerPosition[];
  battlegrounds: MapBattlegroundState[];
  instances: MapInstanceState[];
  deaths: MapInstanceDeath[];
  events: MapSessionEvent[];
  source: 'worldserver' | 'database';
  capturedAt: number;
}

export type SessionEventType = 'kill' | 'death' | 'loot' | 'level' | 'boss' | 'objective' | 'flag-capture' | 'match-result';

export interface RecordedSessionEvent {
  id: string;
  source: 'worldserver' | 'snapshot';
  sourceEventId?: number;
  type: SessionEventType;
  occurredAt: number;
  elapsedMs: number;
  actorGuid: number;
  actorName: string;
  targetGuid: number;
  targetType: number;
  targetName: string;
  valueId: number;
  valueName: string;
  amount: number;
  description: string;
}

export interface SessionRoutePoint {
  occurredAt: number;
  elapsedMs: number;
  name: string;
  isBot: boolean;
  teamId?: number;
  x: number;
  y: number;
  z: number;
  orientation: number;
  wmoGroupId?: number;
  alive: boolean;
  inCombat: boolean;
  onTaxi?: boolean;
  mounted?: boolean;
  sapped?: boolean;
  stunned?: boolean;
  spiritForm?: boolean;
  flagCarrier?: boolean;
  flying?: boolean;
  waitingForResurrect?: boolean;
}

export interface SessionParticipant {
  name: string;
  isBot: boolean;
  teamId?: number;
  classId: number;
  raceId?: number;
  gender?: number;
  levelStart: number;
  levelEnd: number;
}

export interface SessionTotals {
  kills: number;
  deaths: number;
  lootItems: number;
  levelUps: number;
  objectives: number;
  flagCaptures: number;
}

export interface SessionBattlegroundOutcome {
  mapId: number;
  battlegroundTypeId: number;
  status: number;
  winner: number;
  allianceScore: number;
  hordeScore: number;
}

export interface SessionRecord {
  schemaVersion: 1;
  id: string;
  mapId: number;
  mapName: string;
  mapType: number;
  difficulty: number;
  instanceId: number;
  startedAt: number;
  endedAt: number;
  elapsedMs: number;
  completed: boolean;
  battleground?: SessionBattlegroundOutcome;
  participants: SessionParticipant[];
  events: RecordedSessionEvent[];
  routes: SessionRoutePoint[];
  totals: SessionTotals;
}

export interface SessionIndexEntry {
  id: string;
  mapId: number;
  mapName: string;
  mapType: number;
  difficulty: number;
  instanceId: number;
  startedAt: number;
  endedAt: number;
  elapsedMs: number;
  participantCount: number;
  eventCount: number;
  routePointCount: number;
  battleground?: SessionBattlegroundOutcome;
  totals: SessionTotals;
  bytes: number;
}

export interface MapBotWaypointRequest {
  charName: string;
  map: number;
  position_x: number;
  position_y: number;
  position_z: number;
  playerbotsDatabase?: string;
}

export interface MapBotWaypoint {
  nodeId: number;
  name: string;
  map: number;
  x: number;
  y: number;
  z: number;
  distance: number;
  sourceDatabase: string;
}

/** One row from character_inventory + item_instance + item_template (inventory browser). */
export interface CharacterInventoryItemRow {
  bag: number;
  slot: number;
  itemGuid: number;
  itemEntry: number;
  count: number;
  currentDurability: number;
  maxDurability: number;
  enchantments: string;
  name: string;
  Quality: number;
  ItemLevel: number;
  itemClass: number;
  subclass: number;
  InventoryType: number;
  armor: number;
  dmg_min1: number;
  dmg_max1: number;
  dmg_min2: number;
  dmg_max2: number;
  delay: number;
  bonding: number;
  description: string;
  holy_res: number;
  fire_res: number;
  nature_res: number;
  frost_res: number;
  shadow_res: number;
  arcane_res: number;
  stat_type1: number;
  stat_value1: number;
  stat_type2: number;
  stat_value2: number;
  stat_type3: number;
  stat_value3: number;
  stat_type4: number;
  stat_value4: number;
  stat_type5: number;
  stat_value5: number;
  stat_type6: number;
  stat_value6: number;
  stat_type7: number;
  stat_value7: number;
  stat_type8: number;
  stat_value8: number;
  stat_type9: number;
  stat_value9: number;
  stat_type10: number;
  stat_value10: number;
  socketColor_1: number;
  socketColor_2: number;
  socketColor_3: number;
  ContainerSlots: number;
}

export interface CharacterInventoryResult {
  success: boolean;
  message: string;
  characterName: string;
  characterGuid: number | null;
  items: CharacterInventoryItemRow[];
  /** item_instance.guid of a container → display name */
  bagLabels: Record<string, string>;
}

export interface EconomyOverview {
  totalAuctions: number;
  uniqueAuctionItems: number;
  totalListedQuantity: number;
  totalBuyoutValue: number;
  averageListingBuyout: number;
  averageUnitBuyout: number;
  totalCharacters: number;
  totalCharacterGold: number;
  averageCharacterGold: number;
  richestCharacterName: string | null;
  richestCharacterGold: number;
}

export interface EconomyCharacterGoldResult {
  found: boolean;
  characterName: string;
  level: number | null;
  race: number | null;
  class: number | null;
  money: number;
  online: boolean;
  accountId: number | null;
}

export interface EconomyAuctionRow {
  auctionId: number;
  itemEntry: number;
  itemName: string;
  quality: number;
  ownerName: string;
  bidderName: string | null;
  stackSize: number;
  startBid: number;
  currentBid: number;
  buyoutPrice: number;
  deposit: number;
  houseId: number;
  expiresAt: number;
}

export interface EconomyMarketSummaryRow {
  itemEntry: number;
  itemName: string;
  quality: number;
  listingCount: number;
  totalQuantity: number;
  averageListingBuyout: number;
  averageUnitBuyout: number;
  minimumUnitBuyout: number;
  maximumUnitBuyout: number;
}

// ── SOAP Types ────────────────────────────────────────────────────────────

export interface SoapConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface SoapResult {
  success: boolean;
  message: string;
}

export interface LogMonitorConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  worldserverConfigPath: string;
  liveFollow: boolean;
  refreshIntervalSeconds: number;
}

export interface LogMonitorAppenderInfo {
  name: string;
  type: 'none' | 'console' | 'file' | 'db';
  typeId: number;
  logLevel: number;
  logLevelLabel: string;
  flags: number;
  optionalValues: string[];
  fileName: string | null;
  mode: string | null;
  maxFileSize: number | null;
  resolvedPath: string | null;
  isDynamicFile: boolean;
  matchedDynamicFiles?: string[];
}

export interface LogMonitorLoggerInfo {
  name: string;
  logLevel: number;
  logLevelLabel: string;
  appenderNames: string[];
  resolvedFiles: string[];
}

export interface LogMonitorFileInfo {
  path: string;
  name: string;
  size: number | null;
  modifiedAt: string | null;
  readable: boolean;
  sourceHints: string[];
  matchedAppenderNames: string[];
}

export interface LogMonitorInspectionResult {
  success: boolean;
  message: string;
  inspectedAt: string;
  host: string;
  port: number;
  username: string;
  configPath: string;
  configDirectory: string;
  logsDir: string | null;
  resolvedLogsDir: string | null;
  packetLogFile: string | null;
  appenders: LogMonitorAppenderInfo[];
  loggers: LogMonitorLoggerInfo[];
  files: LogMonitorFileInfo[];
  warnings: string[];
}

export interface LogMonitorFileTailResult {
  success: boolean;
  path: string;
  content: string;
  bytesRead: number;
  truncated: boolean;
  message: string;
}

export interface EntityMediaPreviewRequest {
  entityType: string;
  id: string;
  displayIds?: number[];
}

export interface EntityMediaPreviewResult {
  status: 'ready' | 'unsupported' | 'error';
  sourceLabel: string;
  sourceUrl: string | null;
  imageUrl: string | null;
  title: string | null;
  summary: string | null;
  message: string;
}

// ── Profile Types ──────────────────────────────────────────────────────────

export interface ConnectionProfile {
  id: string;
  name: string;
  type?: 'soap' | 'database';
  config?: SoapConfig | DbConfig;
  soapConfig: SoapConfig;
  databaseConfig: DbConfig;
  mapDatabaseConfig: DbConfig;
  economyDatabaseConfig: DbConfig;
  logMonitorConfig: LogMonitorConfig;
  createdAt: string;
  updatedAt: string;
}

// ── API Channel Types ──────────────────────────────────────────────────────

export type ApiChannels = {
  // SOAP operations
  'soap:connect': (config: SoapConfig) => SoapResult;
  'soap:command': (command: string) => SoapResult;
  'soap:disconnect': () => SoapResult;
  'logs:inspect': (config: LogMonitorConfig) => LogMonitorInspectionResult;
  'logs:readTail': (config: LogMonitorConfig, remotePath: string, maxBytes?: number) => LogMonitorFileTailResult;
  'app:openExternal': (url: string) => SoapResult;
  'app:getEntityMediaPreview': (request: EntityMediaPreviewRequest) => EntityMediaPreviewResult;
  
  // Database operations
  'db:connect': (config: DbConfig) => DbConnectionState;
  'db:disconnect': () => void;
  'db:testConnection': (config: DbConfig) => boolean;
  'db:query': <T>(sql: string, params?: unknown[]) => QueryResult<T>;
  'db:execute': (sql: string, params?: unknown[]) => QueryResult;
  'db:getTables': () => string[];
  'db:getSchema': (table: string) => FieldInfo[];
  'db:beginTransaction': () => void;
  'db:commit': () => void;
  'db:rollback': () => void;

  // Live map operations
  'map:connect': (config: DbConfig) => DbConnectionState;
  'map:disconnect': () => void;
  'map:getPlayerPositions': (mapId?: number, instanceId?: number) => MapPlayerSnapshot;
  'map:getOnlineCounts': () => MapOnlineCounts;
  'players:getOnline': () => OnlinePlayerRow[];
  'map:getBotWaypoint': (request: MapBotWaypointRequest) => MapBotWaypoint | null;
  'map:getCreatureInfo': (entries: number[]) => CreatureInfo[];
  'sessions:list': () => SessionIndexEntry[];
  'sessions:get': (id: string) => SessionRecord | null;
  'sessions:isRecordingEnabled': () => boolean;
  'sessions:setRecordingEnabled': (enabled: boolean) => boolean;
  'sessions:purgeCompleted': () => number;

  'economy:connect': (config: DbConfig) => DbConnectionState;
  'economy:disconnect': () => void;
  'economy:getOverview': () => EconomyOverview;
  'economy:getCharacterGold': (characterName: string) => EconomyCharacterGoldResult;
  'economy:searchAuctions': (searchTerm?: string, limit?: number) => EconomyAuctionRow[];
  'economy:getMarketSummary': (searchTerm?: string, limit?: number) => EconomyMarketSummaryRow[];

  'inventory:getCharacterInventory': (characterName: string) => CharacterInventoryResult;

  // Profile operations
  'config:getProfiles': () => ConnectionProfile[];
  'config:getActiveProfileId': () => string | null;
  'config:addProfile': (profile: Omit<ConnectionProfile, 'id' | 'createdAt' | 'updatedAt'>) => ConnectionProfile;
  'config:updateProfile': (params: { id: string; fields: Partial<ConnectionProfile> }) => ConnectionProfile;
  'config:deleteProfile': (id: string) => void;
  'config:setActiveProfile': (id: string) => void;
};
