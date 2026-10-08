import { OrthographicCamera, Vector3 } from 'three';

import type { IsoView, Vec3 } from '../utils/map-projection';

// Scenes are exported with a Z-up to Y-up root rotation, so server
// coordinates (x, y, z) sit at (x, z, -y) in three.js space.
export function serverToThree([x, y, z]: Vec3): Vector3 {
  return new Vector3(x, z, -y);
}

const CAMERA_DISTANCE = 20000;

// Points the orthographic camera so three.js draws exactly what the overlay's
// IsoView projection maps to the same pixels.
export function applyIsoCamera(camera: OrthographicCamera, view: IsoView, width: number, height: number): void {
  const center = serverToThree(view.center);
  const toCamera = serverToThree(view.basis.toCamera);
  camera.position.copy(center).addScaledVector(toCamera, CAMERA_DISTANCE);
  camera.up.copy(serverToThree(view.basis.up));
  camera.lookAt(center);
  const halfWidth = width / 2 / view.pixelsPerUnit;
  const halfHeight = height / 2 / view.pixelsPerUnit;
  camera.left = -halfWidth;
  camera.right = halfWidth;
  camera.top = halfHeight;
  camera.bottom = -halfHeight;
  camera.near = 1;
  camera.far = CAMERA_DISTANCE * 2;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}
