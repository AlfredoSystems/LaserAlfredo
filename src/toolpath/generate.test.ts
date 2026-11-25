import { describe, expect, it } from 'vitest';
import { HL1060_BED } from '../model/bed';
import { addShapes, EMPTY_DOCUMENT, updateLayer } from '../model/document';
import type { LaserDocument, Shape, ShapeCutSettings } from '../model/types';
import { checkJobAgainstBed, estimateJob, generateJob, previewSegments } from './generate';
import type { Job } from './types';

const rect = (id: string, color: string, x: number, y: number, w: number, h: number): Shape => ({
  id,
  color,
  closed: true,
  points: [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ],
});

const line = (id: string, color: string, x1: number, y1: number, x2: number, y2: number): Shape => ({
  id,
  color,
  closed: false,
  points: [
    { x: x1, y: y1 },
    { x: x2, y: y2 },
  ],
});

function docOf(...shapes: Shape[]): LaserDocument {
  return addShapes(EMPTY_DOCUMENT, shapes);
}

function extent(points: readonly { x: number; y: number }[]) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

describe('generateJob', () => {
  it('copies layer settings and cuts holes before their outline', () => {
    let doc = docOf(rect('outer', '#ff0000', 10, 10, 100, 100), rect('hole', '#ff0000', 40, 40, 20, 20));
    doc = updateLayer(doc, '#ff0000', { speedMmS: 35, maxPowerPct: 60, minPowerPct: 15, passes: 2 });
    const { job, warnings } = generateJob(doc);
    expect(warnings).toEqual([]);
    expect(job.layers).toHaveLength(1);
    expect(job.layers[0]).toMatchObject({ color: '#ff0000', speedMmS: 35, maxPowerPct: 60, minPowerPct: 15, passes: 2 });
    const widths = job.layers[0]?.paths.map((path) => {
      const e = extent(path.points);
      return e.maxX - e.minX;
    });
    expect(widths).toEqual([20, 100]);
    expect(job.bounds).toEqual({ minX: 10, minY: 10, maxX: 110, maxY: 110 });
  });

  it('follows layer order and skips disabled layers', () => {
    let doc = docOf(rect('a', '#ff0000', 0, 0, 10, 10), rect('b', '#0000ff', 20, 0, 10, 10), rect('c', '#00a000', 40, 0, 10, 10));
    doc = updateLayer(doc, '#0000ff', { enabled: false });
    const { job } = generateJob(doc);
    expect(job.layers.map((layer) => layer.color)).toEqual(['#ff0000', '#00a000']);
    expect(job.bounds?.maxX).toBe(50);
  });

  it('leaves fill layers out with a warning', () => {
    let doc = docOf(rect('a', '#ff0000', 0, 0, 10, 10));
    doc = updateLayer(doc, '#ff0000', { mode: 'fill' });
    const { job, warnings } = generateJob(doc);
    expect(job.layers).toEqual([]);
    expect(job.bounds).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Fill');
  });

  it('applies kerf: outlines grow and holes shrink by half the kerf per side', () => {
    let doc = docOf(rect('outer', '#ff0000', 10, 10, 100, 100), rect('hole', '#ff0000', 40, 40, 20, 20));
    doc = updateLayer(doc, '#ff0000', { kerfMm: 0.2 });
    const { job } = generateJob(doc);
    const [hole, outer] = job.layers[0]?.paths ?? [];
    const h = extent(hole?.points ?? []);
    const o = extent(outer?.points ?? []);
    expect(h.maxX - h.minX).toBeCloseTo(19.8, 3);
    expect(h.minX).toBeCloseTo(40.1, 3);
    expect(o.maxX - o.minX).toBeCloseTo(100.2, 3);
    expect(o.minY).toBeCloseTo(9.9, 3);
  });

  it('keeps open paths and returns an empty job for an empty document', () => {
    const { job } = generateJob(docOf(line('l', '#000000', 5, 5, 50, 5)));
    expect(job.layers[0]?.paths).toEqual([{ closed: false, points: [{ x: 5, y: 5 }, { x: 50, y: 5 }] }]);
    expect(generateJob(EMPTY_DOCUMENT).job).toEqual({ layers: [], bounds: null });
  });
});

