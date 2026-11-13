/**
 * Ruida byte scrambling ("swizzle"). Every byte of an `.rd` file is scrambled
 * on its own: swap bit 0 and bit 7, XOR with a per-model magic byte, add 1.
 * See docs/ruida-protocol.md for sources.
 */

/** Magic byte for RDC644x controllers (including the RDC6442G/S). */
export const RUIDA_MAGIC_644X = 0x88;

function swapOuterBits(b: number): number {
  return (b & 0x7e) | ((b >> 7) & 0x01) | ((b << 7) & 0x80);
}

/** Scrambles one plain byte (0–255). */
export function swizzleByte(b: number, magic: number): number {
  return ((swapOuterBits(b & 0xff) ^ (magic & 0xff)) + 1) & 0xff;
}

/** Reverses `swizzleByte`. */
export function unswizzleByte(b: number, magic: number): number {
  return swapOuterBits((((b & 0xff) + 0xff) & 0xff) ^ (magic & 0xff));
}

/** Scrambles a plain command stream into `.rd` file bytes. */
export function swizzle(bytes: Uint8Array, magic: number): Uint8Array {
  return bytes.map((b) => swizzleByte(b, magic));
}

/** Turns `.rd` file bytes back into the plain command stream. */
export function unswizzle(bytes: Uint8Array, magic: number): Uint8Array {
  return bytes.map((b) => unswizzleByte(b, magic));
}
