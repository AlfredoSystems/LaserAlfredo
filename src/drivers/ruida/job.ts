import type { Bed } from '../../model/bed';
import type { Point } from '../../model/types';
import type { Job, JobLayer } from '../../toolpath/types';
import {
  encodeColor,
  encodeInt35,
  encodePowerPct,
  encodeSpeedMmS,
  encodeUnsigned,
  mmToMicrometres,
} from './encode';
import { RUIDA_MAGIC_644X, swizzle } from './swizzle';

export { describeRuidaCommands } from './describe';

/**
 * Job → Ruida `.rd` file for an RDC644x controller. The command sequence
 * follows RDWorks vector-cut files as documented in docs/ruida-protocol.md.
 * It has NOT been run on a machine; read that document before using it.
 */

/** Which bed corner the controller calls (0, 0): the corner it homes to. */
export type RuidaOrigin = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface RuidaOptions {
  readonly bed: Bed;
  /** Hard ceiling for every power value in the file, in percent. Clamped to 0–100. */
  readonly maxPowerCapPct: number;
  /** Scramble byte. Defaults to 0x88 (RDC644x). */
  readonly magic?: number;
  /**
   * Validated but not written: no documented file command sets the travel
   * speed. The controller uses its own "idle speed" setting.
   */
  readonly travelSpeedMmS?: number;
  /** Defaults to `top-left`. Must match the machine, see docs/ruida-protocol.md. */
  readonly origin?: RuidaOrigin;
}

/** The job was refused. Nothing is ever clipped or silently repaired. */
export class RuidaJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuidaJobError';
  }
}

/**
 * Driver sanity limit, not a protocol limit: the format can express far more
 * (5-byte µm/s). 500 mm/s is above any vector cutting speed a 1060 gantry
 * is specified for.
 */
export const RUIDA_MAX_SPEED_MM_S = 500;
/** A layer index is one 7-bit byte. */
export const RUIDA_MAX_LAYERS = 128;
/** Sanity limit on repeats of one layer. */
export const RUIDA_MAX_PASSES = 100;

const BED_EPSILON_MM = 1e-6;

/** Opaque 10-byte element name found unchanged in every RDWorks file examined. */
const ELEMENT_NAME = [0x05, 0x2a, 0x39, 0x1c, 0x41, 0x04, 0x6a, 0x15, 0x08, 0x20] as const;

interface MachinePoint {
  readonly xUm: number;
  readonly yUm: number;
}

interface UmBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface PreparedLayer {
  readonly color: Uint8Array;
  readonly speed: Uint8Array;
  readonly minPower: Uint8Array;
  readonly maxPower: Uint8Array;
  readonly passes: number;
  /** Each path is the full list of points to visit; closed paths already end on their start. */
  readonly paths: readonly (readonly MachinePoint[])[];
  readonly bounds: UmBounds;
  readonly cutLengthUm: number;
}

/**
 * The one place where job coordinates (mm, origin top-left, Y down) become
 * controller coordinates (µm, measured from the machine's home corner).
 * Every axis flip lives here.
 */
export function jobPointToMachineUm(point: Point, bed: Bed, origin: RuidaOrigin): MachinePoint {
  const fromRight = origin === 'top-right' || origin === 'bottom-right';
  const fromBottom = origin === 'bottom-left' || origin === 'bottom-right';
  return {
    xUm: mmToMicrometres(fromRight ? bed.widthMm - point.x : point.x),
    yUm: mmToMicrometres(fromBottom ? bed.heightMm - point.y : point.y),
  };
}

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function checkSpeed(speedMmS: number, what: string): void {
  if (!Number.isFinite(speedMmS) || speedMmS <= 0) {
    throw new RuidaJobError(`${what} must be a positive, finite speed, got ${speedMmS} mm/s.`);
  }
  if (speedMmS > RUIDA_MAX_SPEED_MM_S) {
    throw new RuidaJobError(
      `${what} of ${speedMmS} mm/s is above the driver limit of ${RUIDA_MAX_SPEED_MM_S} mm/s.`,
    );
  }
  if (Math.round(speedMmS * 1000) < 1) {
    throw new RuidaJobError(`${what} of ${speedMmS} mm/s is below 1 µm/s and cannot be encoded.`);
  }
}