describe('checkJobAgainstBed', () => {
  const jobFor = (...shapes: Shape[]) => generateJob(docOf(...shapes)).job;

  it('accepts a job that touches the bed edges', () => {
    expect(checkJobAgainstBed(jobFor(rect('a', '#000000', 0, 0, 1000, 600)), HL1060_BED)).toBeNull();
  });

  it('refuses anything outside the bed, on every side', () => {
    expect(checkJobAgainstBed(jobFor(rect('a', '#000000', -0.01, 0, 10, 10)), HL1060_BED)).toContain('outside');
    expect(checkJobAgainstBed(jobFor(rect('a', '#000000', 0, -0.01, 10, 10)), HL1060_BED)).toContain('outside');
    expect(checkJobAgainstBed(jobFor(rect('a', '#000000', 995, 0, 5.01, 10)), HL1060_BED)).toContain('outside');
    expect(checkJobAgainstBed(jobFor(rect('a', '#000000', 0, 595, 10, 5.01)), HL1060_BED)).toContain('outside');
  });

  it('refuses when kerf pushes an edge-to-edge part off the bed', () => {
    let doc = docOf(rect('a', '#000000', 0, 0, 1000, 600));
    doc = updateLayer(doc, '#000000', { kerfMm: 0.2 });
    expect(checkJobAgainstBed(generateJob(doc).job, HL1060_BED)).toContain('outside');
  });

  it('refuses empty and non-finite jobs', () => {
    expect(checkJobAgainstBed({ layers: [], bounds: null }, HL1060_BED)).toContain('empty');
    const bad: Job = { layers: [], bounds: { minX: 0, minY: 0, maxX: Number.NaN, maxY: 1 } };
    expect(checkJobAgainstBed(bad, HL1060_BED)).toContain('invalid');
  });
});

describe('estimateJob and previewSegments', () => {
  it('adds up cut and travel distance and time', () => {
    let doc = docOf(rect('a', '#000000', 30, 40, 100, 50));
    doc = updateLayer(doc, '#000000', { speedMmS: 10 });
    const { job } = generateJob(doc);
    const estimate = estimateJob(job, { x: 0, y: 0 }, 100);
    expect(estimate.cutMm).toBeCloseTo(300, 9);
    expect(estimate.travelMm).toBeCloseTo(50, 9); // (0,0) → (30,40)
    expect(estimate.seconds).toBeCloseTo(300 / 10 + 50 / 100, 9);
    expect(estimate.pathCount).toBe(1);
  });

  it('counts every pass', () => {
    let doc = docOf(line('l', '#000000', 0, 0, 100, 0));
    doc = updateLayer(doc, '#000000', { passes: 3, speedMmS: 10 });
    const estimate = estimateJob(generateJob(doc).job, { x: 0, y: 0 }, 100);
    expect(estimate.cutMm).toBeCloseTo(300, 9);
    // Passes two and three first travel back to the start of the line.
    expect(estimate.travelMm).toBeCloseTo(200, 9);
  });

  it('preview segments agree with the estimate and close closed paths', () => {
    let doc = docOf(rect('outer', '#ff0000', 10, 10, 100, 100), rect('hole', '#ff0000', 40, 40, 20, 20), line('l', '#0000ff', 200, 200, 300, 200));
    doc = updateLayer(doc, '#ff0000', { passes: 2 });
    const { job } = generateJob(doc);
    const segments = previewSegments(job);
    const estimate = estimateJob(job);
    const last = segments[segments.length - 1];
    expect(last?.endMm).toBeCloseTo(estimate.cutMm + estimate.travelMm, 6);
    const cut = segments.filter((s) => s.layer >= 0).reduce((sum, s) => sum + Math.hypot(s.bx - s.ax, s.by - s.ay), 0);
    expect(cut).toBeCloseTo(estimate.cutMm, 6);
    // Segments form one continuous head path.
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]?.ax).toBe(segments[i - 1]?.bx);
      expect(segments[i]?.ay).toBe(segments[i - 1]?.by);
    }
  });
});

