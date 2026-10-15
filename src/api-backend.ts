import * as path from 'path';
import { apiRouter, ApiRequestContext } from './api-router';
import packageJson from '../package.json';
import { SoapClient } from './soap-client';
import { ConfigStore } from './config-store';
import { getDbService, DatabaseService } from './database/db-service';
import { SoapConfig, SoapResult, ConnectionProfile, DbConfig, DbConnectionState, QueryResult, FieldInfo, EntityMediaPreviewRequest, EntityMediaPreviewResult, LogMonitorConfig, LogMonitorInspectionResult, LogMonitorFileTailResult, MapPlayerPosition, MapPlayerSnapshot, MapOnlineCounts, OnlinePlayerRow, MapBotWaypointRequest, MapBotWaypoint, CharacterInventoryResult, CharacterInventoryItemRow, EconomyOverview, EconomyCharacterGoldResult, EconomyAuctionRow, EconomyMarketSummaryRow, SessionIndexEntry, SessionRecord, BackendConnectionStatus, ManagedServiceName, CreatureInfo } from './types/api';
import { ManagedConnectionLifecycle } from './managed-connection-lifecycle';
import { inspectRemoteLogs, readRemoteLogTail } from './log-monitor-service';
import { buildLiveMapTelemetryCommand, parseLiveMapTelemetrySnapshot } from './live-map-telemetry';
import { SessionRecorder } from './session-recorder';
import { TelemetryStream } from './telemetry-stream';

export const APP_NAME = 'WoW Admin';
export const APP_VERSION = packageJson.version;
const DEFAULT_DATA_DIR = path.resolve(process.cwd(), '.wowmin-data');

let soapClient: SoapClient | null = null;
let configStore: ConfigStore | null = null;
const dbService = getDbService();
const mapDbService = new DatabaseService();
const economyDbService = new DatabaseService();
const DEFAULT_GITHUB_REPO = 'scarecr0w12/wowmin';
const ENTITY_MEDIA_CACHE_TTL_MS = 60 * 60 * 1000;
const entityMediaCache = new Map<string, { expiresAt: number; result: EntityMediaPreviewResult }>();
const sessionRecorder = new SessionRecorder({
  dataDir: process.env.WOWMIN_DATA_DIR || DEFAULT_DATA_DIR,
  mapAssetIndexPath: path.resolve(__dirname, '..', 'assets', 'instances', 'index.json'),
  routeIntervalMs: Number(process.env.WOWMIN_SESSION_ROUTE_INTERVAL_MS) || 5000,
  completionGraceMs: Number(process.env.WOWMIN_SESSION_COMPLETION_GRACE_MS) || 15000,
});
let telemetryPollTimer: ReturnType<typeof setInterval> | null = null;
let managedConnections: ManagedConnectionLifecycle | null = null;
let telemetryPollInFlight: Promise<MapPlayerSnapshot | null> | null = null;
let latestTelemetrySnapshot: MapPlayerSnapshot | null = null;
const telemetryPollIntervalMs = Math.max(500, Number(process.env.WOWMIN_TELEMETRY_POLL_MS) || 1000);
// Live position stream from mod-wowmin-telemetry (WowMinTelemetry.Stream.*).
// The UDP socket opens only while a session is being watched.
export const telemetryStream = new TelemetryStream(
  (command) => soapClient
    ? soapClient.executeCommand(command)
    : Promise.resolve({ success: false, message: 'Not connected to the worldserver.' }),
  process.env.WOWMIN_STREAM_HOST || '127.0.0.1',
  Number(process.env.WOWMIN_STREAM_PORT) || 7979,
);

export interface ManagedBackendConfig {
  soap: SoapConfig;
  worldDatabase: DbConfig;
  mapDatabase: DbConfig;
  economyDatabase: DbConfig;
  initialRetryMs?: number;
  maximumRetryMs?: number;
  healthCheckMs?: number;
}

