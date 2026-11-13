import { describe, expect, it } from 'vitest';
import { describeRuidaCommands } from './describe';

function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const text = (hex: string) => describeRuidaCommands(fromHex(hex)).map((line) => line.split(' | ')[0]);

describe('describeRuidaCommands', () => {
  it('decodes commands from the annotated example on the EduTech Wiki Ruida page', () => {
    expect(
      text(`
        d810 f0 e601 f10200 d800
        c904000000060d20
        c631001319
        ca0601000000017f
        ca410000
        ca2200
        c9020000047100
        c6013f7f
        8800000806670000065d5c
        a80000052d3e0000065d5c
        eb e700
        da01062000000002470000000247
        d7
      `),
    ).toEqual([
      'Ref point mode 2 (machine zero, absolute)',
      'Ref point set',
      'Set absolute',
      'Enable block cutting 0',
      'Start process',
      'Layer speed 0 100.000mm/s',
      'Layer laser 1 min power 0 15.00%',
      'Layer colour 1 #ff0000',
      'Layer work mode 0 0',
      'Max layer index 0',
      'Speed 80.000mm/s',
      'Laser 1 min power 50.00%',
      'Move abs 131.943mm 110.300mm',
      'Cut abs 87.742mm 110.300mm',
      'Array end',
      'Block end',
      'Set param 6 32 327 327',
      'End of file',
    ]);
  });

  it('decodes relative moves and negative values from an RDWorks file', () => {
    expect(text('891f206060 aa5110 a917386848 f205000100010000030650 7f7f7c7930')).toEqual([
      'Move rel 4.000mm -4.000mm',
      'Cut rel X -6.000mm',
      'Cut rel 3.000mm -3.000mm',
      'Element array 1 1 50.000mm -50.000mm',
    ]);
  });

  it('keeps the raw bytes on every line', () => {
    expect(describeRuidaCommands(fromHex('d7 ca0113'))).toEqual(['End of file | d7', 'Air assist on | ca 01 13']);
  });

  it('flags unknown, malformed and stray bytes instead of hiding them', () => {
    expect(describeRuidaCommands(fromHex('0102 ff01 8800 d7'))).toEqual([
      'STRAY DATA | 01 02',
      'UNKNOWN | ff 01',
      'MALFORMED Move abs (expected 11 bytes, got 2) | 88 00',
      'End of file | d7',
    ]);
  });

  it('returns nothing for an empty stream', () => {
    expect(describeRuidaCommands(new Uint8Array())).toEqual([]);
  });
});
