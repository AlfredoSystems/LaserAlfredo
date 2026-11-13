/**
 * Ruida value encodings. Only the first byte of a command has its top bit
 * set, so every parameter byte carries 7 bits, most significant group first.
 * See docs/ruida-protocol.md for the layouts and their sources.
 */

/** Power value that means 100 % (14 bits, all ones). */
export const POWER_FULL_SCALE = 0x3fff;

const INT35_MODULUS = 2 ** 35;
const INT35_MAX = 2 ** 34 - 1;
const INT35_MIN = -(2 ** 34);
const INT14_MODULUS = 2 ** 14;
const INT14_MAX = 2 ** 13 - 1;
const INT14_MIN = -(2 ** 13);

/** Encodes a non-negative integer as `byteCount` 7-bit groups, big-endian. */
export function encodeUnsigned(value: number, byteCount: number): Uint8Array {
  const limit = 2 ** (7 * byteCount);
  if (!Number.isInteger(value) || value < 0 || value >= limit) {
    throw new RangeError(`Value ${value} does not fit in ${byteCount} seven-bit bytes.`);
  }
  const out = new Uint8Array(byteCount);
  let rest = value;
  for (let i = byteCount - 1; i >= 0; i--) {
    out[i] = rest % 128;
    rest = Math.floor(rest / 128);
  }
  return out;
}

/** Decodes 7-bit groups, big-endian, into a non-negative integer. */
export function decodeUnsigned(bytes: ArrayLike<number>): number {
  let value = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    if (b < 0 || b > 0x7f) {
      throw new RangeError(`Parameter byte 0x${b.toString(16)} has its top bit set.`);
    }
    value = value * 128 + b;
  }
  return value;
}

/** Signed 35-bit two's complement in 5 bytes (absolute coordinates). */
export function encodeInt35(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < INT35_MIN || value > INT35_MAX) {
    throw new RangeError(`Value ${value} does not fit in a signed 35-bit number.`);
  }
  return encodeUnsigned(value < 0 ? value + INT35_MODULUS : value, 5);
}

export function decodeInt35(bytes: ArrayLike<number>): number {
  if (bytes.length !== 5) throw new RangeError('A 35-bit number needs 5 bytes.');
  const raw = decodeUnsigned(bytes);
  return raw > INT35_MAX ? raw - INT35_MODULUS : raw;
}

/** Signed 14-bit two's complement in 2 bytes (relative coordinates). */
export function encodeInt14(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < INT14_MIN || value > INT14_MAX) {
    throw new RangeError(`Value ${value} does not fit in a signed 14-bit number.`);
  }
  return encodeUnsigned(value < 0 ? value + INT14_MODULUS : value, 2);
}

export function decodeInt14(bytes: ArrayLike<number>): number {
  if (bytes.length !== 2) throw new RangeError('A 14-bit number needs 2 bytes.');
  const raw = decodeUnsigned(bytes);
  return raw > INT14_MAX ? raw - INT14_MODULUS : raw;
}

/** Millimetres to whole micrometres, the unit of every Ruida coordinate. */
export function mmToMicrometres(mm: number): number {
  if (!Number.isFinite(mm)) throw new RangeError(`Length ${mm} mm is not finite.`);
  const um = Math.round(mm * 1000);
  return um === 0 ? 0 : um;
}

/** Absolute coordinate: 5 bytes, signed, micrometres. */
export function encodeAbsCoordMm(mm: number): Uint8Array {
  return encodeInt35(mmToMicrometres(mm));
}

/** Relative coordinate: 2 bytes, signed, micrometres (±8.19 mm). */
export function encodeRelCoordMm(mm: number): Uint8Array {
  return encodeInt14(mmToMicrometres(mm));
}

/**
 * Power: 2 bytes, 0x3FFF = 100 %. Rounds down, so the encoded power is never
 * above the requested one. RDWorks files round the same way (1 % → 01 23).
 */
export function encodePowerPct(pct: number): Uint8Array {
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new RangeError(`Power ${pct} % is outside 0–100 %.`);
  }
  return encodeUnsigned(Math.floor((pct * POWER_FULL_SCALE) / 100), 2);
}

export function decodePowerPct(bytes: ArrayLike<number>): number {
  if (bytes.length !== 2) throw new RangeError('A power value needs 2 bytes.');
  return (decodeUnsigned(bytes) * 100) / POWER_FULL_SCALE;
}

/** Speed: 5 bytes, unsigned, micrometres per second. */
export function encodeSpeedMmS(mmPerSecond: number): Uint8Array {
  if (!Number.isFinite(mmPerSecond) || mmPerSecond < 0) {
    throw new RangeError(`Speed ${mmPerSecond} mm/s is not a non-negative finite number.`);
  }
  return encodeUnsigned(Math.round(mmPerSecond * 1000), 5);
}

/** Layer colour: 5 bytes holding blue << 16 | green << 8 | red. Takes `#rrggbb`. */
export function encodeColor(hex: string): Uint8Array {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new RangeError(`Colour "${hex}" is not in #rrggbb form.`);
  const [, r = '', g = '', b = ''] = match;
  const value = parseInt(b, 16) * 65536 + parseInt(g, 16) * 256 + parseInt(r, 16);
  return encodeUnsigned(value, 5);
}

/** Reverses `encodeColor`, returning lowercase `#rrggbb`. */
export function decodeColor(bytes: ArrayLike<number>): string {
  if (bytes.length !== 5) throw new RangeError('A colour needs 5 bytes.');
  const value = decodeUnsigned(bytes);
  const part = (n: number) => (n & 0xff).toString(16).padStart(2, '0');
  return `#${part(value)}${part(value >> 8)}${part(value >> 16)}`;
}