function getGithubRepoSlug(): string {
  const metadataSources = [packageJson.homepage, (packageJson as { repository?: string | { url?: string } }).repository]
    .flatMap((value) => {
      if (!value) return [] as string[];
      if (typeof value === 'string') return [value];
      return value.url ? [value.url] : [];
    });

  for (const source of metadataSources) {
    const match = source.match(/github\.com[/:]([^/]+\/[^/#?]+?)(?:\.git)?(?:[#?].*)?$/i);
    if (match?.[1]) {
      return match[1];
    }
  }

  return DEFAULT_GITHUB_REPO;
}

function buildWowheadEntityUrl(entityType: string, id: string): string | null {
  switch (entityType) {
    case 'item':
      return `https://www.wowhead.com/wotlk/item=${encodeURIComponent(id)}`;
    case 'creature':
      return `https://www.wowhead.com/wotlk/npc=${encodeURIComponent(id)}`;
    case 'quest':
      return `https://www.wowhead.com/wotlk/quest=${encodeURIComponent(id)}`;
    case 'gameobject':
      return `https://www.wowhead.com/wotlk/object=${encodeURIComponent(id)}`;
    default:
      return null;
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractMetaContent(html: string, propertyName: string): string | null {
  const escapedProperty = propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escapedProperty}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escapedProperty}["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+name=["']${escapedProperty}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escapedProperty}["'][^>]*>`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return decodeHtmlEntities(match[1].trim());
    }
  }

  return null;
}

function extractTextSummary(html: string): string | null {
  const quickFactsMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i);

  if (!quickFactsMatch?.[1]) return null;
  return decodeHtmlEntities(quickFactsMatch[1].trim());
}

async function getEntityMediaPreview(request: EntityMediaPreviewRequest): Promise<EntityMediaPreviewResult> {
  const entityType = request.entityType.trim().toLowerCase();
  const id = request.id.trim();
  const cacheKey = `${entityType}:${id}`;
  const cached = entityMediaCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const sourceUrl = buildWowheadEntityUrl(entityType, id);
  if (!sourceUrl) {
    return {
      status: 'unsupported',
      sourceLabel: 'Reference Preview',
      sourceUrl: null,
      imageUrl: null,
      title: null,
      summary: null,
      message: `No live media source is configured yet for ${entityType}.`,
    };
  }

  try {
    const response = await fetch(sourceUrl, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': `${APP_NAME}/${APP_VERSION} (+https://github.com/${getGithubRepoSlug()})`,
      },
    });

    if (!response.ok) {
      throw new Error(`Source returned ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const imageUrl = extractMetaContent(html, 'og:image') || extractMetaContent(html, 'twitter:image');
    const title = extractMetaContent(html, 'og:title') || extractMetaContent(html, 'twitter:title');
    const summary = extractMetaContent(html, 'og:description') || extractTextSummary(html);

    const result: EntityMediaPreviewResult = {
      status: imageUrl ? 'ready' : 'error',
      sourceLabel: 'Wowhead Visual Reference',
      sourceUrl,
      imageUrl,
      title,
      summary,
      message: imageUrl
        ? 'Live reference image fetched successfully.'
        : 'The reference page loaded, but it did not expose an image preview.',
    };

    entityMediaCache.set(cacheKey, {
      expiresAt: Date.now() + ENTITY_MEDIA_CACHE_TTL_MS,
      result,
    });

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      status: 'error',
      sourceLabel: 'Wowhead Visual Reference',
      sourceUrl,
      imageUrl: null,
      title: null,
      summary: null,
      message: `Unable to fetch live reference media right now: ${errorMessage}`,
    };
  }
}

// ── API handlers ──────────────────────────────────────────────

async function pollWorldTelemetry(): Promise<MapPlayerSnapshot | null> {
  if (telemetryPollInFlight) return telemetryPollInFlight;
  telemetryPollInFlight = (async () => {
    const client = soapClient;
    if (!client) return null;
    try {
      const telemetry = await client.executeCommand(buildLiveMapTelemetryCommand());
      if (!telemetry.success) return null;
      const parsed = parseLiveMapTelemetrySnapshot(telemetry.message);
      if (!parsed) return null;
      const snapshot: MapPlayerSnapshot = { ...parsed, source: 'worldserver', capturedAt: Date.now() };
      latestTelemetrySnapshot = snapshot;
      await sessionRecorder.ingest(snapshot);
      return snapshot;
    } catch {
      return null;
    }
  })().finally(() => {
    telemetryPollInFlight = null;
  });
  return telemetryPollInFlight;
}

function startTelemetryPolling(): void {
  if (telemetryPollTimer) clearInterval(telemetryPollTimer);
  void pollWorldTelemetry();
  telemetryPollTimer = setInterval(() => void pollWorldTelemetry(), telemetryPollIntervalMs);
}

function stopTelemetryPolling(): void {
  if (telemetryPollTimer) clearInterval(telemetryPollTimer);
  telemetryPollTimer = null;
  latestTelemetrySnapshot = null;
}

function filterTelemetrySnapshot(
  snapshot: MapPlayerSnapshot,
  mapId?: number,
  instanceId?: number,
): MapPlayerSnapshot {
  if (!Number.isInteger(mapId)) return snapshot;
  const matchesSession = (candidateMapId: number, candidateInstanceId: number): boolean =>
    candidateMapId === mapId && (!Number.isInteger(instanceId) || candidateInstanceId === instanceId);
  return {
    ...snapshot,
    players: snapshot.players.filter((player) => matchesSession(player.map, player.instanceId)),
    battlegrounds: snapshot.battlegrounds.filter((state) => matchesSession(state.mapId, state.instanceId)),
    instances: snapshot.instances.filter((state) => matchesSession(state.mapId, state.instanceId)),
    deaths: snapshot.deaths.filter((death) => matchesSession(death.mapId, death.instanceId)),
    events: snapshot.events.filter((event) => matchesSession(event.mapId, event.instanceId)),
  };
}

async function connectSoap(config: SoapConfig): Promise<SoapResult> {
  try {
    soapClient = new SoapClient({
      host: config.host,
      port: Number(config.port),
      username: config.username,
      password: config.password,
    });

    const result = await soapClient.testConnection();
    if (result.success) startTelemetryPolling();
    else soapClient = null;
    return result;
  } catch (err) {
    stopTelemetryPolling();
    soapClient = null;
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { success: false, message: errorMessage };
  }
}

function managedServiceResult(service: ManagedServiceName): SoapResult {
  const status = managedConnections?.snapshot().services[service];
  return status?.phase === 'connected'
    ? { success: true, message: `${service} is managed by the server.` }
    : { success: false, message: status?.error || `${service} is connecting.` };
}

apiRouter.handle('soap:connect', async (_event, config: SoapConfig): Promise<SoapResult> => {
  if (managedConnections) return managedServiceResult('soap');
  return connectSoap(config);
});

apiRouter.handle('soap:command', async (_event, command: string): Promise<SoapResult> => {
  if (!soapClient) {
    return { success: false, message: 'Not connected. Configure connection first.' };
  }

  try {
    return await soapClient.executeCommand(command);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { success: false, message: errorMessage };
  }
});

apiRouter.handle('soap:disconnect', async (): Promise<SoapResult> => {
  if (managedConnections) return { success: true, message: 'SOAP is managed by the server.' };
  stopTelemetryPolling();
  soapClient = null;
  return { success: true, message: 'Disconnected.' };
});

apiRouter.handle('logs:inspect', async (_event, config: LogMonitorConfig): Promise<LogMonitorInspectionResult> => {
  return inspectRemoteLogs(config);
});

apiRouter.handle('logs:readTail', async (_event, config: LogMonitorConfig, remotePath: string, maxBytes?: number): Promise<LogMonitorFileTailResult> => {
  return readRemoteLogTail(config, remotePath, maxBytes);
});

apiRouter.handle('app:openExternal', async (_event, url: string): Promise<SoapResult> => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only HTTP(S) links are supported.');
    }
    return { success: true, message: 'Opened link in your browser.' };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Failed to open link: ${errorMessage}` };
  }
});

apiRouter.handle('app:getEntityMediaPreview', async (_event, request: EntityMediaPreviewRequest): Promise<EntityMediaPreviewResult> => {
  return getEntityMediaPreview(request);
});

