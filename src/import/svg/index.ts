import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { DEFAULT_FLATTEN_TOLERANCE_MM, flattenCircle, flattenEllipse, flattenSvgArc } from '../../geometry/flatten';
import {
  cleanPolyline,
  DEFAULT_JOIN_TOLERANCE_MM,
  joinPolylines,
  removeDuplicatePolylines,
} from '../../geometry/join';
import { applyToPoints, compose, translation } from '../../model/transform';
import type { Matrix } from '../../model/transform';
import type { ColoredPolyline, ImportResult, Point } from '../../model/types';
import type { ImportOptions } from '../options';
import { parsePathData } from './pathData';
import { isNoPaint, ownStyle, parseColor, parseStyleSheet } from './style';
import type { StyleProps, StyleRule } from './style';
import {
  fitViewBox,
  maxScale,
  MM_PER_PX,
  parseLength,
  parseLengthMm,
  parseNumberListLenient,
  parseTransform,
  parseViewBox,
} from './units';

interface XmlElement {
  /** Tag name without an `svg:` prefix; other prefixes are kept. */
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  /** Concatenated direct text and CDATA content. */
  readonly text: string;
}

/** Size of the nearest viewport in user units, used to resolve percentages. */
interface Viewport {
  readonly width: number | null;
  readonly height: number | null;
}

interface InheritedStyle {
  readonly stroke: string | undefined;
  readonly fill: string | undefined;
  readonly visibility: string | undefined;
}

interface Context {
  /** Maps the element's user units to document mm. */
  readonly ctm: Matrix;
  readonly style: InheritedStyle;
  readonly viewport: Viewport;
}

interface State {
  readonly rules: readonly StyleRule[];
  readonly ids: ReadonlyMap<string, XmlElement>;
  readonly toleranceMm: number;
  readonly raw: ColoredPolyline[];
  readonly skipped: Map<string, number>;
  readonly colorCache: Map<string, string>;
  /** Ids of the `use` targets currently being expanded, to stop reference cycles. */
  readonly useStack: string[];
  badPaths: number;
  badTransforms: number;
  /** Elements still allowed to be visited; guards against `use` bombs. */
  budget: number;
}

/** Most elements one import will visit, counting every `use` expansion. */
const MAX_ELEMENTS = 500000;
/** Consecutive points closer than this are merged before joining. */
const MAX_CLEAN_TOLERANCE_MM = 0.001;

const CONTAINERS: ReadonlySet<string> = new Set(['g', 'a', 'switch']);

