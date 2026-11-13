// Default import: it is the one export that resolves to the parser class both in the
// ESM build Vite bundles and in the UMD build Node (Vitest) loads.
import DxfParser from 'dxf-parser';

/**
 * Thin layer over `dxf-parser`. The library does the tokenising and the
 * HEADER / BLOCKS / ENTITIES sectioning, but its built-in entity handlers lose
 * things this importer needs (spline weights, circle and ellipse extrusion,
 * every entity type it does not know, layer true colours) and its POLYLINE
 * handler can loop forever on a missing SEQEND. So every entity type found in
 * the file is registered with one handler that just keeps the raw group codes;
 * `entities.ts` interprets them.
 */

type HandlerConstructor = Parameters<DxfParser['registerEntityHandler']>[0];
type Handler = InstanceType<HandlerConstructor>;
type Scanner = Parameters<Handler['parseEntity']>[0];
type Group = Parameters<Handler['parseEntity']>[1];
export type GroupValue = Group['value'];

/** One entity as its raw DXF groups, in file order. */
export interface RawEntity {
  readonly type: string;
  readonly codes: readonly number[];
  readonly values: readonly GroupValue[];
  /** VERTEX records of an old-style POLYLINE; empty for everything else. */
  readonly vertices: readonly RawEntity[];
}

export interface RawBlock {
  readonly name: string;
  readonly baseX: number;
  readonly baseY: number;
  readonly paperSpace: boolean;
  readonly entities: readonly RawEntity[];
}

export interface RawLayer {
  readonly aci: number | undefined;
  readonly trueColor: number | undefined;
}

export interface ParsedDxf {
  /** `$INSUNITS` from the header, or undefined when the header does not have it. */
  readonly insUnits: number | undefined;
  /** Keyed by upper-cased layer name (DXF names are case-insensitive). */
  readonly layers: ReadonlyMap<string, RawLayer>;
  /** Keyed by upper-cased block name. */
  readonly blocks: ReadonlyMap<string, RawBlock>;
  readonly entities: readonly RawEntity[];
  /** True when the file stopped before its EOF marker. */
  readonly truncated: boolean;
}

/** Group-0 values that structure the file and must never get an entity handler. */
const STRUCTURAL = new Set(['SECTION', 'ENDSEC', 'TABLE', 'ENDTAB', 'BLOCK', 'ENDBLK', 'EOF', 'VERTEX', 'SEQEND']);

interface Prescan {
  readonly lines: string[];
  readonly entityTypes: Set<string>;
  readonly layers: Map<string, RawLayer>;
  readonly sawSection: boolean;
  readonly truncated: boolean;
}

/**
 * One cheap pass over the group pairs to learn what the library will not tell
 * us: which entity types occur (so each can be given a handler) and the layer
 * table including true colours.
 */
function prescan(text: string): Prescan {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop();
  if (lines.length % 2 === 1) lines.pop();

  const entityTypes = new Set<string>();
  const layers = new Map<string, RawLayer>();
  let section = '';
  let sawSection = false;
  let lastWasEof = false;

  let inLayer = false;
  let layerName: string | undefined;
  let layerAci: number | undefined;
  let layerTrueColor: number | undefined;
  const finishLayer = (): void => {
    if (inLayer && layerName !== undefined) {
      layers.set(layerName.toUpperCase(), { aci: layerAci, trueColor: layerTrueColor });
    }
    inLayer = false;
    layerName = undefined;
    layerAci = undefined;
    layerTrueColor = undefined;
  };

  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i] ?? '', 10);
    const value = (lines[i + 1] ?? '').trim();
    lastWasEof = false;
    if (code !== 0) {
      if (inLayer) {
        if (code === 2) layerName = value;
        else if (code === 62) layerAci = Number.parseInt(value, 10);
        else if (code === 420) layerTrueColor = Number.parseInt(value, 10);
      }
      continue;
    }
    finishLayer();
    if (value === 'SECTION') {
      const nameCode = Number.parseInt(lines[i + 2] ?? '', 10);
      if (nameCode === 2) {
        section = (lines[i + 3] ?? '').trim();
        sawSection = true;
        i += 2;
      }
    } else if (value === 'ENDSEC') {
      section = '';
    } else if (value === 'EOF') {
      lastWasEof = true;
    } else if (section === 'ENTITIES' || section === 'BLOCKS') {
      if (!STRUCTURAL.has(value) && value !== '') entityTypes.add(value);
    } else if (section === 'TABLES' && value === 'LAYER') {
      inLayer = true;
    }
  }
  finishLayer();
  return { lines, entityTypes, layers, sawSection, truncated: !lastWasEof };
}

