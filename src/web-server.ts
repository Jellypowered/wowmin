import './load-env';
import { APP_VERSION, getBackendConnectionStatus, initializeApiBackend, initializeManagedConnections, shutdownApiBackend, telemetryStream } from './api-backend';
import { apiRouter } from './api-router';
import { createHash, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import * as path from 'path';
import { inspectLocalLogs, readLocalLogTail } from './local-logs';
import { sceneExportAdvice } from './scene-export-version';
import { parseUnitModelPath, UnitModels } from './unit-models';
import { buildContentSecurityPolicy, deriveDungeonClearUrl, normalizeDungeonClearUrl } from './dungeon-clear-config';
import type { DbConfig, SoapConfig } from './types/api';

const host = process.env.WOWMIN_HOST || '127.0.0.1';
const port = Number(process.env.WOWMIN_PORT || '3000');
const username = process.env.WOWMIN_USERNAME || '';
const password = process.env.WOWMIN_PASSWORD || '';
const projectRoot = path.resolve(__dirname, '..');
const maxRequestBytes = 2 * 1024 * 1024;
const managed = Boolean(process.env.WOWMIN_SOAP_USERNAME && process.env.WOWMIN_SOAP_PASSWORD && process.env.WOWMIN_DB_PASSWORD);
const configuredDungeonClearUrl = normalizeDungeonClearUrl(process.env.WOWMIN_DUNGEON_CLEAR_URL);

// A watched instance's updates go to every page watching it, so each is
// serialized once however many pages there are.
const serializedEvents = new WeakMap<object, string>();
function eventJson(data: unknown): string {
  if (typeof data !== 'object' || data === null) return JSON.stringify(data);
  let json = serializedEvents.get(data);
  if (json === undefined) {
    json = JSON.stringify(data);
    serializedEvents.set(data, json);
  }
  return json;
}

function managedSoapConfig(): SoapConfig {
  return {
    host: process.env.WOWMIN_SOAP_HOST || '127.0.0.1',
    port: Number(process.env.WOWMIN_SOAP_PORT || 7878),
    username: process.env.WOWMIN_SOAP_USERNAME || '',
    password: process.env.WOWMIN_SOAP_PASSWORD || '',
  };
}

function managedDatabaseConfig(prefix: 'WORLD' | 'CHARACTERS' | 'ECONOMY', database: string): DbConfig {
  return {
    host: process.env[`WOWMIN_${prefix}_DB_HOST`] || process.env.WOWMIN_DB_HOST || '127.0.0.1',
    port: Number(process.env[`WOWMIN_${prefix}_DB_PORT`] || process.env.WOWMIN_DB_PORT || 3306),
    username: process.env[`WOWMIN_${prefix}_DB_USERNAME`] || process.env.WOWMIN_DB_USERNAME || 'acore',
    password: process.env[`WOWMIN_${prefix}_DB_PASSWORD`] ?? process.env.WOWMIN_DB_PASSWORD ?? '',
    database,
  };
}

function managedConfig(channel: string, args: unknown[]): unknown[] {
  if (!managed) return args;
  if (channel === 'soap:connect') return [managedSoapConfig()];
  if (['db:connect', 'db:testConnection', 'map:connect', 'economy:connect'].includes(channel)) {
    const worldDatabase = process.env.WOWMIN_WORLD_DB || 'acore_world';
    const charactersDatabase = process.env.WOWMIN_CHARACTERS_DB || 'acore_characters';
    return [channel === 'db:connect' || channel === 'db:testConnection'
      ? managedDatabaseConfig('WORLD', worldDatabase)
      : channel === 'economy:connect'
        ? managedDatabaseConfig('ECONOMY', process.env.WOWMIN_ECONOMY_DB || charactersDatabase)
        : managedDatabaseConfig('CHARACTERS', charactersDatabase)];
  }
  return args;
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid WOWMIN_PORT: ${process.env.WOWMIN_PORT}`);
}
if (!username || !password) {
  throw new Error('WOWMIN_USERNAME and WOWMIN_PASSWORD are required.');
}

const staticFiles: Record<string, string> = {
  '/': path.join(projectRoot, 'renderer', 'index.html'),
  '/index.html': path.join(projectRoot, 'renderer', 'index.html'),
  '/styles.css': path.join(projectRoot, 'renderer', 'styles.css'),
  '/styles/output.css': path.join(projectRoot, 'renderer', 'styles', 'output.css'),
  '/dist/web-api.js': path.join(projectRoot, 'dist', 'web-api.js'),
  '/dist/renderer.js': path.join(projectRoot, 'dist', 'renderer.js'),
  '/spell-preview': path.join(projectRoot, 'renderer', 'spell-preview.html'),
  '/dist/spell-preview.js': path.join(projectRoot, 'dist', 'spell-preview.js'),
};

const mimeTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

function requestScheme(request: IncomingMessage): 'http' | 'https' {
  const forwarded = request.headers['x-forwarded-proto'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
  return value?.trim().toLowerCase() === 'https' ? 'https' : 'http';
}

function dungeonClearUrl(request: IncomingMessage): string {
  return configuredDungeonClearUrl || deriveDungeonClearUrl(requestScheme(request), request.headers.host);
}

function setSecurityHeaders(request: IncomingMessage, response: ServerResponse): void {
  response.setHeader('Content-Security-Policy', buildContentSecurityPolicy(dungeonClearUrl(request)));
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
}

function secureEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function isAuthorized(request: IncomingMessage): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith('Basic ')) return false;

  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) return false;
    return secureEqual(decoded.slice(0, separator), username)
      && secureEqual(decoded.slice(separator + 1), password);
  } catch {
    return false;
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxRequestBytes) throw new Error('Request body is too large.');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

// Says at startup when the 3D scenes on disk come from an older (or newer)
// export than this WoWMin draws, and what to run.
async function reportSceneExports(directory: string): Promise<void> {
  let names: string[];
  try {
    names = (await fs.promises.readdir(directory)).filter((name) => /^\d+\.scene\.json$/.test(name));
  } catch {
    return;
  }
  const versions = await Promise.all(names.map(async (name) => {
    try {
      const manifest = JSON.parse(await fs.promises.readFile(path.join(directory, name), 'utf8')) as { exportVersion?: number };
      return manifest.exportVersion;
    } catch {
      return undefined;
    }
  }));
  const advice = sceneExportAdvice(versions);
  if (advice) console.warn(advice);
}

function resolveStaticFile(urlPath: string): string | null {
  const exact = staticFiles[urlPath];
  if (exact) return exact;

  for (const prefix of ['/assets/', '/renderer/']) {
    if (!urlPath.startsWith(prefix)) continue;
    const base = path.join(projectRoot, prefix.slice(1, -1));
    const candidate = path.resolve(base, urlPath.slice(prefix.length));
    if (candidate === base || !candidate.startsWith(`${base}${path.sep}`)) return null;
    return candidate;
  }
  return null;
}

const assetsRoot = path.join(projectRoot, 'assets');
const modelCacheRoot = path.resolve(process.env.WOWMIN_MODEL_CACHE_DIR || path.join(assetsRoot, 'models'));
const unitModels = new UnitModels(
  modelCacheRoot,
  path.join(projectRoot, 'scripts', 'scene', 'unit-model-worker.mjs'),
);

function serveFile(request: IncomingMessage, response: ServerResponse, filePath: string): void {
  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    // Extracted map assets (scenes run to megabytes) may be cached, but are
    // revalidated on every use so a re-extraction shows up immediately.
    if (filePath.startsWith(`${assetsRoot}${path.sep}`)
      || filePath.startsWith(`${modelCacheRoot}${path.sep}`)) {
      const etag = `W/"${stats.size.toString(36)}-${Math.floor(stats.mtimeMs).toString(36)}"`;
      response.setHeader('Cache-Control', 'no-cache');
      response.setHeader('ETag', etag);
      response.setHeader('Last-Modified', stats.mtime.toUTCString());
      if (request.headers['if-none-match'] === etag) {
        response.writeHead(304);
        response.end();
        return;
      }
    }
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stats.size,
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    fs.createReadStream(filePath).pipe(response);
  });
}

const apiErrorLogTimes = new Map<string, number>();
const API_ERROR_LOG_INTERVAL_MS = 30000;

function logApiError(channel: string, message: string): void {
  if (/not connected|is connecting/i.test(message)) return;
  const key = `${channel}:${message}`;
  const now = Date.now();
  if (now - (apiErrorLogTimes.get(key) ?? 0) < API_ERROR_LOG_INTERVAL_MS) return;
  apiErrorLogTimes.set(key, now);
  console.error(`API request failed [${channel}]: ${message}`);
}

function hasValidOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

const server = createServer(async (request, response) => {
  setSecurityHeaders(request, response);
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  if (url.pathname === '/healthz') {
    sendJson(response, 200, { status: 'ok', version: APP_VERSION });
    return;
  }

  if (!isAuthorized(request)) {
    response.setHeader('WWW-Authenticate', 'Basic realm="WoW Admin", charset="UTF-8"');
    sendJson(response, 401, { error: 'Authentication required' });
    return;
  }

  // Server-Sent Events: live positions for one session, from the module's UDP
  // stream. Events: "status" (starting | streaming | unavailable) and "frame".
  if (url.pathname === '/api/stream') {
    const mapId = Number(url.searchParams.get('map'));
    const instanceId = Number(url.searchParams.get('instance'));
    if (!Number.isInteger(mapId) || mapId < 0 || !Number.isInteger(instanceId) || instanceId <= 0) {
      sendJson(response, 400, { error: 'map and instance are required' });
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.write('retry: 3000\n\n');
    const send = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${eventJson(data)}\n\n`);
    const unwatch = telemetryStream.watch(mapId, instanceId, {
      onFrame: (frame) => send('frame', frame),
      onStatus: (status) => send('status', status),
      onPaths: (update) => send('paths', update),
      onCreatures: (update) => send('creatures', update),
      onBots: (update) => send('bots', update),
      onAppearances: (update) => send('appearances', update),
      onCombatEvents: (update) => send('combat', update),
      onUnitAuras: (update) => send('auras', update),
      onPassengers: (update) => send('passengers', update),
      onGameObjects: (update) => send('gameobjects', update),
      onDebuffs: (update) => send('debuffs', update),
      onMarkers: (update) => send('markers', update),
    });
    // Comment lines keep idle connections open through proxies.
    const keepAlive = setInterval(() => response.write(': keep-alive\n\n'), 15000);
    request.on('close', () => {
      clearInterval(keepAlive);
      unwatch();
    });
    return;
  }

  if (url.pathname === '/api/bootstrap') {
    sendJson(response, 200, {
      managed,
      localLogs: managed,
      dungeonClearUrl: dungeonClearUrl(request),
      connections: getBackendConnectionStatus(),
    });
    return;
  }

  if (url.pathname === '/api/invoke') {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'Method not allowed' });
      return;
    }
    if (!hasValidOrigin(request)) {
      sendJson(response, 403, { error: 'Invalid request origin' });
      return;
    }
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      sendJson(response, 415, { error: 'Content-Type must be application/json' });
      return;
    }

    let requestChannel = 'unknown';
    try {
      const body = await readJson(request) as { channel?: unknown; args?: unknown };
      if (typeof body.channel !== 'string' || !Array.isArray(body.args)) {
        sendJson(response, 400, { error: 'Expected channel and args.' });
        return;
      }
      requestChannel = body.channel;
      if (managed && body.channel.startsWith('config:')) {
        sendJson(response, 403, { error: 'Profiles are disabled in managed web mode.' });
        return;
      }
      if (managed && body.channel === 'logs:inspect') {
        sendJson(response, 200, { ok: true, result: await inspectLocalLogs() });
        return;
      }
      if (managed && body.channel === 'logs:readTail') {
        sendJson(response, 200, { ok: true, result: await readLocalLogTail(String(body.args[1]), Number(body.args[2])) });
        return;
      }
      const result = await apiRouter.invoke(body.channel, managedConfig(body.channel, body.args));
      sendJson(response, 200, { ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logApiError(requestChannel, message);
      sendJson(response, 400, { ok: false, error: message });
    }
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    sendJson(response, 400, { error: 'Invalid URL path' });
    return;
  }
  // Unit models are built from the client's files the first time they are asked for.
  const unitModel = parseUnitModelPath(decodedPath);
  if (unitModel) {
    const modelPath = await unitModels.ensure(unitModel);
    if (modelPath) serveFile(request, response, modelPath);
    else sendJson(response, 404, { error: 'No model' });
    return;
  }
  const filePath = resolveStaticFile(decodedPath);
  if (!filePath) {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }
  serveFile(request, response, filePath);
});

