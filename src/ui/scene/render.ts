import type { Bed } from '../../model/bed';
import { isInScope, type GroupPath } from '../../model/groups';
import { handlePosition, SCALE_HANDLES } from '../../model/handles';
import { boundsOfShapes } from '../../model/selection';
import { applyToPoint, type Matrix } from '../../model/transform';
import type { Bounds, LaserDocument, Point, Shape } from '../../model/types';
import { toScreen, type View } from '../../model/view';
import type { PreviewSegment } from '../../toolpath/generate';

export const HANDLE_SIZE_PX = 8;
export const ROTATE_HANDLE_OFFSET_PX = 26;

/** Opacity of shapes outside the entered group, relative to their normal one. */
const DIMMED_ALPHA = 0.25;
/** How far the frame of the entered group sits outside its bounds. */
const SCOPE_FRAME_PAD_PX = 6;

const COLORS = {
  outside: '#23262b',
  bed: '#f6f6f3',
  bedBorder: '#6b7280',
  gridMinor: '#e4e5e1',
  gridMajor: '#c9cbc6',
  selection: '#1d6fe0',
  scope: '#7c5cd6',
  travel: 'rgba(214, 64, 64, 0.6)',
  pending: 'rgba(90, 96, 106, 0.28)',
  head: '#e03131',
  marqueeFill: 'rgba(29, 111, 224, 0.12)',
  offSheet: 'rgba(35, 38, 43, 0.2)',
  sheetBorder: '#1d6fe0',
  axisLabel: '#8b93a0',
};

interface LayerPaths {
  readonly normal: Path2D;
  readonly selected: Path2D;
  /** Shapes outside the entered group. */
  readonly dimmed: Path2D;
  hasNormal: boolean;
  hasSelected: boolean;
  hasDimmed: boolean;
}

interface PathCache {
  readonly shapes: readonly Shape[];
  readonly selection: ReadonlySet<string>;
  readonly scope: GroupPath;
  readonly byColor: Map<string, LayerPaths>;
  /** Bounds of the entered group; null at top level. */
  readonly scopeBounds: Bounds | null;
}

let cache: PathCache | null = null;

function tracePath(path: Path2D, shape: Shape): void {
  const first = shape.points[0];
  if (!first) return;
  path.moveTo(first.x, first.y);
  for (let i = 1; i < shape.points.length; i++) {
    const p = shape.points[i];
    if (p) path.lineTo(p.x, p.y);
  }
  if (shape.closed) path.closePath();
}

/** One Path2D per layer and state, rebuilt only when the document, selection or scope changes. */
function layerPaths(shapes: readonly Shape[], selection: ReadonlySet<string>, scope: GroupPath): PathCache {
  if (cache && cache.shapes === shapes && cache.selection === selection && cache.scope === scope) return cache;
  const byColor = new Map<string, LayerPaths>();
  const inside: Shape[] = [];
  for (const shape of shapes) {
    let entry = byColor.get(shape.color);
    if (!entry) {
      entry = {
        normal: new Path2D(),
        selected: new Path2D(),
        dimmed: new Path2D(),
        hasNormal: false,
        hasSelected: false,
        hasDimmed: false,
      };
      byColor.set(shape.color, entry);
    }
    const reachable = isInScope(shape, scope);
    if (reachable && scope.length > 0) inside.push(shape);
    if (selection.has(shape.id)) {
      tracePath(entry.selected, shape);
      entry.hasSelected = true;
    } else if (reachable) {
      tracePath(entry.normal, shape);
      entry.hasNormal = true;
    } else {
      tracePath(entry.dimmed, shape);
      entry.hasDimmed = true;
    }
  }
  cache = { shapes, selection, scope, byColor, scopeBounds: boundsOfShapes(inside) };
  return cache;
}

function gridStepMm(scale: number): number {
  // Smallest 1/2/5 step that stays at least ~8 px apart.
  const steps = [1, 5, 10, 50, 100, 500];
  for (const step of steps) if (step * scale >= 8) return step;
  return 1000;
}

