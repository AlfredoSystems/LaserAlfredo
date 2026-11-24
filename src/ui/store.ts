import { create } from 'zustand';
import { boundsContainsBounds } from '../geometry/bounds';
import { importFile } from '../import';
import { HL1060_BED } from '../model/bed';
import { copyShapes, PASTE_OFFSET_MM, pasteShapes, type PasteTarget } from '../model/clipboard';
import {
  addShapes,
  EMPTY_DOCUMENT,
  nearestPaletteColor,
  normalizeColor,
  removeShapes,
  setShapesColor,
  shapesFromPaths,
  transformShapes,
  updateLayer,
  type GroupedPath,
  type LayerPatch,
} from '../model/document';
import {
  existingScope,
  expandToUnits,
  groupShapes,
  isInScope,
  remapGroupIds,
  scopeEntering,
  scopeShapeIds,
  TOP_LEVEL,
  ungroupShapes,
  unitOf,
  unitsInRect,
  type GroupPath,
} from '../model/groups';
import { boundsOfShapes } from '../model/selection';
import { applyToPoints, translation, type Matrix } from '../model/transform';
import type { Bounds, LaserDocument, Point, Shape } from '../model/types';

const HISTORY_LIMIT = 100;
const EMPTY_SELECTION: ReadonlySet<string> = new Set();

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `s${idCounter}`;
}

let groupCounter = 0;
function nextGroupId(): string {
  groupCounter += 1;
  return `g${groupCounter}`;
}

// Where the next paste goes. Kept outside the store: none of it is for rendering.
/** Pastes without a target point since the last copy; each one steps further from the original. */
let offsetPastes = 0;
/** The point of the last paste at the cursor, and how often it has been repeated there. */
let cursorPaste: { readonly at: Point; repeats: number } | null = null;

export interface Notice {
  readonly kind: 'info' | 'error';
  readonly text: string;
}

export interface AppState {
  readonly doc: LaserDocument;
  readonly selection: ReadonlySet<string>;
  /** The groups the user has entered, outermost first. Empty at top level. */
  readonly scope: GroupPath;
  /** The shapes last copied or cut, with group paths relative to where they were copied. */
  readonly clipboard: readonly Shape[];
  readonly past: readonly LaserDocument[];
  readonly future: readonly LaserDocument[];
  readonly joinToleranceMm: number;
  /** Layer colour that imports land on, unless `keepFileColors` is set. */
  readonly activeColor: string;
  /** Keep the file's colours (snapped to the palette) instead of using the active layer. */
  readonly keepFileColors: boolean;
  readonly cursor: Point | null;
  readonly zoom: number;
  readonly notice: Notice | null;
  /** Bumped to ask the canvas to fit `fitTarget` (or the bed when null). */
  readonly fitRequest: number;
  readonly fitTarget: Bounds | null;

