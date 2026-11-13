import { useEffect, useRef } from 'react';
import { HL1060_BED } from '../model/bed';
import {
  handlePosition,
  rotateDragMatrix,
  SCALE_HANDLES,
  scaleDragMatrix,
  type ScaleHandle,
} from '../model/handles';
import { boundsOfShapes, pickShape, shapesInRect } from '../model/selection';
import { IDENTITY, translation, type Matrix } from '../model/transform';
import type { Bounds, Point } from '../model/types';
import { fitBounds, panBy, toDocument, toScreen, zoomAt, type View } from '../model/view';
import { HANDLE_SIZE_PX, renderScene, rotateHandleScreen } from './scene/render';
import { useJobStore } from './jobStore';
import { BED_BOUNDS, useAppStore } from './store';

const PICK_TOLERANCE_PX = 6;
const DRAG_THRESHOLD_PX = 3;
const ROTATE_SNAP = Math.PI / 12;

type Drag =
  | { kind: 'pan'; last: Point }
  | { kind: 'move'; startScreen: Point; start: Point; active: boolean }
  | { kind: 'scale'; handle: ScaleHandle; bounds: Bounds }
  | { kind: 'rotate'; center: Point; start: Point }
  | { kind: 'marquee'; startScreen: Point; start: Point; current: Point; additive: boolean; active: boolean };

function isTextInput(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
}

