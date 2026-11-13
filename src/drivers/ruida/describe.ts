import { decodeColor, decodeInt14, decodeInt35, decodePowerPct, decodeUnsigned } from './encode';

/**
 * Disassembler for an unscrambled Ruida command stream. It exists so tests
 * and golden files have a readable companion; it knows the commands this
 * driver emits plus the ones seen in RDWorks vector files. Names follow
 * docs/ruida-protocol.md and are as uncertain as the notes there.
 */

type Field =
  | 'abs' // 5 bytes, signed micrometres
  | 'rel' // 2 bytes, signed micrometres
  | 'power' // 2 bytes, 0x3FFF = 100 %
  | 'speed' // 5 bytes, micrometres per second
  | 'time' // 5 bytes, microseconds
  | 'color' // 5 bytes, BGR
  | 'u7' // 1 byte
  | 'u14' // 2 bytes
  | 'i35' // 5 bytes, signed raw value
  | 'raw10'; // 10 opaque bytes

const FIELD_SIZE: Record<Field, number> = {
  abs: 5,
  rel: 2,
  power: 2,
  speed: 5,
  time: 5,
  color: 5,
  u7: 1,
  u14: 2,
  i35: 5,
  raw10: 10,
};

interface CommandSpec {
  readonly name: string;
  readonly fields: readonly Field[];
}

const spec = (name: string, ...fields: Field[]): CommandSpec => ({ name, fields });

/** Keyed by the fixed leading bytes of a command, as lowercase hex. */
const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  '88': spec('Move abs', 'abs', 'abs'),
  '89': spec('Move rel', 'rel', 'rel'),
  '8a': spec('Move rel X', 'rel'),
  '8b': spec('Move rel Y', 'rel'),
  a8: spec('Cut abs', 'abs', 'abs'),
  a9: spec('Cut rel', 'rel', 'rel'),
  aa: spec('Cut rel X', 'rel'),
  ab: spec('Cut rel Y', 'rel'),
  'c6 01': spec('Laser 1 min power', 'power'),
  'c6 02': spec('Laser 1 max power', 'power'),
  'c6 21': spec('Laser 2 min power', 'power'),
  'c6 22': spec('Laser 2 max power', 'power'),
  'c6 05': spec('Laser 3 min power', 'power'),
  'c6 06': spec('Laser 3 max power', 'power'),
  'c6 07': spec('Laser 4 min power', 'power'),
  'c6 08': spec('Laser 4 max power', 'power'),
  'c6 12': spec('Laser on delay', 'time'),
  'c6 13': spec('Laser off delay', 'time'),
  'c6 15': spec('Laser on delay 2', 'time'),
  'c6 16': spec('Laser off delay 2', 'time'),
  'c6 31': spec('Layer laser 1 min power', 'u7', 'power'),
  'c6 32': spec('Layer laser 1 max power', 'u7', 'power'),
  'c6 41': spec('Layer laser 2 min power', 'u7', 'power'),
  'c6 42': spec('Layer laser 2 max power', 'u7', 'power'),
  'c6 35': spec('Layer laser 3 min power', 'u7', 'power'),
  'c6 36': spec('Layer laser 3 max power', 'u7', 'power'),
  'c6 37': spec('Layer laser 4 min power', 'u7', 'power'),
  'c6 38': spec('Layer laser 4 max power', 'u7', 'power'),
  'c6 50': spec('Through power 1', 'power'),
  'c6 51': spec('Through power 2', 'power'),
  'c6 55': spec('Through power 3', 'power'),
  'c6 56': spec('Through power 4', 'power'),
  'c9 02': spec('Speed', 'speed'),
  'c9 04': spec('Layer speed', 'u7', 'speed'),
  'ca 01 00': spec('Layer flag 00 (docs: "End Layer")'),
  'ca 01 10': spec('Layer device 0'),
  'ca 01 11': spec('Layer device 1'),
  'ca 01 12': spec('Air assist off'),
  'ca 01 13': spec('Air assist on'),
  'ca 01 30': spec('Laser 2 offset disabled'),
  'ca 01 31': spec('Laser 2 offset enabled'),
  'ca 02': spec('Layer number', 'u7'),
  'ca 03': spec('Laser tube enable', 'u7'),
  'ca 06': spec('Layer colour', 'u7', 'color'),
  'ca 10': spec('Ext IO enable', 'u7'),
  'ca 22': spec('Max layer index', 'u7'),
  'ca 41': spec('Layer work mode', 'u7', 'u7'),
  d7: spec('End of file'),
  'd8 00': spec('Start process'),
  'd8 10': spec('Ref point mode 2 (machine zero, absolute)'),
  'd8 11': spec('Ref point mode 1 (anchor point)'),
  'd8 12': spec('Ref point mode 0 (current position)'),
  'da 01': spec('Set param', 'u7', 'u7', 'i35', 'i35'),
  'e6 01': spec('Set absolute'),
  'e7 00': spec('Block end'),
  'e7 03': spec('Process top-left', 'abs', 'abs'),
  'e7 07': spec('Process bottom-right', 'abs', 'abs'),
  'e7 04': spec('Process repeat', 'u14', 'u14', 'abs', 'abs'),
  'e7 05': spec('Array direction', 'u7'),
  'e7 06': spec('Feed repeat', 'abs', 'abs'),
  'e7 08': spec('Array repeat', 'u14', 'u14', 'abs', 'abs'),
  'e7 13': spec('Array min point', 'abs', 'abs'),
  'e7 17': spec('Array max point', 'abs', 'abs'),
  'e7 23': spec('Array add', 'abs', 'abs'),
  'e7 24': spec('Array mirror', 'u7'),
  'e7 50': spec('Document min point', 'abs', 'abs'),
  'e7 51': spec('Document max point', 'abs', 'abs'),
  'e7 52': spec('Layer min point', 'u7', 'abs', 'abs'),
  'e7 53': spec('Layer max point', 'u7', 'abs', 'abs'),
  'e7 54': spec('Pen offset', 'u7', 'abs'),
  'e7 55': spec('Layer offset', 'u7', 'abs'),
  'e7 60': spec('Set current element index', 'u7'),
  'e7 61': spec('Layer min point ex', 'u7', 'abs', 'abs'),
  'e7 62': spec('Layer max point ex', 'u7', 'abs', 'abs'),
  ea: spec('Array start', 'u7'),
  eb: spec('Array end'),
  f0: spec('Ref point set'),
  'f1 00': spec('Element max index', 'u7'),
  'f1 01': spec('Element name max index', 'u7'),
  'f1 02': spec('Enable block cutting', 'u7'),
  'f1 03': spec('Display offset', 'abs', 'abs'),
  'f2 00': spec('Element index', 'u7'),
  'f2 01': spec('Element name index', 'u7'),
  'f2 02': spec('Element name', 'raw10'),
  'f2 03': spec('Element array min point', 'abs', 'abs'),
  'f2 04': spec('Element array max point', 'abs', 'abs'),
  'f2 05': spec('Element array', 'u14', 'u14', 'abs', 'abs'),
  'f2 06': spec('Element array add', 'abs', 'abs'),
  'f2 07': spec('Element array mirror', 'u7'),
};

