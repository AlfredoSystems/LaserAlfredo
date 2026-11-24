/** "1 part", "2 parts", "1,790 layouts": the count with the noun in the right number. */
export function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

export interface NestStatusInput {
  readonly status: 'idle' | 'running' | 'stopped' | 'finished';
  /** A nested layout is on show. */
  readonly hasResult: boolean;
  /** The running search has not delivered its first layout yet. */
  readonly awaitingFirst: boolean;
  /** Quantities, rotate flags or options differ from what the search was given. */
  readonly outOfDate: boolean;
  /** Utilization of the layout on show, 0–1. */
  readonly utilization: number;
  /** Layouts tried for the layout on show. */
  readonly evaluations: number;
  /** Parts on offer, and how many copies of them are asked for. */
  readonly partCount: number;
  readonly copies: number;
}

/** The one line that says where nesting stands. Kept short: it has to fit the sidebar without wrapping. */
export function nestStatusText(input: NestStatusInput): string {
  const tried = plural(input.evaluations, 'layout', 'layouts');
  if (input.status === 'running') {
    if (input.outOfDate) return 'Settings changed — stop, then nest again';
    if (input.awaitingFirst || !input.hasResult) return 'Working out the first layout…';
    return `Searching — ${(input.utilization * 100).toFixed(1)} %, ${tried}`;
  }
  if (input.hasResult) {
    if (input.outOfDate) return 'Out of date — settings changed';
    return `${input.status === 'finished' ? 'Done' : 'Stopped'} — best of ${tried}`;
  }
  if (input.partCount === 0) return 'No parts to nest yet';
  if (input.copies === 0) return 'Nothing to nest — every quantity is 0';
  return `Ready — ${plural(input.copies, 'copy', 'copies')} to nest`;
}