function checkBed(bed: Bed): void {
  for (const size of [bed.widthMm, bed.heightMm]) {
    if (!Number.isFinite(size) || size <= 0) {
      throw new RuidaJobError(`Bed size ${bed.widthMm} × ${bed.heightMm} mm is not valid.`);
    }
  }
}

function preparePath(
  points: readonly Point[],
  closed: boolean,
  where: string,
  bed: Bed,
  origin: RuidaOrigin,
): MachinePoint[] {
  const out: MachinePoint[] = [];
  const add = (p: MachinePoint) => {
    const last = out[out.length - 1];
    // A zero-length cut would only dwell with the laser on, so repeats are dropped.
    if (!last || last.xUm !== p.xUm || last.yUm !== p.yUm) out.push(p);
  };
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new RuidaJobError(`${where} has a non-finite coordinate (${point.x}, ${point.y}).`);
    }
    if (
      point.x < -BED_EPSILON_MM ||
      point.y < -BED_EPSILON_MM ||
      point.x > bed.widthMm + BED_EPSILON_MM ||
      point.y > bed.heightMm + BED_EPSILON_MM
    ) {
      throw new RuidaJobError(
        `${where} has a point (${point.x}, ${point.y}) mm outside the ` +
          `${bed.widthMm} × ${bed.heightMm} mm bed. The job was refused, not clipped.`,
      );
    }
    add(jobPointToMachineUm(point, bed, origin));
  }
  const first = out[0];
  if (closed && first) add(first);
  if (out.length < 2) {
    throw new RuidaJobError(`${where} has no length: it needs at least two distinct points.`);
  }
  return out;
}

function prepareLayer(
  layer: JobLayer,
  layerNumber: number,
  capPct: number,
  bed: Bed,
  origin: RuidaOrigin,
): PreparedLayer {
  const where = `Layer ${layerNumber} (${layer.color})`;
  checkSpeed(layer.speedMmS, `${where} speed`);
  if (!Number.isFinite(layer.maxPowerPct) || !Number.isFinite(layer.minPowerPct)) {
    throw new RuidaJobError(`${where} has a non-finite power value.`);
  }
  if (!Number.isInteger(layer.passes) || layer.passes < 1 || layer.passes > RUIDA_MAX_PASSES) {
    throw new RuidaJobError(
      `${where} needs a whole number of passes between 1 and ${RUIDA_MAX_PASSES}, got ${layer.passes}.`,
    );
  }
  // Power is clamped, never trusted: 0–100 %, then the cap, then min ≤ max.
  const maxPowerPct = Math.min(clampPct(layer.maxPowerPct), capPct);
  const minPowerPct = Math.min(clampPct(layer.minPowerPct), maxPowerPct);

  let color: Uint8Array;
  try {
    color = encodeColor(layer.color);
  } catch {
    throw new RuidaJobError(`${where} colour is not in #rrggbb form.`);
  }

  const bounds: UmBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let cutLengthUm = 0;
  const paths = layer.paths.map((path, index) => {
    const points = preparePath(path.points, path.closed, `${where} path ${index + 1}`, bed, origin);
    let previous: MachinePoint | undefined;
    for (const p of points) {
      bounds.minX = Math.min(bounds.minX, p.xUm);
      bounds.minY = Math.min(bounds.minY, p.yUm);
      bounds.maxX = Math.max(bounds.maxX, p.xUm);
      bounds.maxY = Math.max(bounds.maxY, p.yUm);
      if (previous) cutLengthUm += Math.hypot(p.xUm - previous.xUm, p.yUm - previous.yUm);
      previous = p;
    }
    return points;
  });

  return {
    color,
    speed: encodeSpeedMmS(layer.speedMmS),
    minPower: encodePowerPct(minPowerPct),
    maxPower: encodePowerPct(maxPowerPct),
    passes: layer.passes,
    paths,
    bounds,
    cutLengthUm: cutLengthUm * layer.passes,
  };
}

