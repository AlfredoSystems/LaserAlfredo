/** Machine bed size. All internal units are millimetres. */
export interface Bed {
  readonly widthMm: number;
  readonly heightMm: number;
}

/** HL1060 working area. Origin is top-left, Y increases downward. */
export const HL1060_BED: Bed = { widthMm: 1000, heightMm: 600 };

/** True when the point lies on or inside the bed. */
export function isInsideBed(bed: Bed, xMm: number, yMm: number): boolean {
  return xMm >= 0 && yMm >= 0 && xMm <= bed.widthMm && yMm <= bed.heightMm;
}
