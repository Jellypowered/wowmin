#!/usr/bin/env node
// Exports the 3D scenes Instance Watch draws: <mapId>.glb plus its manifest
// <mapId>.scene.json, straight from the client's map files. Independent of
// the 2D map extraction (extract-map-assets.mjs): it reads the map catalogue
// itself and every map with a WDT gets a scene, with or without map artwork.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { locateDataDir, openClientData } from './client-archives.mjs';
import { buildMapCatalog } from './map-catalog.mjs';
import { assertNpmValueOptionsHaveValues, readNpmConfigBoolean, readNpmConfigValue } from './npm-config.mjs';
import { exportMapScene } from './scene/export-scene.mjs';

export const SCENE_SCHEMA_VERSION = 1;

const USAGE = `WoW Admin 3D scene exporter

Usage:
  npm run extract:scenes -- --source /path/to/WoW --all-instances
  npm run extract:scenes -- --source /path/to/WoW --map 489 --map 574
  npm run extract:scenes --source=/path/to/WoW --all-instances

Options:
  --source, -s        WoW client root or its Data directory
  --output, -o        Output directory (default: assets/instances)
  --map, -m           Export only these map IDs (repeatable)
  --all-instances     Export every instance, raid, battleground, and arena from Map.dbc
  --scene-texture-max Largest scene texture edge in pixels (default: 512)
  --help, -h          Show this message
`;

const NPM_VALUE_OPTIONS = ['source', 'output', 'map', 'scene_texture_max'];

// Arguments after a standalone --, or npm config options (--source=/path)
// when npm took them itself.
export function parseSceneArgs(argv) {
  assertNpmValueOptionsHaveValues(NPM_VALUE_OPTIONS);
  const npmMaps = readNpmConfigValue('map');
  const options = {
    source: readNpmConfigValue('source') ?? null,
    output: readNpmConfigValue('output') ?? 'assets/instances',
    mapIds: npmMaps ? npmMaps.split(',').map(Number) : [],
    allInstances: readNpmConfigBoolean('all_instances') ?? false,
    textureMax: Number(readNpmConfigValue('scene_texture_max') ?? 512),
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${arg} needs a value.`);
      return next;
    };
    switch (arg) {
      case '--source': case '-s': options.source = value(); break;
      case '--output': case '-o': options.output = value(); break;
      case '--map': case '-m': options.mapIds.push(Number(value())); break;
      case '--all-instances': options.allInstances = true; break;
      case '--scene-texture-max': options.textureMax = Number(value()); break;
      case '--help': case '-h': options.help = true; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.help) return options;
  if (!options.source) throw new Error('Missing required --source argument.');
  if (!options.mapIds.length && !options.allInstances) throw new Error('Pass --map <id> or --all-instances.');
  if (options.mapIds.length && options.allInstances) throw new Error('--map and --all-instances are mutually exclusive.');
  if (options.mapIds.some((mapId) => !Number.isInteger(mapId) || mapId < 0)) {
    throw new Error(`Map IDs must be non-negative integers. Received: ${options.mapIds.join(', ')}`);
  }
  if (!Number.isInteger(options.textureMax) || options.textureMax < 1) {
    throw new Error(`Scene texture size must be a positive integer. Received: ${options.textureMax}`);
  }
  return { ...options, source: path.resolve(options.source), output: path.resolve(options.output) };
}

// The manifest the app reads to find and frame a map's scene.
export function sceneManifest(map, scene) {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    mapId: map.mapId,
    label: map.label,
    mapType: map.mapType ?? null,
    mapTypeLabel: map.mapTypeLabel ?? null,
    ...scene,
  };
}

async function main() {
  const options = parseSceneArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const dataDir = locateDataDir(options.source);
  if (!dataDir) throw new Error(`No WoW client Data directory at ${options.source}.`);
  const readFile = openClientData(dataDir, { warn: (message) => console.warn(`  ! ${message}`) });
  const maps = buildMapCatalog(readFile, { mapIds: options.mapIds, allInstances: options.allInstances });
  fs.mkdirSync(options.output, { recursive: true });

  let written = 0;
  for (const map of maps) {
    console.log(`• Exporting 3D scene for ${map.label}...`);
    try {
      const { scene, stats } = await exportMapScene({
        mapId: map.mapId,
        internalName: map.internalName,
        readFile,
        outputDir: options.output,
        textureMax: options.textureMax,
        floors: map.floors,
        worldMapBounds: map.worldMapBounds,
      });
      const manifestPath = path.join(options.output, `${map.mapId}.scene.json`);
      fs.writeFileSync(manifestPath, `${JSON.stringify(sceneManifest(map, scene), null, 2)}\n`);
      written += 1;
      console.log(`  ✓ Wrote ${scene.file} (${(stats.bytes / 1048576).toFixed(1)} MB; ${stats.wmoCount} WMO, `
        + `${stats.groupCount} groups, ${stats.doodadCount} doodads (${stats.doodadBatches} instanced batches), ${stats.modelCount} models, ${stats.textureCount} textures`
        + `${stats.terrainTiles ? `, terrain ${stats.terrainTiles} tiles / ${stats.terrainChunks} chunks` : ''}`
        + `${stats.liquidCount ? `, ${stats.liquidCount} liquids (${stats.liquidTriangles} triangles)` : ''})`);
      for (const skipped of stats.skippedWmos) console.warn(`  ! Skipped WMO ${skipped}`);
      if (stats.missing.length) {
        console.warn(`  ! ${stats.missing.length} referenced file(s) not found in the client, e.g. ${stats.missing.slice(0, 3).join(', ')}`);
      }
    } catch (error) {
      console.warn(`  ! Skipping scene for ${map.label}: ${error instanceof Error ? error.message : error}`);
    }
  }
  console.log(`\nDone. Wrote ${written} of ${maps.length} scene(s) to ${options.output}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`✖ ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