function readGroups(scanner: Scanner, type: string, vertices: RawEntity[]): RawEntity {
  const codes: number[] = [];
  const values: GroupValue[] = [];
  let group = scanner.next();
  while (!scanner.isEOF() && group.code !== 0) {
    codes.push(group.code);
    values.push(group.value);
    group = scanner.next();
  }
  return { type, codes, values, vertices };
}

/**
 * Handler class for one entity type. On return the scanner's last-read group is
 * the group 0 that starts the next entity, which is what the library expects.
 */
function rawHandlerFor(type: string): HandlerConstructor {
  class RawHandler {
    readonly ForEntityName = type;

    parseEntity(scanner: Scanner): RawEntity {
      const vertices: RawEntity[] = [];
      const entity = readGroups(scanner, type, vertices);
      if (type !== 'POLYLINE') return entity;
      // Old-style polyline: VERTEX records follow until SEQEND. Stop at anything
      // else too, so a missing SEQEND cannot swallow the rest of the file.
      let group = scanner.lastReadGroup;
      while (!scanner.isEOF() && group.code === 0 && group.value === 'VERTEX') {
        vertices.push(readGroups(scanner, 'VERTEX', []));
        group = scanner.lastReadGroup;
      }
      if (!scanner.isEOF() && group.code === 0 && group.value === 'SEQEND') {
        readGroups(scanner, 'SEQEND', []);
      }
      return entity;
    }
  }
  return RawHandler as unknown as HandlerConstructor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRawEntity(value: unknown): value is RawEntity {
  return (
    isRecord(value) &&
    typeof value['type'] === 'string' &&
    Array.isArray(value['codes']) &&
    Array.isArray(value['values']) &&
    Array.isArray(value['vertices'])
  );
}

function rawEntities(value: unknown): RawEntity[] {
  return Array.isArray(value) ? value.filter(isRawEntity) : [];
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Parses DXF text. Throws an Error with a readable message when it is not a DXF. */
export function parseDxfText(text: string): ParsedDxf {
  if (text.startsWith('AutoCAD Binary DXF')) {
    throw new Error('Binary DXF files are not supported. Save the drawing as ASCII (text) DXF.');
  }
  const scan = prescan(text);
  if (!scan.sawSection) {
    throw new Error('This does not look like a DXF file (no SECTION found).');
  }

  const lines = scan.lines;
  if (scan.truncated) {
    // Close whatever was open so a file without its EOF marker still loads.
    lines.push('0', 'ENDTAB', '0', 'ENDBLK', '0', 'ENDSEC', '0', 'EOF');
  }

  const parser = new DxfParser();
  for (const type of scan.entityTypes) parser.registerEntityHandler(rawHandlerFor(type));

  let parsed: unknown;
  try {
    parsed = parser.parseSync(lines.join('\n'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read the DXF file: ${detail}`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error('Could not read the DXF file.');
  }

  const header = parsed['header'];
  const insUnitsValue = isRecord(header) ? header['$INSUNITS'] : undefined;
  const insUnits =
    typeof insUnitsValue === 'number' && Number.isFinite(insUnitsValue) ? insUnitsValue : undefined;

  const blocks = new Map<string, RawBlock>();
  const parsedBlocks = parsed['blocks'];
  if (isRecord(parsedBlocks)) {
    for (const [name, block] of Object.entries(parsedBlocks)) {
      if (!isRecord(block)) continue;
      const position = block['position'];
      blocks.set(name.toUpperCase(), {
        name,
        baseX: isRecord(position) ? finiteOr(position['x'], 0) : 0,
        baseY: isRecord(position) ? finiteOr(position['y'], 0) : 0,
        paperSpace: block['paperSpace'] === true,
        entities: rawEntities(block['entities']),
      });
    }
  }

  return {
    insUnits,
    layers: scan.layers,
    blocks,
    entities: rawEntities(parsed['entities']),
    truncated: scan.truncated,
  };
}
