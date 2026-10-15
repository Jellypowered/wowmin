import type { BootstrapConfig, WowminAPI } from './types/wowmin-api';

let bootstrapPromise: Promise<BootstrapConfig> | null = null;

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const response = await fetch('/api/invoke', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, args }),
  });
  const payload = await response.json() as { ok?: boolean; result?: T; error?: string };
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `API request failed with HTTP ${response.status}`);
  }
  return payload.result as T;
}

async function openBrowserLink(channel: string, url: string): Promise<{ success: boolean; message: string }> {
  const parsed = new URL(url, window.location.href);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { success: false, message: 'Only HTTP(S) links are supported.' };
  }
  window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
  return invoke(channel, parsed.toString());
}

function getBootstrap(): Promise<BootstrapConfig> {
  if (!bootstrapPromise) {
    bootstrapPromise = fetch('/api/bootstrap', { credentials: 'same-origin' }).then(async (response) => {
      if (!response.ok) throw new Error(`Bootstrap request failed with HTTP ${response.status}`);
      return response.json() as Promise<BootstrapConfig>;
    });
  }
  return bootstrapPromise;
}

const wowminAPI: WowminAPI = {
  soap: {
    connect: (config) => invoke('soap:connect', config),
    command: (command) => invoke('soap:command', command),
    disconnect: () => invoke('soap:disconnect'),
  },
  logs: {
    inspect: (config) => invoke('logs:inspect', config),
    readTail: (config, remotePath, maxBytes = 32 * 1024) => invoke('logs:readTail', config, remotePath, maxBytes),
  },
  app: {
    getBootstrap,
    getConnectionStatus: () => invoke('app:getConnectionStatus'),
    openExternal: (url) => openBrowserLink('app:openExternal', url),
    getEntityMediaPreview: (request) => invoke('app:getEntityMediaPreview', request),
  },
  db: {
    connect: (config) => invoke('db:connect', config),
    disconnect: () => invoke('db:disconnect'),
    testConnection: (config) => invoke('db:testConnection', config),
    query: (sql, params) => invoke('db:query', sql, params),
    execute: (sql, params) => invoke('db:execute', sql, params),
    getTables: () => invoke('db:getTables'),
    getSchema: (table) => invoke('db:getSchema', table),
    beginTransaction: () => invoke('db:beginTransaction'),
    commit: () => invoke('db:commit'),
    rollback: () => invoke('db:rollback'),
  },
  players: {
    getOnline: () => invoke('players:getOnline'),
  },
  map: {
    connect: (config) => invoke('map:connect', config),
    disconnect: () => invoke('map:disconnect'),
    getPlayerPositions: (mapId, instanceId) => invoke('map:getPlayerPositions', mapId, instanceId),
    streamPositions: (mapId, instanceId, listeners) => {
      const source = new EventSource(`/api/stream?map=${mapId}&instance=${instanceId}`);
      const data = (event: Event) => JSON.parse((event as MessageEvent<string>).data);
      source.addEventListener('frame', (event) => listeners.onFrame(data(event)));
      source.addEventListener('status', (event) => listeners.onStatus(data(event)));
      source.addEventListener('paths', (event) => listeners.onPaths?.(data(event)));
      source.addEventListener('creatures', (event) => listeners.onCreatures?.(data(event)));
      source.addEventListener('bots', (event) => listeners.onBots?.(data(event)));
      source.addEventListener('appearances', (event) => listeners.onAppearances?.(data(event)));
      source.addEventListener('combat', (event) => listeners.onCombatEvents?.(data(event)));
      source.addEventListener('auras', (event) => listeners.onUnitAuras?.(data(event)));
      source.addEventListener('passengers', (event) => listeners.onPassengers?.(data(event)));
      source.addEventListener('gameobjects', (event) => listeners.onGameObjects?.(data(event)));
      source.addEventListener('debuffs', (event) => listeners.onDebuffs?.(data(event)));
      source.addEventListener('markers', (event) => listeners.onMarkers?.(data(event)));
      // EventSource reconnects by itself; report the gap meanwhile.
      source.addEventListener('error', () => listeners.onStatus('starting'));
      return () => source.close();
    },
    getOnlineCounts: () => invoke('map:getOnlineCounts'),
    getBotWaypoint: (request) => invoke('map:getBotWaypoint', request),
    getCreatureInfo: (entries) => invoke('map:getCreatureInfo', entries),
  },
  sessions: {
    list: () => invoke('sessions:list'),
    get: (id) => invoke('sessions:get', id),
    isRecordingEnabled: () => invoke('sessions:isRecordingEnabled'),
    setRecordingEnabled: (enabled) => invoke('sessions:setRecordingEnabled', enabled),
    purgeCompleted: () => invoke('sessions:purgeCompleted'),
  },
  economy: {
    connect: (config) => invoke('economy:connect', config),
    disconnect: () => invoke('economy:disconnect'),
    getOverview: () => invoke('economy:getOverview'),
    getCharacterGold: (characterName) => invoke('economy:getCharacterGold', characterName),
    searchAuctions: (searchTerm = '', limit = 50) => invoke('economy:searchAuctions', searchTerm, limit),
    getMarketSummary: (searchTerm = '', limit = 25) => invoke('economy:getMarketSummary', searchTerm, limit),
  },
  inventory: {
    getCharacterInventory: (characterName) => invoke('inventory:getCharacterInventory', characterName),
  },
  config: {
    getProfiles: async () => (await getBootstrap()).managed ? [] : invoke('config:getProfiles'),
    getActiveProfileId: async () => (await getBootstrap()).managed ? null : invoke('config:getActiveProfileId'),
    addProfile: (profile) => invoke('config:addProfile', profile),
    updateProfile: (id, fields) => invoke('config:updateProfile', { id, fields }),
    deleteProfile: async (id) => { await invoke('config:deleteProfile', id); },
    setActiveProfile: async (id) => { await invoke('config:setActiveProfile', id); },
  },
};

