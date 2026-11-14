import { expose } from 'comlink';
import { createNester } from './engine';
import type { NestInput, NestResult } from './types';

/** How long the search runs before letting queued messages through. */
const YIELD_EVERY_MS = 50;

const api = {
  /**
   * Searches for layouts, calling `onResult` with each one that beats the
   * last. Resolves when the search is exhausted; to stop it sooner, terminate
   * the worker. Pass `onResult` through Comlink's `proxy`.
   */
  async run(input: NestInput, onResult: (result: NestResult) => void): Promise<void> {
    const nester = createNester(input);
    let lastYield = Date.now();
    while (!nester.done) {
      const result = nester.step();
      if (result) onResult(result);
      if (Date.now() - lastYield >= YIELD_EVERY_MS) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        lastYield = Date.now();
      }
    }
  },
};

export type NestWorkerApi = typeof api;

expose(api);
