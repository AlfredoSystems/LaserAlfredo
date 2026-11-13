import { useMemo, useRef, useState, type DragEvent } from 'react';
import { boundsContainsBounds } from '../geometry/bounds';
import { HL1060_BED } from '../model/bed';
import { boundsOfShapes } from '../model/selection';
import { LayersPanel } from './LayersPanel';
import { NumberField } from './NumberField';
import { BED_BOUNDS, useAppStore } from './store';
import { TransformPanel } from './TransformPanel';
import { Workspace } from './Workspace';

async function importFiles(files: Iterable<File>): Promise<void> {
  for (const file of files) {
    try {
      const text = await file.text();
      useAppStore.getState().importText(file.name, text);
    } catch {
      useAppStore.getState().setNotice({ kind: 'error', text: `${file.name}: could not read the file` });
    }
  }
}

function Toolbar() {
  const fileInput = useRef<HTMLInputElement>(null);
  const canUndo = useAppStore((state) => state.past.length > 0);
  const canRedo = useAppStore((state) => state.future.length > 0);
  const hasSelection = useAppStore((state) => state.selection.size > 0);
  const hasShapes = useAppStore((state) => state.doc.shapes.length > 0);
  const joinToleranceMm = useAppStore((state) => state.joinToleranceMm);
  const keepFileColors = useAppStore((state) => state.keepFileColors);
  const { undo, redo, deleteSelection, requestFit, setJoinTolerance, setKeepFileColors } = useAppStore.getState();

  return (
    <div className="toolbar">
      <button type="button" className="primary" onClick={() => fileInput.current?.click()}>
        Import…
      </button>
      <input
        ref={fileInput}
        type="file"
        accept=".dxf,.svg"
        multiple
        hidden
        data-testid="file-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          // Reset so picking the same file again still fires a change event.
          event.target.value = '';
          void importFiles(files);
        }}
      />
      <span className="toolbar-gap" />
      <button type="button" disabled={!canUndo} onClick={undo} title="Undo (Ctrl+Z)">
        Undo
      </button>
      <button type="button" disabled={!canRedo} onClick={redo} title="Redo (Ctrl+Y)">
        Redo
      </button>
      <button type="button" disabled={!hasSelection} onClick={deleteSelection} title="Delete selection (Del)">
        Delete
      </button>
      <span className="toolbar-gap" />
      <button type="button" onClick={() => requestFit('bed')} title="Show the whole bed">
        Fit bed
      </button>
      <button type="button" disabled={!hasShapes} onClick={() => requestFit('all')} title="Zoom to all shapes">
        Fit all
      </button>
      <button type="button" disabled={!hasSelection} onClick={() => requestFit('selection')} title="Zoom to the selection">
        Fit selection
      </button>
      <span className="toolbar-gap" />
      <NumberField
        label="Join gap mm"
        title="On import, endpoints closer than this are joined into one path"
        value={joinToleranceMm}
        min={0}
        max={10}
        decimals={3}
        onCommit={setJoinTolerance}
      />
      <label
        className="check"
        title="Off: everything imports onto the active layer. On: one layer per colour in the file (snapped to the palette)."
      >
        <input
          type="checkbox"
          checked={keepFileColors}
          data-testid="keep-colors"
          onChange={(event) => setKeepFileColors(event.target.checked)}
        />
        Keep file colours
      </label>
    </div>
  );
}

function StatusBar() {
  const cursor = useAppStore((state) => state.cursor);
  const zoom = useAppStore((state) => state.zoom);
  const shapes = useAppStore((state) => state.doc.shapes);
  const notice = useAppStore((state) => state.notice);
  const outOfBed = useMemo(() => {
    const bounds = boundsOfShapes(shapes);
    return bounds !== null && !boundsContainsBounds(BED_BOUNDS, bounds);
  }, [shapes]);

  return (
    <footer className="status">
      <span className="status-cell status-mono">
        {cursor ? `X ${cursor.x.toFixed(2)}  Y ${cursor.y.toFixed(2)} mm` : 'X –  Y –'}
      </span>
      <span className="status-cell status-mono">{zoom.toFixed(2)} px/mm</span>
      <span className="status-cell" data-testid="shape-count">
        {shapes.length} {shapes.length === 1 ? 'shape' : 'shapes'}
      </span>
      {outOfBed && (
        <span className="status-cell status-error" data-testid="out-of-bed">
          Shapes outside the bed
        </span>
      )}
      {notice && (
        <span className={`status-cell status-notice ${notice.kind === 'error' ? 'status-error' : ''}`} data-testid="notice">
          {notice.text}
        </span>
      )}
    </footer>
  );
}

export function App() {
  const [dropping, setDropping] = useState(false);

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropping(false);
    void importFiles(Array.from(event.dataTransfer.files));
  };

  return (
    <div
      className={`app ${dropping ? 'app-dropping' : ''}`}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDropping(false);
      }}
      onDrop={onDrop}
    >
      <header className="app-header">
        <h1>LaserAlfredo</h1>
        <span className="app-bed" data-testid="bed-size">
          Bed {HL1060_BED.widthMm} × {HL1060_BED.heightMm} mm
        </span>
        <Toolbar />
      </header>
      <div className="app-body">
        <Workspace />
        <aside className="sidebar">
          <TransformPanel />
          <LayersPanel />
        </aside>
      </div>
      <StatusBar />
    </div>
  );
}
