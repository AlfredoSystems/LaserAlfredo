import { proxy, wrap } from 'comlink';
import { create } from 'zustand';
import { HL1060_BED } from '../model/bed';
import { addShapes } from '../model/document';
import type { Shape } from '../model/types';
import type { NestWorkerApi } from '../nesting/nest.worker';
import {
  clampQuantity,
  DEFAULT_PART_SETTING,
  findParts,
  partSources,
  sheetShapes,
  toNestParts,
  type PartGroup,
  type PartSetting,
} from '../nesting/parts';
import { DEFAULT_NEST_OPTIONS, type NestOptions, type NestResult } from '../nesting/types';
import { safeFileName } from '../transport/transport';
import { exportDocumentRd, useJobStore } from './jobStore';
import { useAppStore } from './store';

/** Rotation steps offered in the panel, in degrees. 0 means parts are not rotated. */
export const ROTATION_STEPS: readonly number[] = [0, 180, 90, 45, 15];

const MIN_SHEET_MM = 10;
const MAX_MARGIN_MM = 100;
const MAX_SPACING_MM = 50;
const MAX_WORKERS = 4;
/** The search stops by itself when nothing better has turned up for this long. */
const STALL_MS = 20_000;
/** Longest file name `safeFileName` keeps, without the extension. */
const MAX_NAME_LENGTH = 32;

export interface NestSource {
  readonly groups: readonly PartGroup[];
  /** True when the parts come from the selection, false for the whole document. */
  readonly fromSelection: boolean;
}

let sourceCache: { shapes: readonly Shape[]; selection: ReadonlySet<string>; source: NestSource } | null = null;

/** The parts on offer: those in the selection, or all of them when nothing is selected. */
export function nestSource(shapes: readonly Shape[], selection: ReadonlySet<string>): NestSource {
  if (sourceCache && sourceCache.shapes === shapes && sourceCache.selection === selection) return sourceCache.source;
  const fromSelection = selection.size > 0;
  const chosen = fromSelection ? shapes.filter((shape) => selection.has(shape.id)) : shapes;
  const source: NestSource = { groups: findParts(chosen), fromSelection };
  sourceCache = { shapes, selection, source };
  return source;
}

export type NestStatus = 'idle' | 'running' | 'stopped' | 'finished';

export interface NestState {
  /** True while the Nest tab is showing; the canvas preview follows it. */
  readonly panelOpen: boolean;
  /** Quantity and rotation lock per part id. Parts without an entry use the defaults. */
  readonly settings: ReadonlyMap<string, PartSetting>;
  readonly options: NestOptions;
  readonly status: NestStatus;
  readonly error: string | null;
  /** The best layout found so far by the current or last run. */
  readonly result: NestResult | null;
  /** Layouts tried by all workers together. */
  readonly evaluations: number;
  readonly sheetIndex: number;
  /** True once the sheet on show has been put into the document. */
  readonly applied: boolean;
  readonly exporting: boolean;
  /** The source shapes of the parts in `result`, as they were when the run started. */
  readonly sources: ReadonlyMap<string, readonly Shape[]>;
  /** The options `result` was nested with. */
  readonly runOptions: NestOptions;

