/** The CSS properties the importer cares about. */
export type StyleProperty = 'stroke' | 'fill' | 'display' | 'visibility';

export type StyleProps = Partial<Record<StyleProperty, string>>;

const PROPERTIES: readonly StyleProperty[] = ['stroke', 'fill', 'display', 'visibility'];

function isStyleProperty(name: string): name is StyleProperty {
  return (PROPERTIES as readonly string[]).includes(name);
}

/** Parses `a:b; c:d` declarations, keeping only the properties we use. */
export function parseDeclarations(text: string): StyleProps {
  const props: StyleProps = {};
  for (const part of text.split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    if (!isStyleProperty(name)) continue;
    const value = part
      .slice(colon + 1)
      .replace(/!\s*important/i, '')
      .trim();
    if (value !== '') props[name] = value;
  }
  return props;
}

export interface StyleRule {
  /** Element name, or null for any element. */
  readonly tag: string | null;
  readonly id: string | null;
  readonly classes: readonly string[];
  readonly specificity: number;
  readonly props: StyleProps;
}

const COMPOUND_SELECTOR = /^(\*|[a-zA-Z_][\w-]*(?:\|[\w-]+)?)?((?:[.#][\w-]+)*)$/;

/**
 * Parses the text of `<style>` blocks into rules, sorted so later entries win.
 * Supports element, `.class`, `#id` and compound (`path.cut`) selectors and
 * comma-separated lists. Selectors with combinators, attributes or
 * pseudo-classes are ignored, as are at-rule preludes.
 */
export function parseStyleSheet(css: string): StyleRule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--|-->/g, '');
  const rules: StyleRule[] = [];
  const block = /([^{}]+)\{([^{}]*)\}/g;
  for (let match = block.exec(text); match !== null; match = block.exec(text)) {
    const props = parseDeclarations(match[2] ?? '');
    if (Object.keys(props).length === 0) continue;
    for (const raw of (match[1] ?? '').split(',')) {
      const selector = raw.trim();
      const parsed = COMPOUND_SELECTOR.exec(selector);
      if (selector === '' || parsed === null) continue;
      const tagPart = parsed[1];
      const tag = tagPart === undefined || tagPart === '*' ? null : (tagPart.split('|').pop() ?? null);
      let id: string | null = null;
      const classes: string[] = [];
      for (const token of (parsed[2] ?? '').match(/[.#][\w-]+/g) ?? []) {
        if (token.startsWith('#')) id = token.slice(1);
        else classes.push(token.slice(1));
      }
      const specificity = (id === null ? 0 : 100) + classes.length * 10 + (tag === null ? 0 : 1);
      rules.push({ tag, id, classes, specificity, props });
    }
  }
  // Stable sort: equal specificity keeps source order.
  return rules.sort((a, b) => a.specificity - b.specificity);
}

/**
 * An element's own (not inherited) style: presentation attributes, then
 * matching stylesheet rules, then the inline `style` attribute.
 */
export function ownStyle(
  tag: string,
  attrs: Readonly<Record<string, string>>,
  rules: readonly StyleRule[],
): StyleProps {
  const props: StyleProps = {};
  for (const name of PROPERTIES) {
    const value = attrs[name]?.trim();
    if (value !== undefined && value !== '') props[name] = value;
  }
  if (rules.length > 0) {
    const id = attrs['id'];
    const classes = (attrs['class'] ?? '').split(/\s+/);
    for (const rule of rules) {
      if (rule.tag !== null && rule.tag !== tag) continue;
      if (rule.id !== null && rule.id !== id) continue;
      if (!rule.classes.every((c) => classes.includes(c))) continue;
      Object.assign(props, rule.props);
    }
  }
  const inline = attrs['style'];
  if (inline !== undefined) Object.assign(props, parseDeclarations(inline));
  return props;
}

const NAMED_COLORS: Readonly<Record<string, string>> = {
  black: '#000000',
  silver: '#c0c0c0',
  gray: '#808080',
  grey: '#808080',
  white: '#ffffff',
  maroon: '#800000',
  red: '#ff0000',
  purple: '#800080',
  fuchsia: '#ff00ff',
  magenta: '#ff00ff',
  green: '#008000',
  lime: '#00ff00',
  olive: '#808000',
  yellow: '#ffff00',
  navy: '#000080',
  blue: '#0000ff',
  teal: '#008080',
  aqua: '#00ffff',
  cyan: '#00ffff',
  orange: '#ffa500',
  darkorange: '#ff8c00',
  orangered: '#ff4500',
  gold: '#ffd700',
  pink: '#ffc0cb',
  hotpink: '#ff69b4',
  brown: '#a52a2a',
  crimson: '#dc143c',
  darkred: '#8b0000',
  darkgreen: '#006400',
  darkblue: '#00008b',
  darkgray: '#a9a9a9',
  darkgrey: '#a9a9a9',
  lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3',
  dimgray: '#696969',
  dimgrey: '#696969',
  indigo: '#4b0082',
  violet: '#ee82ee',
  turquoise: '#40e0d0',
  skyblue: '#87ceeb',
  royalblue: '#4169e1',
  steelblue: '#4682b4',
  tomato: '#ff6347',
  coral: '#ff7f50',
  salmon: '#fa8072',
  khaki: '#f0e68c',
  chocolate: '#d2691e',
  tan: '#d2b48c',
  beige: '#f5f5dc',
  ivory: '#fffff0',
  snow: '#fffafa',
};

const BLACK = '#000000';
/** Channels at or above this in all of r, g, b count as white (invisible on the light canvas). */
const NEAR_WHITE = 240;

function toHex(r: number, g: number, b: number): string {
  if (Math.min(r, g, b) >= NEAR_WHITE) return BLACK;
  const part = (v: number): string => v.toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

function channel(text: string): number | null {
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(%?)$/.exec(text);
  if (match === null) return null;
  const value = match[2] === '%' ? (Number(match[1]) * 255) / 100 : Number(match[1]);
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** True when a paint value means "do not paint". */
export function isNoPaint(value: string | undefined): boolean {
  if (value === undefined) return true;
  const v = value.trim().toLowerCase();
  return v === '' || v === 'none' || v === 'transparent';
}

/**
 * Converts a CSS colour to lowercase `#rrggbb`. Near-white becomes black, and
 * so does anything unsupported (`currentColor`, gradients, unknown names).
 */
export function parseColor(value: string): string {
  const v = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1];
  if (hex !== undefined) {
    if (hex.length === 3 || hex.length === 4) {
      const [r = '0', g = '0', b = '0'] = hex;
      return toHex(parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16));
    }
    if (hex.length === 6 || hex.length === 8) {
      return toHex(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16));
    }
    return BLACK;
  }
  const rgb = /^rgba?\(([^)]*)\)$/.exec(v)?.[1];
  if (rgb !== undefined) {
    const parts = rgb.split(/[\s,/]+/).filter((p) => p !== '');
    const r = channel(parts[0] ?? '');
    const g = channel(parts[1] ?? '');
    const b = channel(parts[2] ?? '');
    if (parts.length < 3 || r === null || g === null || b === null) return BLACK;
    return toHex(r, g, b);
  }
  const named = NAMED_COLORS[v];
  if (named === undefined) return BLACK;
  return toHex(parseInt(named.slice(1, 3), 16), parseInt(named.slice(3, 5), 16), parseInt(named.slice(5, 7), 16));
}