apiRouter.handle('app:getConnectionStatus', (): BackendConnectionStatus => getBackendConnectionStatus());

// ── Profile API handlers ──────────────────────────────────────

apiRouter.handle('config:getProfiles', (): ConnectionProfile[] => {
  return configStore?.getProfiles() ?? [];
});

apiRouter.handle('config:getActiveProfileId', (): string | null => {
  return configStore?.getActiveProfileId() ?? null;
});

apiRouter.handle(
  'config:addProfile',
  (_event, profile: Omit<ConnectionProfile, 'id' | 'createdAt' | 'updatedAt'>): ConnectionProfile => {
    return configStore!.addProfile(profile);
  }
);

apiRouter.handle(
  'config:updateProfile',
  (_event, { id, fields }: { id: string; fields: Partial<ConnectionProfile> }): ConnectionProfile | null => {
    return configStore!.updateProfile(id, fields);
  }
);

apiRouter.handle('config:deleteProfile', (_event, id: string): { success: boolean } => {
  configStore?.deleteProfile(id);
  return { success: true };
});

apiRouter.handle('config:setActiveProfile', (_event, id: string): { success: boolean } => {
  configStore?.setActiveProfile(id);
  return { success: true };
});

// ── Database API handlers ──────────────────────────────────────

apiRouter.handle('db:connect', async (_event, config: DbConfig): Promise<DbConnectionState> => {
  if (managedConnections) {
    const status = managedConnections.snapshot().services.worldDatabase;
    return { connected: status.phase === 'connected', database: dbService.config?.database ?? null, error: status.error };
  }
  try {
    const result = await dbService.connect(config);
    if (result.success) {
      return { connected: true, database: config.database, error: null };
    }
    return { connected: false, database: null, error: result.message };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { connected: false, database: null, error: errorMessage };
  }
});

apiRouter.handle('db:disconnect', async (): Promise<void> => {
  if (!managedConnections) await dbService.disconnect();
});

apiRouter.handle('db:testConnection', async (_event, config: DbConfig): Promise<boolean> => {
  return dbService.testConnection(config);
});

apiRouter.handle('db:query', async <T>(_event: ApiRequestContext, sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
  return dbService.query<T>(sql, params);
});

apiRouter.handle('db:execute', async (_event, sql: string, params?: unknown[]): Promise<QueryResult> => {
  return dbService.execute(sql, params);
});

apiRouter.handle('db:getTables', async (): Promise<string[]> => {
  return dbService.getTables();
});

apiRouter.handle('db:getSchema', async (_event, table: string): Promise<FieldInfo[]> => {
  return dbService.getSchema(table);
});

apiRouter.handle('db:beginTransaction', async (): Promise<void> => {
  await dbService.beginTransaction();
});

apiRouter.handle('db:commit', async (): Promise<void> => {
  await dbService.commit();
});

apiRouter.handle('db:rollback', async (): Promise<void> => {
  await dbService.rollback();
});

// ── Map API handlers ───────────────────────────────────────────

interface MapPlayerQueryRow {
  name: string;
  map: number;
  instance_id: number;
  position_x: number;
  position_y: number;
  position_z: number;
  level: number;
  race: number;
  class: number;
  gender: number;
  account: string | number;
}

let mapAuthDatabaseName = 'acore_auth';
let mapPlayerbotsDatabaseName = 'acore_playerbots';

function deriveAuthDatabaseName(charactersDatabaseName: string): string {
  const normalized = charactersDatabaseName.trim();
  if (!normalized) return 'acore_auth';
  if (/characters$/i.test(normalized)) {
    return normalized.replace(/characters$/i, 'auth');
  }
  if (/_char$/i.test(normalized)) {
    return normalized.replace(/_char$/i, '_auth');
  }
  return 'acore_auth';
}

function derivePlayerbotsDatabaseName(charactersDatabaseName: string): string {
  const normalized = charactersDatabaseName.trim();
  if (!normalized) return 'acore_playerbots';
  if (/characters$/i.test(normalized)) {
    return normalized.replace(/characters$/i, 'playerbots');
  }
  if (/_char$/i.test(normalized)) {
    return normalized.replace(/_char$/i, '_playerbots');
  }
  return 'acore_playerbots';
}

function escapeIdentifier(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``;
}

function deriveWorldDatabaseName(charactersDatabaseName: string): string {
  const normalized = charactersDatabaseName.trim();
  if (!normalized) return 'acore_world';
  if (/characters$/i.test(normalized)) {
    return normalized.replace(/characters$/i, 'world');
  }
  if (/_char$/i.test(normalized)) {
    return normalized.replace(/_char$/i, '_world');
  }
  return 'acore_world';
}

function isCharactersDatabase(database: string): boolean {
  const normalized = database.trim();
  if (!normalized) return false;
  if (/characters$/i.test(normalized)) return true;
  if (/_char$/i.test(normalized)) return true;
  return false;
}

function getCharactersDbService(): DatabaseService | null {
  if (mapDbService.connected && mapDbService.config?.database && isCharactersDatabase(mapDbService.config.database)) {
    return mapDbService;
  }
  if (dbService.connected && dbService.config?.database && isCharactersDatabase(dbService.config.database)) {
    return dbService;
  }
  return null;
}

