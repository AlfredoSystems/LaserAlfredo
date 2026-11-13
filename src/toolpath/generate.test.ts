import { describe, expect, it } from 'vitest';
import { HL1060_BED } from '../model/bed';
import { addShapes, EMPTY_DOCUMENT, updateLayer } from '../model/document';
import type { LaserDocument, Shape } from '../model/types';
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