  importText(fileName: string, text: string): void;
  select(ids: Iterable<string>): void;
  /** Selects the unit (the shape, or its whole group in the current scope) the shape belongs to. */
  selectUnit(shapeId: string): void;
  /** Adds the shape's unit to the selection, or takes it out when all of it is selected. */
  toggleUnit(shapeId: string): void;
  /** Marquee selection of whole units in the current scope. */
  selectInRect(rect: Bounds, mode: 'enclose' | 'cross', additive: boolean): void;
  /** Selects everything reachable in the current scope. */
  selectAll(): void;
  /** Selects exactly the shapes of one colour (in the current scope), whatever their groups. */
  selectLayer(color: string): void;
  clearSelection(): void;
  /** One new group of the selected units. */
  groupSelection(): void;
  /** Dissolves the selected groups, one level. */
  ungroupSelection(): void;
  /** Goes one level into the group the shape is in and selects the shape's unit there. */
  enterGroup(shapeId: string): void;
  /** Goes one level out and selects the group that was left. */
  leaveGroup(): void;
  /** Goes back to top level. The selection is kept. */
  leaveToTop(): void;
  copySelection(): void;
  /** Copy and delete as one undo step. */
  cutSelection(): void;
  /**
   * Pastes the clipboard into the current scope: centred on `at`, or a step
   * away from the copied shapes when there is no point. The paste is selected.
   */
  paste(at: Point | null): void;
  /** Copies the selection a step away without touching the clipboard. */
  duplicateSelection(): void;
  transformSelection(m: Matrix): void;
  deleteSelection(): void;
  /**
   * Removes the shapes with the given ids and adds the paths as new shapes,
   * as one undo step. The new shapes become the selection; returns their ids.
   * Groups among the paths are kept, under fresh group ids.
   */
  replaceShapes(removeIds: Iterable<string>, paths: readonly GroupedPath[]): readonly string[];
  setSelectionColor(color: string): void;
  patchLayer(color: string, patch: LayerPatch): void;
  undo(): void;
  redo(): void;
  setJoinTolerance(mm: number): void;
  setActiveColor(color: string): void;
  setKeepFileColors(keep: boolean): void;
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
      // An entered group that is gone falls back to the deepest level left.
      scope: existingScope(doc.shapes, extra.scope ?? state.scope),
    });
  };

  /** Adds the pasted copies to the current scope as one undo step and selects them. */
  const pasteInto = (copied: readonly Shape[], target: PasteTarget) => {
    const shapes = pasteShapes(copied, { scope: get().scope, target, nextShapeId: nextId, nextGroupId });
    if (shapes.length === 0) return;
    commit(addShapes(get().doc, shapes), { selection: new Set(shapes.map((shape) => shape.id)) });
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
    scope: TOP_LEVEL,
    clipboard: [],
    past: [],
    future: [],
    joinToleranceMm: 0.01,
    activeColor: '#000000',
    keepFileColors: false,
    cursor: null,
    zoom: 1,
    notice: null,
    fitRequest: 0,
    fitTarget: null,

    importText(fileName, text) {
      try {
        const result = importFile(fileName, text, { joinToleranceMm: get().joinToleranceMm });
        const { activeColor, keepFileColors } = get();
        const paths = result.paths.map((path) => ({
          ...path,
          color: keepFileColors ? nearestPaletteColor(path.color) : activeColor,
        }));
        let shapes = shapesFromPaths(paths, nextId);
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
        // A file with several shapes comes in as one group, at top level.
        if (shapes.length > 1) {
          const groups = [nextGroupId()];
          shapes = shapes.map((shape) => ({ ...shape, groups }));
        }
        const placed = boundsOfShapes(shapes);
        const closed = shapes.filter((shape) => shape.closed).length;
        const warnings = result.warnings.length > 0 ? ` — ${result.warnings.join('; ')}` : '';
        const oversize = placed && !boundsContainsBounds(BED_BOUNDS, placed) ? ' — larger than the bed' : '';
        commit(addShapes(get().doc, shapes), {
          selection: new Set(shapes.map((shape) => shape.id)),
          scope: TOP_LEVEL,
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
    selectUnit(shapeId) {
      const { doc, scope } = get();
      const ids = unitOf(doc.shapes, shapeId, scope);
      set({ selection: ids.length === 0 ? EMPTY_SELECTION : new Set(ids) });
    },
    toggleUnit(shapeId) {
      const { doc, scope, selection } = get();
      const ids = unitOf(doc.shapes, shapeId, scope);
      if (ids.length === 0) return;
      const next = new Set(selection);
      if (ids.every((id) => next.has(id))) for (const id of ids) next.delete(id);
      else for (const id of ids) next.add(id);
      set({ selection: next.size === 0 ? EMPTY_SELECTION : next });
    },
    selectInRect(rect, mode, additive) {
      const { doc, scope, selection } = get();
      const ids = unitsInRect(doc.shapes, rect, mode, scope);
      const next = new Set(additive ? [...selection, ...ids] : ids);
      set({ selection: next.size === 0 ? EMPTY_SELECTION : next });
    },
    selectAll() {
      const { doc, scope } = get();
      set({ selection: new Set(scopeShapeIds(doc.shapes, scope)) });
    },
    selectLayer(color) {
      const { doc, scope } = get();
      const ids = doc.shapes.filter((shape) => shape.color === color && isInScope(shape, scope)).map((shape) => shape.id);
      set({ selection: new Set(ids), activeColor: color });
    },
    clearSelection() {
      if (get().selection.size > 0) set({ selection: EMPTY_SELECTION });
    },

    groupSelection() {
      const { doc, selection, scope } = get();
      const next = groupShapes(doc, selection, scope, nextGroupId());
      if (next === doc) return;
      // Grouping takes whole units, so the selection grows to match.
      commit(next, { selection: expandToUnits(doc.shapes, selection, scope) });
    },
    ungroupSelection() {
      const { doc, selection, scope } = get();
      commit(ungroupShapes(doc, selection, scope));
    },
    enterGroup(shapeId) {
      const { doc, scope } = get();
      const inner = scopeEntering(doc.shapes, shapeId, scope);
      if (!inner) return;
      set({ scope: inner, selection: new Set(unitOf(doc.shapes, shapeId, inner)) });
    },
    leaveGroup() {
      const { doc, scope } = get();
      if (scope.length === 0) return;
      set({ scope: scope.slice(0, -1), selection: new Set(scopeShapeIds(doc.shapes, scope)) });
    },
    leaveToTop() {
      if (get().scope.length > 0) set({ scope: TOP_LEVEL });
    },

    copySelection() {
      const { doc, selection, scope } = get();
      const copied = copyShapes(doc.shapes, selection, scope);
      if (copied.length === 0) return;
      offsetPastes = 0;
      cursorPaste = null;
      set({ clipboard: copied });
    },
    cutSelection() {
      if (get().selection.size === 0) return;
      get().copySelection();
      get().deleteSelection();
    },
    paste(at) {
      const { clipboard } = get();
      if (clipboard.length === 0) return;
      if (at) {
        // Pasting again without moving the mouse steps away, so copies do not stack exactly.
        if (cursorPaste && cursorPaste.at.x === at.x && cursorPaste.at.y === at.y) cursorPaste.repeats += 1;
        else cursorPaste = { at, repeats: 0 };
        const shift = cursorPaste.repeats * PASTE_OFFSET_MM;
        pasteInto(clipboard, { kind: 'center', point: { x: at.x + shift, y: at.y + shift } });
      } else {
        offsetPastes += 1;
        const shift = offsetPastes * PASTE_OFFSET_MM;
        pasteInto(clipboard, { kind: 'offset', dx: shift, dy: shift });
      }
    },
    duplicateSelection() {
      const { doc, selection, scope } = get();
      pasteInto(copyShapes(doc.shapes, selection, scope), { kind: 'offset', dx: PASTE_OFFSET_MM, dy: PASTE_OFFSET_MM });
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
    replaceShapes(removeIds, paths) {
      const shapes = remapGroupIds(shapesFromPaths(paths, nextId), nextGroupId);
      const doc = addShapes(removeShapes(get().doc, new Set(removeIds)), shapes);
      const ids = shapes.map((shape) => shape.id);
      commit(doc, { selection: liveSelection(doc, new Set(ids)), scope: TOP_LEVEL });
      return ids;
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
        scope: existingScope(previous.shapes, get().scope),
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
        scope: existingScope(next.shapes, get().scope),
      });
    },

    setJoinTolerance(mm) {
      if (Number.isFinite(mm) && mm >= 0 && mm <= 10) set({ joinToleranceMm: mm });
    },
    setActiveColor(color) {
      const { doc, selection } = get();
      const activeColor = normalizeColor(color);
      commit(setShapesColor(doc, selection, activeColor), { activeColor });
    },
    setKeepFileColors(keep) {
      set({ keepFileColors: keep });
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