function numField(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** MySQL may return column names lowercased depending on server OS/settings. */
function rowVal(raw: Record<string, unknown>, key: string): unknown {
  if (Object.prototype.hasOwnProperty.call(raw, key)) return raw[key];
  const lower = key.toLowerCase();
  for (const k of Object.keys(raw)) {
    if (k.toLowerCase() === lower) return raw[k];
  }
  return undefined;
}

function mapInventorySqlRow(raw: Record<string, unknown>): CharacterInventoryItemRow {
  const s = (k: string): string => {
    const v = rowVal(raw, k);
    return v == null ? '' : String(v);
  };
  const n = (k: string, d = 0): number => numField(rowVal(raw, k), d);

  return {
    bag: n('bag'),
    slot: n('slot'),
    itemGuid: n('itemGuid'),
    itemEntry: n('itemEntry'),
    count: n('count', 1),
    currentDurability: n('currentDurability'),
    maxDurability: n('maxDurability'),
    enchantments: s('enchantments'),
    name: s('name') || 'Unknown item',
    Quality: n('Quality'),
    ItemLevel: n('ItemLevel'),
    itemClass: n('itemClass'),
    subclass: n('subclass'),
    InventoryType: n('InventoryType'),
    armor: n('armor'),
    dmg_min1: n('dmg_min1'),
    dmg_max1: n('dmg_max1'),
    dmg_min2: n('dmg_min2'),
    dmg_max2: n('dmg_max2'),
    delay: n('delay'),
    bonding: n('bonding'),
    description: s('description'),
    holy_res: n('holy_res'),
    fire_res: n('fire_res'),
    nature_res: n('nature_res'),
    frost_res: n('frost_res'),
    shadow_res: n('shadow_res'),
    arcane_res: n('arcane_res'),
    stat_type1: n('stat_type1'),
    stat_value1: n('stat_value1'),
    stat_type2: n('stat_type2'),
    stat_value2: n('stat_value2'),
    stat_type3: n('stat_type3'),
    stat_value3: n('stat_value3'),
    stat_type4: n('stat_type4'),
    stat_value4: n('stat_value4'),
    stat_type5: n('stat_type5'),
    stat_value5: n('stat_value5'),
    stat_type6: n('stat_type6'),
    stat_value6: n('stat_value6'),
    stat_type7: n('stat_type7'),
    stat_value7: n('stat_value7'),
    stat_type8: n('stat_type8'),
    stat_value8: n('stat_value8'),
    stat_type9: n('stat_type9'),
    stat_value9: n('stat_value9'),
    stat_type10: n('stat_type10'),
    stat_value10: n('stat_value10'),
    socketColor_1: n('socketColor_1'),
    socketColor_2: n('socketColor_2'),
    socketColor_3: n('socketColor_3'),
    ContainerSlots: n('ContainerSlots'),
  };
}

apiRouter.handle('map:connect', async (_event, config: DbConfig): Promise<DbConnectionState> => {
  if (managedConnections) {
    const status = managedConnections.snapshot().services.mapDatabase;
    return { connected: status.phase === 'connected', database: mapDbService.config?.database ?? null, error: status.error };
  }
  try {
    const result = await mapDbService.connect(config);
    if (result.success) {
      mapAuthDatabaseName = deriveAuthDatabaseName(config.database || '');
      mapPlayerbotsDatabaseName = derivePlayerbotsDatabaseName(config.database || '');
      return { connected: true, database: config.database, error: null };
    }
    return { connected: false, database: null, error: result.message };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { connected: false, database: null, error: errorMessage };
  }
});

apiRouter.handle('map:disconnect', async (): Promise<void> => {
  if (!managedConnections) await mapDbService.disconnect();
});

// ── Economy API handlers ─────────────────────────────────────

function getEconomyWorldTable(tableName: string): string {
  const databaseName = deriveWorldDatabaseName(economyDbService.config?.database || '');
  return `${escapeIdentifier(databaseName)}.${escapeIdentifier(tableName)}`;
}

function buildEconomySearchFilter(searchTerm: string): { whereClause: string; params: unknown[] } {
  const trimmed = searchTerm.trim();
  if (!trimmed) {
    return { whereClause: '', params: [] };
  }

  const like = `%${trimmed}%`;
  if (/^\d+$/.test(trimmed)) {
    return {
      whereClause: 'WHERE (it.name LIKE ? OR ownerChar.name LIKE ? OR CAST(ii.itemEntry AS CHAR) = ?)',
      params: [like, like, trimmed],
    };
  }

  return {
    whereClause: 'WHERE (it.name LIKE ? OR ownerChar.name LIKE ?)',
    params: [like, like],
  };
}

apiRouter.handle('economy:connect', async (_event, config: DbConfig): Promise<DbConnectionState> => {
  if (managedConnections) {
    const status = managedConnections.snapshot().services.economyDatabase;
    return { connected: status.phase === 'connected', database: economyDbService.config?.database ?? null, error: status.error };
  }
  try {
    const result = await economyDbService.connect(config);
    if (result.success) {
      return { connected: true, database: config.database, error: null };
    }
    return { connected: false, database: null, error: result.message };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { connected: false, database: null, error: errorMessage };
  }
});

apiRouter.handle('economy:disconnect', async (): Promise<void> => {
  if (!managedConnections) await economyDbService.disconnect();
});

apiRouter.handle('economy:getOverview', async (): Promise<EconomyOverview> => {
  if (!economyDbService.connected) {
    throw new Error('Economy database is not connected');
  }

  const auctionStatsResult = await economyDbService.query<{
    totalAuctions: number;
    uniqueAuctionItems: number;
    totalListedQuantity: number;
    totalBuyoutValue: number;
    averageListingBuyout: number;
    averageUnitBuyout: number;
  }>(`
    SELECT
      COUNT(*) AS totalAuctions,
      COUNT(DISTINCT ii.itemEntry) AS uniqueAuctionItems,
      COALESCE(SUM(ii.count), 0) AS totalListedQuantity,
      COALESCE(SUM(ah.buyoutprice), 0) AS totalBuyoutValue,
      COALESCE(AVG(CASE WHEN ah.buyoutprice > 0 THEN ah.buyoutprice END), 0) AS averageListingBuyout,
      COALESCE(AVG(CASE WHEN ah.buyoutprice > 0 AND ii.count > 0 THEN ah.buyoutprice / ii.count END), 0) AS averageUnitBuyout
    FROM auctionhouse ah
    INNER JOIN item_instance ii ON ii.guid = ah.itemguid
  `);

  const characterStatsResult = await economyDbService.query<{
    totalCharacters: number;
    totalCharacterGold: number;
    averageCharacterGold: number;
  }>(`
    SELECT
      COUNT(*) AS totalCharacters,
      COALESCE(SUM(money), 0) AS totalCharacterGold,
      COALESCE(AVG(money), 0) AS averageCharacterGold
    FROM characters
  `);

  const richestCharacterResult = await economyDbService.query<{
    name: string;
    money: number;
  }>(`
    SELECT name, money
    FROM characters
    ORDER BY money DESC, name ASC
    LIMIT 1
  `);

  const auctionStats = auctionStatsResult.rows[0];
  const characterStats = characterStatsResult.rows[0];
  const richestCharacter = richestCharacterResult.rows[0];

  return {
    totalAuctions: numField(auctionStats?.totalAuctions),
    uniqueAuctionItems: numField(auctionStats?.uniqueAuctionItems),
    totalListedQuantity: numField(auctionStats?.totalListedQuantity),
    totalBuyoutValue: numField(auctionStats?.totalBuyoutValue),
    averageListingBuyout: numField(auctionStats?.averageListingBuyout),
    averageUnitBuyout: numField(auctionStats?.averageUnitBuyout),
    totalCharacters: numField(characterStats?.totalCharacters),
    totalCharacterGold: numField(characterStats?.totalCharacterGold),
    averageCharacterGold: numField(characterStats?.averageCharacterGold),
    richestCharacterName: richestCharacter?.name ? String(richestCharacter.name) : null,
    richestCharacterGold: numField(richestCharacter?.money),
  };
});

apiRouter.handle('economy:getCharacterGold', async (_event, characterName: string): Promise<EconomyCharacterGoldResult> => {
  if (!economyDbService.connected) {
    throw new Error('Economy database is not connected');
  }

  const name = characterName.trim();
  if (!name) {
    return {
      found: false,
      characterName: '',
      level: null,
      race: null,
      class: null,
      money: 0,
      online: false,
      accountId: null,
    };
  }

  const result = await economyDbService.query<{
    name: string;
    level: number;
    race: number;
    class: number;
    money: number;
    online: number;
    account: number;
  }>(`
    SELECT name, level, race, class, money, online, account
    FROM characters
    WHERE LOWER(name) = LOWER(?)
    LIMIT 1
  `, [name]);

  const row = result.rows[0];
  if (!row) {
    return {
      found: false,
      characterName: name,
      level: null,
      race: null,
      class: null,
      money: 0,
      online: false,
      accountId: null,
    };
  }

  return {
    found: true,
    characterName: String(row.name),
    level: numField(row.level),
    race: numField(row.race),
    class: numField(row.class),
    money: numField(row.money),
    online: numField(row.online) > 0,
    accountId: numField(row.account),
  };
});

apiRouter.handle('economy:searchAuctions', async (_event, searchTerm: string = '', limit: number = 50): Promise<EconomyAuctionRow[]> => {
  if (!economyDbService.connected) {
    throw new Error('Economy database is not connected');
  }

  const worldItemTemplateTable = getEconomyWorldTable('item_template');
  const normalizedLimit = Math.min(Math.max(numField(limit, 50), 1), 100);
  const { whereClause, params } = buildEconomySearchFilter(searchTerm);

  const result = await economyDbService.query<{
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
  }>(`
    SELECT
      ah.id AS auctionId,
      ii.itemEntry AS itemEntry,
      it.name AS itemName,
      it.Quality AS quality,
      COALESCE(ownerChar.name, CONCAT('GUID ', ah.itemowner)) AS ownerName,
      bidderChar.name AS bidderName,
      ii.count AS stackSize,
      ah.startbid AS startBid,
      ah.lastbid AS currentBid,
      ah.buyoutprice AS buyoutPrice,
      ah.deposit AS deposit,
      ah.houseid AS houseId,
      ah.time AS expiresAt
    FROM auctionhouse ah
    INNER JOIN item_instance ii ON ii.guid = ah.itemguid
    INNER JOIN ${worldItemTemplateTable} it ON it.entry = ii.itemEntry
    LEFT JOIN characters ownerChar ON ownerChar.guid = ah.itemowner
    LEFT JOIN characters bidderChar ON bidderChar.guid = ah.buyguid
    ${whereClause}
    ORDER BY ah.time ASC, ah.buyoutprice DESC, ah.id DESC
    LIMIT ${normalizedLimit}
  `, params);

  return result.rows.map((row) => ({
    auctionId: numField(row.auctionId),
    itemEntry: numField(row.itemEntry),
    itemName: String(row.itemName || 'Unknown item'),
    quality: numField(row.quality),
    ownerName: String(row.ownerName || 'Unknown'),
    bidderName: row.bidderName ? String(row.bidderName) : null,
    stackSize: numField(row.stackSize, 1),
    startBid: numField(row.startBid),
    currentBid: numField(row.currentBid),
    buyoutPrice: numField(row.buyoutPrice),
    deposit: numField(row.deposit),
    houseId: numField(row.houseId),
    expiresAt: numField(row.expiresAt),
  }));
});

apiRouter.handle('economy:getMarketSummary', async (_event, searchTerm: string = '', limit: number = 25): Promise<EconomyMarketSummaryRow[]> => {
  if (!economyDbService.connected) {
    throw new Error('Economy database is not connected');
  }

  const worldItemTemplateTable = getEconomyWorldTable('item_template');
  const normalizedLimit = Math.min(Math.max(numField(limit, 25), 1), 100);
  const { whereClause, params } = buildEconomySearchFilter(searchTerm);

  const result = await economyDbService.query<{
    itemEntry: number;
    itemName: string;
    quality: number;
    listingCount: number;
    totalQuantity: number;
    averageListingBuyout: number;
    averageUnitBuyout: number;
    minimumUnitBuyout: number;
    maximumUnitBuyout: number;
  }>(`
    SELECT
      ii.itemEntry AS itemEntry,
      it.name AS itemName,
      it.Quality AS quality,
      COUNT(*) AS listingCount,
      COALESCE(SUM(ii.count), 0) AS totalQuantity,
      COALESCE(AVG(CASE WHEN ah.buyoutprice > 0 THEN ah.buyoutprice END), 0) AS averageListingBuyout,
      COALESCE(AVG(CASE WHEN ah.buyoutprice > 0 AND ii.count > 0 THEN ah.buyoutprice / ii.count END), 0) AS averageUnitBuyout,
      COALESCE(MIN(CASE WHEN ah.buyoutprice > 0 AND ii.count > 0 THEN ah.buyoutprice / ii.count END), 0) AS minimumUnitBuyout,
      COALESCE(MAX(CASE WHEN ah.buyoutprice > 0 AND ii.count > 0 THEN ah.buyoutprice / ii.count END), 0) AS maximumUnitBuyout
    FROM auctionhouse ah
    INNER JOIN item_instance ii ON ii.guid = ah.itemguid
    INNER JOIN ${worldItemTemplateTable} it ON it.entry = ii.itemEntry
    LEFT JOIN characters ownerChar ON ownerChar.guid = ah.itemowner
    ${whereClause}
    GROUP BY ii.itemEntry, it.name, it.Quality
    ORDER BY listingCount DESC, totalQuantity DESC, averageUnitBuyout DESC
    LIMIT ${normalizedLimit}
  `, params);

  return result.rows.map((row) => ({
    itemEntry: numField(row.itemEntry),
    itemName: String(row.itemName || 'Unknown item'),
    quality: numField(row.quality),
    listingCount: numField(row.listingCount),
    totalQuantity: numField(row.totalQuantity),
    averageListingBuyout: numField(row.averageListingBuyout),
    averageUnitBuyout: numField(row.averageUnitBuyout),
    minimumUnitBuyout: numField(row.minimumUnitBuyout),
    maximumUnitBuyout: numField(row.maximumUnitBuyout),
  }));
});

apiRouter.handle('inventory:getCharacterInventory', async (_event, characterName: string): Promise<CharacterInventoryResult> => {
  const name = characterName?.trim() ?? '';
  if (!name) {
    return {
      success: false,
      message: 'Character name is required.',
      characterName: '',
      characterGuid: null,
      items: [],
      bagLabels: {},
    };
  }

  const charDb = getCharactersDbService();
  if (!charDb?.config?.database) {
    return {
      success: false,
      message:
        'No characters database connection. Connect the Live Map DB (recommended) or the Database tab to your characters database — same host as world — then try again.',
      characterName: name,
      characterGuid: null,
      items: [],
      bagLabels: {},
    };
  }

  const worldDb = deriveWorldDatabaseName(charDb.config.database);
  const worldTable = `${escapeIdentifier(worldDb)}.\`item_template\``;

  try {
    const guidRes = await charDb.query<{ guid: number }>(
      'SELECT guid FROM characters WHERE LOWER(name) = LOWER(?) LIMIT 1',
      [name],
    );
    const guidRow = guidRes.rows[0];
    if (!guidRow) {
      return {
        success: false,
        message: `No character named "${name}" in the connected characters database.`,
        characterName: name,
        characterGuid: null,
        items: [],
        bagLabels: {},
      };
    }
    const characterGuid = numField(guidRow.guid as unknown);

    const invSql = `
      SELECT
        ci.bag AS bag,
        ci.slot AS slot,
        ii.guid AS itemGuid,
        ii.itemEntry AS itemEntry,
        ii.count AS count,
        ii.durability AS currentDurability,
        COALESCE(it.MaxDurability, 0) AS maxDurability,
        ii.enchantments AS enchantments,
        it.name AS name,
        it.Quality AS Quality,
        it.ItemLevel AS ItemLevel,
        it.\`class\` AS itemClass,
        it.subclass AS subclass,
        it.InventoryType AS InventoryType,
        it.armor AS armor,
        it.dmg_min1 AS dmg_min1,
        it.dmg_max1 AS dmg_max1,
        it.dmg_min2 AS dmg_min2,
        it.dmg_max2 AS dmg_max2,
        it.delay AS delay,
        it.bonding AS bonding,
        COALESCE(it.description, '') AS description,
        it.holy_res AS holy_res,
        it.fire_res AS fire_res,
        it.nature_res AS nature_res,
        it.frost_res AS frost_res,
        it.shadow_res AS shadow_res,
        it.arcane_res AS arcane_res,
        it.stat_type1 AS stat_type1,
        it.stat_value1 AS stat_value1,
        it.stat_type2 AS stat_type2,
        it.stat_value2 AS stat_value2,
        it.stat_type3 AS stat_type3,
        it.stat_value3 AS stat_value3,
        it.stat_type4 AS stat_type4,
        it.stat_value4 AS stat_value4,
        it.stat_type5 AS stat_type5,
        it.stat_value5 AS stat_value5,
        it.stat_type6 AS stat_type6,
        it.stat_value6 AS stat_value6,
        it.stat_type7 AS stat_type7,
        it.stat_value7 AS stat_value7,
        it.stat_type8 AS stat_type8,
        it.stat_value8 AS stat_value8,
        it.stat_type9 AS stat_type9,
        it.stat_value9 AS stat_value9,
        it.stat_type10 AS stat_type10,
        it.stat_value10 AS stat_value10,
        it.socketColor_1 AS socketColor_1,
        it.socketColor_2 AS socketColor_2,
        it.socketColor_3 AS socketColor_3,
        COALESCE(it.ContainerSlots, 0) AS ContainerSlots
      FROM character_inventory ci
      INNER JOIN item_instance ii ON ci.item = ii.guid
      INNER JOIN ${worldTable} it ON ii.itemEntry = it.entry
      WHERE ci.guid = ?
    `;

    const invRes = await charDb.query<Record<string, unknown>>(invSql, [characterGuid]);
    const items = invRes.rows.map(mapInventorySqlRow);

    const bagIds = [...new Set(items.map((i) => i.bag).filter((b) => b > 0))];
    const bagLabels: Record<string, string> = {};

    if (bagIds.length > 0) {
      const ph = bagIds.map(() => '?').join(', ');
      const bagSql = `
        SELECT ii.guid AS guid, it.name AS name
        FROM item_instance ii
        INNER JOIN ${worldTable} it ON ii.itemEntry = it.entry
        WHERE ii.guid IN (${ph})
      `;
      const bagRes = await charDb.query<{ guid: number; name: string }>(bagSql, bagIds);
      for (const row of bagRes.rows) {
        bagLabels[String(row.guid)] = String(row.name);
      }
    }

    items.sort((a, b) => {
      if (a.bag !== b.bag) {
        if (a.bag === 0) return -1;
        if (b.bag === 0) return 1;
        return a.bag - b.bag;
      }
      return a.slot - b.slot;
    });

    return {
      success: true,
      message: `${items.length} item stack(s).`,
      characterName: name,
      characterGuid,
      items,
      bagLabels,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      message: msg,
      characterName: name,
      characterGuid: null,
      items: [],
      bagLabels: {},
    };
  }
});

apiRouter.handle('players:getOnline', async (): Promise<OnlinePlayerRow[]> => {
  const charactersDb = getCharactersDbService();
  if (!charactersDb?.config?.database) throw new Error('Characters database is not connected');
  const authName = deriveAuthDatabaseName(charactersDb.config.database);
  const authAccount = `${escapeIdentifier(authName)}.\`account\``;
  const accountAccess = `${escapeIdentifier(authName)}.\`account_access\``;
  const result = await charactersDb.query<OnlinePlayerRow>(`
    SELECT c.name, COALESCE(a.username, CAST(c.account AS CHAR)) AS account,
           COALESCE(a.last_ip, '') AS ip, c.map AS mapId, c.zone AS zoneId,
           COALESCE(a.expansion, 2) AS expansion,
           COALESCE((SELECT MAX(aa.gmlevel) FROM ${accountAccess} aa WHERE aa.id = c.account), 0) AS gmLevel,
           c.level, c.race AS raceId, c.\`class\` AS classId, c.gender
    FROM characters c
    LEFT JOIN ${authAccount} a ON a.id = c.account
    WHERE c.online > 0
  `);
  return result.rows;
});

apiRouter.handle('map:getOnlineCounts', async (): Promise<MapOnlineCounts> => {
  if (!mapDbService.connected) throw new Error('Characters database is not connected');
  const authTable = `${escapeIdentifier(mapAuthDatabaseName)}.\`account\``;
  const result = await mapDbService.query<{ total: number; bots: number }>(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN UPPER(a.username) LIKE 'RNDBOT%' THEN 1 ELSE 0 END), 0) AS bots
    FROM characters c
    LEFT JOIN ${authTable} a ON a.id = c.account
    WHERE c.online = 1
  `);
  const total = numField(result.rows[0]?.total);
  const bots = numField(result.rows[0]?.bots);
  return { players: total - bots, bots, total };
});

apiRouter.handle('map:getPlayerPositions', async (_event, mapId?: number, instanceId?: number): Promise<MapPlayerSnapshot> => {
  if (soapClient) {
    const freshSnapshot = latestTelemetrySnapshot && Date.now() - latestTelemetrySnapshot.capturedAt <= telemetryPollIntervalMs
      ? latestTelemetrySnapshot
      : await pollWorldTelemetry();
    if (freshSnapshot) return filterTelemetrySnapshot(freshSnapshot, mapId, instanceId);
    if (latestTelemetrySnapshot) return filterTelemetrySnapshot(latestTelemetrySnapshot, mapId, instanceId);
  }

  const filters: string[] = [];
  const params: number[] = [];
  if (Number.isInteger(mapId)) {
    filters.push('map = ?');
    params.push(mapId as number);
  }
  if (Number.isInteger(instanceId)) {
    filters.push('instance_id = ?');
    params.push(instanceId as number);
  }
  const whereFilters = filters.length ? ` AND ${filters.join(' AND ')}` : '';
  const result = await mapDbService.query<MapPlayerQueryRow>(
    `SELECT name, map, instance_id, position_x, position_y, position_z, level, race, \`class\`, gender, account
       FROM characters WHERE online = 1${whereFilters}`,
    params,
  );
  const rows = result.rows || [];
  const accountIds = [...new Set(rows.map((row) => Number(row.account))
    .filter((accountId) => Number.isInteger(accountId) && accountId > 0))];
  let usernamesById = new Map<number, string>();

  if (accountIds.length > 0) {
    const placeholders = accountIds.map(() => '?').join(', ');
    const authTable = `${escapeIdentifier(mapAuthDatabaseName)}.\`account\``;
    const accountsResult = await mapDbService.query<{ id: number; username: string }>(
      `SELECT id, username FROM ${authTable} WHERE id IN (${placeholders})`,
      accountIds,
    );
    usernamesById = new Map(accountsResult.rows.map((row) => [Number(row.id), row.username]));
  }

  const players = rows.map((row): MapPlayerPosition => {
    const accountId = Number(row.account);
    const account = usernamesById.get(accountId) ?? String(row.account);
    return {
      name: row.name,
      map: Number(row.map),
      instanceId: Number(row.instance_id),
      position_x: Number(row.position_x),
      position_y: Number(row.position_y),
      position_z: Number(row.position_z),
      orientation: 0,
      level: Number(row.level),
      race: Number(row.race),
      class: Number(row.class),
      gender: Number(row.gender),
      account,
      accountId,
      isBot: /^RNDBOT/i.test(account),
      alive: true,
      inCombat: false,
    };
  });
  return {
    players,
    battlegrounds: [],
    instances: [],
    deaths: [],
    events: [],
    source: 'database',
    capturedAt: Date.now(),
  };
});

