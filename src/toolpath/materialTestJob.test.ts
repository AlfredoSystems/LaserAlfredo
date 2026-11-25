import { describe, expect, it } from 'vitest';
import { encodeRuidaJob, RUIDA_MAX_LAYERS, RuidaJobError } from '../drivers/ruida/job';
import { HL1060_BED } from '../model/bed';
import { addShapes, addShapesWithLayers, EMPTY_DOCUMENT } from '../model/document';
import {
  buildMaterialTest,
  DEFAULT_MATERIAL_TEST_OPTIONS,
  MATERIAL_TEST_CELL_COLOR,
  MATERIAL_TEST_LABEL_COLOR,
  type MaterialTestOptions,
} from '../model/materialTest';
import type { LaserDocument, Shape } from '../model/types';
import { checkJobAgainstBed, estimateJob, generateJob } from './generate';

/**
 * What the job worker does for an export, without the worker: generate,
 * check against the bed, encode. A material test gives the encoder more
 * layers than the document has; these tests pin down that this works, and
 * where it stops.
 */
const EXPORT = { bed: HL1060_BED, maxPowerCapPct: 100, origin: 'top-left' } as const;

function documentWithTest(options: Partial<MaterialTestOptions>): LaserDocument {
  let n = 0;
  const test = buildMaterialTest(
    { ...DEFAULT_MATERIAL_TEST_OPTIONS, ...options },
    { origin: { x: 10, y: 10 }, nextShapeId: () => `t${++n}`, groupId: 'g1' },
  );
  if (!test) throw new Error('no test was built');
  return addShapesWithLayers(EMPTY_DOCUMENT, test.shapes, test.layers);
}

describe('a material test as a job', () => {
  it('turns the default grid into the label layer followed by one job layer per cell, gentlest first', () => {
    const doc = documentWithTest({});
    const { job, warnings } = generateJob(doc);
    expect(warnings).toEqual([]);
    expect(doc.layers).toHaveLength(2);
    expect(job.layers).toHaveLength(26);
    expect(job.layers[0]).toMatchObject({ color: MATERIAL_TEST_LABEL_COLOR, speedMmS: 100, maxPowerPct: 12, minPowerPct: 12, passes: 1 });
    const cells = job.layers.slice(1);
    expect(cells.every((layer) => layer.color === MATERIAL_TEST_CELL_COLOR && layer.paths.length === 1)).toBe(true);
    expect(cells.map((layer) => [layer.maxPowerPct, layer.speedMmS])).toEqual(
      [10, 20, 30, 40, 50].flatMap((power) => [50, 40, 30, 20, 10].map((speed) => [power, speed])),
    );
    expect(checkJobAgainstBed(job, HL1060_BED)).toBeNull();
    // 25 squares of 40 mm outline, plus the labels.
    const estimate = estimateJob(job);
    expect(estimate.pathCount).toBe(doc.shapes.length);
    expect(estimate.cutMm).toBeGreaterThan(1000);
  });

  it('encodes a 10 × 10 grid with labels', () => {
    const doc = documentWithTest({
      columns: { parameter: 'speed', from: 10, to: 100, steps: 10 },
      rows: { parameter: 'power', from: 10, to: 100, steps: 10 },
    });
    const { job } = generateJob(doc);
    expect(job.layers).toHaveLength(101);
    expect(checkJobAgainstBed(job, HL1060_BED)).toBeNull();
    const bytes = encodeRuidaJob(job, EXPORT);
    expect(bytes.length).toBeGreaterThan(5000);
  });

  it('is refused by the driver when the job needs more layers than the format has', () => {
    const shapes: Shape[] = [];
    for (let i = 0; i <= RUIDA_MAX_LAYERS; i++) {
      const x = (i % 20) * 12;
      const y = Math.floor(i / 20) * 12;
      shapes.push({
        id: `s${i}`,
        color: MATERIAL_TEST_CELL_COLOR,
        closed: true,
        points: [
          { x, y },
          { x: x + 10, y },
          { x: x + 10, y: y + 10 },
          { x, y: y + 10 },
        ],
        settings: { speedMmS: 10 + i, maxPowerPct: 20, minPowerPct: 20, passes: 1 },
      });
    }
    const { job } = generateJob(addShapes(EMPTY_DOCUMENT, shapes));
    expect(job.layers).toHaveLength(RUIDA_MAX_LAYERS + 1);
    expect(checkJobAgainstBed(job, HL1060_BED)).toBeNull();
    expect(() => encodeRuidaJob(job, EXPORT)).toThrow(RuidaJobError);
    expect(() => encodeRuidaJob(job, EXPORT)).toThrow('The job has 129 layers; the format allows 128.');

    // One fewer distinct setting fits.
    const fits = generateJob(addShapes(EMPTY_DOCUMENT, shapes.slice(1))).job;
    expect(fits.layers).toHaveLength(RUIDA_MAX_LAYERS);
    expect(() => encodeRuidaJob(fits, EXPORT)).not.toThrow();
  });

  it('is refused, not clipped, when a speed in the grid is above the driver limit', () => {
    const doc = documentWithTest({ columns: { parameter: 'speed', from: 100, to: 600, steps: 6 } });
    expect(() => encodeRuidaJob(generateJob(doc).job, EXPORT)).toThrow(/above the driver limit of 500 mm\/s/);
  });
});