  setPanelOpen(open: boolean): void;
  setQuantity(partId: string, quantity: number): void;
  setCanRotate(partId: string, canRotate: boolean): void;
  setOptions(patch: Partial<NestOptions>): void;
  start(): void;
  stop(): void;
  discard(): void;
  setSheetIndex(index: number): void;
  applySheet(): void;
  exportAllSheets(): Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function clampOptions(next: NestOptions, previous: NestOptions): NestOptions {
  return {
    sheetWidthMm: clamp(next.sheetWidthMm, MIN_SHEET_MM, HL1060_BED.widthMm, previous.sheetWidthMm),
    sheetHeightMm: clamp(next.sheetHeightMm, MIN_SHEET_MM, HL1060_BED.heightMm, previous.sheetHeightMm),
    marginMm: clamp(next.marginMm, 0, MAX_MARGIN_MM, previous.marginMm),
    spacingMm: clamp(next.spacingMm, 0, MAX_SPACING_MM, previous.spacingMm),
    rotationStepDeg: ROTATION_STEPS.includes(next.rotationStepDeg) ? next.rotationStepDeg : previous.rotationStepDeg,
    useHoles: next.useHoles,
  };
}

function workerCount(): number {
  const cores = typeof navigator === 'undefined' ? 1 : navigator.hardwareConcurrency || 1;
  return Math.min(MAX_WORKERS, Math.max(1, cores - 1));
}

interface WorkerSlot {
  readonly worker: Worker;
  evaluations: number;
  done: boolean;
}

// The live run. Kept outside the store: none of it is for rendering.
let runToken = 0;
let slots: WorkerSlot[] = [];
let stallTimer: ReturnType<typeof setTimeout> | undefined;
let nextSeed = 1;
/** What the last apply put into the document: which sheet, and the ids of the shapes it added. */
let lastApply: { readonly result: NestResult; readonly sheetIndex: number; readonly ids: readonly string[] } | null = null;

/** True while the document still holds everything the last apply added for this very sheet. */
function isApplied(result: NestResult | null, sheetIndex: number): boolean {
  if (!lastApply || lastApply.result !== result || lastApply.sheetIndex !== sheetIndex) return false;
  const present = new Set(useAppStore.getState().doc.shapes.map((shape) => shape.id));
  return lastApply.ids.every((id) => present.has(id));
}

/** Ends the run, if any: no worker survives and no late message is listened to. */
function teardown(): void {
  runToken += 1;
  clearTimeout(stallTimer);
  stallTimer = undefined;
  for (const slot of slots) slot.worker.terminate();
  slots = [];
}

let previewCounter = 0;
function previewId(): string {
  previewCounter += 1;
  return `nest${previewCounter}`;
}

let sheetCache: { result: NestResult; sheetIndex: number; shapes: readonly Shape[] } | null = null;
const NO_SHAPES: readonly Shape[] = [];

/** The placed shapes of the sheet on show. The same array is returned until the result or sheet changes. */
export function currentSheetShapes(state: NestState): readonly Shape[] {
  const { result, sheetIndex } = state;
  const sheet = result?.sheets[sheetIndex];
  if (!result || !sheet) return NO_SHAPES;
  if (sheetCache && sheetCache.result === result && sheetCache.sheetIndex === sheetIndex) return sheetCache.shapes;
  const shapes = sheetShapes(sheet, state.sources, previewId);
  sheetCache = { result, sheetIndex, shapes };
  return shapes;
}

export interface NestPreview {
  readonly shapes: readonly Shape[];
  readonly sheetWidthMm: number;
  readonly sheetHeightMm: number;
  readonly marginMm: number;
}

/** What the canvas shows instead of the editable document, or null when there is nothing to show. */
export function nestPreview(state: NestState): NestPreview | null {
  if (!state.panelOpen || state.applied || !state.result || state.result.sheets.length === 0) return null;
  const { sheetWidthMm, sheetHeightMm, marginMm } = state.runOptions;
  return { shapes: currentSheetShapes(state), sheetWidthMm, sheetHeightMm, marginMm };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export const useNestStore = create<NestState>((set, get) => {
  const finish = (status: NestStatus, error: string | null = null) => {
    teardown();
    set({ status, error });
  };

  const armStallTimer = (token: number) => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      if (token === runToken) finish('finished');
    }, STALL_MS);
  };

  const onResult = (token: number, slot: WorkerSlot, result: NestResult) => {
    if (token !== runToken) return;
    slot.evaluations = result.evaluations;
    let evaluations = 0;
    for (const each of slots) evaluations += each.evaluations;
    const best = get().result;
    if (best && !(result.fitness < best.fitness)) {
      set({ evaluations });
      return;
    }
    const lastSheet = Math.max(0, result.sheets.length - 1);
    set({ result, evaluations, sheetIndex: Math.min(get().sheetIndex, lastSheet), applied: false });
    armStallTimer(token);
  };

  const onSettled = (token: number, slot: WorkerSlot) => {
    if (token !== runToken) return;
    slot.done = true;
    if (!slots.every((each) => each.done)) return;
    finish('finished', get().result ? null : 'Nesting ended without a layout.');
  };

  const fail = (token: number, text: string) => {
    if (token === runToken) finish('stopped', `Nesting failed — ${text}`);
  };

  const patchSetting = (partId: string, patch: Partial<PartSetting>) => {
    const settings = new Map(get().settings);
    settings.set(partId, { ...(settings.get(partId) ?? DEFAULT_PART_SETTING), ...patch });
    set({ settings });
  };

  // Undoing an apply makes the sheet applicable again; redoing it does the reverse.
  useAppStore.subscribe((state, previous) => {
    if (state.doc === previous.doc || !lastApply) return;
    const applied = isApplied(get().result, get().sheetIndex);
    if (applied !== get().applied) set({ applied });
  });

