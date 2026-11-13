import { create } from 'zustand';
import { boundsContainsBounds } from '../geometry/bounds';
import { importFile } from '../import';
import { HL1060_BED } from '../model/bed';
import {
  addShapes,
  EMPTY_DOCUMENT,
  removeShapes,
  setShapesColor,
  shapesFromPaths,
  transformShapes,
  updateLayer,
  type LayerPatch,
} from '../model/document';
import { boundsOfShapes } from '../model/selection';
import { applyToPoints, translation, type Matrix } from '../model/transform';
import type { Bounds, LaserDocument, Point } from '../model/types';

const HISTORY_LIMIT = 100;
const EMPTY_SELECTION: ReadonlySet<string> = new Set();

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `s${idCounter}`;
}

export interface Notice {
  readonly kind: 'info' | 'error';
  readonly text: string;
}

export interface AppState {
  readonly doc: LaserDocument;
  readonly selection: ReadonlySet<string>;
  readonly past: readonly LaserDocument[];
  readonly future: readonly LaserDocument[];
  readonly joinToleranceMm: number;
  readonly cursor: Point | null;
  readonly zoom: number;
  readonly notice: Notice | null;
  /** Bumped to ask the canvas to fit `fitTarget` (or the bed when null). */
  readonly fitRequest: number;
  readonly fitTarget: Bounds | null;

  importText(fileName: string, text: string): void;
  select(ids: Iterable<string>): void;
  toggleSelect(id: string): void;
  selectAll(): void;
  selectLayer(color: string): void;
  clearSelection(): void;
  transformSelection(m: Matrix): void;
  deleteSelection(): void;
  setSelectionColor(color: string): void;
  patchLayer(color: string, patch: LayerPatch): void;
  undo(): void;
  redo(): void;
  setJoinTolerance(mm: number): void;
  setCursor(p: Point | null): void;
  setZoom(scale: number): void;
  setNotice(notice: Notice | null): void;
  requestFit(target: 'bed' | 'selection' | 'all'): void;
}

const BED_BOUNDS: Bounds = { minX: 0, minY: 0, maxX: HL1060_BED.widthMm, maxY: HL1060_BED.heightMm };

export const useAppStore = create<AppState>((set, get) => {
  /** Replaces the document and records the old one for undo. */
  const commit = (doc: LaserDocument, extra: Partial<AppState> = {}) => {
    const state = get();
    if (doc === state.doc) {
      if (Object.keys(extra).length > 0) set(extra);
      return;
    }
    set({
      doc,
      past: [...state.past, state.doc].slice(-HISTORY_LIMIT),
      future: [],
      ...extra,
    });
  };

  const liveSelection = (doc: LaserDocument, selection: ReadonlySet<string>): ReadonlySet<string> => {
    if (selection.size === 0) return EMPTY_SELECTION;
    const ids = new Set<string>();
    for (const shape of doc.shapes) if (selection.has(shape.id)) ids.add(shape.id);
    return ids.size === selection.size ? selection : ids;
  };

  return {
    doc: EMPTY_DOCUMENT,
    selection: EMPTY_SELECTION,
    past: [],
    future: [],
    joinToleranceMm: 0.01,
    cursor: null,
    zoom: 1,
    notice: null,
    fitRequest: 0,
    fitTarget: null,

    importText(fileName, text) {
      try {
        const result = importFile(fileName, text, { joinToleranceMm: get().joinToleranceMm });
        let shapes = shapesFromPaths(result.paths, nextId);
        if (shapes.length === 0) {
          const detail = result.warnings.length > 0 ? ` (${result.warnings.join('; ')})` : '';
          set({ notice: { kind: 'error', text: `${fileName}: nothing to import${detail}` } });
          return;
        }
        // Keep the file's own position when it already sits on the bed,
        // otherwise park it at the top-left corner.
        const bounds = boundsOfShapes(shapes);
        if (bounds && !boundsContainsBounds(BED_BOUNDS, bounds)) {
          const m = translation(-bounds.minX, -bounds.minY);
          shapes = shapes.map((shape) => ({ ...shape, points: applyToPoints(m, shape.points) }));
        }
        const placed = boundsOfShapes(shapes);
        const closed = shapes.filter((shape) => shape.closed).length;
        const warnings = result.warnings.length > 0 ? ` — ${result.warnings.join('; ')}` : '';
        const oversize = placed && !boundsContainsBounds(BED_BOUNDS, placed) ? ' — larger than the bed' : '';
        commit(addShapes(get().doc, shapes), {
          selection: new Set(shapes.map((shape) => shape.id)),
          notice: {
            kind: oversize ? 'error' : 'info',
            text: `${fileName}: ${shapes.length} ${shapes.length === 1 ? 'shape' : 'shapes'} (${closed} closed)${oversize}${warnings}`,
          },
          fitRequest: get().fitRequest + 1,
          fitTarget: placed && oversize ? placed : null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({ notice: { kind: 'error', text: `${fileName}: import failed — ${message}` } });
      }
    },

    select(ids) {
      const next = new Set(ids);
      set({ selection: next.size === 0 ? EMPTY_SELECTION : next });
    },
    toggleSelect(id) {
      const next = new Set(get().selection);
      if (!next.delete(id)) next.add(id);
      set({ selection: next.size === 0 ? EMPTY_SELECTION : next });
    },
    selectAll() {
      set({ selection: new Set(get().doc.shapes.map((shape) => shape.id)) });
    },
    selectLayer(color) {
      const ids = get()
        .doc.shapes.filter((shape) => shape.color === color)
        .map((shape) => shape.id);
      set({ selection: new Set(ids) });
    },
    clearSelection() {
      if (get().selection.size > 0) set({ selection: EMPTY_SELECTION });
    },

    transformSelection(m) {
      const { doc, selection } = get();
      if (!m.every((value) => Number.isFinite(value))) return;
      commit(transformShapes(doc, selection, m));
    },
    deleteSelection() {
      const { doc, selection } = get();
      commit(removeShapes(doc, selection), { selection: EMPTY_SELECTION });
    },
    setSelectionColor(color) {
      const { doc, selection } = get();
      commit(setShapesColor(doc, selection, color));
    },
    patchLayer(color, patch) {
      commit(updateLayer(get().doc, color, patch));
    },

    undo() {
      const { past, future, doc, selection } = get();
      const previous = past[past.length - 1];
      if (!previous) return;
      set({
        doc: previous,
        past: past.slice(0, -1),
        future: [doc, ...future],
        selection: liveSelection(previous, selection),
      });
    },
    redo() {
      const { past, future, doc, selection } = get();
      const next = future[0];
      if (!next) return;
      set({
        doc: next,
        past: [...past, doc],
        future: future.slice(1),
        selection: liveSelection(next, selection),
      });
    },

    setJoinTolerance(mm) {
      if (Number.isFinite(mm) && mm >= 0 && mm <= 10) set({ joinToleranceMm: mm });
    },
    setCursor(p) {
      set({ cursor: p });
    },
    setZoom(scale) {
      if (scale !== get().zoom) set({ zoom: scale });
    },
    setNotice(notice) {
      set({ notice });
    },
    requestFit(target) {
      const { doc, selection, fitRequest } = get();
      const fitTarget =
        target === 'bed'
          ? null
          : target === 'selection'
            ? boundsOfShapes(doc.shapes, selection)
            : boundsOfShapes(doc.shapes);
      set({ fitRequest: fitRequest + 1, fitTarget });
    },
  };
});

export { BED_BOUNDS };