class CommandWriter {
  private readonly bytes: number[] = [];

  /** Appends one command: fixed bytes and already-encoded parameters. */
  command(...parts: readonly (number | ArrayLike<number>)[]): void {
    for (const part of parts) {
      if (typeof part === 'number') {
        this.bytes.push(part);
      } else {
        for (let i = 0; i < part.length; i++) this.bytes.push(part[i] ?? 0);
      }
    }
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

const ZERO_COORD = encodeInt35(0);
const ZERO_POWER = encodePowerPct(0);

function xy(xUm: number, yUm: number): number[] {
  return [...encodeInt35(xUm), ...encodeInt35(yUm)];
}

/**
 * Builds the plain (unscrambled) command stream for a job. Throws
 * `RuidaJobError` instead of producing a file that differs from the job.
 */
export function buildRuidaCommands(job: Job, options: RuidaOptions): Uint8Array {
  const { bed } = options;
  const origin = options.origin ?? 'top-left';
  checkBed(bed);
  if (!Number.isFinite(options.maxPowerCapPct)) {
    throw new RuidaJobError(`The power cap must be a finite number, got ${options.maxPowerCapPct}.`);
  }
  const capPct = clampPct(options.maxPowerCapPct);
  if (options.travelSpeedMmS !== undefined) checkSpeed(options.travelSpeedMmS, 'Travel speed');

  // Layers without paths have nothing to cut and are left out of the file.
  const layers = job.layers
    .map((layer, index) => ({ layer, layerNumber: index + 1 }))
    .filter(({ layer }) => layer.paths.length > 0)
    .map(({ layer, layerNumber }) => prepareLayer(layer, layerNumber, capPct, bed, origin));
  if (layers.length === 0) {
    throw new RuidaJobError('The job is empty: there is nothing to cut.');
  }
  if (layers.length > RUIDA_MAX_LAYERS) {
    throw new RuidaJobError(`The job has ${layers.length} layers; the format allows ${RUIDA_MAX_LAYERS}.`);
  }

  const bounds = layers.reduce<UmBounds>(
    (all, { bounds: b }) => ({
      minX: Math.min(all.minX, b.minX),
      minY: Math.min(all.minY, b.minY),
      maxX: Math.max(all.maxX, b.maxX),
      maxY: Math.max(all.maxY, b.maxY),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
  const min = xy(bounds.minX, bounds.minY);
  const max = xy(bounds.maxX, bounds.maxY);
  const size = xy(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  const zeroXY = [...ZERO_COORD, ...ZERO_COORD];
  const one = encodeUnsigned(1, 2);

  const w = new CommandWriter();

  // --- Preamble: absolute machine coordinates.
  w.command(0xd8, 0x10); // ref point mode 2: machine zero
  w.command(0xf0); // ref point set
  w.command(0xe6, 0x01); // set absolute
  w.command(0xf1, 0x02, 0x00); // block cutting off
  w.command(0xd8, 0x00); // start process
  w.command(0xe7, 0x06, zeroXY); // feed repeat 0, 0

  // --- Job bounding box.
  w.command(0xe7, 0x03, min);
  w.command(0xe7, 0x07, max);
  w.command(0xe7, 0x50, min);
  w.command(0xe7, 0x51, max);
  w.command(0xe7, 0x04, one, one, zeroXY); // process repeat 1 × 1
  w.command(0xe7, 0x05, 0x00); // array direction

  // --- Per-layer settings table.
  layers.forEach((layer, index) => {
    const b = layer.bounds;
    const layerMin = xy(b.minX, b.minY);
    const layerMax = xy(b.maxX, b.maxY);
    w.command(0xc9, 0x04, index, layer.speed);
    w.command(0xc6, 0x31, index, layer.minPower);
    w.command(0xc6, 0x32, index, layer.maxPower);
    // Lasers 2–4 are always present in RDWorks files. This machine has one
    // tube, so they are written as zero.
    for (const laser of [0x41, 0x42, 0x35, 0x36, 0x37, 0x38]) {
      w.command(0xc6, laser, index, ZERO_POWER);
    }
    w.command(0xca, 0x06, index, layer.color);
    w.command(0xca, 0x41, index, 0x00); // work mode 0: cut
    w.command(0xe7, 0x52, index, layerMin);
    w.command(0xe7, 0x53, index, layerMax);
    w.command(0xe7, 0x61, index, layerMin);
    w.command(0xe7, 0x62, index, layerMax);
  });
  w.command(0xca, 0x22, layers.length - 1); // highest layer index

  // --- Offsets, element and array blocks (one element, 1 × 1 array).
  w.command(0xe7, 0x54, 0x00, ZERO_COORD);
  w.command(0xe7, 0x54, 0x01, ZERO_COORD);
  w.command(0xe7, 0x55, 0x00, ZERO_COORD);
  w.command(0xe7, 0x55, 0x01, ZERO_COORD);
  w.command(0xf1, 0x03, zeroXY);
  w.command(0xf1, 0x00, 0x00);
  w.command(0xf1, 0x01, 0x00);
  w.command(0xf2, 0x00, 0x00);
  w.command(0xf2, 0x01, 0x00);
  w.command(0xf2, 0x02, ELEMENT_NAME);
  w.command(0xf2, 0x03, min);
  w.command(0xf2, 0x04, max);
  w.command(0xf2, 0x06, zeroXY);
  w.command(0xf2, 0x07, 0x00);
  w.command(0xf2, 0x05, one, one, size);
  w.command(0xea, 0x00);
  w.command(0xe7, 0x60, 0x00);
  w.command(0xe7, 0x13, min);
  w.command(0xe7, 0x17, max);
  w.command(0xe7, 0x23, zeroXY);
  w.command(0xe7, 0x24, 0x00);
  w.command(0xe7, 0x08, one, one, size);

  // --- Layer bodies.
  layers.forEach((layer, index) => {
    w.command(0xca, 0x01, 0x00);
    w.command(0xca, 0x02, index); // select layer
    w.command(0xca, 0x01, 0x30); // laser 2 offset off
    w.command(0xca, 0x01, 0x10); // layer device 0
    w.command(0xca, 0x01, 0x13); // air assist on
    w.command(0xc9, 0x02, layer.speed);
    w.command(0xc6, 0x12, ZERO_COORD); // laser on delay 0
    w.command(0xc6, 0x13, ZERO_COORD); // laser off delay 0
    w.command(0xc6, 0x01, layer.minPower);
    w.command(0xc6, 0x02, layer.maxPower);
    for (const laser of [0x21, 0x22, 0x05, 0x06, 0x07, 0x08]) {
      w.command(0xc6, laser, ZERO_POWER);
    }
    w.command(0xca, 0x03, 0x0f);
    w.command(0xca, 0x10, 0x00);
    for (let pass = 0; pass < layer.passes; pass++) {
      for (const path of layer.paths) {
        path.forEach((p, i) => w.command(i === 0 ? 0x88 : 0xa8, xy(p.xUm, p.yUm)));
      }
    }
  });

  // --- Trailer.
  const totalCutMm = Math.floor(layers.reduce((sum, layer) => sum + layer.cutLengthUm, 0) / 1000);
  const length = encodeUnsigned(totalCutMm, 5);
  w.command(0xeb); // array end
  w.command(0xe7, 0x00); // block end
  w.command(0xda, 0x01, 0x06, 0x20, length, length);
  w.command(0xd7); // end of file

  return w.toBytes();
}

/** Returns the complete, scrambled `.rd` file for a job. */
export function encodeRuidaJob(job: Job, options: RuidaOptions): Uint8Array {
  const magic = options.magic ?? RUIDA_MAGIC_644X;
  if (!Number.isInteger(magic) || magic < 0 || magic > 0xff) {
    throw new RuidaJobError(`The scramble byte must be 0–255, got ${magic}.`);
  }
  return swizzle(buildRuidaCommands(job, options), magic);
}
