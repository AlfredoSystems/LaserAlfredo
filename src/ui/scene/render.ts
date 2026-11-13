import type { Bed } from '../../model/bed';
import { handlePosition, SCALE_HANDLES } from '../../model/handles';
import { applyToPoint, type Matrix } from '../../model/transform';
import type { Bounds, LaserDocument, Point, Shape } from '../../model/types';
import { toScreen, type View } from '../../model/view';

export const HANDLE_SIZE_PX = 8;
export const ROTATE_HANDLE_OFFSET_PX = 26;

const COLORS = {
  outside: '#23262b',
  bed: '#f6f6f3',
  bedBorder: '#6b7280',
  gridMinor: '#e4e5e1',
  gridMajor: '#c9cbc6',
  selection: '#1d6fe0',
  marqueeFill: 'rgba(29, 111, 224, 0.12)',
  axisLabel: '#8b93a0',
};

interface LayerPaths {
  readonly normal: Path2D;
  readonly selected: Path2D;
  hasNormal: boolean;
  hasSelected: boolean;
}

interface PathCache {
  readonly shapes: readonly Shape[];
  readonly selection: ReadonlySet<string>;
  readonly byColor: Map<string, LayerPaths>;
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

/** One Path2D per layer and selection state, rebuilt only when the document or selection changes. */
function layerPaths(shapes: readonly Shape[], selection: ReadonlySet<string>): Map<string, LayerPaths> {
  if (cache && cache.shapes === shapes && cache.selection === selection) return cache.byColor;
  const byColor = new Map<string, LayerPaths>();
  for (const shape of shapes) {
    let entry = byColor.get(shape.color);
    if (!entry) {
      entry = { normal: new Path2D(), selected: new Path2D(), hasNormal: false, hasSelected: false };
      byColor.set(shape.color, entry);
    }
    if (selection.has(shape.id)) {
      tracePath(entry.selected, shape);
      entry.hasSelected = true;
    } else {
      tracePath(entry.normal, shape);
      entry.hasNormal = true;
    }
  }
  cache = { shapes, selection, byColor };
  return byColor;
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

export interface RenderInput {
  readonly doc: LaserDocument;
  readonly selection: ReadonlySet<string>;
  readonly selectionBounds: Bounds | null;
  readonly view: View;
  readonly bed: Bed;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly dpr: number;
  /** Uncommitted transform of the selection while dragging. */
  readonly preview: Matrix | null;
  readonly marquee: { readonly a: Point; readonly b: Point } | null;
}

export function renderScene(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { doc, selection, view, dpr, preview } = input;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COLORS.outside;
  ctx.fillRect(0, 0, input.widthPx, input.heightPx);
  drawBed(ctx, view, input.bed);

  // Shapes are drawn in document space so cached paths survive pan and zoom.
  const paths = layerPaths(doc.shapes, selection);
  const enabled = new Map(doc.layers.map((layer) => [layer.color, layer]));
  ctx.lineJoin = 'round';
  for (const [color, entry] of paths) {
    const layer = enabled.get(color);
    const alpha = layer && !layer.enabled ? 0.3 : 1;
    const fill = layer?.mode === 'fill';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
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
