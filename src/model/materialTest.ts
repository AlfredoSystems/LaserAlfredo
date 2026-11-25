import { boundsOfPoints, unionBounds } from '../geometry/bounds';
import type { LayerSetup } from './document';
import { GLYPH_ADVANCE, GLYPH_HEIGHT, strokeText, strokeTextWidth } from './strokeFont';
import type { Bounds, Point, Polyline, Shape, ShapeCutSettings } from './types';

/**
 * Material test: a grid of small squares in which one cut setting changes
 * from column to column and another from row to row, so a single job shows
 * which combination works on a material. Line (cut) mode only.
 */

/** Layer colour of the test squares. Not in the layer palette. */
export const MATERIAL_TEST_CELL_COLOR = '#a04000';
/** Layer colour of the engraved labels. Not in the layer palette. */
export const MATERIAL_TEST_LABEL_COLOR = '#008060';

export type TestParameter = 'speed' | 'power' | 'passes';

export const TEST_PARAMETERS: readonly TestParameter[] = ['speed', 'power', 'passes'];

export interface TestAxis {
  readonly parameter: TestParameter;
  readonly from: number;
  readonly to: number;
  /** How many values the axis has, both ends included. Whole, 4 to 10. */
  readonly steps: number;
}

export interface MaterialTestOptions {
  readonly columns: TestAxis;
  readonly rows: TestAxis;
  readonly cellSizeMm: number;
  readonly gapMm: number;
  /** Used by every cell unless speed is on an axis. */
  readonly speedMmS: number;
  /** Used by every cell unless power is on an axis. */
  readonly maxPowerPct: number;
  /**
   * Null: every cell's min power equals its max power, so the power stays the
   * same in corners. A number: that min power, lowered to the cell's max power
   * where it would exceed it.
   */
  readonly minPowerPct: number | null;
  /** Used by every cell unless passes is on an axis. */
  readonly passes: number;
  readonly labels: boolean;
  readonly labelSpeedMmS: number;
  readonly labelPowerPct: number;
}

export const MIN_TEST_STEPS = 4;
export const MAX_TEST_STEPS = 10;
export const DEFAULT_TEST_STEPS = 5;

interface ParameterInfo {
  readonly min: number;
  readonly max: number;
  /** Decimals a value is rounded to; the label shows exactly what is cut. */
  readonly decimals: number;
  readonly from: number;
  readonly to: number;
  /** Name in the engraved title, in characters the stroke font has. */
  readonly title: string;
}

const PARAMETERS: Readonly<Record<TestParameter, ParameterInfo>> = {
  speed: { min: 0.1, max: 2000, decimals: 1, from: 10, to: 50, title: 'SPEED MM/S' },
  power: { min: 0, max: 100, decimals: 1, from: 10, to: 50, title: 'POWER %' },
  passes: { min: 1, max: 100, decimals: 0, from: 1, to: 5, title: 'PASSES' },
};

/** The range an axis starts with when it is switched to the parameter. */
export function defaultAxis(parameter: TestParameter): TestAxis {
  const info = PARAMETERS[parameter];
  return { parameter, from: info.from, to: info.to, steps: DEFAULT_TEST_STEPS };
}

