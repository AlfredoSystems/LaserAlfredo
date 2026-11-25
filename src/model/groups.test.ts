import { describe, expect, it } from 'vitest';
import { removeShapes, setShapesColor, transformShapes } from './document';
import {
  canGroup,
  canUngroup,
  countUnits,
  existingScope,
  expandToUnits,
  groupShapes,
  isInScope,
  reachableShapes,
  remapGroupIds,
  scopeEntering,
  scopeExists,
  scopeShapeIds,
  shapeGroups,
  TOP_LEVEL,
  ungroupShapes,
  unitOf,
  unitsInRect,
  withGroups,
} from './groups';
import { translation } from './transform';
import type { LaserDocument, Shape } from './types';

/** A 10 mm square at (x, 0). */
function square(id: string, x: number, groups?: readonly string[]): Shape {
  const shape: Shape = {
    id,
    color: '#000000',
    closed: true,
    points: [
      { x, y: 0 },
      { x: x + 10, y: 0 },
      { x: x + 10, y: 10 },
      { x, y: 10 },
    ],
  };
  return groups ? { ...shape, groups } : shape;
}

function counter(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

/**
 * a, b: group A, with b one level deeper in A/B together with c
 * d: group D
 * e: ungrouped
 */
const shapes: readonly Shape[] = [
  square('a', 0, ['A']),
  square('b', 20, ['A', 'B']),
  square('c', 40, ['A', 'B']),
  square('d', 60, ['D']),
  square('e', 80),
];
const doc: LaserDocument = { shapes, layers: [] };
const ids = (...list: string[]) => new Set(list);
const groupsOf = (d: LaserDocument) => d.shapes.map((shape) => shape.groups);

describe('scopes', () => {
  it('reaches everything at top level and only the group inside a scope', () => {
    expect(reachableShapes(shapes, TOP_LEVEL)).toBe(shapes);
    expect(scopeShapeIds(shapes, ['A'])).toEqual(['a', 'b', 'c']);
    expect(scopeShapeIds(shapes, ['A', 'B'])).toEqual(['b', 'c']);
    expect(scopeShapeIds(shapes, ['B'])).toEqual([]);
    expect(isInScope(square('x', 0), ['A'])).toBe(false);
  });

  it('knows which scopes exist and falls back to the deepest one left', () => {
    expect(scopeExists(shapes, TOP_LEVEL)).toBe(true);
    expect(scopeExists(shapes, ['A', 'B'])).toBe(true);
    expect(scopeExists(shapes, ['B'])).toBe(false);
    expect(scopeExists([], TOP_LEVEL)).toBe(true);

    const scope = ['A', 'B'];
    expect(existingScope(shapes, scope)).toBe(scope);
    expect(existingScope(shapes, ['A', 'gone'])).toEqual(['A']);
    expect(existingScope(shapes, ['gone', 'B'])).toEqual([]);
    expect(existingScope([], ['A'])).toEqual([]);
    expect(existingScope(shapes, TOP_LEVEL)).toBe(TOP_LEVEL);
  });

  it('enters one level at a time', () => {
    expect(scopeEntering(shapes, 'b', TOP_LEVEL)).toEqual(['A']);
    expect(scopeEntering(shapes, 'b', ['A'])).toEqual(['A', 'B']);
    expect(scopeEntering(shapes, 'b', ['A', 'B'])).toBeNull();
    expect(scopeEntering(shapes, 'a', ['A'])).toBeNull();
    expect(scopeEntering(shapes, 'e', TOP_LEVEL)).toBeNull();
    expect(scopeEntering(shapes, 'd', ['A'])).toBeNull();
    expect(scopeEntering(shapes, 'missing', TOP_LEVEL)).toBeNull();
  });
});

describe('units', () => {
  it('takes the whole outermost group at top level', () => {
    expect(unitOf(shapes, 'b', TOP_LEVEL)).toEqual(['a', 'b', 'c']);
    expect(unitOf(shapes, 'd', TOP_LEVEL)).toEqual(['d']);
    expect(unitOf(shapes, 'e', TOP_LEVEL)).toEqual(['e']);
  });

  it('takes one level less inside a scope', () => {
    expect(unitOf(shapes, 'a', ['A'])).toEqual(['a']);
    expect(unitOf(shapes, 'b', ['A'])).toEqual(['b', 'c']);
    expect(unitOf(shapes, 'b', ['A', 'B'])).toEqual(['b']);
  });

  it('has no unit for shapes that are out of scope or unknown', () => {
    expect(unitOf(shapes, 'd', ['A'])).toEqual([]);
    expect(unitOf(shapes, 'a', ['A', 'B'])).toEqual([]);
    expect(unitOf(shapes, 'missing', TOP_LEVEL)).toEqual([]);
  });

  it('expands a partial selection to whole units', () => {
    expect([...expandToUnits(shapes, ids('c', 'e'), TOP_LEVEL)].sort()).toEqual(['a', 'b', 'c', 'e']);
    expect([...expandToUnits(shapes, ids('c'), ['A'])].sort()).toEqual(['b', 'c']);
    expect([...expandToUnits(shapes, ids('c'), ['A', 'B'])]).toEqual(['c']);
    // Out-of-scope and unknown ids are dropped.
    expect([...expandToUnits(shapes, ids('a', 'd', 'nope'), ['A'])]).toEqual(['a']);
    expect(expandToUnits(shapes, ids(), TOP_LEVEL).size).toBe(0);
  });

  it('counts units, not shapes', () => {
    expect(countUnits(shapes, ids('a', 'b', 'c'), TOP_LEVEL)).toBe(1);
    expect(countUnits(shapes, ids('a', 'b', 'c'), ['A'])).toBe(2);
    expect(countUnits(shapes, ids('b', 'c'), ['A', 'B'])).toBe(2);
    expect(countUnits(shapes, ids('a', 'd', 'e'), TOP_LEVEL)).toBe(3);
    expect(countUnits(shapes, ids('d'), ['A'])).toBe(0);
  });
});

describe('unitsInRect', () => {
  const around = (minX: number, maxX: number) => ({ minX, minY: -1, maxX, maxY: 11 });

  it('encloses a unit only when all its shapes are inside', () => {
    // Covers a and b but not c: group A is incomplete.
    expect(unitsInRect(shapes, around(-1, 31), 'enclose', TOP_LEVEL)).toEqual([]);
    expect(unitsInRect(shapes, around(-1, 51), 'enclose', TOP_LEVEL)).toEqual(['a', 'b', 'c']);
    // c of the incomplete group A is dropped, d and e are whole.
    expect(unitsInRect(shapes, around(39, 91), 'enclose', TOP_LEVEL)).toEqual(['d', 'e']);
  });

  it('crossing takes a unit when any of its shapes is touched', () => {
    expect(unitsInRect(shapes, around(-1, 5), 'cross', TOP_LEVEL).sort()).toEqual(['a', 'b', 'c']);
    expect(unitsInRect(shapes, around(45, 65), 'cross', TOP_LEVEL).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('only sees the shapes of the scope', () => {
    expect(unitsInRect(shapes, around(-1, 91), 'enclose', ['A']).sort()).toEqual(['a', 'b', 'c']);
    expect(unitsInRect(shapes, around(-1, 31), 'enclose', ['A'])).toEqual(['a']);
    expect(unitsInRect(shapes, around(-1, 31), 'enclose', ['A', 'B'])).toEqual(['b']);
    expect(unitsInRect(shapes, around(55, 91), 'cross', ['A'])).toEqual([]);
  });
});

describe('groupShapes', () => {
  it('puts two units into a new outermost group and keeps what is inside them', () => {
    const next = groupShapes(doc, ids('a', 'e'), TOP_LEVEL, 'N');
    expect(groupsOf(next)).toEqual([['N', 'A'], ['N', 'A', 'B'], ['N', 'A', 'B'], ['D'], ['N']]);
    expect(next.layers).toBe(doc.layers);
    // The untouched shape keeps its identity.
    expect(next.shapes[3]).toBe(shapes[3]);
    expect(unitOf(next.shapes, 'e', TOP_LEVEL)).toEqual(['a', 'b', 'c', 'e']);
    expect(unitOf(next.shapes, 'e', ['N'])).toEqual(['e']);
    expect(unitOf(next.shapes, 'a', ['N'])).toEqual(['a', 'b', 'c']);
  });

  it('inserts the new group at the depth of the scope', () => {
    const next = groupShapes(doc, ids('a', 'b'), ['A'], 'N');
    expect(groupsOf(next)).toEqual([['A', 'N'], ['A', 'N', 'B'], ['A', 'N', 'B'], ['D'], undefined]);
  });

  it('grows a partial selection to whole units so no group is split', () => {
    const next = groupShapes(doc, ids('c', 'd'), TOP_LEVEL, 'N');
    expect(groupsOf(next)).toEqual([['N', 'A'], ['N', 'A', 'B'], ['N', 'A', 'B'], ['N', 'D'], undefined]);
  });

  it('does nothing for fewer than two units', () => {
    expect(groupShapes(doc, ids(), TOP_LEVEL, 'N')).toBe(doc);
    expect(groupShapes(doc, ids('e'), TOP_LEVEL, 'N')).toBe(doc);
    // One existing group, fully or partly selected, is not grouped again.
    expect(groupShapes(doc, ids('a', 'b', 'c'), TOP_LEVEL, 'N')).toBe(doc);
    expect(groupShapes(doc, ids('b'), TOP_LEVEL, 'N')).toBe(doc);
    // Out-of-scope shapes do not count.
    expect(groupShapes(doc, ids('a', 'd', 'e'), ['A'], 'N')).toBe(doc);
    expect(canGroup(shapes, ids('a', 'b', 'c'), TOP_LEVEL)).toBe(false);
    expect(canGroup(shapes, ids('a', 'b', 'c'), ['A'])).toBe(true);
    expect(canGroup(shapes, ids('d', 'e'), TOP_LEVEL)).toBe(true);
  });
});

describe('ungroupShapes', () => {
  it('removes one level and keeps the groups inside', () => {
    const next = ungroupShapes(doc, ids('a', 'b', 'c', 'e'), TOP_LEVEL);
    expect(groupsOf(next)).toEqual([undefined, ['B'], ['B'], ['D'], undefined]);
    expect('groups' in (next.shapes[0] ?? {})).toBe(false);
    expect(next.shapes[4]).toBe(shapes[4]);
  });

  it('removes the level below the scope', () => {
    const next = ungroupShapes(doc, ids('b', 'c'), ['A']);
    expect(groupsOf(next)).toEqual([['A'], ['A'], ['A'], ['D'], undefined]);
  });

  it('releases only the selected shapes of a partly selected group', () => {
    const next = ungroupShapes(doc, ids('b'), TOP_LEVEL);
    expect(groupsOf(next)).toEqual([['A'], ['B'], ['A', 'B'], ['D'], undefined]);
  });

  it('does nothing when no selected shape is in a group of the scope', () => {
    expect(ungroupShapes(doc, ids(), TOP_LEVEL)).toBe(doc);
    expect(ungroupShapes(doc, ids('e'), TOP_LEVEL)).toBe(doc);
    expect(ungroupShapes(doc, ids('a'), ['A'])).toBe(doc);
    expect(ungroupShapes(doc, ids('d'), ['A'])).toBe(doc);
    expect(canUngroup(shapes, ids('e'), TOP_LEVEL)).toBe(false);
    expect(canUngroup(shapes, ids('a'), ['A'])).toBe(false);
    expect(canUngroup(shapes, ids('b'), ['A'])).toBe(true);
    expect(canUngroup(shapes, ids('e', 'd'), TOP_LEVEL)).toBe(true);
  });

  it('undoes a group', () => {
    const grouped = groupShapes(doc, ids('d', 'e'), TOP_LEVEL, 'N');
    expect(groupsOf(ungroupShapes(grouped, ids('d', 'e'), TOP_LEVEL))).toEqual(groupsOf(doc));
  });
});

describe('remapGroupIds', () => {
  it('gives fresh ids and keeps the nesting', () => {
    const mapped = remapGroupIds(shapes, counter('n'));
    expect(mapped.map((shape) => shape.groups)).toEqual([['n1'], ['n1', 'n2'], ['n1', 'n2'], ['n3'], undefined]);
    expect(mapped.map((shape) => shape.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(mapped[4]).toBe(shapes[4]);
    // The originals are untouched.
    expect(shapes[1]?.groups).toEqual(['A', 'B']);
  });

  it('asks for no id when nothing is grouped', () => {
    let calls = 0;
    remapGroupIds([square('x', 0), square('y', 20)], () => `n${++calls}`);
    expect(calls).toBe(0);
  });
});

describe('withGroups', () => {
  it('drops the property for an empty path', () => {
    const plain = withGroups(square('x', 0, ['A']), []);
    expect('groups' in plain).toBe(false);
    expect(shapeGroups(plain)).toEqual([]);
    const same = square('y', 0);
    expect(withGroups(same, [])).toBe(same);
    expect(withGroups(same, ['G']).groups).toEqual(['G']);
  });
});

describe('document edits keep the groups', () => {
  it('survives a transform', () => {
    const next = transformShapes(doc, ids('b', 'e'), translation(5, 5));
    expect(groupsOf(next)).toEqual(groupsOf(doc));
    expect(next.shapes[1]?.points[0]).toEqual({ x: 25, y: 5 });
  });

  it('survives a colour change', () => {
    const next = setShapesColor(doc, ids('a', 'b'), '#ff0000');
    expect(next.shapes[1]?.color).toBe('#ff0000');
    expect(groupsOf(next)).toEqual(groupsOf(doc));
  });

  it('survives the removal of other shapes', () => {
    const next = removeShapes(doc, ids('a', 'd'));
    expect(next.shapes.map((shape) => shape.id)).toEqual(['b', 'c', 'e']);
    expect(groupsOf(next)).toEqual([['A', 'B'], ['A', 'B'], undefined]);
    // Group D is gone with its last shape; A/B still exists.
    expect(scopeExists(next.shapes, ['D'])).toBe(false);
    expect(existingScope(next.shapes, ['A', 'B'])).toEqual(['A', 'B']);
  });
});

describe('per-shape cut settings and groups', () => {
  const settings = { speedMmS: 30, maxPowerPct: 40, minPowerPct: 40, passes: 1 };
  const cell = (id: string, groups?: readonly string[]): Shape => ({
    id,
    color: '#a04000',
    closed: true,
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ],
    settings,
    ...(groups ? { groups } : {}),
  });

  it('keeps them through grouping, ungrouping and fresh group ids', () => {
    const doc = { shapes: [cell('a'), cell('b')], layers: [] };
    const grouped = groupShapes(doc, new Set(['a', 'b']), TOP_LEVEL, 'g9');
    expect(grouped.shapes.map((shape) => shape.groups)).toEqual([['g9'], ['g9']]);
    expect(grouped.shapes.map((shape) => shape.settings)).toEqual([settings, settings]);
    const ungrouped = ungroupShapes(grouped, new Set(['a', 'b']), TOP_LEVEL);
    expect(ungrouped.shapes.map((shape) => shape.groups)).toEqual([undefined, undefined]);
    expect(ungrouped.shapes.map((shape) => shape.settings)).toEqual([settings, settings]);
    let n = 0;
    const remapped = remapGroupIds(grouped.shapes, () => `n${++n}`);
    expect(remapped.map((shape) => shape.groups)).toEqual([['n1'], ['n1']]);
    expect(remapped.map((shape) => shape.settings)).toEqual([settings, settings]);
    expect(withGroups(cell('c', ['g1']), []).settings).toBe(settings);
  });
});