function drawBed(ctx: CanvasRenderingContext2D, view: View, bed: Bed): void {
  const topLeft = toScreen(view, { x: 0, y: 0 });
  const w = bed.widthMm * view.scale;
  const h = bed.heightMm * view.scale;
  ctx.fillStyle = COLORS.bed;
  ctx.fillRect(topLeft.x, topLeft.y, w, h);

  const minor = gridStepMm(view.scale);
  const major = minor * (minor === 5 || minor === 50 || minor === 500 ? 2 : 10);
  const drawLines = (step: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = step; x < bed.widthMm; x += step) {
      const sx = Math.round(topLeft.x + x * view.scale) + 0.5;
      ctx.moveTo(sx, topLeft.y);
      ctx.lineTo(sx, topLeft.y + h);
    }
    for (let y = step; y < bed.heightMm; y += step) {
      const sy = Math.round(topLeft.y + y * view.scale) + 0.5;
      ctx.moveTo(topLeft.x, sy);
      ctx.lineTo(topLeft.x + w, sy);
    }
    ctx.stroke();
  };
  if (minor <= bed.widthMm) drawLines(minor, COLORS.gridMinor);
  if (major <= bed.widthMm) drawLines(major, COLORS.gridMajor);

  ctx.strokeStyle = COLORS.bedBorder;
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(topLeft.x) + 0.5, Math.round(topLeft.y) + 0.5, Math.round(w), Math.round(h));

  ctx.fillStyle = COLORS.axisLabel;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'bottom';
  ctx.fillText('0,0', topLeft.x + 2, topLeft.y - 3);
  ctx.textAlign = 'right';
  ctx.fillText(`${bed.widthMm} × ${bed.heightMm} mm`, topLeft.x + w - 2, topLeft.y - 3);
  ctx.textAlign = 'left';
}

/** Screen position of the rotate handle for an (untransformed) selection box. */
export function rotateHandleScreen(view: View, bounds: Bounds): Point {
  const top = toScreen(view, { x: (bounds.minX + bounds.maxX) / 2, y: bounds.minY });
  return { x: top.x, y: top.y - ROTATE_HANDLE_OFFSET_PX };
}

export interface JobPreview {
  readonly segments: readonly PreviewSegment[];
  /** Colour of each job layer, indexed like `PreviewSegment.layer`. */
  readonly colors: readonly string[];
  readonly fraction: number;
}

/** Draws the job as the machine will run it: cuts so far, travel moves, and the head. */
function drawPreview(ctx: CanvasRenderingContext2D, view: View, dpr: number, preview: JobPreview): void {
  const { segments } = preview;
  const last = segments[segments.length - 1];
  if (!last) return;
  const limit = last.endMm * preview.fraction;
  ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.offsetX, dpr * view.offsetY);
  ctx.lineJoin = 'round';

  // Index of the first segment that is not fully done.
  let lo = 0;
  let hi = segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const segment = segments[mid];
    if (segment && segment.endMm <= limit) lo = mid + 1;
    else hi = mid;
  }
  const done = lo;
  const current = segments[done];
  let head: Point = { x: last.bx, y: last.by };
  let partialLayer: number | null = null;
  if (current) {
    const length = Math.hypot(current.bx - current.ax, current.by - current.ay);
    const t = length > 0 ? Math.min(1, Math.max(0, 1 - (current.endMm - limit) / length)) : 0;
    head = { x: current.ax + (current.bx - current.ax) * t, y: current.ay + (current.by - current.ay) * t };
    partialLayer = current.layer;
  }

  /** Traces segments [from, to) that are travel moves (-1), one layer's cuts, or any cut. */
  const trace = (from: number, to: number, layer: number | 'cuts', withPartial: boolean) => {
    ctx.beginPath();
    let px = Number.NaN;
    let py = Number.NaN;
    for (let i = from; i < to; i++) {
      const s = segments[i];
      if (!s || (layer === 'cuts' ? s.layer < 0 : s.layer !== layer)) continue;
      if (s.ax !== px || s.ay !== py) ctx.moveTo(s.ax, s.ay);
      ctx.lineTo(s.bx, s.by);
      px = s.bx;
      py = s.by;
    }
    if (withPartial && current && partialLayer === layer) {
      if (current.ax !== px || current.ay !== py) ctx.moveTo(current.ax, current.ay);
      ctx.lineTo(head.x, head.y);
    }
  };

  // Cuts still to come, faint.
  ctx.setLineDash([]);
  ctx.lineWidth = 1 / view.scale;
  ctx.strokeStyle = COLORS.pending;
  trace(done, segments.length, 'cuts', false);
  ctx.stroke();

  // Travel moves so far.
  ctx.strokeStyle = COLORS.travel;
  ctx.setLineDash([4 / view.scale, 3 / view.scale]);
  trace(0, done, -1, true);
  ctx.stroke();

  // Cuts so far, in layer colours.
  ctx.setLineDash([]);
  ctx.lineWidth = 1.5 / view.scale;
  preview.colors.forEach((color, layer) => {
    ctx.strokeStyle = color;
    trace(0, done, layer, true);
    ctx.stroke();
  });

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const p = toScreen(view, head);
  ctx.fillStyle = COLORS.head;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
  ctx.fill();
}