/** Conservative for a CO2 cutter: low power, moderate speed, one pass. */
export const DEFAULT_MATERIAL_TEST_OPTIONS: MaterialTestOptions = {
  columns: defaultAxis('speed'),
  rows: defaultAxis('power'),
  cellSizeMm: 10,
  gapMm: 3,
  speedMmS: 20,
  maxPowerPct: 30,
  minPowerPct: null,
  passes: 1,
  labels: true,
  labelSpeedMmS: 100,
  labelPowerPct: 12,
};

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function roundTo(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

function clampParameter(parameter: TestParameter, value: number, fallback: number): number {
  const info = PARAMETERS[parameter];
  return roundTo(clamp(value, info.min, info.max, fallback), info.decimals);
}

/** Whole steps from 4 to 10; anything unusable becomes the default of 5. */
export function clampTestSteps(steps: number): number {
  return Math.round(clamp(steps, MIN_TEST_STEPS, MAX_TEST_STEPS, DEFAULT_TEST_STEPS));
}

function normalizeAxis(axis: TestAxis): TestAxis {
  const parameter = TEST_PARAMETERS.includes(axis.parameter) ? axis.parameter : 'speed';
  const info = PARAMETERS[parameter];
  return {
    parameter,
    from: clampParameter(parameter, axis.from, info.from),
    to: clampParameter(parameter, axis.to, info.to),
    steps: clampTestSteps(axis.steps),
  };
}

/** The options with every value brought into its allowed range. */
export function normalizeMaterialTestOptions(options: MaterialTestOptions): MaterialTestOptions {
  const d = DEFAULT_MATERIAL_TEST_OPTIONS;
  return {
    columns: normalizeAxis(options.columns),
    rows: normalizeAxis(options.rows),
    cellSizeMm: clamp(options.cellSizeMm, 3, 50, d.cellSizeMm),
    gapMm: clamp(options.gapMm, 0, 20, d.gapMm),
    speedMmS: clampParameter('speed', options.speedMmS, d.speedMmS),
    maxPowerPct: clampParameter('power', options.maxPowerPct, d.maxPowerPct),
    minPowerPct:
      options.minPowerPct === null || !Number.isFinite(options.minPowerPct)
        ? null
        : clampParameter('power', options.minPowerPct, 0),
    passes: clampParameter('passes', options.passes, d.passes),
    labels: options.labels,
    labelSpeedMmS: clampParameter('speed', options.labelSpeedMmS, d.labelSpeedMmS),
    labelPowerPct: clampParameter('power', options.labelPowerPct, d.labelPowerPct),
  };
}

/**
 * The values along an axis: evenly spaced from `from` to `to`, both included
 * (`from` may be the larger one). Speed and power are rounded to 0.1, passes
 * to whole numbers, so neighbouring values can come out equal.
 */
export function axisValues(axis: TestAxis): number[] {
  const { parameter, from, to, steps } = normalizeAxis(axis);
  const values: number[] = [];
  for (let i = 0; i < steps; i++) {
    values.push(clampParameter(parameter, from + ((to - from) * i) / (steps - 1), from));
  }
  return values;
}

/** A number as it is engraved: no needless decimals. */
export function formatTestValue(value: number): string {
  const text = String(roundTo(value, 1));
  return text === '-0' ? '0' : text;
}

/** One piece of engraved text and the bounding box of its strokes. */
export interface MaterialTestLabel {
  readonly kind: 'title' | 'column' | 'row';
  readonly text: string;
  readonly bounds: Bounds;
}

export interface MaterialTest {
  /** Labels first (they are engraved before anything is cut loose), then the cells row by row. */
  readonly shapes: Shape[];
  /** The cell squares only, row by row, each with its own settings. */
  readonly cells: Shape[];
  readonly columnValues: readonly number[];
  readonly rowValues: readonly number[];
  /** Bounding box of everything, labels included. Its top-left is the requested origin. */
  readonly bounds: Bounds;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly labels: readonly MaterialTestLabel[];
  /** Settings for the label layer, to apply when the shapes are added. */
  readonly layers: readonly LayerSetup[];
}

export interface MaterialTestPlacement {
  /** Where the top-left corner of the whole test goes. */
  readonly origin: Point;
  readonly nextShapeId: () => string;
  /** The one group every shape of the test belongs to. */
  readonly groupId: string;
}

/** Capital height of the labels: readable, but well inside one row of the grid. */
function labelHeight(pitchMm: number): number {
  return Math.min(4, 0.45 * pitchMm);
}

interface Drawn {
  readonly lines: Polyline[];
  readonly label: MaterialTestLabel;
}

/** The drawn text with the box its strokes occupy. */
function drawnLabel(kind: MaterialTestLabel['kind'], text: string, lines: Polyline[]): Drawn {
  let bounds: Bounds | null = null;
  for (const line of lines) bounds = unionBounds(bounds, boundsOfPoints(line.points));
  return { lines, label: { kind, text, bounds: bounds ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 } } };
}

function horizontalText(kind: MaterialTestLabel['kind'], text: string, topLeft: Point, heightMm: number): Drawn {
  return drawnLabel(kind, text, strokeText(text, topLeft, heightMm));
}