apiRouter.handle('sessions:list', async (): Promise<SessionIndexEntry[]> => sessionRecorder.list());

apiRouter.handle('sessions:get', async (_event, id: string): Promise<SessionRecord | null> => sessionRecorder.get(id));

apiRouter.handle('sessions:isRecordingEnabled', async (): Promise<boolean> => sessionRecorder.isEnabled());

apiRouter.handle('sessions:setRecordingEnabled', async (_event, enabled: boolean): Promise<boolean> =>
  sessionRecorder.setEnabled(Boolean(enabled)));

apiRouter.handle('sessions:purgeCompleted', async (): Promise<number> => sessionRecorder.purgeCompleted());

// Names, levels, and ranks for creatures in the live stream, by entry.
apiRouter.handle('map:getCreatureInfo', async (_event, entries: unknown): Promise<CreatureInfo[]> => {
  const ids = [...new Set((Array.isArray(entries) ? entries : []).map(Number))]
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, 500);
  const charDb = getCharactersDbService();
  if (!ids.length || !charDb?.config) return [];
  const worldDb = process.env.WOWMIN_WORLD_DB || deriveWorldDatabaseName(charDb.config.database);
  const result = await charDb.query<{
    entry: number;
    name: string;
    subname: string | null;
    minlevel: number;
    maxlevel: number;
    rank: number;
    unit_flags: number;
    flags_extra: number;
    npcflag: number;
    type: number;
  }>(
    `SELECT entry, name, subname, minlevel, maxlevel, \`rank\`, unit_flags, flags_extra, npcflag, \`type\`
       FROM ${escapeIdentifier(worldDb)}.\`creature_template\`
      WHERE entry IN (${ids.map(() => '?').join(', ')})`,
    ids,
  );
  return result.rows.map((row) => ({
    entry: Number(row.entry),
    name: row.name,
    subname: row.subname ?? '',
    minLevel: Number(row.minlevel),
    maxLevel: Number(row.maxlevel),
    rank: Number(row.rank),
    unitFlags: Number(row.unit_flags) || 0,
    flagsExtra: Number(row.flags_extra) || 0,
    npcFlags: Number(row.npcflag) || 0,
    creatureType: Number(row.type) || 0,
  }));
});

