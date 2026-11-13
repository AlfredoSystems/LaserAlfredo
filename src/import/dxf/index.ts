import { boundsOfPolylines } from '../../geometry/bounds';
import { DEFAULT_FLATTEN_TOLERANCE_MM } from '../../geometry/flatten';
import {
  cleanPolyline,
  DEFAULT_JOIN_TOLERANCE_MM,
  joinPolylines,
  removeDuplicatePolylines,
} from '../../geometry/join';
import type { Matrix } from '../../model/transform';
import { applyToPoints, compose, rotation, scaling, translation } from '../../model/transform';
import type { ColoredPolyline, ImportResult } from '../../model/types';
import type { ImportOptions } from '../options';
import { ACI_BYBLOCK, ACI_BYLAYER, aciToHex, DEFAULT_COLOR, trueColorToHex } from './color';
import type { EntityCommon, LocalPath } from './entities';
import {
  flattenArcEntity,
  flattenCircleEntity,
  flattenEllipseEntity,
  flattenLine,
  flattenLwPolyline,
  flattenPolyline,
  flattenSplineEntity,
  isPolylineMesh,
  readCommon,
  readInsert,
} from './entities';
import type { ParsedDxf, RawEntity } from './parse';
import { parseDxfText } from './parse';

/** Nested INSERTs deeper than this are dropped. */
const MAX_INSERT_DEPTH = 32;
/** Upper bound on emitted paths plus block placements, against runaway block arrays. */
const MAX_WORK = 2_000_000;
/** Only exactly repeated points and zero-length lines are removed before joining. */
const CLEAN_TOLERANCE_MM = 1e-6;
/** Entity X axis mirrored: the object coordinate system of an extrusion direction of (0, 0, -1). */
const MIRROR_X: Matrix = [-1, 0, 0, 1, 0, 0];

interface Unit {
  readonly name: string;
  readonly mm: number;
}

/** `$INSUNITS` codes. 0 (unitless) and a missing header are treated as millimetres. */
const UNITS: ReadonlyMap<number, Unit> = new Map<number, Unit>([
  [0, { name: 'unitless', mm: 1 }],
  [1, { name: 'inches', mm: 25.4 }],
  [2, { name: 'feet', mm: 304.8 }],
  [3, { name: 'miles', mm: 1609344 }],
  [4, { name: 'millimetres', mm: 1 }],
  [5, { name: 'centimetres', mm: 10 }],
  [6, { name: 'metres', mm: 1000 }],
  [7, { name: 'kilometres', mm: 1e6 }],
  [8, { name: 'microinches', mm: 2.54e-5 }],
  [9, { name: 'mils', mm: 0.0254 }],
  [10, { name: 'yards', mm: 914.4 }],
  [11, { name: 'angstroms', mm: 1e-7 }],
  [12, { name: 'nanometres', mm: 1e-6 }],
  [13, { name: 'microns', mm: 0.001 }],
  [14, { name: 'decimetres', mm: 100 }],
  [15, { name: 'decametres', mm: 10000 }],
  [16, { name: 'hectometres', mm: 100000 }],
  [21, { name: 'US survey feet', mm: 1200000 / 3937 }],
]);

function unitScale(insUnits: number | undefined, warnings: string[]): number {
  if (insUnits === undefined) return 1;
  const unit = UNITS.get(insUnits);
  if (unit === undefined) {
    warnings.push(`Unknown drawing units ($INSUNITS ${insUnits}); assumed millimetres.`);
    return 1;
  }
  if (unit.mm !== 1) {
    warnings.push(`Drawing units are ${unit.name} ($INSUNITS ${insUnits}); converted to mm (x${unit.mm}).`);
  }
  return unit.mm;
}

/** Largest factor by which the matrix stretches a length. */
function maxScale(m: Matrix): number {
  const sumSquares = m[0] * m[0] + m[1] * m[1] + m[2] * m[2] + m[3] * m[3];
  const det = m[0] * m[3] - m[1] * m[2];
  const spread = Math.sqrt(Math.max(0, sumSquares * sumSquares - 4 * det * det));
  return Math.sqrt((sumSquares + spread) / 2);
}

/** Colours an entity inside a block can inherit from the INSERT that placed it. */
interface ColorContext {
  /** What BYBLOCK resolves to. */
  readonly byBlock: string;
  /** Colour for BYLAYER entities on layer "0" inside a block (they take the INSERT's layer); null at top level. */
  readonly layerZero: string | null;
}

interface Notes {
  readonly skipped: Map<string, number>;
  readonly missingBlocks: Set<string>;
  readonly cyclicBlocks: Set<string>;
  paperSpace: number;
  tilted: number;
  tooDeep: boolean;
  overBudget: boolean;
}

function countSkipped(notes: Notes, label: string): void {
  notes.skipped.set(label, (notes.skipped.get(label) ?? 0) + 1);
}

/**
 * Flattens every entity (expanding INSERTs) into millimetre paths grouped by
 * colour. Coordinates are still Y-up here.
 */
