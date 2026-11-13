import { describe, expect, it } from 'vitest';
import {
  addShapes,
  defaultLayer,
  EMPTY_DOCUMENT,
  nearestPaletteColor,
  normalizeColor,
  removeShapes,
  setShapesColor,
  shapesFromPaths,
  transformShapes,
  updateLayer,
} from './document';
import { translation } from './transform';
import type { Shape } from './types';

function counter(): () => string {
  let n = 0;
  return () => `s${++n}`;
}

const square = (id: string, color: string): Shape => ({
  id,
  color,
  closed: true,
  points: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ],
});

describe('normalizeColor', () => {
  it('lowercases and expands short hex', () => {
    expect(normalizeColor('#FF00aa')).toBe('#ff00aa');
    expect(normalizeColor('#F0a')).toBe('#ff00aa');
  });
  it('falls back to black', () => {
    expect(normalizeColor('red')).toBe('#000000');
    expect(normalizeColor('')).toBe('#000000');
  });
});

describe('nearestPaletteColor', () => {
  it('collapses near-blacks and keeps distinct colours apart', () => {
    expect(nearestPaletteColor('#010101')).toBe('#000000');
    expect(nearestPaletteColor('#1a1a1a')).toBe('#000000');
    expect(nearestPaletteColor('#fe0000')).toBe('#ff0000');
    expect(nearestPaletteColor('#00ff00')).toBe('#00a000');
    expect(nearestPaletteColor('#0000ff')).toBe('#0000ff');
  });
});

describe('shapesFromPaths', () => {
  it('drops degenerate and non-finite paths and assigns ids', () => {
    const shapes = shapesFromPaths(
      [
        { color: '#FF0000', closed: false, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
        { color: '#ff0000', closed: false, points: [{ x: 0, y: 0 }] },
        { color: '#ff0000', closed: false, points: [{ x: 0, y: 0 }, { x: Number.NaN, y: 1 }] },
      ],
      counter(),
    );
    expect(shapes).toHaveLength(1);
    expect(shapes[0]).toMatchObject({ id: 's1', color: '#ff0000', closed: false });
  });

  it('does not keep a two-point path closed', () => {
    const [shape] = shapesFromPaths(
      [{ color: '#000000', closed: true, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
      counter(),
    );
    expect(shape?.closed).toBe(false);
  });
});

describe('document operations', () => {
  it('creates one layer per colour in order of first appearance', () => {
    const doc = addShapes(EMPTY_DOCUMENT, [square('a', '#ff0000'), square('b', '#0000ff'), square('c', '#ff0000')]);
    expect(doc.layers.map((layer) => layer.color)).toEqual(['#ff0000', '#0000ff']);
  });

  it('keeps layer settings when more shapes arrive', () => {
    let doc = addShapes(EMPTY_DOCUMENT, [square('a', '#ff0000')]);
    doc = updateLayer(doc, '#ff0000', { speedMmS: 123 });
    doc = addShapes(doc, [square('b', '#ff0000'), square('c', '#00a000')]);
    expect(doc.layers[0]?.speedMmS).toBe(123);
    expect(doc.layers).toHaveLength(2);
  });

  it('removes shapes and their now-empty layers', () => {
    let doc = addShapes(EMPTY_DOCUMENT, [square('a', '#ff0000'), square('b', '#0000ff')]);
    doc = removeShapes(doc, new Set(['a']));
    expect(doc.shapes.map((shape) => shape.id)).toEqual(['b']);
    expect(doc.layers.map((layer) => layer.color)).toEqual(['#0000ff']);
  });

  it('returns the same document when nothing changes', () => {
    const doc = addShapes(EMPTY_DOCUMENT, [square('a', '#ff0000')]);
    expect(removeShapes(doc, new Set(['zzz']))).toBe(doc);
    expect(transformShapes(doc, new Set(), translation(1, 1))).toBe(doc);
  });

  it('transforms only the given shapes', () => {
    let doc = addShapes(EMPTY_DOCUMENT, [square('a', '#ff0000'), square('b', '#ff0000')]);
    doc = transformShapes(doc, new Set(['b']), translation(5, -2));
    expect(doc.shapes[0]?.points[0]).toEqual({ x: 0, y: 0 });
    expect(doc.shapes[1]?.points[0]).toEqual({ x: 5, y: -2 });
  });

  it('moves shapes between layers', () => {
    let doc = addShapes(EMPTY_DOCUMENT, [square('a', '#ff0000'), square('b', '#ff0000')]);
    doc = setShapesColor(doc, new Set(['b']), '#0000FF');
    expect(doc.shapes[1]?.color).toBe('#0000ff');
    expect(doc.layers.map((layer) => layer.color)).toEqual(['#ff0000', '#0000ff']);
    doc = setShapesColor(doc, new Set(['a']), '#0000ff');
    expect(doc.layers.map((layer) => layer.color)).toEqual(['#0000ff']);
  });
});

describe('updateLayer', () => {
  const base = addShapes(EMPTY_DOCUMENT, [square('a', '#ff0000')]);

  it('new layers start at a modest power', () => {
    expect(defaultLayer('#ff0000').maxPowerPct).toBeLessThanOrEqual(30);
  });

  it('clamps power to 0–100 and keeps min at or below max', () => {
    let doc = updateLayer(base, '#ff0000', { maxPowerPct: 250 });
    expect(doc.layers[0]?.maxPowerPct).toBe(100);
    doc = updateLayer(doc, '#ff0000', { maxPowerPct: -5 });
    expect(doc.layers[0]?.maxPowerPct).toBe(0);
    expect(doc.layers[0]?.minPowerPct).toBe(0);
    doc = updateLayer(base, '#ff0000', { maxPowerPct: 40, minPowerPct: 90 });
    expect(doc.layers[0]?.minPowerPct).toBe(40);
  });

  it('clamps kerf to 0–2 mm', () => {
    expect(updateLayer(base, '#ff0000', { kerfMm: 0.15 }).layers[0]?.kerfMm).toBe(0.15);
    expect(updateLayer(base, '#ff0000', { kerfMm: -1 }).layers[0]?.kerfMm).toBe(0);
    expect(updateLayer(base, '#ff0000', { kerfMm: 50 }).layers[0]?.kerfMm).toBe(2);
  });

  it('rejects non-finite values and keeps passes a positive integer', () => {
    let doc = updateLayer(base, '#ff0000', { speedMmS: Number.NaN, passes: 2.6 });
    expect(doc.layers[0]?.speedMmS).toBe(20);
    expect(doc.layers[0]?.passes).toBe(3);
    doc = updateLayer(base, '#ff0000', { passes: 0, speedMmS: 0 });
    expect(doc.layers[0]?.passes).toBe(1);
    expect(doc.layers[0]?.speedMmS).toBe(0.1);
  });
});
