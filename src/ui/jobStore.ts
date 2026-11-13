import { wrap, type Remote } from 'comlink';
import { create } from 'zustand';
import type { RuidaOrigin } from '../drivers/ruida/job';
import { HL1060_BED } from '../model/bed';
import type { LaserDocument } from '../model/types';
import { previewSegments, type PreviewSegment } from '../toolpath/generate';
import type { BuiltJob, JobWorkerApi } from '../toolpath/job.worker';
import { FileExport } from '../transport/fileExport';
import { safeFileName, type Transport } from '../transport/transport';
import { useAppStore } from './store';

const REBUILD_DELAY_MS = 200;

let worker: Remote<JobWorkerApi> | null = null;
function jobWorker(): Remote<JobWorkerApi> {
  if (!worker) {
    worker = wrap<JobWorkerApi>(
      new Worker(new URL('../toolpath/job.worker.ts', import.meta.url), { type: 'module' }),
    );
  }
  return worker;
}

const fileExport: Transport = new FileExport();

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface JobState {
  readonly status: 'idle' | 'computing' | 'ready' | 'error';
  /** The job for `builtFor`; kept while a newer one is computing so the panel doesn't flicker. */
  readonly built: BuiltJob | null;
  readonly builtFor: LaserDocument | null;
  readonly segments: readonly PreviewSegment[];
  readonly error: string | null;
  readonly preview: boolean;
  /** How much of the job the preview shows, 0–1. */
  readonly fraction: number;
  readonly maxPowerCapPct: number;
  readonly fileName: string;
  /** Bed corner the controller homes to (machine zero). */
  readonly origin: RuidaOrigin;
  readonly exporting: boolean;

  setPreview(on: boolean): void;
  setFraction(fraction: number): void;
  setMaxPowerCap(pct: number): void;
  setFileName(name: string): void;
  setOrigin(origin: RuidaOrigin): void;
  exportRd(): Promise<void>;
}

let buildToken = 0;
let pending: Promise<void> = Promise.resolve();

export const useJobStore = create<JobState>((set, get) => {
  const build = async (doc: LaserDocument): Promise<void> => {
    const token = ++buildToken;
    if (doc.shapes.length === 0) {
      set({ status: 'idle', built: null, builtFor: doc, segments: [], error: null, preview: false });
      return;
    }
    set({ status: 'computing', error: null });
    try {
      const built = await jobWorker().buildJob(doc, HL1060_BED);
      if (token !== buildToken) return;
      set({ status: 'ready', built, builtFor: doc, segments: previewSegments(built.job), error: null });
    } catch (error) {
      if (token !== buildToken) return;
      set({ status: 'error', built: null, builtFor: doc, segments: [], error: message(error), preview: false });
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolvePending: (() => void) | null = null;
  useAppStore.subscribe((state, previous) => {
    if (state.doc === previous.doc) return;
    clearTimeout(timer);
    set({ status: state.doc.shapes.length === 0 ? 'idle' : 'computing' });
    if (!resolvePending) {
      pending = new Promise<void>((resolve) => {
        resolvePending = resolve;
      });
    }
    timer = setTimeout(() => {
      const done = resolvePending;
      resolvePending = null;
      void build(useAppStore.getState().doc).finally(() => done?.());
    }, REBUILD_DELAY_MS);
  });

  return {
    status: 'idle',
    built: null,
    builtFor: null,
    segments: [],
    error: null,
    preview: false,
    fraction: 1,
    maxPowerCapPct: 100,
    fileName: 'job',
    origin: 'top-left',
    exporting: false,

    setPreview(on) {
      set({ preview: on && get().built !== null, fraction: 1 });
    },
    setFraction(fraction) {
      if (Number.isFinite(fraction)) set({ fraction: Math.min(1, Math.max(0, fraction)) });
    },
    setMaxPowerCap(pct) {
      if (Number.isFinite(pct)) set({ maxPowerCapPct: Math.min(100, Math.max(0, pct)) });
    },
    setFileName(name) {
      set({ fileName: name });
    },
    setOrigin(origin) {
      set({ origin });
    },

    async exportRd() {
      if (get().exporting) return;
      const notify = useAppStore.getState().setNotice;
      set({ exporting: true });
      try {
        // Never export a job that is older than the document on screen.
        for (let i = 0; i < 20 && get().builtFor !== useAppStore.getState().doc; i++) await pending;
        const { built, builtFor, error, maxPowerCapPct, fileName, origin } = get();
        if (!built || builtFor !== useAppStore.getState().doc) {
          notify({ kind: 'error', text: error ?? 'Nothing to export.' });
          return;
        }
        if (built.problem) {
          notify({ kind: 'error', text: built.problem });
          return;
        }
        const bytes = await jobWorker().encodeRd(built.job, { bed: HL1060_BED, maxPowerCapPct, origin });
        const payload = { fileName: safeFileName(fileName, 'rd'), bytes };
        await fileExport.send(payload);
        notify({ kind: 'info', text: `Exported ${payload.fileName} (${bytes.length} bytes)` });
      } catch (error) {
        notify({ kind: 'error', text: `Export failed — ${message(error)}` });
      } finally {
        set({ exporting: false });
      }
    },
  };
});
