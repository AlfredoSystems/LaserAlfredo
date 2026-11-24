import { proxy, wrap } from 'comlink';
import { create } from 'zustand';
import { HL1060_BED } from '../model/bed';
import { addShapes, removeShapes } from '../model/document';
import type { LaserDocument, Shape } from '../model/types';
import type { NestWorkerApi } from '../nesting/nest.worker';
import {
  clampQuantity,
  DEFAULT_PART_SETTING,
  findParts,
  partSources,
  placedSourceIds,
  sameOptions,
  sameParts,
  sheetShapes,
  toNestParts,
  type PartGroup,
  type PartSetting,
} from '../nesting/parts';
import { DEFAULT_NEST_OPTIONS, type NestOptions, type NestPart, type NestResult } from '../nesting/types';
import { safeFileName } from '../transport/transport';
import { exportDocumentRd, useJobStore } from './jobStore';
import { plural } from './nestText';
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

/**
 * A nest that is in the document. It starts when Nest is pressed and lasts
 * while the document on screen is the one the nest put there.
 */
export interface NestSession {
  /** The document the parts were taken from. Undo goes back to it. */
  readonly base: LaserDocument;
  /** The document the nest put in place, or null while nothing has been placed. */
  readonly doc: LaserDocument | null;
  /** The parts on offer when Nest was pressed, as they were in `base`. */
  readonly groups: readonly PartGroup[];
  readonly fromSelection: boolean;
  /** The selection when Nest was pressed. Undoing the nest brings it back. */
  readonly selection: ReadonlySet<string>;
}

/** What one search was given. */
export interface NestRun {
  readonly parts: readonly NestPart[];
  readonly options: NestOptions;
  /** The source shapes of the parts, keyed by part id, as they are in the session's base document. */
  readonly sources: ReadonlyMap<string, readonly Shape[]>;
}

export interface NestState {
  /** True while the Nest tab is showing; the sheet outline on the canvas follows it. */
  readonly panelOpen: boolean;
  /** Quantity and rotation lock per part id. Parts without an entry use the defaults. */
  readonly settings: ReadonlyMap<string, PartSetting>;
  readonly options: NestOptions;
  readonly status: NestStatus;
  readonly error: string | null;
  /** Set from the press on Nest until something else changes the document. */
  readonly session: NestSession | null;
  /** The layout that is in the document: the best one found so far. */
  readonly result: NestResult | null;
  /** Layouts tried for `result`, by all workers together. */
  readonly evaluations: number;
  /** Which sheet of `result` is on the bed. */
  readonly sheetIndex: number;
  readonly exporting: boolean;
  /** What `result` was nested from. */
  readonly shown: NestRun | null;
  /**
   * What the current search was given. A different object than `shown` only
   * while a search with new settings has not delivered its first layout.
   */
  readonly run: NestRun | null;

