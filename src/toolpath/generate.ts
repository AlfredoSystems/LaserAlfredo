import { boundsOfPolylines } from '../geometry/bounds';
import { applyKerf } from '../geometry/kerf';
import { cutLength, orderForCutting, travelLength } from '../geometry/order';
import type { Bed } from '../model/bed';
import { clampCutSettings } from '../model/document';
import type { LaserDocument, Point, Polyline, ShapeCutSettings } from '../model/types';
import type { Job, JobLayer, JobPath } from './types';

/** Where the head is assumed to be when a job starts. */
export const JOB_START: Point = { x: 0, y: 0 };

export const DEFAULT_TRAVEL_SPEED_MM_S = 200;

export interface GeneratedJob {
  readonly job: Job;
  /** Human-readable notes about content that was left out. */
  readonly warnings: readonly string[];
}

function exitPoint(path: JobPath): Point | undefined {
  return path.closed ? path.points[0] : path.points[path.points.length - 1];
}

/** The shapes of one layer that are cut with the same settings. */
interface SettingsRun {
  readonly settings: ShapeCutSettings;
  readonly paths: Polyline[];
}

/** Gentlest first: least power, then fastest, then fewest passes. */
function gentlerFirst(a: SettingsRun, b: SettingsRun): number {
  return (
    a.settings.maxPowerPct - b.settings.maxPowerPct ||
    b.settings.speedMmS - a.settings.speedMmS ||
    a.settings.passes - b.settings.passes ||
    a.settings.minPowerPct - b.settings.minPowerPct
  );
}

/**
 * Turns the document into a job: enabled line layers in panel order, kerf
 * applied per layer, inner contours before outer ones, then shortest travel.
 *
 * Shapes that carry their own cut settings are split off their layer: after
 * the layer's ordinary cuts comes one job layer per distinct set of settings,
 * gentlest first, each ordered by itself. They keep the layer's colour, kerf
 * and enabled flag, so a job can have more layers than the document.
 */
export function generateJob(doc: LaserDocument, start: Point = JOB_START): GeneratedJob {
  const warnings: string[] = [];
  const layers: JobLayer[] = [];
  let head = start;

  for (const layer of doc.layers) {
    if (!layer.enabled) continue;
    const shapes = doc.shapes.filter((shape) => shape.color === layer.color && shape.points.length >= 2);
    if (shapes.length === 0) continue;
    if (layer.mode === 'fill') {
      warnings.push(`Layer ${layer.color} is set to Fill, which is not supported yet; it was left out`);
      continue;
    }
    // Kerf looks at the whole layer, so a hole stays a hole whatever its settings.
    const compensated = applyKerf(shapes, layer.kerfMm);
    const ordinary: SettingsRun = { settings: layer, paths: [] };
    const overridden = new Map<string, SettingsRun>();
    for (const path of compensated) {
      if (!path.settings) {
        ordinary.paths.push(path);
        continue;
      }
      const settings = clampCutSettings(path.settings, layer);
      const key = `${settings.speedMmS}|${settings.maxPowerPct}|${settings.minPowerPct}|${settings.passes}`;
      let run = overridden.get(key);
      if (!run) {
        run = { settings, paths: [] };
        overridden.set(key, run);
      }
      run.paths.push(path);
    }

    for (const run of [ordinary, ...[...overridden.values()].sort(gentlerFirst)]) {
      if (run.paths.length === 0) continue;
      const paths: JobPath[] = orderForCutting(run.paths, head)
        // Drop specks shorter than a micrometre: the controller cannot represent them.
        .filter((path) => path.points.length >= 2 && cutLength(path) > 0.001)
        .map((path) => ({ points: path.points, closed: path.closed }));
      if (paths.length === 0) continue;
      const last = paths[paths.length - 1];
      head = (last && exitPoint(last)) ?? head;
      layers.push({
        color: layer.color,
        speedMmS: run.settings.speedMmS,
        maxPowerPct: run.settings.maxPowerPct,
        minPowerPct: run.settings.minPowerPct,
        passes: run.settings.passes,
        paths,
      });
    }
  }

  return { job: { layers, bounds: boundsOfPolylines(layers.flatMap((layer) => layer.paths)) }, warnings };
}

