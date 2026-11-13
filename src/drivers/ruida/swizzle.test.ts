import { describe, expect, it } from 'vitest';
import { RUIDA_MAGIC_644X, swizzle, swizzleByte, unswizzle, unswizzleByte } from './swizzle';

describe('swizzle', () => {
  it('round-trips every byte value for several magic bytes', () => {
    for (const magic of [RUIDA_MAGIC_644X, 0x11, 0x38, 0x00, 0xff]) {
      const seen = new Set<number>();
      for (let b = 0; b < 256; b++) {
        const scrambled = swizzleByte(b, magic);
        expect(scrambled).toBeGreaterThanOrEqual(0);
        expect(scrambled).toBeLessThanOrEqual(255);
        expect(unswizzleByte(scrambled, magic)).toBe(b);
        seen.add(scrambled);
      }
      expect(seen.size).toBe(256);
    }
  });

  it('matches the documented steps: swap bit 0 and bit 7, XOR magic, add 1', () => {
    // 0x00 → swap 0x00 → ^0x88 = 0x88 → +1 = 0x89 (plain zero is "magic + 1").
    expect(swizzleByte(0x00, 0x88)).toBe(0x89);
    // 0x01 → swap 0x80 → ^0x88 = 0x08 → +1.
    expect(swizzleByte(0x01, 0x88)).toBe(0x09);
    // 0x80 → swap 0x01 → ^0x88 = 0x89 → +1.
    expect(swizzleByte(0x80, 0x88)).toBe(0x8a);
    // 0x77 → swap 0xf6 → ^0x88 = 0x7e → +1.
    expect(swizzleByte(0x77, 0x88)).toBe(0x7f);
    // Add wraps around: 0x76 → swap 0x76 → ^0x89 = 0xff → +1 = 0x00.
    expect(swizzleByte(0x76, 0x89)).toBe(0x00);
    expect(unswizzleByte(0x00, 0x89)).toBe(0x76);
    // Other models only change the XOR value.
    expect(swizzleByte(0x00, 0x11)).toBe(0x12);
  });

  it('matches bytes observed in RDWorks files for an RDC644x', () => {
    // RDWorks .rd files start with the plain commands D8 12, F0 and end with
    // D7; on disk those are D2 9B FA ... 60 (jnweiger/ruida-laser example files).
    expect(Array.from(swizzle(Uint8Array.of(0xd8, 0x12, 0xf0), RUIDA_MAGIC_644X))).toEqual([0xd2, 0x9b, 0xfa]);
    expect(swizzleByte(0xd7, RUIDA_MAGIC_644X)).toBe(0x60);
    expect(Array.from(unswizzle(Uint8Array.of(0xd2, 0x9b, 0xfa, 0x60), RUIDA_MAGIC_644X))).toEqual([
      0xd8, 0x12, 0xf0, 0xd7,
    ]);
  });

  it('scrambles arrays without touching the input', () => {
    const plain = Uint8Array.of(0x88, 0x00, 0x7f);
    const scrambled = swizzle(plain, RUIDA_MAGIC_644X);
    expect(Array.from(plain)).toEqual([0x88, 0x00, 0x7f]);
    expect(scrambled).not.toBe(plain);
    expect(Array.from(unswizzle(scrambled, RUIDA_MAGIC_644X))).toEqual([0x88, 0x00, 0x7f]);
  });
});
