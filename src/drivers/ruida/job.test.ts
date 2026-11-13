import { describe, expect, it } from 'vitest';
import { HL1060_BED } from '../../model/bed';
import type { Job } from '../../toolpath/types';
import { decodePowerPct } from './encode';
import type { RuidaOptions } from './job';
import {
  RUIDA_MAX_PASSES,
  RUIDA_MAX_SPEED_MM_S,
  RuidaJobError,
  buildRuidaCommands,
  describeRuidaCommands,
  encodeRuidaJob,
  jobPointToMachineUm,
} from './job';
import { RUIDA_MAGIC_644X, unswizzle } from './swizzle';
import { RECTANGLE_JOB, TEST_OPTIONS, TWO_LAYER_JOB, jobOf, layerOf, rectPath } from './testJobs';

function lines(job: Job, options: RuidaOptions = TEST_OPTIONS): string[] {
  return describeRuidaCommands(buildRuidaCommands(job, options));
}

/** Every power value in the stream, in percent, whatever command carries it. */
function allPowers(job: Job, options: RuidaOptions): number[] {
  return lines(job, options)
    .filter((line) => /power/i.test(line))
    .map((line) => {
      const match = / (\d+\.\d+)% \|/.exec(line);
      if (!match?.[1]) throw new Error(`No power value in "${line}"`);
      return Number(match[1]);
    });
}

function powerOf(job: Job, options: RuidaOptions, name: string): number {
  const stream = buildRuidaCommands(job, options);
  const text = describeRuidaCommands(stream).find((line) => line.startsWith(name));
  if (!text) throw new Error(`No "${name}" command`);
  const hex = text.split(' | ')[1]?.split(' ') ?? [];
  return decodePowerPct(hex.slice(-2).map((h) => parseInt(h, 16)));
}

function movesAndCuts(job: Job, options: RuidaOptions = TEST_OPTIONS): string[] {
  return lines(job, options)
    .filter((line) => /^(Move|Cut) /.test(line))
    .map((line) => line.split(' | ')[0] ?? '');
}

