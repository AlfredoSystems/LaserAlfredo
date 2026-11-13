import { describe, expect, it } from 'vitest';
import {
  decodeColor,
  decodeInt14,
  decodeInt35,
  decodePowerPct,
  decodeUnsigned,
  encodeAbsCoordMm,
  encodeColor,
  encodeInt14,
  encodeInt35,
  encodePowerPct,
  encodeRelCoordMm,
  encodeSpeedMmS,
  encodeUnsigned,
  mmToMicrometres,
} from './encode';

const bytes = (...values: number[]) => values;
const arr = (u: Uint8Array) => Array.from(u);

describe('7-bit numbers', () => {
  it('encodes big-endian groups of 7 bits', () => {
    expect(arr(encodeUnsigned(0, 2))).toEqual(bytes(0x00, 0x00));
    expect(arr(encodeUnsigned(127, 2))).toEqual(bytes(0x00, 0x7f));
    expect(arr(encodeUnsigned(128, 2))).toEqual(bytes(0x01, 0x00));
    expect(arr(encodeUnsigned(0x3fff, 2))).toEqual(bytes(0x7f, 0x7f));
    expect(decodeUnsigned(bytes(0x01, 0x00))).toBe(128);
  });

  it('never produces a byte with the top bit set', () => {
    for (const value of [0, 1, 127, 128, 16383, 16384, 2 ** 31, 2 ** 35 - 1]) {
      for (const b of encodeUnsigned(value, 5)) expect(b).toBeLessThan(0x80);
    }
  });

  it('refuses values that do not fit', () => {
    expect(() => encodeUnsigned(16384, 2)).toThrow(RangeError);
    expect(() => encodeUnsigned(-1, 2)).toThrow(RangeError);
    expect(() => encodeUnsigned(1.5, 2)).toThrow(RangeError);
    expect(() => encodeUnsigned(Number.NaN, 2)).toThrow(RangeError);
    expect(() => decodeUnsigned(bytes(0x80))).toThrow(RangeError);
  });
});

