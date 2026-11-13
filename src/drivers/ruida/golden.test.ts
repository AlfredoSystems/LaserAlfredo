import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Job } from '../../toolpath/types';
import type { RuidaOptions } from './job';
import { buildRuidaCommands, describeRuidaCommands, encodeRuidaJob } from './job';
import { RUIDA_MAGIC_644X, unswizzle } from './swizzle';
import { OPEN_POLYLINE_JOB, RECTANGLE_JOB, TEST_OPTIONS, TWO_LAYER_JOB } from './testJobs';

/**
 * Golden files: `<name>.rd` is the exact file the driver writes and
 * `<name>.txt` is its disassembly. They prove the output is stable and
 * follows the documented format. They do NOT prove a controller accepts it;
 * no golden file comes from RDWorks, LightBurn or a machine.
 *
 * To regenerate on purpose after an intended encoding change:
 *   PowerShell: $env:UPDATE_GOLDEN = '1'; pnpm vitest run src/drivers/ruida/golden.test.ts
 *   POSIX sh:   UPDATE_GOLDEN=1 pnpm vitest run src/drivers/ruida/golden.test.ts
 * Then review the `.txt` diff before committing.
 */
const FIXTURE_DIR = fileURLToPath(new URL('../../../tests/fixtures/ruida/', import.meta.url));
const UPDATE = process.env.UPDATE_GOLDEN === '1';

const CASES: readonly { name: string; job: Job; options: RuidaOptions }[] = [
  { name: 'rectangle-50x30', job: RECTANGLE_JOB, options: TEST_OPTIONS },
  { name: 'two-layers-two-passes', job: TWO_LAYER_JOB, options: TEST_OPTIONS },
  { name: 'open-polyline', job: OPEN_POLYLINE_JOB, options: TEST_OPTIONS },
  // Same rectangle for a machine that homes to the rear right, with a 25 % power cap.
  {
    name: 'rectangle-50x30-top-right-cap25',
    job: RECTANGLE_JOB,
    options: { ...TEST_OPTIONS, origin: 'top-right', maxPowerCapPct: 25 },
  },
];

describe('Ruida golden files', () => {
  for (const { name, job, options } of CASES) {
    it(`${name} matches byte for byte`, () => {
      const rdPath = `${FIXTURE_DIR}${name}.rd`;
      const txtPath = `${FIXTURE_DIR}${name}.txt`;
      const file = encodeRuidaJob(job, options);
      const listing = `${describeRuidaCommands(buildRuidaCommands(job, options)).join('\n')}\n`;

      if (UPDATE) {
        mkdirSync(FIXTURE_DIR, { recursive: true });
        writeFileSync(rdPath, file);
        writeFileSync(txtPath, listing);
      }
      expect(existsSync(rdPath), `${rdPath} is missing; see the note at the top of this test`).toBe(true);

      const golden = new Uint8Array(readFileSync(rdPath));
      expect(Array.from(file)).toEqual(Array.from(golden));
      // Tolerate a checkout that converted the text file to CRLF.
      expect(listing).toBe(readFileSync(txtPath, 'utf8').replace(/\r\n/g, '\n'));
      // The listing really is the disassembly of the binary golden file.
      expect(describeRuidaCommands(unswizzle(golden, RUIDA_MAGIC_644X)).join('\n') + '\n').toBe(listing);
    });
  }
});
