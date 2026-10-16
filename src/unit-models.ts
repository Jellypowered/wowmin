import { fork, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Builds unit models (creatures, and characters with their gear), spell
// effect models, and spell art lookups on demand from the WoW client's Data
// directory, in a child process, and caches them under the configured model
// cache directory. Needs WOWMIN_CLIENT_DATA; without it only what is already
// cached is served.

const BUILD_TIMEOUT_MS = 60000;
// Bumped when the converter's output changes, so models are rebuilt: built
// models live under v<version>/, and older ones are removed at startup.
// 2: spell effect points (hands, chest, overhead).
// 3: a head point; spell effect models and spell art lookups.
// 4: animations spell kits name (channelling, hit reactions, other casts).
// 5: a breath point (the mouth), for breath effects.
// 6: a mount's saddle point and riders' seated (Mount) animation.
// 7: flying mounts' Fly and Hover animations.
// 8: creature displays' model opacity (a Shadowfiend's see-through look).
// 9: sitting on the ground (SitGroundDown, SitGround, SitGroundUp).
// 10: every attachment by M2 ID, and the spell release events ($CSL, $CSR,
// $CST, $BWR), for the client's own effect and missile points, when each
// clip releases a missile, more of the clips kits name, and drawn weapons'
// blades for swing trails.
export const UNIT_MODEL_CACHE_VERSION = 10;
// Spell art (effect models and spell lookups) changes more often than unit
// models, so it has its own version and folder, art-v<version>/, and can be
// rebuilt without rebuilding every unit.
// 2: lookups name the model procedure 9 rains (Blizzard, Rain of Fire) and
// each kit's procedures.
// 3: effect clips named for what they are: Stand (start), Hold (idle),
// Decay (end), not Birth/Death.
// 4: spell lookups say whether the spell taunts.
// 5: chain effects (Chain Heal), areas round an aura's bearer (Starfall),
// and a wand's Shoot art by school.
// 6: map lights carry their objects' lights (torches, braziers).
// 7: map lights carry the map's fixed time of day, if it has one.
// 8: map lights carry their interior WMO groups (building ambient, outdoor-lit).
// 9: rain models from SpellVisualKitAreaModel (effect/area-<row>.glb), the
// missile's points and offsets, the missile targeting kit, whether the
// spell roots (its world effects follow the unit), whether its visual has a
// chain effect, its chain's full SpellChainEffects record and combo, how its
// missile flies (release, motion script, ground following, gravity arc),
// effects' Fly and Impact clips, and kits' flags and animation clips (with
// their fallbacks) and whether the spell is harmful.
export const SPELL_ART_CACHE_VERSION = 9;
const SPELL_ART_KINDS = new Set<UnitModelRequest['kind']>(['effect', 'visual', 'spell', 'icon', 'gameobject', 'light']);
const EXTENSIONS: Partial<Record<UnitModelRequest['kind'], string>> = { visual: 'json', spell: 'json', icon: 'png', light: 'json' };
// A look that could not be built is not retried for this long.
const FAILURE_RETRY_MS = 10 * 60 * 1000;

interface PendingBuild {
  resolve: (ok: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface UnitModelRequest {
  // 'effect' is a SpellVisualEffectName model, or a SpellVisualKitAreaModel
  // one (the models a lasting area rains); 'visual' a spell's art (JSON);
  // 'spell' a spell's name (JSON); 'icon' a client icon (PNG): a spell's, a
  // side's PvP crest, a raid marker, or a spell chain's texture; 'gameobject'
  // a game object display's model (GLB); 'light' a map's lights (JSON).
  kind: 'creature' | 'character' | 'effect' | 'visual' | 'spell' | 'icon' | 'gameobject' | 'light';
  key: string;
  params: Record<string, unknown>;
}

// Parses /assets/models/<kind>/<key>.glb into a build request. Creatures are
// keyed by display ID, plus main hand, off hand, and ranged item display IDs
// when they carry weapons; characters by their look (see characterKey in
// scripts/scene/unit-model.mjs), which the worker validates.
export function parseUnitModelPath(urlPath: string): UnitModelRequest | null {
  const creature = urlPath.match(/^\/assets\/models\/creature\/((\d{1,7})(?:-(\d{1,7})\.(\d{1,7})\.(\d{1,7}))?)\.glb$/);
  if (creature) {
    const [, key, displayId, mainHand, offHand, ranged] = creature;
    const weapons = mainHand === undefined ? {} : { 15: Number(mainHand), 16: Number(offHand), 17: Number(ranged) };
    return { kind: 'creature', key, params: { displayId: Number(displayId), weapons } };
  }
  const effect = urlPath.match(/^\/assets\/models\/effect\/(\d{1,7})\.glb$/);
  if (effect) return { kind: 'effect', key: effect[1], params: { effectId: Number(effect[1]) } };
  const areaModel = urlPath.match(/^\/assets\/models\/effect\/area-(\d{1,3})\.glb$/);
  if (areaModel) return { kind: 'effect', key: `area-${areaModel[1]}`, params: { areaModel: Number(areaModel[1]) } };
  const visual = urlPath.match(/^\/assets\/models\/visual\/(\d{1,7})\.json$/);
  if (visual) return { kind: 'visual', key: visual[1], params: { spellId: Number(visual[1]) } };
  const spell = urlPath.match(/^\/assets\/models\/spell\/(\d{1,7})\.json$/);
  if (spell) return { kind: 'spell', key: spell[1], params: { spellId: Number(spell[1]) } };
  const light = urlPath.match(/^\/assets\/models\/light\/(\d{1,5})\.json$/);
  if (light) return { kind: 'light', key: light[1], params: { mapId: Number(light[1]) } };
  const gameObject = urlPath.match(/^\/assets\/models\/gameobject\/(\d{1,7})\.glb$/);
  if (gameObject) return { kind: 'gameobject', key: gameObject[1], params: { displayId: Number(gameObject[1]) } };
  const icon = urlPath.match(/^\/assets\/models\/icon\/(faction-(alliance|horde)|spell-(\d{1,7})|marker-([1-8])|chain-(\d{1,7}))\.png$/);
  if (icon) {
    const params = icon[2] ? { faction: icon[2] } : icon[4] ? { marker: Number(icon[4]) }
      : icon[5] ? { chain: Number(icon[5]) } : { spellId: Number(icon[3]) };
    return { kind: 'icon', key: icon[1], params };
  }
  const character = urlPath.match(/^\/assets\/models\/character\/([0-9][0-9.-]{0,199})\.glb$/);
  if (character) return { kind: 'character', key: character[1], params: { key: character[1] } };
  return null;
}

export class UnitModels {
  private worker: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingBuild>();
  private readonly building = new Map<string, Promise<boolean>>();
  private readonly failedAt = new Map<string, number>();

  constructor(private readonly cacheRoot: string, private readonly workerScript: string) {
    this.removeOldVersions();
  }

  get enabled(): boolean {
    return Boolean(process.env.WOWMIN_CLIENT_DATA);
  }

  pathFor(request: UnitModelRequest): string {
    const extension = EXTENSIONS[request.kind] ?? 'glb';
    const folder = SPELL_ART_KINDS.has(request.kind) ? `art-v${SPELL_ART_CACHE_VERSION}` : `v${UNIT_MODEL_CACHE_VERSION}`;
    return path.join(this.cacheRoot, folder, request.kind, `${request.key}.${extension}`);
  }

  // Only folders this cache made: older versions, the unversioned creature/
  // and character/ from before versioning, and spell art kept with the unit
  // models before it had its own version.
  private removeOldVersions(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.cacheRoot);
    } catch {
      return;
    }
    const old = entries.filter((entry) => entry === 'creature' || entry === 'character'
      || (/^v\d+$/.test(entry) && entry !== `v${UNIT_MODEL_CACHE_VERSION}`)
      || (/^art-v\d+$/.test(entry) && entry !== `art-v${SPELL_ART_CACHE_VERSION}`));
    for (const kind of SPELL_ART_KINDS) old.push(path.join(`v${UNIT_MODEL_CACHE_VERSION}`, kind));
    for (const entry of old) {
      try {
        fs.rmSync(path.join(this.cacheRoot, entry), { recursive: true, force: true });
      } catch (error) {
        console.warn(`Could not remove old cached models in ${entry}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  // Resolves to the cached file, building it first if needed; null if there
  // is no model for this look.
  async ensure(request: UnitModelRequest): Promise<string | null> {
    const filePath = this.pathFor(request);
    if (await fs.promises.access(filePath).then(() => true, () => false)) return filePath;
    if (!this.enabled) return null;
    const id = `${request.kind}/${request.key}`;
    const failedAt = this.failedAt.get(id);
    if (failedAt !== undefined) {
      if (Date.now() - failedAt < FAILURE_RETRY_MS) return null;
      this.failedAt.delete(id);
    }
    let build = this.building.get(id);
    if (!build) {
      build = this.build(request, filePath).finally(() => this.building.delete(id));
      this.building.set(id, build);
    }
    const ok = await build;
    if (!ok) this.failedAt.set(id, Date.now());
    return ok ? filePath : null;
  }

  private build(request: UnitModelRequest, outputPath: string): Promise<boolean> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(false);
      }, BUILD_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      worker.send({ id, kind: request.kind, params: request.params, outputPath });
    });
  }

  private ensureWorker(): ChildProcess {
    if (this.worker) return this.worker;
    const worker = fork(this.workerScript, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    worker.on('message', (message: { id: number; ok: boolean; error?: string }) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (!message.ok && message.error) console.warn(`Unit model not built: ${message.error}`);
      pending.resolve(message.ok);
    });
    worker.on('exit', (code) => {
      if (this.worker === worker) this.worker = null;
      if (code) console.warn(`Unit model worker exited with code ${code}.`);
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.resolve(false);
        this.pending.delete(id);
      }
    });
    this.worker = worker;
    return worker;
  }
}
