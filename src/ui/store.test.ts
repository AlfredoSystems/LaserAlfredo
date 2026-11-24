import { beforeEach, describe, expect, it } from 'vitest';
import { addShapes, EMPTY_DOCUMENT } from '../model/document';
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
