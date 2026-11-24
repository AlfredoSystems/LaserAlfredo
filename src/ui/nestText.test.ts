import { describe, expect, it } from 'vitest';
import { nestStatusText, plural, type NestStatusInput } from './nestText';

const BASE: NestStatusInput = {
  status: 'idle',
  hasResult: false,
  awaitingFirst: false,
  outOfDate: false,
  utilization: 0,
  evaluations: 0,
  partCount: 2,
  copies: 5,
};

describe('plural', () => {
  it('picks the noun by the count and groups thousands', () => {
    expect(plural(0, 'part', 'parts')).toBe('0 parts');
    expect(plural(1, 'part', 'parts')).toBe('1 part');
    expect(plural(2, 'part', 'parts')).toBe('2 parts');
    expect(plural(5666, 'layout', 'layouts')).toBe('5,666 layouts');
  });
});

describe('nestStatusText', () => {
  it('says what is ready before nesting', () => {
    expect(nestStatusText(BASE)).toBe('Ready — 5 copies to nest');
    expect(nestStatusText({ ...BASE, copies: 1 })).toBe('Ready — 1 copy to nest');
    expect(nestStatusText({ ...BASE, copies: 0 })).toBe('Nothing to nest — every quantity is 0');
    expect(nestStatusText({ ...BASE, partCount: 0, copies: 0 })).toBe('No parts to nest yet');
  });

  it('follows a search from the first layout to the end', () => {
    const running: NestStatusInput = { ...BASE, status: 'running' };
    expect(nestStatusText({ ...running, awaitingFirst: true })).toBe('Working out the first layout…');
    expect(nestStatusText({ ...running, hasResult: true, utilization: 0.8163, evaluations: 1790 })).toBe(
      'Searching — 81.6 %, 1,790 layouts',
    );
    expect(nestStatusText({ ...running, hasResult: true, utilization: 0.5, evaluations: 1 })).toBe(
      'Searching — 50.0 %, 1 layout',
    );
    expect(nestStatusText({ ...BASE, status: 'finished', hasResult: true, evaluations: 5666 })).toBe(
      'Done — best of 5,666 layouts',
    );
    expect(nestStatusText({ ...BASE, status: 'finished', hasResult: true, evaluations: 1 })).toBe('Done — best of 1 layout');
    expect(nestStatusText({ ...BASE, status: 'stopped', hasResult: true, evaluations: 12 })).toBe(
      'Stopped — best of 12 layouts',
    );
  });

  it('does not claim the old layout for a search with new settings that has nothing yet', () => {
    expect(nestStatusText({ ...BASE, status: 'running', hasResult: true, awaitingFirst: true, utilization: 0.7 })).toBe(
      'Working out the first layout…',
    );
  });

  it('says when the settings no longer match the nest', () => {
    const stale: NestStatusInput = { ...BASE, hasResult: true, outOfDate: true, evaluations: 9 };
    expect(nestStatusText({ ...stale, status: 'finished' })).toBe('Out of date — settings changed');
    expect(nestStatusText({ ...stale, status: 'stopped' })).toBe('Out of date — settings changed');
    expect(nestStatusText({ ...stale, status: 'running' })).toBe('Settings changed — stop, then nest again');
  });
});
