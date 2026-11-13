import { HL1060_BED } from '../../model/bed';
import type { Point } from '../../model/types';
import type { Job, JobLayer, JobPath } from '../../toolpath/types';
import type { RuidaOptions } from './job';

/** Shared fixtures for the Ruida driver tests. Not used by the app. */

export const TEST_OPTIONS: RuidaOptions = { bed: HL1060_BED, maxPowerCapPct: 100 };

export function rectPath(x: number, y: number, width: number, height: number): JobPath {
  return {
    closed: true,
    points: [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ],
  };
}

export function layerOf(paths: readonly JobPath[], overrides: Partial<JobLayer> = {}): JobLayer {
  return {
    color: '#000000',
    speedMmS: 20,
    maxPowerPct: 30,
    minPowerPct: 20,
    passes: 1,
    paths,
    ...overrides,
  };
}

export function jobOf(...layers: JobLayer[]): Job {
  const points: Point[] = layers.flatMap((layer) => layer.paths.flatMap((path) => path.points));
  if (points.length === 0) return { layers, bounds: null };
  return {
    layers,
    bounds: {
      minX: Math.min(...points.map((p) => p.x)),
      minY: Math.min(...points.map((p) => p.y)),
      maxX: Math.max(...points.map((p) => p.x)),
      maxY: Math.max(...points.map((p) => p.y)),
    },
  };
}

/** Golden job 1: one 50 × 30 mm rectangle at (10, 10), 20 mm/s, 30 % / 20 %. */
export const RECTANGLE_JOB: Job = jobOf(layerOf([rectPath(10, 10, 50, 30)]));

/** Golden job 2: two layers with different settings, two passes on the second. */
export const TWO_LAYER_JOB: Job = jobOf(
  layerOf([rectPath(100, 50, 20, 20), rectPath(140, 50, 20, 20)], {
    color: '#0000ff',
    speedMmS: 150,
    maxPowerPct: 18,
    minPowerPct: 12,
  }),
  layerOf([rectPath(90, 40, 80, 40)], {
    color: '#ff0000',
    speedMmS: 12.5,
    maxPowerPct: 65,
    minPowerPct: 50,
    passes: 2,
  }),
);

/** Golden job 3: one open polyline. */
export const OPEN_POLYLINE_JOB: Job = jobOf(
  layerOf(
    [
      {
        closed: false,
        points: [
          { x: 200, y: 300 },
          { x: 250.5, y: 300 },
          { x: 275.25, y: 342.125 },
          { x: 300, y: 300 },
          { x: 1000, y: 600 },
        ],
      },
    ],
    { color: '#00ff00', speedMmS: 35, maxPowerPct: 45, minPowerPct: 10 },
  ),
);
