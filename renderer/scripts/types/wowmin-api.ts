import type {
  BackendConnectionStatus,
  CharacterInventoryResult,
  ConnectionProfile,
  DbConfig,
  DbConnectionState,
  EconomyAuctionRow,
  EconomyCharacterGoldResult,
  EconomyMarketSummaryRow,
  EconomyOverview,
  EntityMediaPreviewRequest,
  EntityMediaPreviewResult,
  FieldInfo,
  LogMonitorConfig,
  LogMonitorFileTailResult,
  LogMonitorInspectionResult,
  MapBotWaypoint,
  MapBotWaypointRequest,
  MapOnlineCounts,
  CreatureInfo,
  MapPlayerSnapshot,
  OnlinePlayerRow,
  QueryResult,
  SessionIndexEntry,
  SessionRecord,
  SoapConfig,
  SoapResult,
  StreamListeners,
} from '../../../src/types/api';

export interface BootstrapConfig {
  managed: boolean;
  localLogs: boolean;
  dungeonClearUrl: string;
  connections: BackendConnectionStatus;
}

export interface WowminAPI {
  soap: {
    connect(config: SoapConfig): Promise<SoapResult>;
    command(command: string): Promise<SoapResult>;
    disconnect(): Promise<SoapResult>;
  };
  logs: {
    inspect(config: LogMonitorConfig): Promise<LogMonitorInspectionResult>;
    readTail(config: LogMonitorConfig, remotePath: string, maxBytes?: number): Promise<LogMonitorFileTailResult>;
  };
  app: {
    getBootstrap(): Promise<BootstrapConfig>;
    getConnectionStatus(): Promise<BackendConnectionStatus>;
    openExternal(url: string): Promise<SoapResult>;
    getEntityMediaPreview(request: EntityMediaPreviewRequest): Promise<EntityMediaPreviewResult>;
  };
  db: {
    connect(config: DbConfig): Promise<DbConnectionState>;
    disconnect(): Promise<void>;
    testConnection(config: DbConfig): Promise<boolean>;
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
    execute(sql: string, params?: unknown[]): Promise<QueryResult>;
    getTables(): Promise<string[]>;
    getSchema(table: string): Promise<FieldInfo[]>;
    beginTransaction(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
  };
  players: {
    getOnline(): Promise<OnlinePlayerRow[]>;
  };
  map: {
    connect(config: DbConfig): Promise<DbConnectionState>;
    disconnect(): Promise<void>;
    getPlayerPositions(mapId?: number, instanceId?: number): Promise<MapPlayerSnapshot>;
    // The live position stream (mod-wowmin-telemetry) for one instance;
    // returns a function that closes it.
    streamPositions(mapId: number, instanceId: number, listeners: StreamListeners): () => void;
    getOnlineCounts(): Promise<MapOnlineCounts>;
    getBotWaypoint(request: MapBotWaypointRequest): Promise<MapBotWaypoint | null>;
    getCreatureInfo(entries: number[]): Promise<CreatureInfo[]>;
  };
  sessions: {
    list(): Promise<SessionIndexEntry[]>;
    get(id: string): Promise<SessionRecord | null>;
    isRecordingEnabled(): Promise<boolean>;
    setRecordingEnabled(enabled: boolean): Promise<boolean>;
    purgeCompleted(): Promise<number>;
  };
  economy: {
    connect(config: DbConfig): Promise<DbConnectionState>;
    disconnect(): Promise<void>;
    getOverview(): Promise<EconomyOverview>;
    getCharacterGold(characterName: string): Promise<EconomyCharacterGoldResult>;
    searchAuctions(searchTerm?: string, limit?: number): Promise<EconomyAuctionRow[]>;
    getMarketSummary(searchTerm?: string, limit?: number): Promise<EconomyMarketSummaryRow[]>;
  };
  inventory: {
    getCharacterInventory(characterName: string): Promise<CharacterInventoryResult>;
  };
  config: {
    getProfiles(): Promise<ConnectionProfile[]>;
    getActiveProfileId(): Promise<string | null>;
    addProfile(profile: Omit<ConnectionProfile, 'id' | 'createdAt' | 'updatedAt'>): Promise<ConnectionProfile>;
    updateProfile(id: string, fields: Partial<ConnectionProfile>): Promise<ConnectionProfile | null>;
    deleteProfile(id: string): Promise<void>;
    setActiveProfile(id: string): Promise<void>;
  };
}
