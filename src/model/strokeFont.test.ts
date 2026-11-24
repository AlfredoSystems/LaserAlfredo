import { describe, expect, it } from 'vitest';
import {
  GLYPH_ADVANCE,
  GLYPH_HEIGHT,
  GLYPH_WIDTH,
  hasGlyph,
  STROKE_FONT_CHARACTERS,
  strokeText,
  strokeTextWidth,
} from './strokeFont';

describe('stroke font', () => {
  it('has digits, capitals, space and the signs the labels need', () => {
    for (const character of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ .%/-') {
      expect(hasGlyph(character), character).toBe(true);
    }
  });

  it('draws every character as finite polylines inside its glyph box', () => {
    for (const character of STROKE_FONT_CHARACTERS) {
      const lines = strokeText(character, { x: 0, y: 0 }, GLYPH_HEIGHT);
      if (character !== ' ') expect(lines.length, character).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.closed).toBe(false);
        expect(line.points.length).toBeGreaterThanOrEqual(2);
        for (const p of line.points) {
          expect(Number.isFinite(p.x) && Number.isFinite(p.y), character).toBe(true);
          expect(p.x, character).toBeGreaterThanOrEqual(0);
          expect(p.x, character).toBeLessThanOrEqual(GLYPH_WIDTH);
          expect(p.y, character).toBeGreaterThanOrEqual(0);
          expect(p.y, character).toBeLessThanOrEqual(GLYPH_HEIGHT);
        }
      }
    }
  });

  it('draws a space as nothing, but lets it take room', () => {
    expect(strokeText(' ', { x: 0, y: 0 }, 6)).toEqual([]);
    const lines = strokeText('L L', { x: 0, y: 0 }, 6);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.points[0]).toEqual({ x: 2 * GLYPH_ADVANCE, y: 0 });
  });

  it('is upright and not mirrored with Y down: L has its foot at the bottom right', () => {
    // An L is one stroke: down the left side, then right along the baseline.
    expect(strokeText('L', { x: 100, y: 50 }, 3)).toEqual([
      {
        closed: false,
        points: [
          { x: 100, y: 50 },
          { x: 100, y: 53 },
          { x: 102, y: 53 },
        ],
      },
    ]);
    // A 7 has its bar along the top.
    const seven = strokeText('7', { x: 0, y: 0 }, 6)[0]?.points ?? [];
    expect(seven.slice(0, 2)).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
    ]);
  });

  it('scales with the height and advances from left to right', () => {
    const lines = strokeText('LL', { x: 10, y: 20 }, 12);
    expect(lines[0]?.points[0]).toEqual({ x: 10, y: 20 });
    expect(lines[1]?.points[0]).toEqual({ x: 10 + 2 * GLYPH_ADVANCE, y: 20 });
    expect(lines[1]?.points[2]).toEqual({ x: 10 + 2 * (GLYPH_ADVANCE + GLYPH_WIDTH), y: 32 });
  });

  it('measures the width from the first glyph box to the last', () => {
    expect(strokeTextWidth('', 6)).toBe(0);
    expect(strokeTextWidth('1', 6)).toBe(GLYPH_WIDTH);
    expect(strokeTextWidth('100', 6)).toBe(2 * GLYPH_ADVANCE + GLYPH_WIDTH);
    expect(strokeTextWidth('100', 3)).toBe((2 * GLYPH_ADVANCE + GLYPH_WIDTH) / 2);
    const drawn = strokeText('MM/S', { x: 0, y: 0 }, 6).flatMap((line) => line.points);
    expect(Math.max(...drawn.map((p) => p.x))).toBe(strokeTextWidth('MM/S', 6));
  });

  it('draws lowercase letters as capitals', () => {
    expect(strokeText('mm', { x: 0, y: 0 }, 6)).toEqual(strokeText('MM', { x: 0, y: 0 }, 6));
  });

  it('skips unsupported characters without throwing or leaving a gap', () => {
    expect(hasGlyph('é')).toBe(false);
    expect(strokeText('é€~', { x: 0, y: 0 }, 6)).toEqual([]);
    expect(strokeText('1é€2', { x: 0, y: 0 }, 6)).toEqual(strokeText('12', { x: 0, y: 0 }, 6));
    expect(strokeTextWidth('1é€2', 6)).toBe(strokeTextWidth('12', 6));
    expect(strokeTextWidth('😀', 6)).toBe(0);
  });

  it('draws nothing for a height that is not a positive number', () => {
    expect(strokeText('A', { x: 0, y: 0 }, 0)).toEqual([]);
    expect(strokeText('A', { x: 0, y: 0 }, Number.NaN)).toEqual([]);
  });
});