describe('buildRuidaCommands structure', () => {
  it('produces only known, well-formed commands', () => {
    for (const line of lines(TWO_LAYER_JOB)) {
      expect(line).not.toMatch(/^(UNKNOWN|MALFORMED|STRAY)/);
    }
  });

  it('keeps every parameter byte below 0x80 and every command start at or above it', () => {
    const stream = buildRuidaCommands(TWO_LAYER_JOB, TEST_OPTIONS);
    expect(stream[0]).toBe(0xd8);
    expect(stream[stream.length - 1]).toBe(0xd7);
    // Re-joining the disassembly must give back exactly the same bytes.
    const rejoined = describeRuidaCommands(stream)
      .flatMap((line) => (line.split(' | ')[1] ?? '').split(' '))
      .map((h) => parseInt(h, 16));
    expect(rejoined).toEqual(Array.from(stream));
  });

  it('starts in absolute mode and ends with the documented trailer', () => {
    const text = lines(RECTANGLE_JOB).map((line) => line.split(' | ')[0]);
    expect(text.slice(0, 5)).toEqual([
      'Ref point mode 2 (machine zero, absolute)',
      'Ref point set',
      'Set absolute',
      'Enable block cutting 0',
      'Start process',
    ]);
    expect(text.slice(-4)).toEqual(['Array end', 'Block end', 'Set param 6 32 160 160', 'End of file']);
  });

  it('writes the job bounding box and the layer settings', () => {
    const text = lines(RECTANGLE_JOB).map((line) => line.split(' | ')[0]);
    expect(text).toContain('Process top-left 10.000mm 10.000mm');
    expect(text).toContain('Process bottom-right 60.000mm 40.000mm');
    expect(text).toContain('Document min point 10.000mm 10.000mm');
    expect(text).toContain('Document max point 60.000mm 40.000mm');
    expect(text).toContain('Layer speed 0 20.000mm/s');
    expect(text).toContain('Layer colour 0 #000000');
    expect(text).toContain('Layer min point 0 10.000mm 10.000mm');
    expect(text).toContain('Layer max point 0 60.000mm 40.000mm');
    expect(text).toContain('Max layer index 0');
    expect(text).toContain('Speed 20.000mm/s');
    expect(powerOf(RECTANGLE_JOB, TEST_OPTIONS, 'Layer laser 1 max power')).toBeCloseTo(30, 1);
    expect(powerOf(RECTANGLE_JOB, TEST_OPTIONS, 'Layer laser 1 min power')).toBeCloseTo(20, 1);
    expect(powerOf(RECTANGLE_JOB, TEST_OPTIONS, 'Laser 1 max power')).toBeCloseTo(30, 1);
    expect(powerOf(RECTANGLE_JOB, TEST_OPTIONS, 'Laser 1 min power')).toBeCloseTo(20, 1);
  });

  it('moves to the start of a closed path, cuts round it and closes it', () => {
    expect(movesAndCuts(RECTANGLE_JOB)).toEqual([
      'Move abs 10.000mm 10.000mm',
      'Cut abs 60.000mm 10.000mm',
      'Cut abs 60.000mm 40.000mm',
      'Cut abs 10.000mm 40.000mm',
      'Cut abs 10.000mm 10.000mm',
    ]);
  });

  it('does not close an open path', () => {
    const job = jobOf(
      layerOf([
        {
          closed: false,
          points: [
            { x: 1, y: 2 },
            { x: 3, y: 4 },
            { x: 5, y: 2 },
          ],
        },
      ]),
    );
    expect(movesAndCuts(job)).toEqual([
      'Move abs 1.000mm 2.000mm',
      'Cut abs 3.000mm 4.000mm',
      'Cut abs 5.000mm 2.000mm',
    ]);
  });

  it('does not add a second closing cut when a closed path already repeats its start', () => {
    const square = rectPath(0, 0, 10, 10);
    const first = square.points[0];
    if (!first) throw new Error('fixture');
    const job = jobOf(layerOf([{ closed: true, points: [...square.points, first] }]));
    expect(movesAndCuts(job)).toHaveLength(5);
  });

  it('repeats the whole layer once per pass', () => {
    const job = jobOf(layerOf([rectPath(0, 0, 10, 10), rectPath(20, 0, 10, 10)], { passes: 3 }));
    const onePass = movesAndCuts(jobOf(layerOf([rectPath(0, 0, 10, 10), rectPath(20, 0, 10, 10)])));
    expect(movesAndCuts(job)).toEqual([...onePass, ...onePass, ...onePass]);
  });

  it('runs layers in order, each with its own settings', () => {
    const text = lines(TWO_LAYER_JOB).map((line) => line.split(' | ')[0] ?? '');
    const selects = text.filter((line) => line.startsWith('Layer number'));
    expect(selects).toEqual(['Layer number 0', 'Layer number 1']);
    expect(text.filter((line) => line.startsWith('Speed '))).toEqual(['Speed 150.000mm/s', 'Speed 12.500mm/s']);
    expect(text).toContain('Layer colour 0 #0000ff');
    expect(text).toContain('Layer colour 1 #ff0000');
    expect(text).toContain('Max layer index 1');
    // Layer 0 geometry comes before the second layer select.
    const secondSelect = text.indexOf('Layer number 1');
    const firstCut = text.findIndex((line) => line.startsWith('Cut abs'));
    expect(firstCut).toBeGreaterThan(text.indexOf('Layer number 0'));
    expect(firstCut).toBeLessThan(secondSelect);
  });

  it('leaves out layers that have no paths', () => {
    const job = jobOf(layerOf([], { color: '#111111' }), layerOf([rectPath(0, 0, 5, 5)], { color: '#222222' }));
    const text = lines(job).map((line) => line.split(' | ')[0]);
    expect(text).toContain('Layer colour 0 #222222');
    expect(text).toContain('Max layer index 0');
  });

  it('drops repeated points so no zero-length cut is written', () => {
    const job = jobOf(
      layerOf([
        {
          closed: false,
          points: [
            { x: 0, y: 0 },
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10.0000001, y: 0 },
          ],
        },
      ]),
    );
    expect(movesAndCuts(job)).toEqual(['Move abs 0.000mm 0.000mm', 'Cut abs 10.000mm 0.000mm']);
  });

  it('always writes lasers 2 to 4 as zero', () => {
    const others = lines(TWO_LAYER_JOB).filter((line) => /[Ll]aser [234] (min|max) power/.test(line));
    expect(others.length).toBe(2 * 6 * 2);
    for (const line of others) expect(line).toContain(' 0.00% |');
  });
});