  setPanelOpen(open: boolean): void;
  setQuantity(partId: string, quantity: number): void;
  setCanRotate(partId: string, canRotate: boolean): void;
  setOptions(patch: Partial<NestOptions>): void;
  /**
   * Nests the parts into the document. In a session it nests the original
   * parts again: with changed settings the next layout replaces the current
   * one, with unchanged settings only a better layout does. Either way the
   * nest stays the one undo step it was.
   */
  start(): void;
  stop(): void;
  /** Puts another sheet of the result on the bed. Not an undo step of its own. */
  setSheetIndex(index: number): void;
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
/** Layouts tried by earlier searches with the same settings; the running one adds to it. */
let priorEvaluations = 0;
/** True while this store itself is changing the document. */
let writing = false;

/** Ends the run, if any: no worker survives and no late message is listened to. */
function teardown(): void {
  runToken += 1;
  clearTimeout(stallTimer);
  stallTimer = undefined;
  for (const slot of slots) slot.worker.terminate();
  slots = [];
}

let idCounter = 0;
/** Ids for nested shapes and their groups. The prefix keeps them apart from the document's own. */
function nestId(): string {
  idCounter += 1;
  return `nest${idCounter}`;
}

type NestedSession = NestSession & { readonly doc: LaserDocument };

/** A session that undo, redo or an edit stepped out of, kept for as long as history can bring its document back. */
interface ParkedSession {
  readonly session: NestedSession;
  readonly result: NestResult;
  readonly evaluations: number;
  readonly sheetIndex: number;
  readonly shown: NestRun;
  readonly status: NestStatus;
}
let parked: ParkedSession | null = null;

/** True when the settings differ from what the search (running or last) was given. */
export function isOutOfDate(state: Pick<NestState, 'session' | 'settings' | 'options' | 'run'>): boolean {
  const { session, settings, options, run } = state;
  if (!session || !run) return false;
  if (!sameOptions(options, run.options)) return true;
  return !sameParts(
    toNestParts(session.groups, (id) => settings.get(id)),
    run.parts,
  );
}

export interface SheetOutline {
  readonly widthMm: number;
  readonly heightMm: number;
  readonly marginMm: number;
}

/**
 * The sheet to outline on the canvas while the Nest tab is open: the one the
 * layout in the document was nested for, otherwise the one set in the panel.
 */
export function sheetOutline(
  state: Pick<NestState, 'panelOpen' | 'options' | 'result' | 'shown'>,
): SheetOutline | null {
  if (!state.panelOpen) return null;
  const { sheetWidthMm, sheetHeightMm, marginMm } = state.result && state.shown ? state.shown.options : state.options;
  return { widthMm: sheetWidthMm, heightMm: sheetHeightMm, marginMm };
}

/** The fields of a store without a session. */
const NO_SESSION = {
  status: 'idle',
  error: null,
  session: null,
  result: null,
  evaluations: 0,
  sheetIndex: 0,
  shown: null,
  run: null,
} satisfies Partial<NestState>;

export const useNestStore = create<NestState>((set, get) => {
  /** Leaves the session for good. The document keeps whatever it holds. */
  const endSession = (error: string | null = null) => {
    teardown();
    parked = null;
    set({ ...NO_SESSION, error });
  };

  /**
   * Puts one sheet of the result into the document: the session's base
   * document, minus the originals of every placed part, plus the sheet's
   * copies. The first time that is a new undo step; after that the nest's own
   * document is swapped, so the whole nest stays one step. Returns the
   * session to carry on with, or null when the document was not the nest's.
   */
  const land = (session: NestSession, result: NestResult, sheetIndex: number, run: NestRun): NestSession | null => {
    const sheet = result.sheets[sheetIndex];
    // Every copy made of several shapes (outline plus holes or marks) goes in as a group.
    const placed = sheet ? sheetShapes(sheet, run.sources, nestId, nestId) : [];
    const added = addShapes(removeShapes(session.base, placedSourceIds(result.sheets, run.sources)), placed);
    const app = useAppStore.getState();
    // Nothing was placed and no nest is in the document: there is nothing to change.
    if (added === session.base && !session.doc) return app.doc === session.base ? session : null;
    // A copy, so that the nest's document is never the base document itself.
    const target: LaserDocument = added === session.base ? { ...added } : added;
    let done = false;
    writing = true;
    try {
      if (session.doc) done = app.amendDocument(session.doc, target);
      else if (app.doc === session.base) done = app.commitDocument(target);
    } finally {
      writing = false;
    }
    return done ? { ...session, doc: target } : null;
  };

  const finish = (status: NestStatus, error: string | null = null) => {
    teardown();
    const { result, shown, session } = get();
    if (!result || !shown) {
      // Nothing was nested: back to how it was before Nest was pressed.
      endSession(error);
      return;
    }
    // A search with new settings that delivered nothing leaves the old layout, out of date.
    set({ status, error, run: shown });
    if (!error && session?.doc) {
      useAppStore.getState().setNotice({
        kind: 'info',
        text: `Nested ${plural(result.placedCount, 'part', 'parts')} on ${plural(result.sheets.length, 'sheet', 'sheets')}`,
      });
    }
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
    let evaluations = priorEvaluations;
    for (const each of slots) evaluations += each.evaluations;
    const { result: best, session, run, shown, sheetIndex } = get();
    if (!session || !run) return;
    // The first layout for new settings always replaces what is there; after that only a better one does.
    const first = run !== shown;
    if (!first && best && !(result.fitness < best.fitness)) {
      set({ evaluations });
      return;
    }
    const lastSheet = Math.max(0, result.sheets.length - 1);
    const nextIndex = first ? 0 : Math.min(sheetIndex, lastSheet);
    const landed = land(session, result, nextIndex, run);
    if (!landed) {
      endSession();
      return;
    }
    set({ result, evaluations, sheetIndex: nextIndex, session: landed, shown: run });
    armStallTimer(token);
  };

  const onSettled = (token: number, slot: WorkerSlot) => {
    if (token !== runToken) return;
    slot.done = true;
    if (!slots.every((each) => each.done)) return;
    const { result, run, shown } = get();
    finish('finished', result && run === shown ? null : 'Nesting ended without a layout.');
  };

  const fail = (token: number, text: string) => {
    if (token === runToken) finish('stopped', `Nesting failed — ${text}`);
  };

  const patchSetting = (partId: string, patch: Partial<PartSetting>) => {
    const settings = new Map(get().settings);
    settings.set(partId, { ...(settings.get(partId) ?? DEFAULT_PART_SETTING), ...patch });
    set({ settings });
  };

  /** Steps out of the session but keeps it, so that history can bring it back. The search ends. */
  const park = (session: NestedSession, result: NestResult, shown: NestRun) => {
    const { status, evaluations, sheetIndex } = get();
    teardown();
    parked = { session, result, evaluations, sheetIndex, shown, status: status === 'finished' ? 'finished' : 'stopped' };
    set(NO_SESSION);
  };

  // The document is the nest's only for as long as nothing else changes it.
  useAppStore.subscribe((state, previous) => {
    const { session, result, shown, status } = get();
    if (state.doc === previous.doc) {
      // A result that placed nothing left the document alone; picking other parts moves on from it.
      if (session && !session.doc && status !== 'running' && state.selection !== previous.selection) endSession();
      return;
    }
    if (writing) return;
    if (session) {
      const nested = session.doc;
      if (nested && result && shown && (state.past.includes(nested) || state.future.includes(nested))) {
        park({ ...session, doc: nested }, result, shown);
        // Undone: the parts are back as they were, and so is their selection.
        if (state.doc === session.base && session.fromSelection && state.selection.size === 0) {
          const present = new Set(state.doc.shapes.map((shape) => shape.id));
          state.select([...session.selection].filter((id) => present.has(id)));
        }
      } else {
        endSession();
      }
    } else if (parked) {
      const nested = parked.session.doc;
      if (state.doc === nested) {
        // Undo or redo landed on the nest's document again: carry on where it was left.
        const back = parked;
        parked = null;
        set({
          status: back.status,
          error: null,
          session: back.session,
          result: back.result,
          evaluations: back.evaluations,
          sheetIndex: back.sheetIndex,
          shown: back.shown,
          run: back.shown,
        });
      } else if (!state.past.includes(nested) && !state.future.includes(nested)) {
        parked = null;
      }
    }
  });

  return {
    panelOpen: false,
    settings: new Map(),
    options: DEFAULT_NEST_OPTIONS,
    exporting: false,
    ...NO_SESSION,

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
      const state = get();
      if (state.status === 'running') return;
      teardown();
      const app = useAppStore.getState();
      let session = state.session;
      if (!session) {
        const source = nestSource(app.doc.shapes, app.selection);
        session = {
          base: app.doc,
          doc: null,
          groups: source.groups,
          fromSelection: source.fromSelection,
          selection: app.selection,
        };
      }
      const { groups, base } = session;
      const parts = toNestParts(groups, (id) => state.settings.get(id));
      if (parts.length === 0) {
        set({ error: 'There are no parts to nest.' });
        return;
      }
      // Unchanged settings: the search carries on from the layout that is there.
      const { shown } = state;
      const again =
        state.session !== null &&
        state.result !== null &&
        shown !== null &&
        sameOptions(state.options, shown.options) &&
        sameParts(parts, shown.parts);
      let run: NestRun;
      if (again && shown) {
        run = shown;
      } else {
        const wanted = new Set(parts.map((part) => part.id));
        const sources = partSources(
          groups.filter((group) => wanted.has(group.id)),
          base.shapes,
        );
        run = { parts, options: state.options, sources };
      }
      priorEvaluations = again ? state.evaluations : 0;
      const token = runToken;
      if (state.session) {
        set({ status: 'running', error: null, run });
      } else {
        // A new nest: an older one that undo or redo could still bring back is let go.
        parked = null;
        set({ ...NO_SESSION, status: 'running', session, run });
      }
      // Nothing better may ever turn up, so the wait for it starts now.
      if (again) armStallTimer(token);

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
              { parts: run.parts, options: run.options, seed },
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

    setSheetIndex(index) {
      const { result, session, shown, sheetIndex: current } = get();
      const count = result?.sheets.length ?? 0;
      if (!result || !session || !shown || count === 0 || !Number.isFinite(index)) return;
      const sheetIndex = Math.min(count - 1, Math.max(0, Math.round(index)));
      if (sheetIndex === current) return;
      const landed = land(session, result, sheetIndex, shown);
      if (!landed) {
        endSession();
        return;
      }
      set({ sheetIndex, session: landed });
    },

    async exportAllSheets() {
      const state = get();
      const { result, shown } = state;
      if (state.exporting || !result || !shown || result.sheets.length === 0) return;
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
          const doc = addShapes({ shapes: [], layers }, sheetShapes(sheet, shown.sources, nestId));
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