/**
 * Null when the whole job lies on the bed, otherwise a message saying why it
 * must be refused. Jobs are never clipped to fit.
 */
export function checkJobAgainstBed(job: Job, bed: Bed): string | null {
  const b = job.bounds;
  if (!b) return 'The job is empty: there is nothing to cut on an enabled layer.';
  if (![b.minX, b.minY, b.maxX, b.maxY].every(Number.isFinite)) return 'The job contains invalid coordinates.';
  const eps = 1e-6;
  if (b.minX < -eps || b.minY < -eps || b.maxX > bed.widthMm + eps || b.maxY > bed.heightMm + eps) {
    const f = (n: number) => n.toFixed(2);
    return (
      `The job reaches outside the ${bed.widthMm} × ${bed.heightMm} mm bed ` +
      `(X ${f(b.minX)} to ${f(b.maxX)}, Y ${f(b.minY)} to ${f(b.maxY)}). Move or resize it; nothing was exported.`
    );
  }
  return null;
}

export interface JobEstimate {
  /** Laser-on distance, counting every pass. */
  readonly cutMm: number;
  /** Laser-off distance, counting every pass. */
  readonly travelMm: number;
  /** Rough duration: distance over speed, ignoring acceleration. */
  readonly seconds: number;
  readonly pathCount: number;
}

export function estimateJob(
  job: Job,
  start: Point = JOB_START,
  travelSpeedMmS = DEFAULT_TRAVEL_SPEED_MM_S,
): JobEstimate {
  let cutMm = 0;
  let travelMm = 0;
  let seconds = 0;
  let pathCount = 0;
  let head = start;
  for (const layer of job.layers) {
    const layerCut = layer.paths.reduce((sum, path) => sum + cutLength(path), 0);
    const last = layer.paths[layer.paths.length - 1];
    const exit = (last && exitPoint(last)) ?? head;
    for (let pass = 0; pass < layer.passes; pass++) {
      travelMm += travelLength(layer.paths, head);
      head = exit;
    }
    cutMm += layerCut * layer.passes;
    seconds += (layerCut * layer.passes) / Math.max(layer.speedMmS, 0.01);
    pathCount += layer.paths.length;
  }
  seconds += travelMm / Math.max(travelSpeedMmS, 0.01);
  return { cutMm, travelMm, seconds, pathCount };
}

export interface PreviewSegment {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
  /** Index into the job's layers, or -1 for a laser-off travel move. */
  readonly layer: number;
  /** Distance travelled from the start of the job to the end of this segment. */
  readonly endMm: number;
}

/** Every head movement of the job in order, for drawing and scrubbing the preview. */
export function previewSegments(job: Job, start: Point = JOB_START): PreviewSegment[] {
  const segments: PreviewSegment[] = [];
  let head = start;
  let total = 0;
  const push = (to: Point, layer: number) => {
    const length = Math.hypot(to.x - head.x, to.y - head.y);
    if (length > 0) {
      total += length;
      segments.push({ ax: head.x, ay: head.y, bx: to.x, by: to.y, layer, endMm: total });
    }
    head = to;
  };
  job.layers.forEach((layer, layerIndex) => {
    for (let pass = 0; pass < layer.passes; pass++) {
      for (const path of layer.paths) {
        const first = path.points[0];
        if (!first) continue;
        push(first, -1);
        for (let i = 1; i < path.points.length; i++) {
          const p = path.points[i];
          if (p) push(p, layerIndex);
        }
        if (path.closed) push(first, layerIndex);
      }
    }
  });
  return segments;
}
