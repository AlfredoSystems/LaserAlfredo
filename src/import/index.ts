import type { ImportResult } from '../model/types';
import { importDxf } from './dxf';
import type { ImportOptions } from './options';
import { importSvg } from './svg';

export type { ImportOptions } from './options';

export type ImportFormat = 'dxf' | 'svg';

/** Picks the importer from the file name, falling back to sniffing the content. */
export function detectFormat(fileName: string, text: string): ImportFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.dxf')) return 'dxf';
  if (lower.endsWith('.svg')) return 'svg';
  if (/<svg[\s>]/i.test(text.slice(0, 4096))) return 'svg';
  if (/^\s*0\s*\r?\n\s*SECTION/i.test(text.slice(0, 4096))) return 'dxf';
  return null;
}

/** Imports a DXF or SVG file. Throws an Error with a readable message on failure. */
export function importFile(fileName: string, text: string, options: ImportOptions = {}): ImportResult {
  const format = detectFormat(fileName, text);
  if (format === 'dxf') return importDxf(text, options);
  if (format === 'svg') return importSvg(text, options);
  throw new Error(`Unsupported file type: ${fileName}. Use a .dxf or .svg file.`);
}
