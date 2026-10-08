import * as dgram from 'dgram';

import type { StreamFrame, StreamPlayerSample, StreamStatus } from './types/electron';

// Receives the mod-wowmin-telemetry UDP position stream. A session streams only
// while it is watched: every RENEW_INTERVAL_MS the subscription is renewed with
// "wowmin stream <mapId> <instanceId>" over SOAP, and the module stops sending
// when renewals stop. The datagram layout is documented in WowMinTelemetry.cpp.

export interface StreamDatagram {
  mapId: number;
  instanceId: number;
  sequence: number;
  serverTimeMs: number;
  part: number;
  partCount: number;
  players: StreamPlayerSample[];
}

const MAGIC = 'WMS1';
const VERSION = 1;
const HEADER_SIZE = 28;
const PLAYER_SIZE = 30;
const RENEW_INTERVAL_MS = 3000;
// A frame this old means the module restarted or the stream lapsed, so accept
// whatever sequence comes next rather than waiting to catch up.
const SEQUENCE_RESET_MS = 2000;
// No frame for this long: the stream has lapsed (status back to 'starting').
const STREAM_LAPSED_MS = 3000;
// Still nothing this long after watching or the last frame: report it as
// unavailable (module disabled, or datagrams not reaching this port).
const STREAM_UNAVAILABLE_MS = 8000;

export function parseStreamDatagram(buffer: Buffer): StreamDatagram | null {
  if (buffer.length < HEADER_SIZE || buffer.toString('latin1', 0, 4) !== MAGIC || buffer.readUInt8(4) !== VERSION) {
    return null;
  }
  const partCount = buffer.readUInt8(6);
  const part = buffer.readUInt8(5);
  if (!partCount || part >= partCount) return null;
  const playerCount = buffer.readUInt16LE(24);
  const players: StreamPlayerSample[] = [];
  let offset = HEADER_SIZE;
  for (let index = 0; index < playerCount; index += 1) {
    if (offset + PLAYER_SIZE > buffer.length) return null;
    const nameLength = buffer.readUInt8(offset + 25);
    if (offset + PLAYER_SIZE + nameLength > buffer.length) return null;
    const flags = buffer.readUInt8(offset + 23);
    players.push({
      guid: buffer.readUInt32LE(offset),
      x: buffer.readFloatLE(offset + 4),
      y: buffer.readFloatLE(offset + 8),
      z: buffer.readFloatLE(offset + 12),
      orientation: buffer.readFloatLE(offset + 16),
      healthPct: buffer.readUInt8(offset + 20),
      powerPct: buffer.readUInt8(offset + 21),
      powerType: buffer.readInt8(offset + 22),
      alive: Boolean(flags & 1),
      inCombat: Boolean(flags & 2),
      waitingForResurrect: Boolean(flags & 4),
      stateFlags: buffer.readUInt8(offset + 24),
      wmoGroupId: buffer.readInt32LE(offset + 26),
      name: buffer.toString('utf8', offset + PLAYER_SIZE, offset + PLAYER_SIZE + nameLength),
    });
    offset += PLAYER_SIZE + nameLength;
  }
  return {
    mapId: buffer.readUInt32LE(8),
    instanceId: buffer.readUInt32LE(12),
    sequence: buffer.readUInt32LE(16),
    serverTimeMs: buffer.readUInt32LE(20),
    part,
    partCount,
    players,
  };
}

type CommandRunner = (command: string) => Promise<{ success: boolean; message: string }>;

interface WatchedSession {
  mapId: number;
  instanceId: number;
  frameListeners: Set<(frame: StreamFrame) => void>;
  statusListeners: Set<(status: StreamStatus) => void>;
  status: StreamStatus;
  // Reassembly of the snapshot currently arriving.
  sequence: number;
  parts: Map<number, StreamPlayerSample[]>;
  lastFrameAt: number;
  watchedAt: number;
}

