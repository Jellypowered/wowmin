import type { MapPlayerPosition, StreamFrame, StreamPlayerSample } from '../../../src/types/electron';

// Buffers stream samples per player and interpolates between them, drawing a
// little in the past so there is always a newer sample to move towards.

export const LIVE_RENDER_DELAY_MS = 150;
// Samples older than this no longer describe the player; use the polled data.
export const LIVE_STALE_MS = 2000;
// Movement larger than this between two samples is a teleport: snap, not slide.
const TELEPORT_DISTANCE = 50;
const HISTORY_LENGTH = 4;

interface TimedSample {
  at: number;
  sample: StreamPlayerSample;
}

export function lerpAngle(from: number, to: number, t: number): number {
  const turn = Math.PI * 2;
  let delta = (to - from) % turn;
  if (delta > Math.PI) delta -= turn;
  if (delta < -Math.PI) delta += turn;
  return from + delta * t;
}

export class LivePositionBuffer {
  private readonly history = new Map<string, TimedSample[]>();
  private lastFrameAt = -Infinity;

  push(frame: StreamFrame, receivedAt: number): void {
    this.lastFrameAt = receivedAt;
    for (const sample of frame.players) {
      const samples = this.history.get(sample.name) ?? [];
      samples.push({ at: receivedAt, sample });
      if (samples.length > HISTORY_LENGTH) samples.shift();
      this.history.set(sample.name, samples);
    }
    for (const [name, samples] of this.history) {
      if (receivedAt - samples[samples.length - 1].at > LIVE_STALE_MS) this.history.delete(name);
    }
  }

  clear(): void {
    this.history.clear();
    this.lastFrameAt = -Infinity;
  }

  // True while frames are still arriving, i.e. worth animating.
  isActive(now: number): boolean {
    return now - this.lastFrameAt <= LIVE_STALE_MS;
  }

  // The player's state at `now - LIVE_RENDER_DELAY_MS`, or null if the stream
  // has nothing recent for them.
  sampleAt(name: string, now: number): StreamPlayerSample | null {
    const samples = this.history.get(name);
    if (!samples?.length || now - samples[samples.length - 1].at > LIVE_STALE_MS) return null;
    const time = now - LIVE_RENDER_DELAY_MS;
    let next = samples.findIndex((entry) => entry.at >= time);
    if (next === -1) return samples[samples.length - 1].sample;
    if (next === 0) return samples[0].sample;
    const before = samples[next - 1];
    const after = samples[next];
    const { sample: from } = before;
    const { sample: to } = after;
    if (Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) > TELEPORT_DISTANCE) return to;
    const t = after.at === before.at ? 1 : (time - before.at) / (after.at - before.at);
    return {
      ...to,
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      z: from.z + (to.z - from.z) * t,
      orientation: lerpAngle(from.orientation, to.orientation, t),
    };
  }
}

// Overlays the stream's fast-changing fields on a polled player record; names,
// classes, groups, and the rest stay as polled.
export function applyLiveSample(player: MapPlayerPosition, sample: StreamPlayerSample): MapPlayerPosition {
  return {
    ...player,
    position_x: sample.x,
    position_y: sample.y,
    position_z: sample.z,
    orientation: sample.orientation,
    healthPct: sample.healthPct,
    powerPct: sample.powerPct,
    alive: sample.alive,
    inCombat: sample.inCombat,
    waitingForResurrect: sample.waitingForResurrect,
    wmoGroupId: sample.wmoGroupId,
    onTaxi: (sample.stateFlags & 1) !== 0,
    mounted: (sample.stateFlags & 2) !== 0,
    sapped: (sample.stateFlags & 4) !== 0,
    stunned: (sample.stateFlags & 8) !== 0,
    spiritForm: (sample.stateFlags & 16) !== 0,
    flagCarrier: (sample.stateFlags & 32) !== 0,
  };
}