describe('encodeRuidaJob', () => {
  it('is the scrambled command stream', () => {
    const file = encodeRuidaJob(RECTANGLE_JOB, TEST_OPTIONS);
    expect(Array.from(unswizzle(file, RUIDA_MAGIC_644X))).toEqual(
      Array.from(buildRuidaCommands(RECTANGLE_JOB, TEST_OPTIONS)),
    );
    // Plain D8 10 ... D7 scrambled with 0x88.
    expect(file[0]).toBe(0xd2);
    expect(file[file.length - 1]).toBe(0x60);
  });

  it('honours another magic byte and refuses an invalid one', () => {
    const file = encodeRuidaJob(RECTANGLE_JOB, { ...TEST_OPTIONS, magic: 0x11 });
    expect(Array.from(unswizzle(file, 0x11))).toEqual(Array.from(buildRuidaCommands(RECTANGLE_JOB, TEST_OPTIONS)));
    expect(() => encodeRuidaJob(RECTANGLE_JOB, { ...TEST_OPTIONS, magic: 256 })).toThrow(RuidaJobError);
    expect(() => encodeRuidaJob(RECTANGLE_JOB, { ...TEST_OPTIONS, magic: 1.5 })).toThrow(RuidaJobError);
  });
});

describe('origin handling', () => {
  it('flips axes only for the chosen corner', () => {
    const p = { x: 10, y: 20 };
    expect(jobPointToMachineUm(p, HL1060_BED, 'top-left')).toEqual({ xUm: 10_000, yUm: 20_000 });
    expect(jobPointToMachineUm(p, HL1060_BED, 'top-right')).toEqual({ xUm: 990_000, yUm: 20_000 });
    expect(jobPointToMachineUm(p, HL1060_BED, 'bottom-left')).toEqual({ xUm: 10_000, yUm: 580_000 });
    expect(jobPointToMachineUm(p, HL1060_BED, 'bottom-right')).toEqual({ xUm: 990_000, yUm: 580_000 });
  });

  it('defaults to top-left', () => {
    expect(lines(RECTANGLE_JOB)).toEqual(lines(RECTANGLE_JOB, { ...TEST_OPTIONS, origin: 'top-left' }));
  });

  it('mirrors geometry and bounding boxes for a top-right machine and stays on the bed', () => {
    const text = lines(RECTANGLE_JOB, { ...TEST_OPTIONS, origin: 'top-right' }).map((line) => line.split(' | ')[0]);
    expect(text).toContain('Process top-left 940.000mm 10.000mm');
    expect(text).toContain('Process bottom-right 990.000mm 40.000mm');
    expect(text).toContain('Move abs 990.000mm 10.000mm');
    expect(text).toContain('Cut abs 940.000mm 10.000mm');
  });
});