initializeApiBackend(process.env.WOWMIN_DATA_DIR || path.join(process.cwd(), '.wowmin-data'));
if (managed) {
  const charactersDatabase = process.env.WOWMIN_CHARACTERS_DB || 'acore_characters';
  void initializeManagedConnections({
    soap: managedSoapConfig(),
    worldDatabase: managedDatabaseConfig('WORLD', process.env.WOWMIN_WORLD_DB || 'acore_world'),
    mapDatabase: managedDatabaseConfig('CHARACTERS', charactersDatabase),
    economyDatabase: managedDatabaseConfig('ECONOMY', process.env.WOWMIN_ECONOMY_DB || charactersDatabase),
    initialRetryMs: Number(process.env.WOWMIN_CONNECTION_RETRY_INITIAL_MS) || 5000,
    maximumRetryMs: Number(process.env.WOWMIN_CONNECTION_RETRY_MAX_MS) || 60000,
    healthCheckMs: Number(process.env.WOWMIN_CONNECTION_HEALTH_MS) || 30000,
  }).catch((error) => console.error('Managed connection startup failed:', error));
}
server.listen(port, host, () => {
  console.log(`WoW Admin web service listening on http://${host}:${port}`);
  void reportSceneExports(path.join(assetsRoot, 'instances'));
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  void shutdownApiBackend().finally(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
