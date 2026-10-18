// The version of the 3D scenes' contents (assets/instances/<mapId>.glb and
// its <mapId>.scene.json), as npm run extract:scenes writes them into each
// manifest's exportVersion (SCENE_EXPORT_VERSION in scripts/export-scenes.mjs,
// kept equal to this by a test). Bumped whenever the export changes in a way
// the viewer draws differently, so a WoWMin that finds older scenes can say
// to export them again, and one that finds newer scenes can say to update
// itself. Scenes exported before the version was kept count as 1.
// 1: the first kept.
export const SCENE_EXPORT_VERSION = 1;

export type SceneExportStatus = 'current' | 'older' | 'newer';

export function sceneExportStatus(version: number | undefined, current = SCENE_EXPORT_VERSION): SceneExportStatus {
  const own = version ?? 1;
  return own < current ? 'older' : own > current ? 'newer' : 'current';
}

const REEXPORT_COMMAND = 'npm run extract:scenes -- --all-instances';
const UPDATE_COMMAND = 'npm run build';

// What to tell the viewer about one map's scene, or null when it is current.
export function sceneExportNotice(status: SceneExportStatus): string | null {
  if (status === 'older') return `This map's 3D scene comes from an older export. Run ${REEXPORT_COMMAND} for the current look.`;
  if (status === 'newer') return `This map's 3D scene is newer than this WoWMin understands. Run ${UPDATE_COMMAND} and restart WoWMin.`;
  return null;
}

// What to tell an administrator about the scenes on disk (their manifests'
// export versions), or null when they are all current.
export function sceneExportAdvice(versions: ReadonlyArray<number | undefined>, current = SCENE_EXPORT_VERSION): string | null {
  const older = versions.filter((version) => sceneExportStatus(version, current) === 'older').length;
  const newer = versions.filter((version) => sceneExportStatus(version, current) === 'newer').length;
  const parts = [
    older ? `${older} of ${versions.length} 3D scenes predate this WoWMin: run ${REEXPORT_COMMAND}.` : null,
    newer ? `${newer} of ${versions.length} 3D scenes are newer than this WoWMin: run ${UPDATE_COMMAND} and restart it.` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}