describe('safety: power', () => {
  const job = (maxPowerPct: number, minPowerPct: number) =>
    jobOf(layerOf([rectPath(0, 0, 10, 10)], { maxPowerPct, minPowerPct }));

  it('never writes a power above the cap, whatever the layer asks for', () => {
    for (const cap of [0, 1, 2, 25, 60, 100]) {
      for (const power of allPowers(job(100, 100), { ...TEST_OPTIONS, maxPowerCapPct: cap })) {
        expect(power).toBeLessThanOrEqual(cap);
      }
    }
    expect(powerOf(job(90, 80), { ...TEST_OPTIONS, maxPowerCapPct: 25 }, 'Laser 1 max power')).toBeCloseTo(25, 1);
    expect(powerOf(job(90, 80), { ...TEST_OPTIONS, maxPowerCapPct: 25 }, 'Laser 1 min power')).toBeCloseTo(25, 1);
    expect(powerOf(job(90, 80), { ...TEST_OPTIONS, maxPowerCapPct: 25 }, 'Layer laser 1 max power')).toBeCloseTo(25, 1);
  });

  it('clamps layer power to 0–100 %', () => {
    expect(powerOf(job(250, 20), TEST_OPTIONS, 'Laser 1 max power')).toBe(100);
    expect(powerOf(job(-5, -10), TEST_OPTIONS, 'Laser 1 max power')).toBe(0);
    expect(powerOf(job(-5, -10), TEST_OPTIONS, 'Laser 1 min power')).toBe(0);
  });

  it('clamps the cap itself to 0–100 %', () => {
    expect(powerOf(job(250, 20), { ...TEST_OPTIONS, maxPowerCapPct: 400 }, 'Laser 1 max power')).toBe(100);
    for (const power of allPowers(job(80, 40), { ...TEST_OPTIONS, maxPowerCapPct: -20 })) {
      expect(power).toBe(0);
    }
  });

  it('never lets min power exceed max power', () => {
    const options = { ...TEST_OPTIONS, maxPowerCapPct: 50 };
    expect(powerOf(job(30, 70), TEST_OPTIONS, 'Laser 1 min power')).toBeCloseTo(30, 1);
    expect(powerOf(job(30, 70), TEST_OPTIONS, 'Layer laser 1 min power')).toBeCloseTo(30, 1);
    expect(powerOf(job(80, 70), options, 'Laser 1 min power')).toBeCloseTo(50, 1);
    expect(powerOf(job(80, 70), options, 'Laser 1 min power')).toBeLessThanOrEqual(
      powerOf(job(80, 70), options, 'Laser 1 max power'),
    );
  });

  it('refuses non-finite power and a non-finite cap', () => {
    expect(() => buildRuidaCommands(job(Number.NaN, 10), TEST_OPTIONS)).toThrow(RuidaJobError);
    expect(() => buildRuidaCommands(job(30, Number.POSITIVE_INFINITY), TEST_OPTIONS)).toThrow(RuidaJobError);
    expect(() => buildRuidaCommands(job(30, 10), { ...TEST_OPTIONS, maxPowerCapPct: Number.NaN })).toThrow(
      RuidaJobError,
    );
  });
});

describe('safety: bed bounds', () => {
  const single = (x: number, y: number) =>
    jobOf(
      layerOf([
        {
          closed: false,
          points: [
            { x: 5, y: 5 },
            { x, y },
          ],
        },
      ]),
    );

  it('accepts points on the bed edge', () => {
    expect(() => buildRuidaCommands(single(1000, 600), TEST_OPTIONS)).not.toThrow();
    expect(() => buildRuidaCommands(single(0, 0), TEST_OPTIONS)).not.toThrow();
    expect(() => buildRuidaCommands(single(1000 + 5e-7, -5e-7), TEST_OPTIONS)).not.toThrow();
  });

  it('refuses any point outside the bed instead of clipping it', () => {
    for (const [x, y] of [
      [1000.001, 300],
      [-0.001, 300],
      [500, 600.001],
      [500, -0.001],
      [5000, 5000],
    ] as const) {
      expect(() => buildRuidaCommands(single(x, y), TEST_OPTIONS), `${x}, ${y}`).toThrow(RuidaJobError);
      expect(() => buildRuidaCommands(single(x, y), TEST_OPTIONS)).toThrow(/outside the 1000 × 600 mm bed/);
    }
  });

  it('checks against the bed that was passed in', () => {
    const small = { ...TEST_OPTIONS, bed: { widthMm: 300, heightMm: 200 } };
    expect(() => buildRuidaCommands(single(300, 200), small)).not.toThrow();
    expect(() => buildRuidaCommands(single(301, 100), small)).toThrow(RuidaJobError);
  });

  it('checks before mirroring, so a flipped origin cannot hide an overrun', () => {
    for (const origin of ['top-right', 'bottom-left', 'bottom-right'] as const) {
      expect(() => buildRuidaCommands(single(1001, 300), { ...TEST_OPTIONS, origin })).toThrow(RuidaJobError);
      expect(() => buildRuidaCommands(single(500, -1), { ...TEST_OPTIONS, origin })).toThrow(RuidaJobError);
    }
  });

  it('refuses non-finite coordinates', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => buildRuidaCommands(single(bad, 10), TEST_OPTIONS)).toThrow(/non-finite/);
      expect(() => buildRuidaCommands(single(10, bad), TEST_OPTIONS)).toThrow(RuidaJobError);
    }
  });

  it('refuses an invalid bed', () => {
    for (const bed of [
      { widthMm: 0, heightMm: 600 },
      { widthMm: 1000, heightMm: -1 },
      { widthMm: Number.NaN, heightMm: 600 },
    ]) {
      expect(() => buildRuidaCommands(RECTANGLE_JOB, { ...TEST_OPTIONS, bed })).toThrow(RuidaJobError);
    }
  });
});

