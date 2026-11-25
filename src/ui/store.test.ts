import { beforeEach, describe, expect, it } from 'vitest';
import { addShapes, defaultLayer, EMPTY_DOCUMENT } from '../model/document';
import {
  DEFAULT_MATERIAL_TEST_OPTIONS,
  defaultAxis,
  MATERIAL_TEST_CELL_COLOR,
  MATERIAL_TEST_LABEL_COLOR,
} from '../model/materialTest';
import { boundsOfShapes } from '../model/selection';
import { translation } from '../model/transform';
import type { LaserDocument, Shape } from '../model/types';
import { useAppStore } from './store';

function rect(id: string, x: number, groups?: readonly string[]): Shape {
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

function docOf(...shapes: Shape[]): LaserDocument {
  return addShapes(EMPTY_DOCUMENT, shapes);
}

const app = () => useAppStore.getState();
const ids = () => app().doc.shapes.map((shape) => shape.id);

/** Every test starts from a document with shapes a and b, a selected, and one step of history. */
let original: LaserDocument;
beforeEach(() => {
  original = docOf(rect('a', 0), rect('b', 20));
  useAppStore.setState({ doc: original, past: [EMPTY_DOCUMENT], future: [], selection: new Set(['a']), scope: [] });
});

describe('commitDocument', () => {
  it('replaces the document as one undo step, with nothing selected and at top level', () => {
    const grouped = docOf(rect('a', 0, ['g']));
    useAppStore.setState({ doc: grouped, scope: ['g'] });
    const next = docOf(rect('n1', 0), rect('n2', 20));
    expect(app().commitDocument(next)).toBe(true);
    expect(app().doc).toBe(next);
    expect(app().past).toEqual([EMPTY_DOCUMENT, grouped]);
    expect(app().selection.size).toBe(0);
    expect(app().scope).toEqual([]);
    app().undo();
    expect(app().doc).toBe(grouped);
  });

  it('does nothing for the document that is already there', () => {
    expect(app().commitDocument(original)).toBe(false);
    expect(app().past).toEqual([EMPTY_DOCUMENT]);
    // And it does not turn that document into one an amend may swap.
    expect(app().amendDocument(original, docOf(rect('x', 0)))).toBe(false);
    expect(app().doc).toBe(original);
  });

  it('clears redo like any other edit', () => {
    app().undo();
    expect(app().future).toHaveLength(1);
    app().commitDocument(docOf(rect('n', 0)));
    expect(app().future).toEqual([]);
  });
});

describe('amendDocument', () => {
  it('swaps a committed document without another undo step, however often', () => {
    const first = docOf(rect('n1', 0));
    const second = docOf(rect('n2', 0), rect('n3', 20));
    const third = docOf(rect('n4', 0));
    app().commitDocument(first);
    expect(app().amendDocument(first, second)).toBe(true);
    expect(app().amendDocument(second, third)).toBe(true);
    expect(app().doc).toBe(third);
    expect(app().past).toEqual([EMPTY_DOCUMENT, original]);

    // One undo goes all the way back, one redo returns to the last amend.
    app().undo();
    expect(app().doc).toBe(original);
    expect(app().future).toEqual([third]);
    app().redo();
    expect(app().doc).toBe(third);
    expect(app().past).toEqual([EMPTY_DOCUMENT, original]);
  });

  it('refuses a document that is not on screen any more', () => {
    const nested = docOf(rect('n1', 0));
    const replacement = docOf(rect('n2', 0));
    app().commitDocument(nested);
    // An edit got in between.
    app().select(['n1']);
    app().transformSelection(translation(5, 0));
    const edited = app().doc;
    expect(edited).not.toBe(nested);
    expect(app().amendDocument(nested, replacement)).toBe(false);
    expect(app().doc).toBe(edited);
    expect(app().past).toEqual([EMPTY_DOCUMENT, original, nested]);

    // Undone twice, the original is on screen: the committed document cannot be swapped then either.
    app().undo();
    app().undo();
    expect(app().doc).toBe(original);
    expect(app().amendDocument(nested, replacement)).toBe(false);
    expect(app().doc).toBe(original);
  });

  it('refuses an amended-away document', () => {
    const first = docOf(rect('n1', 0));
    const second = docOf(rect('n2', 0));
    app().commitDocument(first);
    app().amendDocument(first, second);
    expect(app().amendDocument(first, docOf(rect('n3', 0)))).toBe(false);
    expect(app().doc).toBe(second);
  });

  it('never swaps a document that an ordinary edit made', () => {
    app().selectAll();
    app().transformSelection(translation(5, 0));
    const edited = app().doc;
    const past = app().past;
    expect(app().amendDocument(edited, docOf(rect('x', 0)))).toBe(false);
    expect(app().doc).toBe(edited);
    expect(app().past).toBe(past);
  });

  it('works again once undo and redo are back on the committed document', () => {
    const nested = docOf(rect('n1', 0));
    const replacement = docOf(rect('n2', 0));
    app().commitDocument(nested);
    app().undo();
    app().redo();
    expect(app().amendDocument(nested, replacement)).toBe(true);
    expect(ids()).toEqual(['n2']);
    app().undo();
    expect(app().doc).toBe(original);
  });

  it('clears redo, because what could be redone was built on the old document', () => {
    const nested = docOf(rect('n1', 0));
    app().commitDocument(nested);
    app().select(['n1']);
    app().transformSelection(translation(5, 0));
    app().undo();
    expect(app().doc).toBe(nested);
    expect(app().future).toHaveLength(1);
    expect(app().amendDocument(nested, docOf(rect('n2', 0)))).toBe(true);
    expect(app().future).toEqual([]);
  });

  it('keeps the selection of shapes that are still there and drops the rest', () => {
    const nested = docOf(rect('b', 20), rect('n1', 0));
    app().commitDocument(nested);
    app().select(['b', 'n1']);
    app().amendDocument(nested, docOf(rect('b', 20), rect('n2', 0)));
    expect([...app().selection]).toEqual(['b']);
  });

  it('leaves an entered group that is gone', () => {
    const nested = docOf(rect('n1', 0, ['g1']), rect('n2', 20, ['g1']));
    app().commitDocument(nested);
    app().enterGroup('n1');
    expect(app().scope).toEqual(['g1']);
    app().amendDocument(nested, docOf(rect('n3', 0, ['g2']), rect('n4', 20, ['g2'])));
    expect(app().scope).toEqual([]);
  });

  it('counts amending to the same document as done, and changes nothing', () => {
    const nested = docOf(rect('n1', 0));
    app().commitDocument(nested);
    const before = app();
    expect(app().amendDocument(nested, nested)).toBe(true);
    expect(app()).toBe(before);
  });
});

describe('ordinary edits', () => {
  it('still record one undo step each after a commit and an amend', () => {
    const nested = docOf(rect('n1', 0));
    const swapped = docOf(rect('n2', 0));
    app().commitDocument(nested);
    app().amendDocument(nested, swapped);
    app().select(['n2']);
    app().transformSelection(translation(5, 0));
    app().transformSelection(translation(5, 0));
    expect(app().past).toHaveLength(4);
    app().undo();
    app().undo();
    expect(app().doc).toBe(swapped);
    app().undo();
    expect(app().doc).toBe(original);
  });
});

describe('addMaterialTest', () => {
  it('adds the grid as one undo step, selected as one group at top level, with both layers set up', () => {
    const grouped = docOf(rect('a', 0, ['g']), rect('b', 20, ['g']));
    useAppStore.setState({ doc: grouped, past: [], scope: ['g'], fitRequest: 7 });
    expect(app().addMaterialTest(DEFAULT_MATERIAL_TEST_OPTIONS, { x: 10, y: 10 })).toBe(true);

    const added = app().doc.shapes.slice(2);
    expect(added.filter((shape) => shape.color === MATERIAL_TEST_CELL_COLOR)).toHaveLength(25);
    expect(added.filter((shape) => shape.color === MATERIAL_TEST_LABEL_COLOR).length).toBeGreaterThan(10);
    expect(added).toHaveLength(app().doc.shapes.length - 2);
    // One group, new to the document, holding every added shape.
    const group = added[0]?.groups;
    expect(group).toHaveLength(1);
    expect(group?.[0]).not.toBe('g');
    for (const shape of added) expect(shape.groups).toEqual(group);
    expect(new Set(ids()).size).toBe(ids().length);
    expect(app().selection).toEqual(new Set(added.map((shape) => shape.id)));
    expect(app().scope).toEqual([]);
    const bounds = boundsOfShapes(app().doc.shapes, app().selection);
    expect(bounds?.minX).toBeCloseTo(10, 9);
    expect(bounds?.minY).toBeCloseTo(10, 9);
    // The view is not asked to move.
    expect(app().fitRequest).toBe(7);

    expect(app().doc.layers.map((layer) => layer.color)).toEqual(['#000000', MATERIAL_TEST_LABEL_COLOR, MATERIAL_TEST_CELL_COLOR]);
    expect(app().doc.layers[1]).toEqual({
      ...defaultLayer(MATERIAL_TEST_LABEL_COLOR),
      speedMmS: 100,
      maxPowerPct: 12,
      minPowerPct: 12,
      passes: 1,
    });
    expect(app().doc.layers[2]).toEqual(defaultLayer(MATERIAL_TEST_CELL_COLOR));

    expect(app().past).toEqual([grouped]);
    app().undo();
    expect(app().doc).toBe(grouped);
    expect(app().selection.size).toBe(0);
    app().redo();
    expect(app().doc.shapes).toHaveLength(added.length + 2);
    expect(app().doc.shapes[app().doc.shapes.length - 1]?.settings).toEqual({ speedMmS: 50, maxPowerPct: 50, minPowerPct: 50, passes: 1 });
  });

  it('updates the label layer of an earlier test and gives the second test a group of its own', () => {
    app().addMaterialTest(DEFAULT_MATERIAL_TEST_OPTIONS, { x: 10, y: 10 });
    const firstGroup = app().doc.shapes[app().doc.shapes.length - 1]?.groups;
    app().addMaterialTest({ ...DEFAULT_MATERIAL_TEST_OPTIONS, labelSpeedMmS: 150, labelPowerPct: 9 }, { x: 200, y: 10 });
    const secondGroup = app().doc.shapes[app().doc.shapes.length - 1]?.groups;
    expect(secondGroup).not.toEqual(firstGroup);
    expect(app().doc.layers).toHaveLength(3);
    expect(app().doc.layers.find((layer) => layer.color === MATERIAL_TEST_LABEL_COLOR)).toMatchObject({ speedMmS: 150, maxPowerPct: 9, minPowerPct: 9 });
    expect(app().doc.shapes.filter((shape) => shape.color === MATERIAL_TEST_CELL_COLOR)).toHaveLength(50);
  });

  it('keeps the cells\' own settings through copy, paste, duplicate, move and undo, and drops them on a layer change', () => {
    useAppStore.setState({ doc: EMPTY_DOCUMENT, past: [], selection: new Set() });
    app().addMaterialTest({ ...DEFAULT_MATERIAL_TEST_OPTIONS, labels: false }, { x: 10, y: 10 });
    const withSettings = () => app().doc.shapes.filter((shape) => shape.settings !== undefined).length;
    expect(withSettings()).toBe(25);
    app().transformSelection(translation(30, 0));
    expect(withSettings()).toBe(25);
    app().duplicateSelection();
    expect(withSettings()).toBe(50);
    app().copySelection();
    app().paste({ x: 300, y: 300 });
    expect(withSettings()).toBe(75);
    expect(app().doc.shapes[74]?.settings).toEqual(app().doc.shapes[24]?.settings);
    app().undo();
    app().undo();
    expect(withSettings()).toBe(25);
    app().redo();
    expect(withSettings()).toBe(50);
    // The duplicate moves to black and uses that layer's settings from then on.
    app().select(app().doc.shapes.slice(25).map((shape) => shape.id));
    app().setSelectionColor('#000000');
    expect(withSettings()).toBe(25);
    expect(app().doc.shapes.filter((shape) => shape.color === '#000000')).toHaveLength(25);
    app().undo();
    expect(withSettings()).toBe(50);
  });

  it('adds nothing when both axes vary the same setting', () => {
    const before = app().doc;
    expect(app().addMaterialTest({ ...DEFAULT_MATERIAL_TEST_OPTIONS, rows: defaultAxis('speed') }, { x: 10, y: 10 })).toBe(false);
    expect(app().doc).toBe(before);
    expect(app().past).toEqual([EMPTY_DOCUMENT]);
  });
});
