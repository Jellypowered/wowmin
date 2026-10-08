import type { ElectronAPI } from '../../src/preload';

if (!window.electronAPI) {
  let mapConnection: Promise<unknown> | null = null;
  const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
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
  };

  const openBrowserLink = async (channel: string, url?: string): Promise<{ success: boolean; message: string }> => {
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    return invoke(channel, url);
  };

  window.electronAPI = {
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
      getVersion: () => invoke('app:getVersion'),
      openExternal: (url) => openBrowserLink('app:openExternal', url),
      getEntityMediaPreview: (request) => invoke('app:getEntityMediaPreview', request),
      onNavigateTab: () => () => undefined,
    },
    update: {
      check: async () => ({ currentVersion: await invoke<string>('app:getVersion'), latestVersion: null,
        releaseName: null, releaseUrl: null, publishedAt: null, updateAvailable: false,
        status: 'idle' as const, message: 'Upstream release checks disabled in web mode.' }),
      openReleasePage: (url) => openBrowserLink('update:openReleasePage', url),
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
      connect: (config) => {
        mapConnection = invoke('map:connect', config);
        return mapConnection as ReturnType<ElectronAPI['map']['connect']>;
      },
      disconnect: () => invoke('map:disconnect'),
      getPlayerPositions: (mapId, instanceId) => invoke('map:getPlayerPositions', mapId, instanceId),
      streamPositions: (mapId, instanceId, onFrame, onStatus) => {
        const source = new EventSource(`/api/stream?map=${mapId}&instance=${instanceId}`);
        source.addEventListener('frame', (event) => onFrame(JSON.parse((event as MessageEvent<string>).data)));
        source.addEventListener('status', (event) => onStatus(JSON.parse((event as MessageEvent<string>).data)));
        // EventSource reconnects by itself; report the gap meanwhile.
        source.addEventListener('error', () => onStatus('starting'));
        return () => source.close();
      },
      getOnlineCounts: () => invoke('map:getOnlineCounts'),
      getBotWaypoint: (request) => invoke('map:getBotWaypoint', request),
    },
    sessions: {
      list: () => invoke('sessions:list'),
      get: (id) => invoke('sessions:get', id),
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
      getProfiles: () => Promise.resolve([]),
      getActiveProfileId: () => Promise.resolve(null),
      addProfile: (profile) => invoke('config:addProfile', profile),
      updateProfile: (id, fields) => invoke('config:updateProfile', { id, fields }),
      deleteProfile: async (id) => { await invoke('config:deleteProfile', id); },
      setActiveProfile: async (id) => { await invoke('config:setActiveProfile', id); },
    },
  } as ElectronAPI;

  window.addEventListener('DOMContentLoaded', async () => {
    try {
      const response = await fetch('/api/bootstrap', { credentials: 'same-origin' });
      if (!response.ok) return;
      const bootstrap = await response.json() as { managed: boolean };
      if (!bootstrap.managed) return;
      document.body.classList.add('web-managed');
      const soapUser = document.getElementById('username') as HTMLInputElement | null;
      const soapPassword = document.getElementById('password') as HTMLInputElement | null;
      if (soapUser) soapUser.value = 'managed';
      if (soapPassword) soapPassword.value = 'managed';
      for (const id of ['map-db-connect-btn', 'db-connect-btn', 'economy-db-connect-btn', 'log-scan-btn']) {
        document.getElementById(id)?.click();
      }
      for (const id of ['auto-refresh-players', 'map-auto-refresh', 'auto-refresh-tickets', 'log-follow-enabled']) {
        const toggle = document.getElementById(id) as HTMLInputElement | null;
        if (toggle) {
          toggle.checked = true;
          toggle.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      const logInterval = document.getElementById('log-refresh-interval') as HTMLSelectElement | null;
      if (logInterval) logInterval.value = '2';
      if (mapConnection) await mapConnection.catch(() => undefined);
      document.getElementById('btn-connect')?.click();
    } catch (error) {
      console.error('Unable to initialize managed connections:', error);
    }
  });
}
