import { describe, expect, it } from 'vitest';
import { HL1060_BED, isInsideBed } from './bed';

describe('bed', () => {
  it('is 1000 x 600 mm', () => {
    expect(HL1060_BED).toEqual({ widthMm: 1000, heightMm: 600 });
  });

  it('accepts points on the edges', () => {
    expect(isInsideBed(HL1060_BED, 0, 0)).toBe(true);
    expect(isInsideBed(HL1060_BED, 1000, 600)).toBe(true);
  });

  it('rejects points outside', () => {
    expect(isInsideBed(HL1060_BED, -0.01, 10)).toBe(false);
    expect(isInsideBed(HL1060_BED, 10, 600.01)).toBe(false);
    expect(isInsideBed(HL1060_BED, 1000.01, 10)).toBe(false);
  });
});