  return {
    panelOpen: false,
    settings: new Map(),
    options: DEFAULT_NEST_OPTIONS,
    status: 'idle',
    error: null,
    result: null,
    evaluations: 0,
    sheetIndex: 0,
    applied: false,
    exporting: false,
    sources: new Map(),
    runOptions: DEFAULT_NEST_OPTIONS,

    setPanelOpen(open) {
      if (open !== get().panelOpen) set({ panelOpen: open });
    },
    setQuantity(partId, quantity) {
      patchSetting(partId, { quantity: clampQuantity(quantity) });
    },
    setCanRotate(partId, canRotate) {
      patchSetting(partId, { canRotate });
    },
    setOptions(patch) {
      const previous = get().options;
      set({ options: clampOptions({ ...previous, ...patch }, previous) });
    },

    start() {
      teardown();
      const { doc, selection } = useAppStore.getState();
      const { settings, options } = get();
      const { groups } = nestSource(doc.shapes, selection);
      const parts = toNestParts(groups, (id) => settings.get(id));
      if (parts.length === 0) {
        set({ status: 'idle', error: 'There are no parts to nest.' });
        return;
      }
      const wanted = new Set(parts.map((part) => part.id));
      const sources = partSources(
        groups.filter((group) => wanted.has(group.id)),
        doc.shapes,
      );
      const token = runToken;
      lastApply = null;
      set({
        status: 'running',
        error: null,
        result: null,
        evaluations: 0,
        sheetIndex: 0,
        applied: false,
        sources,
        runOptions: options,
      });

      try {
        const count = workerCount();
        for (let i = 0; i < count; i++) {
          const worker = new Worker(new URL('../nesting/nest.worker.ts', import.meta.url), { type: 'module' });
          const slot: WorkerSlot = { worker, evaluations: 0, done: false };
          slots.push(slot);
          worker.addEventListener('error', (event) => {
            event.preventDefault();
            fail(token, event.message || 'the nesting worker could not run');
          });
          worker.addEventListener('messageerror', () => fail(token, 'a worker message could not be read'));
          const seed = nextSeed++;
          wrap<NestWorkerApi>(worker)
            .run(
              { parts, options, seed },
              proxy((result: NestResult) => onResult(token, slot, result)),
            )
            .then(
              () => onSettled(token, slot),
              (error: unknown) => fail(token, message(error)),
            );
        }
      } catch (error) {
        fail(token, message(error));
      }
    },

    stop() {
      if (get().status === 'running') finish('stopped');
    },

    discard() {
      teardown();
      lastApply = null;
      set({ status: 'idle', error: null, result: null, evaluations: 0, sheetIndex: 0, applied: false, sources: new Map() });
    },

    setSheetIndex(index) {
      const count = get().result?.sheets.length ?? 0;
      if (count === 0 || !Number.isFinite(index)) return;
      const sheetIndex = Math.min(count - 1, Math.max(0, Math.round(index)));
      if (sheetIndex !== get().sheetIndex) set({ sheetIndex, applied: isApplied(get().result, sheetIndex) });
    },

    applySheet() {
      const state = get();
      const { result } = state;
      const shapes = currentSheetShapes(state);
      if (!result || shapes.length === 0) return;
      // The document is about to hold this layout, so the search ends here.
      if (state.status === 'running') finish('stopped');

      // Take out the originals of every part that was placed, and whatever an
      // earlier apply of this result put in. Ids that are gone are ignored.
      const remove = new Set<string>(lastApply?.ids);
      for (const sheet of result.sheets) {
        for (const placement of sheet.placements) {
          for (const shape of state.sources.get(placement.partId) ?? []) remove.add(shape.id);
        }
      }
      const app = useAppStore.getState();
      // Every copy made of several shapes (outline plus holes or marks) goes in as a group.
      const sheet = result.sheets[state.sheetIndex];
      const grouped = sheet ? sheetShapes(sheet, state.sources, previewId, previewId) : shapes;
      const ids = app.replaceShapes(remove, grouped);
      lastApply = { result, sheetIndex: state.sheetIndex, ids };
      set({ applied: true });
      const sheetCount = result.sheets.length;
      app.setNotice({
        kind: 'info',
        text:
          `Nested ${plural(ids.length, 'shape', 'shapes')} placed in the document` +
          (sheetCount > 1 ? ` (sheet ${state.sheetIndex + 1} of ${sheetCount})` : ''),
      });
    },

    async exportAllSheets() {
      const state = get();
      const { result } = state;
      if (state.exporting || !result || result.sheets.length === 0) return;
      const notify = useAppStore.getState().setNotice;
      set({ exporting: true });
      const names: string[] = [];
      let sheetNumber = 0;
      try {
        const base = safeFileName(useJobStore.getState().fileName, 'rd').replace(/\.rd$/, '');
        for (const sheet of result.sheets) {
          sheetNumber += 1;
          const suffix = `-sheet${sheetNumber}`;
          const fileName = safeFileName(base.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix, 'rd');
          // The sheet's shapes with the document's current layer settings.
          // A colour whose layer is gone gets the (low power) defaults.
          const layers = useAppStore.getState().doc.layers;
          const doc = addShapes({ shapes: [], layers }, sheetShapes(sheet, state.sources, previewId));
          await exportDocumentRd(doc, fileName);
          names.push(fileName);
        }
        const first = names[0] ?? '';
        const last = names[names.length - 1] ?? '';
        notify({
          kind: 'info',
          text: `Exported ${plural(names.length, 'sheet', 'sheets')} (${names.length > 1 ? `${first} … ${last}` : first})`,
        });
      } catch (error) {
        const done = names.length > 0 ? `; ${plural(names.length, 'sheet was', 'sheets were')} exported before it` : '';
        notify({ kind: 'error', text: `Sheet ${sheetNumber} was not exported — ${message(error)}${done}` });
      } finally {
        set({ exporting: false });
      }
    },
  };
});