window.wowminAPI = wowminAPI;

window.addEventListener('DOMContentLoaded', async () => {
  try {
    const bootstrap = await getBootstrap();
    if (!bootstrap.managed) return;
    document.body.classList.add('web-managed');
    const soapUser = document.getElementById('username') as HTMLInputElement | null;
    const soapPassword = document.getElementById('password') as HTMLInputElement | null;
    if (soapUser) soapUser.value = 'managed';
    if (soapPassword) soapPassword.value = 'managed';

    const attached = new Set<string>();
    const attachConnectedServices = (connections: BootstrapConfig['connections']): void => {
      const buttons: Array<[keyof BootstrapConfig['connections']['services'], string]> = [
        ['soap', 'btn-connect'],
        ['worldDatabase', 'db-connect-btn'],
        ['mapDatabase', 'map-db-connect-btn'],
        ['economyDatabase', 'economy-db-connect-btn'],
      ];
      for (const [service, buttonId] of buttons) {
        if (connections.services[service].phase !== 'connected' || attached.has(service)) continue;
        attached.add(service);
        document.getElementById(buttonId)?.click();
      }
    };

    attachConnectedServices(bootstrap.connections);
    setInterval(() => {
      void wowminAPI.app.getConnectionStatus()
        .then(attachConnectedServices)
        .catch(() => undefined);
    }, 5000);

    document.getElementById('log-scan-btn')?.click();
    for (const id of ['auto-refresh-players', 'map-auto-refresh', 'auto-refresh-tickets', 'log-follow-enabled']) {
      const toggle = document.getElementById(id) as HTMLInputElement | null;
      if (toggle) {
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    const logInterval = document.getElementById('log-refresh-interval') as HTMLSelectElement | null;
    if (logInterval) logInterval.value = '2';
  } catch (error) {
    console.error('Unable to initialize managed connections:', error);
  }
});