describe('safety: empty and degenerate jobs', () => {
  it('refuses a job with no layers or only empty layers', () => {
    expect(() => buildRuidaCommands({ layers: [], bounds: null }, TEST_OPTIONS)).toThrow(/empty/);
    expect(() => buildRuidaCommands(jobOf(layerOf([])), TEST_OPTIONS)).toThrow(/empty/);
    expect(() => encodeRuidaJob({ layers: [], bounds: null }, TEST_OPTIONS)).toThrow(RuidaJobError);
  });

  it('refuses a path without length', () => {
    const onePoint = jobOf(layerOf([{ closed: true, points: [{ x: 1, y: 1 }] }]));
    const noPoints = jobOf(layerOf([{ closed: false, points: [] }]));
    const samePoint = jobOf(
      layerOf([
        {
          closed: true,
          points: [
            { x: 1, y: 1 },
            { x: 1, y: 1 },
          ],
        },
      ]),
    );
    for (const job of [onePoint, noPoints, samePoint]) {
      expect(() => buildRuidaCommands(job, TEST_OPTIONS)).toThrow(/no length/);
    }
  });

  it('refuses an invalid pass count', () => {
    for (const passes of [0, -1, 1.5, Number.NaN, RUIDA_MAX_PASSES + 1]) {
      const job = jobOf(layerOf([rectPath(0, 0, 10, 10)], { passes }));
      expect(() => buildRuidaCommands(job, TEST_OPTIONS), `${passes}`).toThrow(RuidaJobError);
    }
  });

  it('refuses a malformed colour', () => {
    const job = jobOf(layerOf([rectPath(0, 0, 10, 10)], { color: 'blue' }));
    expect(() => buildRuidaCommands(job, TEST_OPTIONS)).toThrow(/colour/);
  });
});

describe('safety: speed', () => {
  const job = (speedMmS: number) => jobOf(layerOf([rectPath(0, 0, 10, 10)], { speedMmS }));

  it('refuses zero, negative and non-finite speeds', () => {
    for (const speed of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 0.0000001]) {
      expect(() => buildRuidaCommands(job(speed), TEST_OPTIONS), `${speed}`).toThrow(RuidaJobError);
    }
  });

  it('refuses speeds above the driver limit instead of lowering them', () => {
    expect(() => buildRuidaCommands(job(RUIDA_MAX_SPEED_MM_S), TEST_OPTIONS)).not.toThrow();
    expect(() => buildRuidaCommands(job(RUIDA_MAX_SPEED_MM_S + 0.001), TEST_OPTIONS)).toThrow(/above the driver limit/);
  });

  it('validates the travel speed but does not write it', () => {
    const withTravel = buildRuidaCommands(RECTANGLE_JOB, { ...TEST_OPTIONS, travelSpeedMmS: 200 });
    expect(Array.from(withTravel)).toEqual(Array.from(buildRuidaCommands(RECTANGLE_JOB, TEST_OPTIONS)));
    for (const travelSpeedMmS of [0, -1, Number.NaN, RUIDA_MAX_SPEED_MM_S + 1]) {
      expect(() => buildRuidaCommands(RECTANGLE_JOB, { ...TEST_OPTIONS, travelSpeedMmS })).toThrow(RuidaJobError);
    }
  });
});