export class TelemetryStream {
  private socket: dgram.Socket | null = null;
  private readonly sessions = new Map<string, WatchedSession>();
  private renewTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly runCommand: CommandRunner,
    private readonly bindHost: string,
    private readonly bindPort: number,
  ) {}

  // Starts receiving for a session; returns a function that stops watching.
  watch(
    mapId: number,
    instanceId: number,
    onFrame: (frame: StreamFrame) => void,
    onStatus: (status: StreamStatus) => void,
  ): () => void {
    const key = `${mapId}:${instanceId}`;
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        mapId, instanceId, frameListeners: new Set(), statusListeners: new Set(),
        status: 'starting', sequence: 0, parts: new Map(), lastFrameAt: 0, watchedAt: Date.now(),
      };
      this.sessions.set(key, session);
    }
    session.frameListeners.add(onFrame);
    session.statusListeners.add(onStatus);
    onStatus(session.status);
    this.ensureRunning();
    void this.renew(session);

    return () => {
      session.frameListeners.delete(onFrame);
      session.statusListeners.delete(onStatus);
      if (!session.frameListeners.size) this.sessions.delete(key);
      if (!this.sessions.size) this.stop();
    };
  }

  private ensureRunning(): void {
    if (!this.socket) {
      const socket = dgram.createSocket('udp4');
      socket.on('message', (message) => this.receive(message));
      socket.on('error', (error) => {
        console.error(`Telemetry stream socket error on ${this.bindHost}:${this.bindPort}: ${error.message}`);
        for (const session of this.sessions.values()) this.setStatus(session, 'unavailable');
        socket.close();
        if (this.socket === socket) this.socket = null;
      });
      socket.bind(this.bindPort, this.bindHost);
      this.socket = socket;
    }
    if (!this.renewTimer) {
      this.renewTimer = setInterval(() => {
        const now = Date.now();
        for (const session of this.sessions.values()) {
          const quietFor = now - Math.max(session.watchedAt, session.lastFrameAt);
          if (session.status === 'streaming' && quietFor > STREAM_LAPSED_MS) this.setStatus(session, 'starting');
          if (session.status === 'starting' && quietFor > STREAM_UNAVAILABLE_MS) this.setStatus(session, 'unavailable');
          void this.renew(session);
        }
      }, RENEW_INTERVAL_MS);
    }
  }

  private stop(): void {
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  private async renew(session: WatchedSession): Promise<void> {
    try {
      const result = await this.runCommand(`wowmin stream ${session.mapId} ${session.instanceId}`);
      const reply = result.success ? result.message.split(/\r?\n/).find((line) => line.startsWith('WSTREAM|')) : null;
      // An older module has no stream command; treat that as unavailable too.
      if (!reply || reply === 'WSTREAM|disabled' || reply === 'WSTREAM|full') this.setStatus(session, 'unavailable');
    } catch {
      this.setStatus(session, 'unavailable');
    }
  }

  private receive(message: Buffer): void {
    const datagram = parseStreamDatagram(message);
    if (!datagram) return;
    const session = this.sessions.get(`${datagram.mapId}:${datagram.instanceId}`);
    if (!session) return;

    const now = Date.now();
    if (datagram.sequence !== session.sequence) {
      const stale = now - session.lastFrameAt > SEQUENCE_RESET_MS;
      if (datagram.sequence < session.sequence && !stale) return;
      session.sequence = datagram.sequence;
      session.parts = new Map();
    }
    session.parts.set(datagram.part, datagram.players);
    if (session.parts.size < datagram.partCount) return;

    const players = [...session.parts.entries()].sort(([left], [right]) => left - right).flatMap(([, part]) => part);
    session.parts = new Map();
    session.lastFrameAt = now;
    // Mark the sequence complete so late duplicates of it are ignored.
    session.sequence = datagram.sequence + 1;
    this.setStatus(session, 'streaming');
    const frame: StreamFrame = {
      mapId: datagram.mapId,
      instanceId: datagram.instanceId,
      sequence: datagram.sequence,
      serverTimeMs: datagram.serverTimeMs,
      players,
    };
    for (const listener of session.frameListeners) listener(frame);
  }

  private setStatus(session: WatchedSession, status: StreamStatus): void {
    if (session.status === status) return;
    session.status = status;
    for (const listener of session.statusListeners) listener(status);
  }
}