apiRouter.handle('map:getBotWaypoint', async (_event, request: MapBotWaypointRequest): Promise<MapBotWaypoint | null> => {
  try {
    const databaseName = request.playerbotsDatabase?.trim() || mapPlayerbotsDatabaseName;
    const travelTable = `${escapeIdentifier(databaseName)}.\`playerbots_travelnode\``;
    const result = await mapDbService.query<{
      id: number;
      name: string;
      map_id: number;
      x: number;
      y: number;
      z: number;
      distance_sq: number;
    }>(
      `SELECT id, name, map_id, x, y, z,
              POW(x - ?, 2) + POW(y - ?, 2) + POW(z - ?, 2) AS distance_sq
         FROM ${travelTable}
        WHERE map_id = ?
        ORDER BY distance_sq ASC
        LIMIT 1`,
      [request.position_x, request.position_y, request.position_z, request.map],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      nodeId: Number(row.id),
      name: row.name,
      map: Number(row.map_id),
      x: Number(row.x),
      y: Number(row.y),
      z: Number(row.z),
      distance: Math.sqrt(Math.max(0, Number(row.distance_sq) || 0)),
      sourceDatabase: databaseName,
    };
  } catch {
    return null;
  }
});

function unmanagedServiceStatus(connected: boolean): BackendConnectionStatus['services']['soap'] {
  return { phase: connected ? 'connected' : 'disconnected', error: null, retryAt: null };
}

