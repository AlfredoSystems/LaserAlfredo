import type { Point, Polyline } from './types';

/**
 * A small single-stroke font drawn for this project: digits, capital
 * letters, space and a few signs. Every glyph is a handful of straight
 * strokes on a 4 × 6 grid, x to the right and y DOWN (0 is the top of a
 * capital, 6 the baseline), so it needs no flip in document space.
 */

/** Width of a glyph box in grid units. */
export const GLYPH_WIDTH = 4;
/** Height of a glyph box in grid units. */
export const GLYPH_HEIGHT = 6;
/** Distance from one glyph box to the next in grid units. */
export const GLYPH_ADVANCE = 6;

const ROUND = '1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0';
const P_BOWL = '0,6 0,0 3,0 4,1 4,2 3,3 0,3';

/** Strokes per character, each `x,y x,y …` in grid units. */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  ' ': [],
  '0': [ROUND],
  '1': ['1,1 2,0 2,6', '1,6 3,6'],
  '2': ['0,1 1,0 3,0 4,1 4,2 0,6 4,6'],
  '3': ['0,1 1,0 3,0 4,1 4,2 3,3 4,4 4,5 3,6 1,6 0,5', '1.5,3 3,3'],
  '4': ['3,6 3,0 0,4 4,4'],
  '5': ['4,0 0,0 0,2.5 3,2.5 4,3.5 4,5 3,6 1,6 0,5'],
  '6': ['4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5 4,3.5 3,2.5 1,2.5 0,3.5'],
  '7': ['0,0 4,0 1.5,6'],
  '8': ['1,3 0,2 0,1 1,0 3,0 4,1 4,2 3,3 1,3 0,4 0,5 1,6 3,6 4,5 4,4 3,3'],
  '9': ['0,5 1,6 3,6 4,5 4,1 3,0 1,0 0,1 0,2.5 1,3.5 3,3.5 4,2.5'],
  A: ['0,6 0,2 2,0 4,2 4,6', '0,4 4,4'],
  B: ['0,3 3,3 4,2 4,1 3,0 0,0 0,6 3,6 4,5 4,4 3,3'],
  C: ['4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5'],
  D: ['0,0 3,0 4,1 4,5 3,6 0,6 0,0'],
  E: ['4,0 0,0 0,6 4,6', '0,3 3,3'],
  F: ['4,0 0,0 0,6', '0,3 3,3'],
  G: ['4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5 4,3 2,3'],
  H: ['0,0 0,6', '4,0 4,6', '0,3 4,3'],
  I: ['1,0 3,0', '2,0 2,6', '1,6 3,6'],
  J: ['4,0 4,5 3,6 1,6 0,5'],
  K: ['0,0 0,6', '4,0 0,3 4,6'],
  L: ['0,0 0,6 4,6'],
  M: ['0,6 0,0 2,3 4,0 4,6'],
  N: ['0,6 0,0 4,6 4,0'],
  O: [ROUND],
  P: [P_BOWL],
  Q: [ROUND, '2.5,4.5 4,6'],
  R: [P_BOWL, '2,3 4,6'],
  S: ['4,1 3,0 1,0 0,1 0,2 1,3 3,3 4,4 4,5 3,6 1,6 0,5'],
  T: ['0,0 4,0', '2,0 2,6'],
  U: ['0,0 0,5 1,6 3,6 4,5 4,0'],
  V: ['0,0 2,6 4,0'],
  W: ['0,0 1,6 2,3 3,6 4,0'],
  X: ['0,0 4,6', '4,0 0,6'],
  Y: ['0,0 2,3 4,0', '2,3 2,6'],
  Z: ['0,0 4,0 0,6 4,6'],
  '.': ['1.7,5.4 2.3,5.4 2.3,6 1.7,6 1.7,5.4'],
  '%': ['0,6 4,0', '0,0 1.2,0 1.2,1.2 0,1.2 0,0', '2.8,4.8 4,4.8 4,6 2.8,6 2.8,4.8'],
  '/': ['0,6 4,0'],
  '-': ['0.5,3 3.5,3'],
  '+': ['0.5,3 3.5,3', '2,1.5 2,4.5'],
  ':': ['1.7,1.6 2.3,1.6 2.3,2.2 1.7,2.2 1.7,1.6', '1.7,4.4 2.3,4.4 2.3,5 1.7,5 1.7,4.4'],
};

function parseStroke(stroke: string): Point[] {
  return stroke.split(' ').map((pair) => {
    const [x, y] = pair.split(',');
    return { x: Number(x), y: Number(y) };
  });
}

const PARSED = new Map<string, readonly (readonly Point[])[]>(
  Object.entries(GLYPHS).map(([character, strokes]) => [character, strokes.map(parseStroke)]),
);

/** Every character the font can draw. Lowercase letters are drawn as capitals. */
export const STROKE_FONT_CHARACTERS: readonly string[] = [...PARSED.keys()];

function glyph(character: string): readonly (readonly Point[])[] | undefined {
  return PARSED.get(character) ?? PARSED.get(character.toUpperCase());
}

export function hasGlyph(character: string): boolean {
  return glyph(character) !== undefined;
}

/** The characters of the text the font can draw; the others are skipped everywhere. */
function drawable(text: string): string[] {
  return Array.from(text).filter(hasGlyph);
}

/**
 * Width in mm of the text at the given capital height, from the left edge of
 * the first glyph box to the right edge of the last. Characters without a
 * glyph take no room.
 */
export function strokeTextWidth(text: string, heightMm: number): number {
  const count = drawable(text).length;
  if (count === 0) return 0;
  return ((count - 1) * GLYPH_ADVANCE + GLYPH_WIDTH) * (heightMm / GLYPH_HEIGHT);
}

/**
 * The text as open polylines, reading left to right, with the top-left corner
 * of its box at `topLeft` and capitals `heightMm` tall. Characters without a
 * glyph are skipped. A height that is not a positive number draws nothing.
 */
export function strokeText(text: string, topLeft: Point, heightMm: number): Polyline[] {
  if (!Number.isFinite(heightMm) || heightMm <= 0) return [];
  const unit = heightMm / GLYPH_HEIGHT;
  const lines: Polyline[] = [];
  drawable(text).forEach((character, index) => {
    const left = topLeft.x + index * GLYPH_ADVANCE * unit;
    for (const stroke of glyph(character) ?? []) {
      lines.push({
        closed: false,
        points: stroke.map((p) => ({ x: left + p.x * unit, y: topLeft.y + p.y * unit })),
      });
    }
  });
  return lines;
}
