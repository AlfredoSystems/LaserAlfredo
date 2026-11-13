/** Colour used when nothing else is known, and for anything white (the canvas is light). */
export const DEFAULT_COLOR = '#000000';

/** ACI value meaning "take the colour of the INSERT that placed this block". */
export const ACI_BYBLOCK = 0;
/** ACI value meaning "take the colour of the entity's layer". */
export const ACI_BYLAYER = 256;

/** Channels at or above this make a colour count as white. */
const NEAR_WHITE_CHANNEL = 240;

/**
 * The standard AutoCAD Color Index palette, entries 0-255 as rrggbb. Entries 0
 * and 7 are never looked up as colours (BYBLOCK, and white-or-black).
 */
const ACI_PALETTE =
  '000000ff0000ffff0000ff0000ffff0000ffff00ffffffff808080c0c0c0' +
  'ff0000ff7f7fcc0000cc6666990000994c4c7f00007f3f3f4c00004c2626' +
  'ff3f00ff9f7fcc3300cc7f66992600995f4c7f1f007f4f3f4c13004c2f26' +
  'ff7f00ffbf7fcc6600cc9966994c0099724c7f3f007f5f3f4c26004c3926' +
  'ffbf00ffdf7fcc9900ccb26699720099854c7f5f007f6f3f4c39004c4226' +
  'ffff00ffff7fcccc00cccc6698980098984c7f7f007f7f3f4c4c004c4c26' +
  'bfff00dfff7f99cc00b2cc6672980085984c5f7f006f7f3f394c00424c26' +
  '7fff00bfff7f66cc0099cc664c980072984c3f7f005f7f3f264c00394c26' +
  '3fff009fff7f33cc007fcc662698005f984c1f7f004f7f3f134c002f4c26' +
  '00ff007fff7f00cc0066cc660098004c984c007f003f7f3f004c00264c26' +
  '00ff3f7fff9f00cc3366cc7f0098264c985f007f1f3f7f4f004c13264c2f' +
  '00ff7f7fffbf00cc6666cc9900984c4c9872007f3f3f7f5f004c26264c39' +
  '00ffbf7fffdf00cc9966ccb20098724c9885007f5f3f7f6f004c39264c42' +
  '00ffff7fffff00cccc66cccc0098984c9898007f7f3f7f7f004c4c264c4c' +
  '00bfff7fdfff0099cc66b2cc0072984c8598005f7f3f6f7f00394c26424c' +
  '007fff7fbfff0066cc6699cc004c984c7298003f7f3f5f7f00264c26394c' +
  '003fff7f9fff0033cc667fcc0026984c5f98001f7f3f4f7f00134c262f4c' +
  '0000ff7f7fff0000cc6666cc0000984c4c9800007f3f3f7f00004c26264c' +
  '3f00ff9f7fff3300cc7f66cc2600985f4c981f007f4f3f7f13004c2f264c' +
  '7f00ffbf7fff6600cc9966cc4c0098724c983f007f5f3f7f26004c39264c' +
  'bf00ffdf7fff9900ccb266cc720098854c985f007f6f3f7f39004c42264c' +
  'ff00ffff7fffcc00cccc66cc980098984c987f007f7f3f7f4c004c4c264c' +
  'ff00bfff7fdfcc0099cc66b2980072984c857f005f7f3f6f4c00394c2642' +
  'ff007fff7fbfcc0066cc669998004c984c727f003f7f3f5f4c00264c2639' +
  'ff003fff7f9fcc0033cc667f980026984c5f7f001f7f3f4f4c00134c262f' +
  '3333335b5b5b848484adadadd6d6d6ffffff';

/** White and near-white would be invisible on the light canvas, so they become black. */
function darkenWhite(rgb: number): string {
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  if (r >= NEAR_WHITE_CHANNEL && g >= NEAR_WHITE_CHANNEL && b >= NEAR_WHITE_CHANNEL) return DEFAULT_COLOR;
  return `#${rgb.toString(16).padStart(6, '0')}`;
}

/** A 24-bit DXF true colour (group 420) as lowercase `#rrggbb`. */
export function trueColorToHex(value: number): string {
  if (!Number.isFinite(value)) return DEFAULT_COLOR;
  return darkenWhite(Math.trunc(value) & 0xffffff);
}

/** An explicit ACI colour (1-255) as lowercase `#rrggbb`; anything else gives the default. */
export function aciToHex(index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > 255 || index === 7) return DEFAULT_COLOR;
  const rgb = Number.parseInt(ACI_PALETTE.slice(index * 6, index * 6 + 6), 16);
  return Number.isFinite(rgb) ? darkenWhite(rgb) : DEFAULT_COLOR;
}