/** A nesting result on show: the placed shapes of one sheet, in bed coordinates. */
export interface NestPreviewInput {
  /** Must keep its identity while the layout is unchanged; the paths are cached on it. */
  readonly shapes: readonly Shape[];
  readonly sheetWidthMm: number;
  readonly sheetHeightMm: number;
  readonly marginMm: number;
}

let nestCache: { readonly shapes: readonly Shape[]; readonly byColor: Map<string, Path2D> } | null = null;

/** One Path2D per layer colour, rebuilt only when a different layout arrives. */
function nestPaths(shapes: readonly Shape[]): Map<string, Path2D> {
  if (nestCache && nestCache.shapes === shapes) return nestCache.byColor;
  const byColor = new Map<string, Path2D>();
  for (const shape of shapes) {
    let path = byColor.get(shape.color);
    if (!path) {
      path = new Path2D();
      byColor.set(shape.color, path);
    }
    tracePath(path, shape);
  }
  nestCache = { shapes, byColor };
  return byColor;
}

/** Draws the nested sheet over the faded document. The sheet's top-left corner is the bed's. */
function drawNestPreview(
  ctx: CanvasRenderingContext2D,
  input: RenderInput,
  nest: NestPreviewInput,
  docPaths: Map<string, LayerPaths>,
): void {
  const { view, dpr, bed } = input;
  const toDocumentSpace = () =>
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.offsetX, dpr * view.offsetY);
  const layers = new Map(input.doc.layers.map((layer) => [layer.color, layer]));
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);

  // The document's own shapes, faint and without selection marks.
  toDocumentSpace();
  ctx.lineWidth = 1 / view.scale;
  ctx.globalAlpha = 0.18;
  for (const [color, entry] of docPaths) {
    ctx.strokeStyle = color;
    if (entry.hasNormal) ctx.stroke(entry.normal);
    if (entry.hasSelected) ctx.stroke(entry.selected);
    if (entry.hasDimmed) ctx.stroke(entry.dimmed);
  }
  ctx.globalAlpha = 1;

  // Shade the part of the bed that is not sheet, then outline the sheet.
  const w = Math.min(nest.sheetWidthMm, bed.widthMm);
  const h = Math.min(nest.sheetHeightMm, bed.heightMm);
  const smaller = w < bed.widthMm || h < bed.heightMm;
  if (smaller) {
    ctx.fillStyle = COLORS.offSheet;
    ctx.fillRect(w, 0, bed.widthMm - w, h);
    ctx.fillRect(0, h, bed.widthMm, bed.heightMm - h);
    ctx.strokeStyle = COLORS.sheetBorder;
    ctx.lineWidth = 1.5 / view.scale;
    ctx.strokeRect(0, 0, w, h);
  }
  const margin = nest.marginMm;
  if (margin > 0 && w > 2 * margin && h > 2 * margin) {
    ctx.strokeStyle = COLORS.sheetBorder;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1 / view.scale;
    ctx.setLineDash([5 / view.scale, 4 / view.scale]);
    ctx.strokeRect(margin, margin, w - 2 * margin, h - 2 * margin);
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  ctx.lineWidth = 1.25 / view.scale;
  for (const [color, path] of nestPaths(nest.shapes)) {
    const layer = layers.get(color);
    const alpha = layer && !layer.enabled ? 0.3 : 1;
    ctx.strokeStyle = color;
    if (layer?.mode === 'fill') {
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha * 0.25;
      ctx.fill(path, 'evenodd');
    }
    ctx.globalAlpha = alpha;
    ctx.stroke(path);
  }
  ctx.globalAlpha = 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

export interface RenderInput {
  readonly doc: LaserDocument;
  readonly selection: ReadonlySet<string>;
  readonly selectionBounds: Bounds | null;
  /** The entered group path; shapes outside it are drawn dimmed. Must keep its identity while unchanged. */
  readonly scope: GroupPath;
  readonly view: View;
  readonly bed: Bed;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly dpr: number;
  /** Uncommitted transform of the selection while dragging. */
  readonly preview: Matrix | null;
  readonly marquee: { readonly a: Point; readonly b: Point } | null;
  /** When set, the job preview is drawn instead of the editable shapes. */
  readonly jobPreview: JobPreview | null;
  /** When set (and there is no job preview), the nested sheet is drawn over the faded shapes. */
  readonly nestPreview: NestPreviewInput | null;
}

export function renderScene(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { doc, selection, view, dpr, preview } = input;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COLORS.outside;
  ctx.fillRect(0, 0, input.widthPx, input.heightPx);
  drawBed(ctx, view, input.bed);
  if (input.jobPreview) {
    drawPreview(ctx, view, dpr, input.jobPreview);
    return;
  }

  // Shapes are drawn in document space so cached paths survive pan and zoom.
  const { byColor: paths, scopeBounds } = layerPaths(doc.shapes, selection, input.scope);
  if (input.nestPreview) {
    drawNestPreview(ctx, input, input.nestPreview, paths);
    return;
  }
  const enabled = new Map(doc.layers.map((layer) => [layer.color, layer]));
  ctx.lineJoin = 'round';
  for (const [color, entry] of paths) {
    const layer = enabled.get(color);
    const alpha = layer && !layer.enabled ? 0.3 : 1;
    const fill = layer?.mode === 'fill';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    if (entry.hasDimmed) {
      ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.offsetX, dpr * view.offsetY);
      ctx.lineWidth = 1 / view.scale;
      ctx.setLineDash([]);
      ctx.globalAlpha = alpha * DIMMED_ALPHA;
      ctx.stroke(entry.dimmed);
    }
    if (entry.hasNormal) {
      ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.offsetX, dpr * view.offsetY);
      ctx.lineWidth = 1.25 / view.scale;
      ctx.setLineDash([]);
      if (fill) {
        ctx.globalAlpha = alpha * 0.25;
        ctx.fill(entry.normal, 'evenodd');
      }
      ctx.globalAlpha = alpha;
      ctx.stroke(entry.normal);
    }
    if (entry.hasSelected) {
      ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.offsetX, dpr * view.offsetY);
      let stretch = 1;
      if (preview) {
        ctx.transform(preview[0], preview[1], preview[2], preview[3], preview[4], preview[5]);
        stretch = Math.sqrt(Math.abs(preview[0] * preview[3] - preview[1] * preview[2])) || 1;
      }
      const px = 1 / (view.scale * stretch);
      ctx.lineWidth = 1.75 * px;
      ctx.setLineDash([6 * px, 4 * px]);
      if (fill) {
        ctx.globalAlpha = alpha * 0.25;
        ctx.fill(entry.selected, 'evenodd');
      }
      ctx.globalAlpha = alpha;
      ctx.stroke(entry.selected);
    }
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // The entered group: a dashed frame a little outside its bounds.
  if (scopeBounds) {
    const a = toScreen(view, { x: scopeBounds.minX, y: scopeBounds.minY });
    const b = toScreen(view, { x: scopeBounds.maxX, y: scopeBounds.maxY });
    const pad = SCOPE_FRAME_PAD_PX;
    ctx.strokeStyle = COLORS.scope;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([7, 4]);
    ctx.strokeRect(Math.round(a.x - pad) + 0.5, Math.round(a.y - pad) + 0.5, Math.round(b.x - a.x + 2 * pad), Math.round(b.y - a.y + 2 * pad));
    ctx.setLineDash([]);
  }

  const bounds = input.selectionBounds;
  if (bounds) {
    const corners: Point[] = [
      { x: bounds.minX, y: bounds.minY },
      { x: bounds.maxX, y: bounds.minY },
      { x: bounds.maxX, y: bounds.maxY },
      { x: bounds.minX, y: bounds.maxY },
    ].map((p) => toScreen(view, preview ? applyToPoint(preview, p) : p));
    ctx.strokeStyle = COLORS.selection;
    ctx.lineWidth = 1;
    ctx.beginPath();
    corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();

    if (!preview) {
      const half = HANDLE_SIZE_PX / 2;
      ctx.fillStyle = '#ffffff';
      for (const handle of SCALE_HANDLES) {
        const p = toScreen(view, handlePosition(bounds, handle));
        ctx.fillRect(p.x - half, p.y - half, HANDLE_SIZE_PX, HANDLE_SIZE_PX);
        ctx.strokeRect(p.x - half + 0.5, p.y - half + 0.5, HANDLE_SIZE_PX - 1, HANDLE_SIZE_PX - 1);
      }
      const rotate = rotateHandleScreen(view, bounds);
      ctx.beginPath();
      ctx.moveTo(rotate.x, rotate.y);
      ctx.lineTo(rotate.x, rotate.y + ROTATE_HANDLE_OFFSET_PX);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(rotate.x, rotate.y, half + 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  if (input.marquee) {
    const a = toScreen(view, input.marquee.a);
    const b = toScreen(view, input.marquee.b);
    const crossing = b.x < a.x;
    ctx.fillStyle = COLORS.marqueeFill;
    ctx.strokeStyle = COLORS.selection;
    ctx.lineWidth = 1;
    ctx.setLineDash(crossing ? [5, 4] : []);
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y);
    ctx.setLineDash([]);
  }
}