/**
 * Text turned a quarter turn counter-clockwise, reading upward from
 * `bottomLeft`, the way the labels of a vertical chart axis do. A rotation,
 * not a mirror image.
 */
function upwardText(kind: MaterialTestLabel['kind'], text: string, bottomLeft: Point, heightMm: number): Drawn {
  const lines = strokeText(text, { x: 0, y: 0 }, heightMm).map((line) => ({
    closed: false,
    points: line.points.map((p) => ({ x: bottomLeft.x + p.y, y: bottomLeft.y - p.x })),
  }));
  return drawnLabel(kind, text, lines);
}

/** The title in as few lines as fit the width, breaking only between its parts. */
function wrapTitle(parts: readonly string[], heightMm: number, maxWidthMm: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const part of parts) {
    const joined = line === '' ? part : `${line}  ${part}`;
    if (line !== '' && strokeTextWidth(joined, heightMm) > maxWidthMm) {
      lines.push(line);
      line = part;
    } else {
      line = joined;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

function titleParts(options: MaterialTestOptions): string[] {
  const onAxis = new Set<TestParameter>([options.columns.parameter, options.rows.parameter]);
  const parts = [
    `${PARAMETERS[options.columns.parameter].title} ACROSS`,
    `${PARAMETERS[options.rows.parameter].title} DOWN`,
  ];
  if (!onAxis.has('speed')) parts.push(`SPEED ${formatTestValue(options.speedMmS)} MM/S`);
  if (!onAxis.has('power')) parts.push(`POWER ${formatTestValue(options.maxPowerPct)} %`);
  if (!onAxis.has('passes')) parts.push(`PASSES ${formatTestValue(options.passes)}`);
  if (options.minPowerPct !== null) parts.push(`MIN POWER ${formatTestValue(options.minPowerPct)} %`);
  return parts;
}

/** Narrowest a title may be asked to fit, so a tiny grid does not shrink it to nothing. */
const MIN_TITLE_WIDTH_MM = 30;

function shift(bounds: Bounds, dx: number, dy: number): Bounds {
  return { minX: bounds.minX + dx, minY: bounds.minY + dy, maxX: bounds.maxX + dx, maxY: bounds.maxY + dy };
}

/** True when both axes vary the same setting: there is no such grid. */
export function axesConflict(options: MaterialTestOptions): boolean {
  return options.columns.parameter === options.rows.parameter;
}

/**
 * Builds the test: closed squares on the cell colour, each with its own cut
 * settings, and (when asked for) labels as open polylines on the label
 * colour: every column's value along the top, every row's down the left and
 * a title naming the axes and the fixed values. Everything is one group.
 *
 * Options are clamped first. Returns null when both axes use the same
 * parameter.
 */
export function buildMaterialTest(input: MaterialTestOptions, placement: MaterialTestPlacement): MaterialTest | null {
  const options = normalizeMaterialTestOptions(input);
  if (axesConflict(options)) return null;
  const columnValues = axisValues(options.columns);
  const rowValues = axisValues(options.rows);
  const cell = options.cellSizeMm;
  const pitch = cell + options.gapMm;
  const gridWidth = columnValues.length * pitch - options.gapMm;

  // Laid out from (0, 0) first, then moved so the real top-left is the origin.
  const drawn: Drawn[] = [];
  let gridX = 0;
  let gridY = 0;
  if (options.labels) {
    const height = labelHeight(pitch);
    const pad = Math.max(0.8, 0.5 * height);
    const columnTexts = columnValues.map(formatTestValue);
    const rowTexts = rowValues.map(formatTestValue);
    gridX = Math.max(...rowTexts.map((text) => strokeTextWidth(text, height))) + pad;

    // Column labels lie flat when they fit their column at a readable size; otherwise they stand upright.
    // Lying flat, neighbours stay a full character apart, or two numbers would read as one.
    const widestPerMm = Math.max(...columnTexts.map((text) => strokeTextWidth(text, 1)));
    const flatHeight = Math.min(height, pitch / (widestPerMm + GLYPH_ADVANCE / GLYPH_HEIGHT));
    const flat = flatHeight >= Math.max(1.2, 0.6 * height);
    const columnBand = flat ? flatHeight : widestPerMm * height;

    const parts = titleParts(options);
    const titleWidth = Math.max(gridX + gridWidth, MIN_TITLE_WIDTH_MM);
    const widestPart = Math.max(...parts.map((text) => strokeTextWidth(text, 1)));
    const titleHeight = Math.min(Math.max(1.5, Math.min(3, 0.75 * height)), titleWidth / widestPart);
    const titleLines = wrapTitle(parts, titleHeight, titleWidth);
    const lineStep = titleHeight * 1.6;
    titleLines.forEach((text, index) => {
      drawn.push(horizontalText('title', text, { x: 0, y: index * lineStep }, titleHeight));
    });
    const titleBottom = (titleLines.length - 1) * lineStep + titleHeight;
    gridY = titleBottom + pad + columnBand + pad;

    columnTexts.forEach((text, index) => {
      const centre = gridX + index * pitch + cell / 2;
      if (flat) {
        const width = strokeTextWidth(text, flatHeight);
        drawn.push(horizontalText('column', text, { x: centre - width / 2, y: gridY - pad - flatHeight }, flatHeight));
      } else {
        drawn.push(upwardText('column', text, { x: centre - height / 2, y: gridY - pad }, height));
      }
    });
    rowTexts.forEach((text, index) => {
      const width = strokeTextWidth(text, height);
      const top = gridY + index * pitch + (cell - height) / 2;
      drawn.push(horizontalText('row', text, { x: gridX - pad - width, y: top }, height));
    });
  }

  const squares: { points: Point[]; settings: ShapeCutSettings }[] = [];
  rowValues.forEach((rowValue, row) => {
    columnValues.forEach((columnValue, column) => {
      const value = (parameter: TestParameter, fixed: number) =>
        options.columns.parameter === parameter ? columnValue : options.rows.parameter === parameter ? rowValue : fixed;
      const maxPowerPct = value('power', options.maxPowerPct);
      const x = gridX + column * pitch;
      const y = gridY + row * pitch;
      squares.push({
        points: [
          { x, y },
          { x: x + cell, y },
          { x: x + cell, y: y + cell },
          { x, y: y + cell },
        ],
        settings: {
          speedMmS: value('speed', options.speedMmS),
          maxPowerPct,
          minPowerPct: options.minPowerPct === null ? maxPowerPct : Math.min(options.minPowerPct, maxPowerPct),
          passes: value('passes', options.passes),
        },
      });
    });
  });

  let ink: Bounds | null = null;
  for (const each of drawn) for (const line of each.lines) ink = unionBounds(ink, boundsOfPoints(line.points));
  for (const square of squares) ink = unionBounds(ink, boundsOfPoints(square.points));
  const dx = placement.origin.x - (ink?.minX ?? 0);
  const dy = placement.origin.y - (ink?.minY ?? 0);
  const move = (points: readonly Point[]) => points.map((p) => ({ x: p.x + dx, y: p.y + dy }));

  const groups = [placement.groupId];
  const labelShapes: Shape[] = drawn.flatMap((each) =>
    each.lines.map((line) => ({
      id: placement.nextShapeId(),
      color: MATERIAL_TEST_LABEL_COLOR,
      closed: false,
      points: move(line.points),
      groups,
    })),
  );
  const cells: Shape[] = squares.map((square) => ({
    id: placement.nextShapeId(),
    color: MATERIAL_TEST_CELL_COLOR,
    closed: true,
    points: move(square.points),
    groups,
    settings: square.settings,
  }));

  const bounds = shift(ink ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 }, dx, dy);
  return {
    shapes: [...labelShapes, ...cells],
    cells,
    columnValues,
    rowValues,
    bounds,
    widthMm: bounds.maxX - bounds.minX,
    heightMm: bounds.maxY - bounds.minY,
    labels: drawn.map((each) => ({ ...each.label, bounds: shift(each.label.bounds, dx, dy) })),
    layers: [
      {
        color: MATERIAL_TEST_LABEL_COLOR,
        patch: {
          speedMmS: options.labelSpeedMmS,
          maxPowerPct: options.labelPowerPct,
          minPowerPct: options.labelPowerPct,
          passes: 1,
        },
      },
    ],
  };
}