function hex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

function formatField(field: Field, bytes: Uint8Array): string {
  switch (field) {
    case 'abs':
      return `${(decodeInt35(bytes) / 1000).toFixed(3)}mm`;
    case 'rel':
      return `${(decodeInt14(bytes) / 1000).toFixed(3)}mm`;
    case 'power':
      return `${decodePowerPct(bytes).toFixed(2)}%`;
    case 'speed':
      return `${(decodeUnsigned(bytes) / 1000).toFixed(3)}mm/s`;
    case 'time':
      return `${(decodeUnsigned(bytes) / 1000).toFixed(3)}ms`;
    case 'color':
      return decodeColor(bytes);
    case 'u7':
    case 'u14':
      return String(decodeUnsigned(bytes));
    case 'i35':
      return String(decodeInt35(bytes));
    case 'raw10':
      return `[${hex(bytes)}]`;
  }
}

function describeCommand(command: Uint8Array): string {
  const raw = hex(command);
  // Longest fixed prefix first: `ca 01 13` before `ca 01`, `c6 01` before `c6`.
  for (let prefixLength = Math.min(3, command.length); prefixLength >= 1; prefixLength--) {
    const found = COMMANDS[hex(command.subarray(0, prefixLength))];
    if (!found) continue;
    const expected = found.fields.reduce((sum, field) => sum + FIELD_SIZE[field], prefixLength);
    if (expected !== command.length) {
      return `MALFORMED ${found.name} (expected ${expected} bytes, got ${command.length}) | ${raw}`;
    }
    let offset = prefixLength;
    const values = found.fields.map((field) => {
      const slice = command.subarray(offset, offset + FIELD_SIZE[field]);
      offset += FIELD_SIZE[field];
      return formatField(field, slice);
    });
    const text = values.length > 0 ? `${found.name} ${values.join(' ')}` : found.name;
    return `${text} | ${raw}`;
  }
  return `UNKNOWN | ${raw}`;
}

/**
 * Splits an unscrambled stream into commands (a byte with its top bit set
 * starts a command) and returns one readable line per command, ending in
 * the raw hex. Unknown or wrongly sized commands are flagged, not dropped.
 */
export function describeRuidaCommands(bytes: Uint8Array): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 1; i <= bytes.length; i++) {
    const atCommandStart = i === bytes.length || (bytes[i] ?? 0) >= 0x80;
    if (!atCommandStart) continue;
    const command = bytes.subarray(start, i);
    if (command.length > 0) {
      lines.push((command[0] ?? 0) >= 0x80 ? describeCommand(command) : `STRAY DATA | ${hex(command)}`);
    }
    start = i;
  }
  return lines;
}