/** Elements that never draw anything themselves; skipped without a warning. */
const SILENT: ReadonlySet<string> = new Set([
  'defs',
  'symbol',
  'clipPath',
  'mask',
  'pattern',
  'marker',
  'linearGradient',
  'radialGradient',
  'meshgradient',
  'hatch',
  'solidcolor',
  'filter',
  'style',
  'script',
  'title',
  'desc',
  'metadata',
  'view',
  'cursor',
  'font',
  'font-face',
  'color-profile',
  'animate',
  'animateMotion',
  'animateTransform',
  'animateColor',
  'set',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Converts fast-xml-parser's ordered output into plain elements. */
function toElements(nodes: unknown): { elements: XmlElement[]; text: string } {
  const elements: XmlElement[] = [];
  let text = '';
  if (!Array.isArray(nodes)) return { elements, text };
  for (const node of nodes as readonly unknown[]) {
    if (!isRecord(node)) continue;
    const key = Object.keys(node).find((k) => k !== ':@');
    if (key === undefined) continue;
    const content = node[key];
    if (key === '#text') {
      if (typeof content === 'string' || typeof content === 'number') text += String(content);
      continue;
    }
    if (key.startsWith('?') || key.startsWith('!') || key.startsWith('#')) continue;
    const attrs: Record<string, string> = {};
    const rawAttrs = node[':@'];
    if (isRecord(rawAttrs)) {
      for (const [name, value] of Object.entries(rawAttrs)) {
        if (typeof value === 'string') attrs[name] = value;
        else if (typeof value === 'number' || typeof value === 'boolean') attrs[name] = String(value);
      }
    }
    const inner = toElements(content);
    elements.push({
      name: key.startsWith('svg:') ? key.slice(4) : key,
      attrs,
      children: inner.elements,
      text: inner.text,
    });
  }
  return { elements, text };
}

function parseXml(text: string): XmlElement[] {
  const source = text.replace(/^﻿/, '');
  const validation = XMLValidator.validate(source, { allowBooleanAttributes: true });
  if (validation !== true) {
    const { msg, line } = validation.err;
    throw new Error(`Not a valid SVG file: XML error on line ${line}: ${msg}`);
  }
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '',
    allowBooleanAttributes: true,
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
    processEntities: true,
  });
  let parsed: unknown;
  try {
    parsed = parser.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Not a valid SVG file: ${detail}`);
  }
  return toElements(parsed).elements;
}

/** Collects every id (first one wins) and all stylesheet text in the document. */
function indexDocument(root: XmlElement): { ids: Map<string, XmlElement>; css: string } {
  const ids = new Map<string, XmlElement>();
  let css = '';
  const stack: XmlElement[] = [root];
  for (let el = stack.pop(); el !== undefined; el = stack.pop()) {
    const id = el.attrs['id'];
    if (id !== undefined && !ids.has(id)) ids.set(id, el);
    if (el.name === 'style') css += `${el.text}\n`;
    // Reverse push keeps document order, so the first duplicate id wins.
    for (let i = el.children.length - 1; i >= 0; i--) {
      const child = el.children[i];
      if (child !== undefined) stack.push(child);
    }
  }
  return { ids, css };
}

function inherit(parent: InheritedStyle, own: StyleProps): InheritedStyle {
  const pick = (value: string | undefined, inherited: string | undefined): string | undefined =>
    value === undefined || value.toLowerCase() === 'inherit' ? inherited : value;
  return {
    stroke: pick(own.stroke, parent.stroke),
    fill: pick(own.fill, parent.fill),
    visibility: pick(own.visibility, parent.visibility),
  };
}

function shapeColor(style: InheritedStyle, state: State): string {
  const paint = !isNoPaint(style.stroke) ? style.stroke : !isNoPaint(style.fill) ? style.fill : undefined;
  if (paint === undefined) return '#000000';
  let color = state.colorCache.get(paint);
  if (color === undefined) {
    color = parseColor(paint);
    state.colorCache.set(paint, color);
  }
  return color;
}

function isHidden(style: InheritedStyle): boolean {
  const visibility = style.visibility?.toLowerCase();
  return visibility === 'hidden' || visibility === 'collapse';
}

function count(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Applies the element's own `transform` attribute on top of the parent matrix. */
function withTransform(el: XmlElement, ctm: Matrix, state: State): Matrix {
  const text = el.attrs['transform'];
  if (text === undefined) return ctm;
  const local = parseTransform(text);
  if (local === null) {
    state.badTransforms += 1;
    return ctm;
  }
  return compose(ctm, local);
}

function emit(points: readonly Point[], closed: boolean, ctx: Context, state: State): void {
  if (points.length < 2) return;
  state.raw.push({ points: applyToPoints(ctx.ctm, points), closed, color: shapeColor(ctx.style, state) });
}

function pushTail(target: Point[], points: readonly Point[]): void {
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (p !== undefined) target.push(p);
  }
}

function rectPoints(
  x: number,
  y: number,
  width: number,
  height: number,
  rx: number,
  ry: number,
  tolerance: number,
): Point[] {
  if (!(rx > 0) || !(ry > 0)) {
    return [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ];
  }
  const right = x + width;
  const bottom = y + height;
  // Clockwise on screen, starting after the top-left corner.
  const corners: readonly (readonly [Point, Point])[] = [
    [
      { x: right - rx, y },
      { x: right, y: y + ry },
    ],
    [
      { x: right, y: bottom - ry },
      { x: right - rx, y: bottom },
    ],
    [
      { x: x + rx, y: bottom },
      { x, y: bottom - ry },
    ],
    [
      { x, y: y + ry },
      { x: x + rx, y },
    ],
  ];
  const points: Point[] = [{ x: x + rx, y }];
  for (const [from, to] of corners) {
    points.push(from);
    pushTail(points, flattenSvgArc(from, rx, ry, 0, false, true, to, tolerance));
  }
  return points;
}

function renderShape(el: XmlElement, ctx: Context, state: State): void {
  if (isHidden(ctx.style)) return;
  const scale = maxScale(ctx.ctm);
  if (!Number.isFinite(scale) || !(scale > 0)) return;
  // Curves are flattened in local units, so tighten the tolerance by the scale to mm.
  const tolerance = state.toleranceMm / scale;
  const { width: vw, height: vh } = ctx.viewport;
  const diagonal = vw === null || vh === null ? null : Math.hypot(vw, vh) / Math.SQRT2;
  const lengthX = (name: string): number | null => parseLength(el.attrs[name], vw);
  const lengthY = (name: string): number | null => parseLength(el.attrs[name], vh);
  const lengthR = (name: string): number | null => parseLength(el.attrs[name], diagonal);

  switch (el.name) {
    case 'path': {
      const result = parsePathData(el.attrs['d'] ?? '', tolerance);
      if (result.error !== null) state.badPaths += 1;
      for (const sub of result.subpaths) emit(sub.points, sub.closed, ctx, state);
      return;
    }
    case 'rect': {
      const width = lengthX('width');
      const height = lengthY('height');
      if (width === null || height === null || !(width > 0) || !(height > 0)) return;
      let rx = lengthX('rx');
      let ry = lengthY('ry');
      if (rx !== null && rx < 0) rx = null;
      if (ry !== null && ry < 0) ry = null;
      rx = rx ?? ry ?? 0;
      ry = ry ?? rx;
      rx = Math.min(rx, width / 2);
      ry = Math.min(ry, height / 2);
      emit(rectPoints(lengthX('x') ?? 0, lengthY('y') ?? 0, width, height, rx, ry, tolerance), true, ctx, state);
      return;
    }
    case 'circle': {
      const r = lengthR('r');
      if (r === null || !(r > 0)) return;
      emit(flattenCircle({ x: lengthX('cx') ?? 0, y: lengthY('cy') ?? 0 }, r, tolerance), true, ctx, state);
      return;
    }
    case 'ellipse': {
      const rx = lengthX('rx') ?? lengthY('ry');
      const ry = lengthY('ry') ?? rx;
      if (rx === null || ry === null || !(rx > 0) || !(ry > 0)) return;
      const center = { x: lengthX('cx') ?? 0, y: lengthY('cy') ?? 0 };
      const ring = flattenEllipse(center, { x: rx, y: 0 }, ry / rx, 0, Math.PI * 2, tolerance);
      // The full ellipse repeats its start point; a closed path must not.
      emit(ring.slice(0, -1), true, ctx, state);
      return;
    }
    case 'line': {
      const from = { x: lengthX('x1') ?? 0, y: lengthY('y1') ?? 0 };
      const to = { x: lengthX('x2') ?? 0, y: lengthY('y2') ?? 0 };
      emit([from, to], false, ctx, state);
      return;
    }
    case 'polyline':
    case 'polygon': {
      const numbers = parseNumberListLenient(el.attrs['points'] ?? '');
      const points: Point[] = [];
      for (let i = 0; i + 1 < numbers.length; i += 2) {
        points.push({ x: numbers[i] ?? 0, y: numbers[i + 1] ?? 0 });
      }
      emit(points, el.name === 'polygon', ctx, state);
      return;
    }
  }
}

const SHAPES: ReadonlySet<string> = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);

function positive(value: number | null): number | null {
  return value !== null && value > 0 ? value : null;
}

/**
 * Establishes the viewport of a nested `svg` or a `use`d `symbol`: its viewBox
 * is fitted into `width` x `height` (in the parent's user units).
 */
function enterViewport(
  el: XmlElement,
  ctx: Context,
  width: number | null,
  height: number | null,
): Context {
  const viewBox = parseViewBox(el.attrs['viewBox']);
  if (viewBox === null) return { ...ctx, viewport: { width, height } };
  const w = width ?? (height === null ? viewBox.width : (height * viewBox.width) / viewBox.height);
  const h = height ?? (w * viewBox.height) / viewBox.width;
  return {
    ...ctx,
    ctm: compose(ctx.ctm, fitViewBox(viewBox, w, h, el.attrs['preserveAspectRatio'])),
    viewport: { width: viewBox.width, height: viewBox.height },
  };
}

function renderChildren(el: XmlElement, ctx: Context, state: State): void {
  for (const child of el.children) renderElement(child, ctx, state);
}

/** A nested `svg`. `width`/`height` override the element's own when it is the target of a `use`. */
function renderNestedSvg(
  el: XmlElement,
  ctx: Context,
  state: State,
  width: number | null,
  height: number | null,
): void {
  const { viewport } = ctx;
  const x = parseLength(el.attrs['x'], viewport.width) ?? 0;
  const y = parseLength(el.attrs['y'], viewport.height) ?? 0;
  const w = width ?? positive(parseLength(el.attrs['width'], viewport.width)) ?? viewport.width;
  const h = height ?? positive(parseLength(el.attrs['height'], viewport.height)) ?? viewport.height;
  const placed = { ...ctx, ctm: compose(withTransform(el, ctx.ctm, state), translation(x, y)) };
  renderChildren(el, enterViewport(el, placed, w, h), state);
}

function renderUse(el: XmlElement, ctx: Context, state: State): void {
  const href = (el.attrs['href'] ?? el.attrs['xlink:href'] ?? '').trim();
  const id = href.startsWith('#') ? href.slice(1) : '';
  const target = id === '' ? undefined : state.ids.get(id);
  if (target === undefined) {
    count(state.skipped, 'use with a missing or external reference');
    return;
  }
  if (state.useStack.includes(id)) {
    count(state.skipped, 'use with a circular reference');
    return;
  }
  const { viewport } = ctx;
  const x = parseLength(el.attrs['x'], viewport.width) ?? 0;
  const y = parseLength(el.attrs['y'], viewport.height) ?? 0;
  const width = positive(parseLength(el.attrs['width'], viewport.width));
  const height = positive(parseLength(el.attrs['height'], viewport.height));
  const placed: Context = { ...ctx, ctm: compose(withTransform(el, ctx.ctm, state), translation(x, y)) };

  state.useStack.push(id);
  if (target.name === 'symbol') {
    const own = ownStyle(target.name, target.attrs, state.rules);
    if (own.display?.toLowerCase() !== 'none') {
      const styled = { ...placed, style: inherit(placed.style, own) };
      const w = width ?? positive(parseLength(target.attrs['width'], viewport.width)) ?? viewport.width;
      const h = height ?? positive(parseLength(target.attrs['height'], viewport.height)) ?? viewport.height;
      renderChildren(target, enterViewport(target, styled, w, h), state);
    }
  } else if (target.name === 'svg') {
    const own = ownStyle(target.name, target.attrs, state.rules);
    if (own.display?.toLowerCase() !== 'none') {
      renderNestedSvg(target, { ...placed, style: inherit(placed.style, own) }, state, width, height);
    }
  } else {
    renderElement(target, placed, state);
  }
  state.useStack.pop();
}

function renderElement(el: XmlElement, parent: Context, state: State): void {
  if (state.budget <= 0) return;
  state.budget -= 1;
  const { name } = el;
  // Skip the cheap cases before resolving any style.
  if (SILENT.has(name)) return;
  const known = SHAPES.has(name) || CONTAINERS.has(name) || name === 'use' || name === 'svg';
  // Editor metadata such as sodipodi:namedview lives in other namespaces.
  if (!known && name.includes(':')) return;

  const own = ownStyle(name, el.attrs, state.rules);
  if (own.display?.toLowerCase() === 'none') return;
  if (!known) {
    count(state.skipped, name);
    return;
  }
  const style = inherit(parent.style, own);
  if (name === 'svg') {
    renderNestedSvg(el, { ...parent, style }, state, null, null);
  } else if (name === 'use') {
    renderUse(el, { ...parent, style }, state);
  } else if (CONTAINERS.has(name)) {
    renderChildren(el, { ...parent, style, ctm: withTransform(el, parent.ctm, state) }, state);
  } else {
    renderShape(el, { ...parent, style, ctm: withTransform(el, parent.ctm, state) }, state);
  }
}

/** The outermost `svg`: its size and viewBox define how user units map to mm. */
function rootContext(root: XmlElement, state: State): Context {
  const style = inherit(
    { stroke: undefined, fill: undefined, visibility: undefined },
    ownStyle(root.name, root.attrs, state.rules),
  );
  // Percentages have no meaning here, so they count as absent.
  const widthMm = positive(parseLengthMm(root.attrs['width']));
  const heightMm = positive(parseLengthMm(root.attrs['height']));
  const toMm: Matrix = [MM_PER_PX, 0, 0, MM_PER_PX, 0, 0];
  const outer = withTransform(root, toMm, state);
  const viewBox = parseViewBox(root.attrs['viewBox']);
  if (viewBox === null) {
    const toPx = (mm: number | null): number | null => (mm === null ? null : mm / MM_PER_PX);
    return { ctm: outer, style, viewport: { width: toPx(widthMm), height: toPx(heightMm) } };
  }
  // The viewBox is fitted straight into the size in mm, so a document drawn in
  // mm keeps its exact coordinates. Without any size its units are px.
  const scaleMm = (other: number | null, otherUnits: number): number =>
    other === null ? MM_PER_PX : other / otherUnits;
  const w = widthMm ?? viewBox.width * scaleMm(heightMm, viewBox.height);
  const h = heightMm ?? viewBox.height * scaleMm(widthMm, viewBox.width);
  const fit = fitViewBox(viewBox, w, h, root.attrs['preserveAspectRatio']);
  // `outer` differs from the plain px-to-mm scale only when the root has a transform.
  const ctm = outer === toMm ? fit : compose(compose(outer, [1 / MM_PER_PX, 0, 0, 1 / MM_PER_PX, 0, 0]), fit);
  return { ctm, style, viewport: { width: viewBox.width, height: viewBox.height } };
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function buildWarnings(state: State): string[] {
  const warnings: string[] = [];
  for (const [name, n] of state.skipped) warnings.push(`Skipped ${n} ${name}`);
  if (state.badPaths > 0) {
    const n = state.badPaths;
    warnings.push(
      `${n} ${plural(n, 'path has', 'paths have')} invalid path data; only the part before the error was imported`,
    );
  }
  if (state.badTransforms > 0) {
    const n = state.badTransforms;
    warnings.push(`Ignored ${n} invalid ${plural(n, 'transform', 'transforms')}`);
  }
  if (state.budget <= 0) warnings.push('The drawing is too complex; some content was left out');
  return warnings;
}

/** Cleans, de-duplicates and joins the raw paths, one colour at a time. */
function finish(raw: readonly ColoredPolyline[], joinToleranceMm: number): ColoredPolyline[] {
  const cleanTolerance = Math.min(joinToleranceMm, MAX_CLEAN_TOLERANCE_MM);
  const byColor = new Map<string, ColoredPolyline[]>();
  for (const path of raw) {
    const points = cleanPolyline(path.points, path.closed, cleanTolerance);
    if (points.length < 2) continue;
    // A closed path needs three points; two are just a line.
    const cleaned = { points, closed: path.closed && points.length >= 3, color: path.color };
    const group = byColor.get(path.color);
    if (group === undefined) byColor.set(path.color, [cleaned]);
    else group.push(cleaned);
  }
  const paths: ColoredPolyline[] = [];
  for (const group of byColor.values()) {
    const unique = removeDuplicatePolylines(group, joinToleranceMm);
    const joined = joinPolylines(unique, joinToleranceMm, (points, closed, source) => ({
      points,
      closed,
      color: source.color,
    }));
    for (const path of joined) {
      if (path.points.length >= 2) paths.push(path);
    }
  }
  return paths;
}

function usableTolerance(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Imports an SVG drawing as coloured polylines in mm (Y down, as in SVG).
 * Throws only when the text is not XML or has no `<svg>` root.
 */
export function importSvg(text: string, options: ImportOptions = {}): ImportResult {
  const root = parseXml(text).find((el) => el.name === 'svg');
  if (root === undefined) throw new Error('Not a valid SVG file: no <svg> root element found.');

  const { ids, css } = indexDocument(root);
  const joinTolerance =
    options.joinToleranceMm !== undefined && Number.isFinite(options.joinToleranceMm) && options.joinToleranceMm >= 0
      ? options.joinToleranceMm
      : DEFAULT_JOIN_TOLERANCE_MM;
  const state: State = {
    rules: parseStyleSheet(css),
    ids,
    toleranceMm: usableTolerance(options.flattenToleranceMm, DEFAULT_FLATTEN_TOLERANCE_MM),
    raw: [],
    skipped: new Map(),
    colorCache: new Map(),
    useStack: [],
    badPaths: 0,
    badTransforms: 0,
    budget: MAX_ELEMENTS,
  };

  const own = ownStyle(root.name, root.attrs, state.rules);
  if (own.display?.toLowerCase() !== 'none') renderChildren(root, rootContext(root, state), state);
  return { paths: finish(state.raw, joinTolerance), warnings: buildWarnings(state) };
}