export function Workspace() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!container || !canvas || !ctx) return;

    let view: View = { scale: 1, offsetX: 0, offsetY: 0 };
    let width = 0;
    let height = 0;
    let drag: Drag | null = null;
    let preview: Matrix | null = null;
    let spaceDown = false;
    let frame = 0;
    let fitted = false;

    const selectionBounds = (): Bounds | null => {
      const { doc, selection } = useAppStore.getState();
      return selection.size === 0 ? null : boundsOfShapes(doc.shapes, selection);
    };

    const draw = () => {
      frame = 0;
      const { doc, selection } = useAppStore.getState();
      const job = useJobStore.getState();
      renderScene(ctx, {
        doc,
        selection,
        selectionBounds: selectionBounds(),
        view,
        bed: HL1060_BED,
        widthPx: width,
        heightPx: height,
        dpr: window.devicePixelRatio || 1,
        preview,
        marquee: drag?.kind === 'marquee' && drag.active ? { a: drag.start, b: drag.current } : null,
        jobPreview:
          job.preview && job.built
            ? { segments: job.segments, colors: job.built.job.layers.map((layer) => layer.color), fraction: job.fraction }
            : null,
      });
    };
    const requestDraw = () => {
      if (frame === 0) frame = requestAnimationFrame(draw);
    };

    const setView = (next: View) => {
      view = next;
      useAppStore.getState().setZoom(next.scale);
      requestDraw();
    };

    const fit = (target: Bounds | null) => {
      if (width > 0 && height > 0) setView(fitBounds(target ?? BED_BOUNDS, width, height));
    };

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      width = container.clientWidth;
      height = container.clientHeight;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      if (!fitted && width > 0 && height > 0) {
        fitted = true;
        fit(null);
      }
      // Draw now: resizing clears the canvas, and waiting a frame would flicker.
      if (frame !== 0) cancelAnimationFrame(frame);
      draw();
    };

    const eventPoint = (event: MouseEvent): Point => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const handleAt = (screen: Point): ScaleHandle | 'rotate' | null => {
      const bounds = selectionBounds();
      if (!bounds) return null;
      const reach = HANDLE_SIZE_PX / 2 + 3;
      const rotate = rotateHandleScreen(view, bounds);
      if (Math.hypot(screen.x - rotate.x, screen.y - rotate.y) <= reach + 1) return 'rotate';
      for (const handle of SCALE_HANDLES) {
        const p = toScreen(view, handlePosition(bounds, handle));
        if (Math.abs(screen.x - p.x) <= reach && Math.abs(screen.y - p.y) <= reach) return handle;
      }
      return null;
    };

    const cursorFor = (screen: Point): string => {
      if (spaceDown || useJobStore.getState().preview) return 'grab';
      const handle = handleAt(screen);
      if (handle === 'rotate') return 'crosshair';
      if (handle === 'n' || handle === 's') return 'ns-resize';
      if (handle === 'e' || handle === 'w') return 'ew-resize';
      if (handle === 'nw' || handle === 'se') return 'nwse-resize';
      if (handle === 'ne' || handle === 'sw') return 'nesw-resize';
      const shape = pickShape(useAppStore.getState().doc.shapes, toDocument(view, screen), PICK_TOLERANCE_PX / view.scale);
      return shape ? 'move' : 'default';
    };

    const onPointerDown = (event: PointerEvent) => {
      if (drag) return;
      const screen = eventPoint(event);
      const point = toDocument(view, screen);
      const store = useAppStore.getState();

      // The preview is read-only: every drag pans.
      const panOnly = useJobStore.getState().preview;
      if (event.button === 1 || event.button === 2 || (event.button === 0 && (spaceDown || panOnly))) {
        drag = { kind: 'pan', last: screen };
      } else if (event.button === 0) {
        const handle = handleAt(screen);
        const bounds = selectionBounds();
        if (handle === 'rotate' && bounds) {
          drag = {
            kind: 'rotate',
            center: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 },
            start: point,
          };
        } else if (handle && handle !== 'rotate' && bounds) {
          drag = { kind: 'scale', handle, bounds };
        } else {
          const shape = pickShape(store.doc.shapes, point, PICK_TOLERANCE_PX / view.scale);
          if (shape && event.shiftKey) {
            store.toggleSelect(shape.id);
          } else if (shape) {
            if (!store.selection.has(shape.id)) store.select([shape.id]);
            drag = { kind: 'move', startScreen: screen, start: point, active: false };
          } else {
            drag = {
              kind: 'marquee',
              startScreen: screen,
              start: point,
              current: point,
              additive: event.shiftKey,
              active: false,
            };
          }
        }
      }
      if (drag) {
        canvas.setPointerCapture(event.pointerId);
        event.preventDefault();
      }
      canvas.focus();
      requestDraw();
    };

    const onPointerMove = (event: PointerEvent) => {
      const screen = eventPoint(event);
      const point = toDocument(view, screen);
      useAppStore.getState().setCursor(point);

      if (!drag) {
        canvas.style.cursor = cursorFor(screen);
        return;
      }
      switch (drag.kind) {
        case 'pan':
          setView(panBy(view, screen.x - drag.last.x, screen.y - drag.last.y));
          drag.last = screen;
          canvas.style.cursor = 'grabbing';
          return;
        case 'move': {
          const moved = Math.hypot(screen.x - drag.startScreen.x, screen.y - drag.startScreen.y);
          if (!drag.active && moved < DRAG_THRESHOLD_PX) return;
          drag.active = true;
          let dx = point.x - drag.start.x;
          let dy = point.y - drag.start.y;
          // Shift locks the move to the dominant axis.
          if (event.shiftKey) {
            if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
            else dx = 0;
          }
          preview = translation(dx, dy);
          break;
        }
        case 'scale':
          // Corners keep the aspect ratio unless Shift is held.
          preview = scaleDragMatrix(drag.bounds, drag.handle, point, {
            uniform: !event.shiftKey,
            fromCenter: event.ctrlKey || event.metaKey,
          });
          break;
        case 'rotate':
          preview = rotateDragMatrix(drag.center, drag.start, point, event.shiftKey ? ROTATE_SNAP : 0);
          break;
        case 'marquee': {
          const moved = Math.hypot(screen.x - drag.startScreen.x, screen.y - drag.startScreen.y);
          if (!drag.active && moved < DRAG_THRESHOLD_PX) return;
          drag.active = true;
          drag.current = point;
          break;
        }
      }
      requestDraw();
    };

    const finishDrag = (commit: boolean) => {
      const finished = drag;
      const matrix = preview;
      drag = null;
      preview = null;
      if (finished && commit) {
        const store = useAppStore.getState();
        if (finished.kind === 'marquee') {
          if (finished.active) {
            const rect: Bounds = {
              minX: Math.min(finished.start.x, finished.current.x),
              minY: Math.min(finished.start.y, finished.current.y),
              maxX: Math.max(finished.start.x, finished.current.x),
              maxY: Math.max(finished.start.y, finished.current.y),
            };
            // Dragging right-to-left also selects shapes the box only touches.
            const mode = finished.current.x < finished.start.x ? 'cross' : 'enclose';
            const ids = shapesInRect(store.doc.shapes, rect, mode).map((shape) => shape.id);
            store.select(finished.additive ? [...store.selection, ...ids] : ids);
          } else if (!finished.additive) {
            store.clearSelection();
          }
        } else if (matrix && matrix !== IDENTITY) {
          store.transformSelection(matrix);
        }
      }
      requestDraw();
    };

    const onPointerUp = (event: PointerEvent) => {
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      finishDrag(true);
      canvas.style.cursor = cursorFor(eventPoint(event));
    };
    const onPointerCancel = () => finishDrag(false);
    const onPointerLeave = () => {
      if (!drag) useAppStore.getState().setCursor(null);
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const lines = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 33 : event.deltaY;
      const factor = Math.exp(-Math.max(-300, Math.min(300, lines)) * 0.0015);
      setView(zoomAt(view, eventPoint(event), factor));
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextInput(event.target)) return;
      const store = useAppStore.getState();
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (key === ' ') {
        spaceDown = true;
        event.preventDefault();
      } else if (useJobStore.getState().preview) {
        if (key === 'escape') useJobStore.getState().setPreview(false);
      } else if (key === 'escape') {
        if (drag) finishDrag(false);
        else store.clearSelection();
      } else if (key === 'delete' || key === 'backspace') {
        store.deleteSelection();
        event.preventDefault();
      } else if (mod && key === 'a') {
        store.selectAll();
        event.preventDefault();
      } else if (mod && key === 'z' && !event.shiftKey) {
        store.undo();
        event.preventDefault();
      } else if (mod && (key === 'y' || (key === 'z' && event.shiftKey))) {
        store.redo();
        event.preventDefault();
      } else if (key.startsWith('arrow') && store.selection.size > 0 && !drag) {
        const step = event.shiftKey ? 10 : mod ? 0.1 : 1;
        const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0;
        const dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0;
        store.transformSelection(translation(dx, dy));
        event.preventDefault();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === ' ') spaceDown = false;
    };
    const onBlur = () => {
      spaceDown = false;
    };
    const onContextMenu = (event: MouseEvent) => event.preventDefault();

    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    let lastFit = useAppStore.getState().fitRequest;
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.fitRequest !== lastFit) {
        lastFit = state.fitRequest;
        fit(state.fitTarget);
      }
      if (state.doc !== previous.doc || state.selection !== previous.selection) requestDraw();
    });

    const unsubscribeJob = useJobStore.subscribe((state, previous) => {
      if (
        state.preview !== previous.preview ||
        state.fraction !== previous.fraction ||
        state.segments !== previous.segments
      ) {
        requestDraw();
      }
    });

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    return () => {
      observer.disconnect();
      unsubscribe();
      unsubscribeJob();
      if (frame !== 0) cancelAnimationFrame(frame);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  return (
    <div className="workspace" ref={containerRef}>
      <canvas ref={canvasRef} className="workspace-canvas" tabIndex={0} data-testid="workspace-canvas" />
    </div>
  );
}