export function getBackendConnectionStatus(): BackendConnectionStatus {
  if (managedConnections) return managedConnections.snapshot();
  return {
    managed: false,
    updatedAt: Date.now(),
    services: {
      soap: unmanagedServiceStatus(Boolean(soapClient)),
      worldDatabase: unmanagedServiceStatus(dbService.connected),
      mapDatabase: unmanagedServiceStatus(mapDbService.connected),
      economyDatabase: unmanagedServiceStatus(economyDbService.connected),
    },
  };
}

export function initializeManagedConnections(config: ManagedBackendConfig): Promise<BackendConnectionStatus> {
  if (managedConnections) return managedConnections.ensureConnected();

  const labels: Record<ManagedServiceName, string> = {
    soap: 'SOAP',
    worldDatabase: 'world database',
    mapDatabase: 'characters database',
    economyDatabase: 'economy database',
  };
  managedConnections = new ManagedConnectionLifecycle({
    soap: {
      connected: () => Boolean(soapClient),
      check: async () => Boolean(soapClient && (await soapClient.testConnection()).success),
      connect: () => connectSoap(config.soap),
      disconnect: async () => {
        stopTelemetryPolling();
        soapClient = null;
      },
    },
    worldDatabase: {
      connected: () => dbService.connected,
      check: () => dbService.checkConnection(),
      connect: () => dbService.connect(config.worldDatabase),
      disconnect: () => dbService.disconnect(),
    },
    mapDatabase: {
      connected: () => mapDbService.connected,
      check: () => mapDbService.checkConnection(),
      connect: async () => {
        const result = await mapDbService.connect(config.mapDatabase);
        if (result.success) {
          mapAuthDatabaseName = deriveAuthDatabaseName(config.mapDatabase.database);
          mapPlayerbotsDatabaseName = derivePlayerbotsDatabaseName(config.mapDatabase.database);
        }
        return result;
      },
      disconnect: () => mapDbService.disconnect(),
    },
    economyDatabase: {
      connected: () => economyDbService.connected,
      check: () => economyDbService.checkConnection(),
      connect: () => economyDbService.connect(config.economyDatabase),
      disconnect: () => economyDbService.disconnect(),
    },
  }, {
    initialRetryMs: config.initialRetryMs,
    maximumRetryMs: config.maximumRetryMs,
    healthCheckMs: config.healthCheckMs,
    onTransition: (service, previous, status) => {
      const detail = status.error ? `: ${status.error}` : '';
      console.log(`Managed ${labels[service]} ${previous} -> ${status.phase}${detail}`);
    },
  });
  return managedConnections.start();
}

export async function shutdownApiBackend(): Promise<void> {
  if (managedConnections) {
    const lifecycle = managedConnections;
    await lifecycle.stop();
    if (managedConnections === lifecycle) managedConnections = null;
    return;
  }
  stopTelemetryPolling();
  soapClient = null;
  await Promise.allSettled([dbService.disconnect(), mapDbService.disconnect(), economyDbService.disconnect()]);
}

export function initializeApiBackend(dataDir = process.env.WOWMIN_DATA_DIR || DEFAULT_DATA_DIR): void {
  if (!configStore) {
    configStore = new ConfigStore(dataDir);
  }
}