function collectPaths(
  dxf: ParsedDxf,
  rootMatrix: Matrix,
  flattenToleranceMm: number,
  notes: Notes,
): Map<string, ColoredPolyline[]> {
  const layerColors = new Map<string, string>();
  for (const [name, layer] of dxf.layers) {
    layerColors.set(
      name,
      layer.trueColor !== undefined && Number.isFinite(layer.trueColor)
        ? trueColorToHex(layer.trueColor)
        : aciToHex(Math.abs(layer.aci ?? 7)),
    );
  }

  const layerColor = (layer: string, context: ColorContext): string => {
    if (context.layerZero !== null && layer === '0') return context.layerZero;
    return layerColors.get(layer.toUpperCase()) ?? DEFAULT_COLOR;
  };

  const resolveColor = (common: EntityCommon, context: ColorContext): string => {
    if (common.trueColor !== undefined) return trueColorToHex(common.trueColor);
    const aci = common.aci === undefined ? ACI_BYLAYER : Math.abs(common.aci);
    if (aci === ACI_BYBLOCK) return context.byBlock;
    if (aci === ACI_BYLAYER) return layerColor(common.layer, context);
    return aciToHex(aci);
  };

  const byColor = new Map<string, ColoredPolyline[]>();
  let work = 0;
  const spend = (): boolean => {
    if (work >= MAX_WORK) {
      notes.overBudget = true;
      return false;
    }
    work += 1;
    return true;
  };

  const emit = (paths: readonly LocalPath[], matrix: Matrix, color: string): void => {
    for (const path of paths) {
      if (path.points.length < 2 || !spend()) continue;
      let bucket = byColor.get(color);
      if (bucket === undefined) {
        bucket = [];
        byColor.set(color, bucket);
      }
      bucket.push({ points: applyToPoints(matrix, path.points), closed: path.closed, color });
    }
  };

  const activeBlocks = new Set<string>();

  const walk = (entities: readonly RawEntity[], matrix: Matrix, context: ColorContext, depth: number): void => {
    const scale = maxScale(matrix);
    if (!(scale > 0) || !Number.isFinite(scale)) return;
    // Curves are flattened before the matrix is applied, so the tolerance
    // shrinks by however much the matrix will magnify the error.
    const tolerance = flattenToleranceMm / scale;
    const mirroredMatrix = compose(matrix, MIRROR_X);

    for (const entity of entities) {
      if (notes.overBudget) return;
      const common = readCommon(entity);
      if (common.paperSpace) {
        notes.paperSpace += 1;
        continue;
      }
      // Arcs, circles, polylines and inserts are stored in the object
      // coordinate system; lines, ellipses and splines in world coordinates.
      const ocsMatrix = common.mirrored ? mirroredMatrix : matrix;

      switch (entity.type) {
        case 'LINE':
          emit(flattenLine(entity), matrix, resolveColor(common, context));
          break;
        case 'ARC':
          if (common.tilted) notes.tilted += 1;
          emit(flattenArcEntity(entity, tolerance), ocsMatrix, resolveColor(common, context));
          break;
        case 'CIRCLE':
          if (common.tilted) notes.tilted += 1;
          emit(flattenCircleEntity(entity, tolerance), ocsMatrix, resolveColor(common, context));
          break;
        case 'ELLIPSE':
          if (common.tilted) notes.tilted += 1;
          emit(flattenEllipseEntity(entity, common.mirrored, tolerance), matrix, resolveColor(common, context));
          break;
        case 'LWPOLYLINE':
          if (common.tilted) notes.tilted += 1;
          emit(flattenLwPolyline(entity, tolerance), ocsMatrix, resolveColor(common, context));
          break;
        case 'POLYLINE':
          if (isPolylineMesh(entity)) {
            countSkipped(notes, 'POLYLINE (3D mesh)');
            break;
          }
          if (common.tilted) notes.tilted += 1;
          emit(flattenPolyline(entity, tolerance), ocsMatrix, resolveColor(common, context));
          break;
        case 'SPLINE':
          emit(flattenSplineEntity(entity, tolerance), matrix, resolveColor(common, context));
          break;
        case 'INSERT': {
          const insert = readInsert(entity);
          const key = insert.blockName.toUpperCase();
          const block = dxf.blocks.get(key);
          if (block === undefined) {
            notes.missingBlocks.add(insert.blockName);
            break;
          }
          if (activeBlocks.has(key)) {
            notes.cyclicBlocks.add(block.name);
            break;
          }
          if (depth >= MAX_INSERT_DEPTH) {
            notes.tooDeep = true;
            break;
          }
          if (common.tilted) notes.tilted += 1;
          const childContext: ColorContext = {
            byBlock: resolveColor(common, context),
            layerZero: layerColor(common.layer, context),
          };
          // Block geometry: move the base point to the origin, scale, step to
          // the array cell, rotate, move to the insertion point.
          const scaled = compose(
            scaling(insert.scaleX, insert.scaleY),
            translation(-block.baseX, -block.baseY),
          );
          const placed = compose(
            ocsMatrix,
            compose(translation(insert.x, insert.y), rotation(insert.rotationRad)),
          );
          activeBlocks.add(key);
          for (let row = 0; row < insert.rows && !notes.overBudget; row++) {
            for (let column = 0; column < insert.columns; column++) {
              if (!spend()) break;
              const cell = compose(
                translation(column * insert.columnSpacing, row * insert.rowSpacing),
                scaled,
              );
              walk(block.entities, compose(placed, cell), childContext, depth + 1);
            }
          }
          activeBlocks.delete(key);
          break;
        }
        default:
          countSkipped(notes, entity.type);
          break;
      }
    }
  };

  walk(dxf.entities, rootMatrix, { byBlock: DEFAULT_COLOR, layerZero: null }, 0);
  return byColor;
}