describe('generateJob with per-shape settings', () => {
  const own = (shape: Shape, speedMmS: number, maxPowerPct: number, passes = 1, minPowerPct = maxPowerPct): Shape => ({
    ...shape,
    settings: { speedMmS, maxPowerPct, minPowerPct, passes },
  });
  const settingsOf = (job: Job) =>
    job.layers.map((layer) => [layer.color, layer.speedMmS, layer.maxPowerPct, layer.minPowerPct, layer.passes]);

  it('leaves a document without overrides exactly as before', () => {
    const doc = docOf(rect('a', '#ff0000', 0, 0, 10, 10), rect('b', '#ff0000', 20, 0, 10, 10));
    expect(generateJob(doc).job.layers).toHaveLength(1);
  });

  it('splits overridden shapes into one job layer per distinct setting, after the ordinary one', () => {
    let doc = docOf(
      own(rect('c1', '#ff0000', 0, 0, 10, 10), 30, 40),
      rect('plain', '#ff0000', 100, 0, 10, 10),
      own(rect('c2', '#ff0000', 20, 0, 10, 10), 30, 40),
      own(rect('c3', '#ff0000', 40, 0, 10, 10), 30, 20),
    );
    doc = updateLayer(doc, '#ff0000', { speedMmS: 15, maxPowerPct: 60, minPowerPct: 50, passes: 3 });
    const { job, warnings } = generateJob(doc);
    expect(warnings).toEqual([]);
    expect(settingsOf(job)).toEqual([
      ['#ff0000', 15, 60, 50, 3],
      ['#ff0000', 30, 20, 20, 1],
      ['#ff0000', 30, 40, 40, 1],
    ]);
    expect(job.layers.map((layer) => layer.paths.length)).toEqual([1, 1, 2]);
    expect(job.bounds).toEqual({ minX: 0, minY: 0, maxX: 110, maxY: 10 });
  });

  it('has no ordinary job layer when every shape has its own settings', () => {
    const { job } = generateJob(docOf(own(rect('a', '#ff0000', 0, 0, 10, 10), 30, 40), own(rect('b', '#ff0000', 20, 0, 10, 10), 10, 40)));
    expect(settingsOf(job)).toEqual([
      ['#ff0000', 30, 40, 40, 1],
      ['#ff0000', 10, 40, 40, 1],
    ]);
  });

  it('orders them gentlest first: least power, then fastest, then fewest passes', () => {
    const at = (id: string, speed: number, power: number, passes: number) =>
      own(rect(id, '#ff0000', 0, 0, 10, 10), speed, power, passes);
    const { job } = generateJob(
      docOf(at('a', 10, 50, 1), at('b', 50, 50, 2), at('c', 50, 50, 1), at('d', 10, 10, 3), at('e', 50, 10, 3), at('f', 20, 10, 1)),
    );
    expect(job.layers.map((layer) => [layer.maxPowerPct, layer.speedMmS, layer.passes])).toEqual([
      [10, 50, 3],
      [10, 20, 1],
      [10, 10, 3],
      [50, 50, 1],
      [50, 50, 2],
      [50, 10, 1],
    ]);
  });

  it('keeps layer order, and a layer switched off takes its overridden shapes with it', () => {
    let doc = docOf(
      own(rect('a', '#ff0000', 0, 0, 10, 10), 30, 40),
      rect('b', '#0000ff', 20, 0, 10, 10),
      own(rect('c', '#0000ff', 40, 0, 10, 10), 5, 5),
      rect('d', '#00a000', 60, 0, 10, 10),
    );
    expect(generateJob(doc).job.layers.map((layer) => [layer.color, layer.speedMmS])).toEqual([
      ['#ff0000', 30],
      ['#0000ff', 20],
      ['#0000ff', 5],
      ['#00a000', 20],
    ]);
    doc = updateLayer(doc, '#0000ff', { enabled: false });
    expect(generateJob(doc).job.layers.map((layer) => layer.color)).toEqual(['#ff0000', '#00a000']);
    doc = updateLayer(updateLayer(doc, '#0000ff', { enabled: true }), '#ff0000', { mode: 'fill' });
    const { job, warnings } = generateJob(doc);
    expect(job.layers.map((layer) => layer.color)).toEqual(['#0000ff', '#0000ff', '#00a000']);
    expect(warnings).toHaveLength(1);
  });

  it('clamps override values the way layer values are clamped', () => {
    const wild: ShapeCutSettings = { speedMmS: 99999, maxPowerPct: 250, minPowerPct: 300, passes: 2.4 };
    const broken: ShapeCutSettings = { speedMmS: Number.NaN, maxPowerPct: -5, minPowerPct: 50, passes: 0 };
    let doc = docOf({ ...rect('a', '#ff0000', 0, 0, 10, 10), settings: wild }, { ...rect('b', '#ff0000', 20, 0, 10, 10), settings: broken });
    doc = updateLayer(doc, '#ff0000', { speedMmS: 15 });
    expect(settingsOf(generateJob(doc).job)).toEqual([
      ['#ff0000', 15, 0, 0, 1],
      ['#ff0000', 2000, 100, 100, 2],
    ]);
  });

  it('merges overrides that are equal after clamping', () => {
    const { job } = generateJob(docOf(own(rect('a', '#ff0000', 0, 0, 10, 10), 30, 100), own(rect('b', '#ff0000', 20, 0, 10, 10), 30, 180)));
    expect(job.layers).toHaveLength(1);
    expect(job.layers[0]?.paths).toHaveLength(2);
  });

  it('orders inner before outer and by travel within each job layer', () => {
    const { job } = generateJob(
      docOf(
        own(rect('outer', '#ff0000', 100, 100, 100, 100), 30, 40),
        own(rect('hole', '#ff0000', 140, 140, 20, 20), 30, 40),
        own(rect('far', '#ff0000', 500, 0, 10, 10), 30, 20),
        own(rect('near', '#ff0000', 0, 0, 10, 10), 30, 20),
      ),
    );
    const widthsAndLefts = job.layers.map((layer) => layer.paths.map((path) => [extent(path.points).maxX - extent(path.points).minX, extent(path.points).minX]));
    expect(widthsAndLefts).toEqual([
      [
        [10, 0],
        [10, 500],
      ],
      [
        [20, 140],
        [100, 100],
      ],
    ]);
  });

  it('applies the layer kerf to overridden shapes, with holes judged across the whole layer', () => {
    let doc = docOf(rect('outer', '#ff0000', 10, 10, 100, 100), own(rect('hole', '#ff0000', 40, 40, 20, 20), 30, 40));
    doc = updateLayer(doc, '#ff0000', { kerfMm: 0.2 });
    const { job } = generateJob(doc);
    expect(job.layers).toHaveLength(2);
    const o = extent(job.layers[0]?.paths[0]?.points ?? []);
    const h = extent(job.layers[1]?.paths[0]?.points ?? []);
    expect(o.maxX - o.minX).toBeCloseTo(100.2, 3);
    // Still a hole, although it is cut in a job layer of its own: it shrinks.
    expect(h.maxX - h.minX).toBeCloseTo(19.8, 3);
    expect(job.layers[1]).toMatchObject({ speedMmS: 30, maxPowerPct: 40 });
  });

  it('counts the extra job layers in the estimate and the preview', () => {
    let doc = docOf(
      own(line('a', '#000000', 0, 0, 100, 0), 10, 20, 2),
      own(line('b', '#000000', 100, 10, 0, 10), 50, 20, 1),
      line('c', '#000000', 0, 20, 100, 20),
    );
    doc = updateLayer(doc, '#000000', { speedMmS: 25 });
    const { job } = generateJob(doc);
    expect(job.layers.map((layer) => layer.speedMmS)).toEqual([25, 50, 10]);
    const estimate = estimateJob(job, { x: 0, y: 0 }, 100);
    expect(estimate.pathCount).toBe(3);
    // c once, b once, a twice.
    expect(estimate.cutMm).toBeCloseTo(400, 9);
    const travel = estimate.travelMm;
    expect(estimate.seconds).toBeCloseTo(100 / 25 + 100 / 50 + 200 / 10 + travel / 100, 9);
    const segments = previewSegments(job);
    expect(segments[segments.length - 1]?.endMm).toBeCloseTo(estimate.cutMm + estimate.travelMm, 6);
    expect(new Set(segments.filter((s) => s.layer >= 0).map((s) => s.layer))).toEqual(new Set([0, 1, 2]));
    const cutOn = (layer: number) =>
      segments.filter((s) => s.layer === layer).reduce((sum, s) => sum + Math.hypot(s.bx - s.ax, s.by - s.ay), 0);
    expect([cutOn(0), cutOn(1), cutOn(2)].map(Math.round)).toEqual([100, 100, 200]);
  });
});
