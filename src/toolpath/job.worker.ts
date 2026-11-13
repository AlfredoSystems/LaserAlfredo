import { expose } from 'comlink';
import { encodeRuidaJob, type RuidaOrigin } from '../drivers/ruida/job';
import type { Bed } from '../model/bed';
import type { LaserDocument } from '../model/types';
import { checkJobAgainstBed, estimateJob, generateJob, type JobEstimate } from './generate';
import type { Job } from './types';

export interface BuiltJob {
  readonly job: Job;
  readonly warnings: readonly string[];
  readonly estimate: JobEstimate;
  /** Why the job cannot be sent, or null when it fits the bed. */
  readonly problem: string | null;
}

export interface RdExportOptions {
  readonly bed: Bed;
  readonly maxPowerCapPct: number;
  /** Which bed corner the controller treats as machine zero. */
  readonly origin: RuidaOrigin;
}

const api = {
  buildJob(doc: LaserDocument, bed: Bed): BuiltJob {
    const { job, warnings } = generateJob(doc);
    return { job, warnings, estimate: estimateJob(job), problem: checkJobAgainstBed(job, bed) };
  },

  /** Encodes a Ruida .rd file. Throws when the job is empty or leaves the bed. */
  encodeRd(job: Job, options: RdExportOptions): Uint8Array {
    const problem = checkJobAgainstBed(job, options.bed);
    if (problem) throw new Error(problem);
    return encodeRuidaJob(job, {
      bed: options.bed,
      maxPowerCapPct: options.maxPowerCapPct,
      origin: options.origin,
    });
  },
};

export type JobWorkerApi = typeof api;

expose(api);