/**
 * Removes exact repeats, drops duplicate paths and joins touching ends into
 * longer (ideally closed) paths. Each colour is handled on its own, so paths
 * are never joined across colours.
 */
function tidyPaths(byColor: ReadonlyMap<string, readonly ColoredPolyline[]>, joinToleranceMm: number): ColoredPolyline[] {
  const result: ColoredPolyline[] = [];
  for (const [color, paths] of byColor) {
    const cleaned: ColoredPolyline[] = [];
    for (const path of paths) {
      const points = cleanPolyline(path.points, path.closed, CLEAN_TOLERANCE_MM);
      if (points.length < 2) continue;
      cleaned.push({ points, closed: path.closed && points.length >= 3, color });
    }
    const unique = removeDuplicatePolylines(cleaned, joinToleranceMm);
    const joined = joinPolylines(unique, joinToleranceMm, (points, closed, source) => ({
      points,
      closed,
      color: source.color,
    }));
    for (const path of joined) result.push(path);
  }
  return result;
}

/**
 * The one place where DXF's Y-up becomes the document's Y-down. Mirrors about
 * the horizontal centre line of the whole drawing's bounding box
 * (y' = minY + maxY - y), so the bounding box stays where it was and the
 * drawing looks the same way up on screen as it does in CAD.
 */
function flipYToDocumentSpace(paths: readonly ColoredPolyline[]): ColoredPolyline[] {
  const bounds = boundsOfPolylines(paths);
  if (bounds === null) return paths.slice();
  const sum = bounds.minY + bounds.maxY;
  return paths.map((path) => ({
    points: path.points.map((p) => ({ x: p.x, y: sum - p.y })),
    closed: path.closed,
    color: path.color,
  }));
}

function quoteList(names: ReadonlySet<string>): string {
  return [...names].map((name) => `"${name}"`).join(', ');
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Imports ASCII DXF text as millimetre, Y-down paths. Throws only when the
 * text cannot be read as DXF at all; anything it has to skip is listed in
 * `warnings`.
 */
export function importDxf(text: string, options: ImportOptions = {}): ImportResult {
  const dxf = parseDxfText(text);
  const warnings: string[] = [];

  const scale = unitScale(dxf.insUnits, warnings);
  if (dxf.truncated) {
    warnings.push('The file ends without an EOF marker; it may be incomplete.');
  }
  const flattenToleranceMm = positiveOr(options.flattenToleranceMm, DEFAULT_FLATTEN_TOLERANCE_MM);
  const joinToleranceMm =
    options.joinToleranceMm !== undefined && Number.isFinite(options.joinToleranceMm) && options.joinToleranceMm >= 0
      ? options.joinToleranceMm
      : DEFAULT_JOIN_TOLERANCE_MM;

  const notes: Notes = {
    skipped: new Map<string, number>(),
    missingBlocks: new Set<string>(),
    cyclicBlocks: new Set<string>(),
    paperSpace: 0,
    tilted: 0,
    tooDeep: false,
    overBudget: false,
  };
  const byColor = collectPaths(dxf, scaling(scale, scale), flattenToleranceMm, notes);
  const paths = flipYToDocumentSpace(tidyPaths(byColor, joinToleranceMm));

  for (const [type, count] of notes.skipped) warnings.push(`Skipped ${count} ${type}`);
  if (notes.paperSpace > 0) warnings.push(`Skipped ${notes.paperSpace} paper-space entities`);
  if (notes.tilted > 0) {
    warnings.push(`${notes.tilted} entities drawn in a tilted 3D plane were imported as if drawn flat`);
  }
  if (notes.missingBlocks.size > 0) {
    warnings.push(`Skipped INSERTs of missing blocks: ${quoteList(notes.missingBlocks)}`);
  }
  if (notes.cyclicBlocks.size > 0) {
    warnings.push(`Skipped blocks that insert themselves: ${quoteList(notes.cyclicBlocks)}`);
  }
  if (notes.tooDeep) {
    warnings.push(`Skipped blocks nested more than ${MAX_INSERT_DEPTH} levels deep`);
  }
  if (notes.overBudget) {
    warnings.push(`The drawing is too large; import stopped after ${MAX_WORK} paths and block placements`);
  }
  if (paths.length === 0) warnings.push('The drawing contains no supported geometry.');

  return { paths, warnings };
}