describe('absolute coordinates (5 bytes, signed µm)', () => {
  it('matches values seen in documented files', () => {
    // 50 mm, from the bounding box of a 50 mm RDWorks square.
    expect(arr(encodeAbsCoordMm(50))).toEqual(bytes(0x00, 0x00, 0x03, 0x06, 0x50));
    // 12 mm and 10 mm, the first move of the same file's triangle.
    expect(arr(encodeAbsCoordMm(12))).toEqual(bytes(0x00, 0x00, 0x00, 0x5d, 0x60));
    expect(arr(encodeAbsCoordMm(10))).toEqual(bytes(0x00, 0x00, 0x00, 0x4e, 0x10));
    expect(arr(encodeAbsCoordMm(0))).toEqual(bytes(0, 0, 0, 0, 0));
  });

  it("uses 35-bit two's complement for negatives", () => {
    // Documented limits: 0x7FFFFFFFF is -1 µm, 0x400000000 the most negative.
    expect(arr(encodeInt35(-1))).toEqual(bytes(0x7f, 0x7f, 0x7f, 0x7f, 0x7f));
    expect(arr(encodeInt35(-(2 ** 34)))).toEqual(bytes(0x40, 0x00, 0x00, 0x00, 0x00));
    expect(arr(encodeInt35(2 ** 34 - 1))).toEqual(bytes(0x3f, 0x7f, 0x7f, 0x7f, 0x7f));
    // -50 mm as it appears in an RDWorks array block.
    expect(arr(encodeAbsCoordMm(-50))).toEqual(bytes(0x7f, 0x7f, 0x7c, 0x79, 0x30));
  });

  it('round-trips and refuses out-of-range values', () => {
    for (const value of [0, 1, -1, 999_999, -999_999, 1_000_000, 2 ** 34 - 1, -(2 ** 34)]) {
      expect(decodeInt35(encodeInt35(value))).toBe(value);
    }
    expect(() => encodeInt35(2 ** 34)).toThrow(RangeError);
    expect(() => encodeInt35(-(2 ** 34) - 1)).toThrow(RangeError);
    expect(() => encodeAbsCoordMm(Number.NaN)).toThrow(RangeError);
    expect(() => encodeAbsCoordMm(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => decodeInt35(bytes(0, 0))).toThrow(RangeError);
  });

  it('rounds to the nearest micrometre and never yields negative zero', () => {
    expect(mmToMicrometres(10.0004)).toBe(10000);
    expect(mmToMicrometres(10.0006)).toBe(10001);
    expect(Object.is(mmToMicrometres(-0.0000001), 0)).toBe(true);
  });
});

describe('relative coordinates (2 bytes, signed µm)', () => {
  it('matches values seen in an RDWorks file', () => {
    // "89 1f 20 60 60": move +4 mm, -4 mm. "aa 51 10": cut -6 mm.
    expect(arr(encodeRelCoordMm(4))).toEqual(bytes(0x1f, 0x20));
    expect(arr(encodeRelCoordMm(-4))).toEqual(bytes(0x60, 0x60));
    expect(arr(encodeRelCoordMm(-6))).toEqual(bytes(0x51, 0x10));
    expect(arr(encodeRelCoordMm(3))).toEqual(bytes(0x17, 0x38));
  });

  it("uses 14-bit two's complement and refuses anything past ±8.19 mm", () => {
    expect(arr(encodeInt14(-1))).toEqual(bytes(0x7f, 0x7f));
    expect(arr(encodeInt14(8191))).toEqual(bytes(0x3f, 0x7f));
    expect(arr(encodeInt14(-8192))).toEqual(bytes(0x40, 0x00));
    expect(decodeInt14(bytes(0x40, 0x00))).toBe(-8192);
    expect(decodeInt14(bytes(0x3f, 0x7f))).toBe(8191);
    expect(() => encodeInt14(8192)).toThrow(RangeError);
    expect(() => encodeInt14(-8193)).toThrow(RangeError);
    expect(() => encodeRelCoordMm(8.2)).toThrow(RangeError);
  });
});

describe('power (2 bytes, 0x3FFF = 100 %)', () => {
  it('matches the RDWorks percentage table (jnweiger laser_percentages)', () => {
    const documented: [number, number, number][] = [
      [1, 0x01, 0x23],
      [2, 0x02, 0x47],
      [3, 0x03, 0x6b],
      [4, 0x05, 0x0f],
      [9, 0x0b, 0x42],
      [15, 0x13, 0x19],
      [30, 0x26, 0x32],
      [32, 0x28, 0x7a],
      [50, 0x3f, 0x7f],
      [69, 0x58, 0x28],
    ];
    for (const [pct, high, low] of documented) {
      expect(arr(encodePowerPct(pct)), `${pct} %`).toEqual(bytes(high, low));
    }
  });

  it('encodes the limits and rounds down', () => {
    expect(arr(encodePowerPct(0))).toEqual(bytes(0x00, 0x00));
    expect(arr(encodePowerPct(100))).toEqual(bytes(0x7f, 0x7f));
    for (let pct = 0; pct <= 100; pct += 0.37) {
      expect(decodePowerPct(encodePowerPct(pct))).toBeLessThanOrEqual(pct);
      expect(decodePowerPct(encodePowerPct(pct))).toBeGreaterThan(pct - 0.007);
    }
  });

  it('refuses anything outside 0–100 %', () => {
    expect(() => encodePowerPct(100.01)).toThrow(RangeError);
    expect(() => encodePowerPct(-0.01)).toThrow(RangeError);
    expect(() => encodePowerPct(Number.NaN)).toThrow(RangeError);
    expect(() => encodePowerPct(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('speed (5 bytes, µm/s)', () => {
  it('matches documented values', () => {
    // "c9 02 00 00 06 0d 20" = 100 mm/s, "... 04 71 00" = 80 mm/s, "... 01 6a 30" = 30 mm/s.
    expect(arr(encodeSpeedMmS(100))).toEqual(bytes(0x00, 0x00, 0x06, 0x0d, 0x20));
    expect(arr(encodeSpeedMmS(80))).toEqual(bytes(0x00, 0x00, 0x04, 0x71, 0x00));
    expect(arr(encodeSpeedMmS(30))).toEqual(bytes(0x00, 0x00, 0x01, 0x6a, 0x30));
  });

  it('refuses negative and non-finite speeds', () => {
    expect(() => encodeSpeedMmS(-1)).toThrow(RangeError);
    expect(() => encodeSpeedMmS(Number.NaN)).toThrow(RangeError);
  });
});

describe('colour (5 bytes, blue-green-red)', () => {
  it('matches documented layer colours', () => {
    // "ca 06 01 00 00 00 01 7f" is red, "ca 06 01 00 07 7c 00 00" is blue.
    expect(arr(encodeColor('#ff0000'))).toEqual(bytes(0x00, 0x00, 0x00, 0x01, 0x7f));
    expect(arr(encodeColor('#0000ff'))).toEqual(bytes(0x00, 0x07, 0x7c, 0x00, 0x00));
    expect(arr(encodeColor('#00ff00'))).toEqual(bytes(0x00, 0x00, 0x03, 0x7e, 0x00));
    expect(arr(encodeColor('#000000'))).toEqual(bytes(0, 0, 0, 0, 0));
  });

  it('round-trips and refuses malformed colours', () => {
    expect(decodeColor(encodeColor('#12ab9F'))).toBe('#12ab9f');
    expect(() => encodeColor('red')).toThrow(RangeError);
    expect(() => encodeColor('#fff')).toThrow(RangeError);
  });
});
