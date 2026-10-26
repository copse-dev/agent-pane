import { NARROW } from './media';

/** What each kind of block is called. */
export const KIND_LABEL: Record<string, string> = {
  repo: 'Repository', dir: 'Folder', file: 'File', notebook: 'Notebook', doc: 'Document', asset: 'Asset',
  class: 'Class', function: 'Function', section: 'Section', loop: 'Loop', branch: 'Branch', lane: 'Branch arm',
  group: 'Group', call: 'Call', op: 'Step', glyph: 'Operator', table: 'Settings', artifact: 'File on disk',
  symbol: 'Definition', input: 'Input', output: 'Output',
};

export interface PanelSize { w: number; h: number }

export const DEFAULT_PANEL: PanelSize = { w: 380, h: 0 };

/** Keeps the panel inside the window, leaving room to see the diagram. */
export function clampPanel(size: PanelSize): PanelSize {
  const maxW = Math.max(300, window.innerWidth - 160);
  const maxH = Math.max(180, window.innerHeight - 140);
  return {
    w: Math.round(Math.min(Math.max(size.w || DEFAULT_PANEL.w, 300), maxW)),
    h: size.h ? Math.round(Math.min(Math.max(size.h, 160), maxH)) : 0,
  };
}

export interface ResizeHandleHandle {
  update(size: PanelSize): void;
  destroy(): void;
}

/** Drag (or arrow keys) on the panel's inner edge: the left edge beside the
 * diagram, or the top edge when the panel is a bottom sheet on narrow screens. */
export function mountResizeHandle(
  container: HTMLElement,
  { size, onResize }: { size: PanelSize; onResize: (s: PanelSize) => void },
): ResizeHandleHandle {
  const narrow = () => window.matchMedia(NARROW).matches;
  const sheetHeight = (s: PanelSize) => s.h || Math.round(window.innerHeight * 0.46);

  const handle = document.createElement('div');
  handle.className = 'insp-resize';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-label', 'Resize details panel');
  handle.tabIndex = 0;
  handle.title = 'Drag to resize · double-click to reset';

  let current = size;
  function syncAria(): void {
    const n = narrow();
    handle.setAttribute('aria-orientation', n ? 'horizontal' : 'vertical');
    handle.setAttribute('aria-valuenow', String(n ? sheetHeight(current) : current.w));
  }
  syncAria();

  let drag: { x: number; y: number; start: PanelSize; narrow: boolean } | null = null;
  const end = (): void => {
    drag = null;
    document.body.classList.remove('resizing-x', 'resizing-y');
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const n = narrow();
    drag = { x: e.clientX, y: e.clientY, start: { w: current.w, h: sheetHeight(current) }, narrow: n };
    document.body.classList.add(n ? 'resizing-y' : 'resizing-x');
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (!drag) return;
    onResize(
      clampPanel(
        drag.narrow
          ? { w: drag.start.w, h: drag.start.h - (e.clientY - drag.y) }
          : { w: drag.start.w - (e.clientX - drag.x), h: drag.start.h },
      ),
    );
  };
  const onDoubleClick = (): void => {
    onResize(clampPanel(narrow() ? { ...current, h: 0 } : { ...current, w: DEFAULT_PANEL.w }));
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    const step = e.shiftKey ? 96 : 24;
    const n = narrow();
    const grow = n
      ? e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0
      : e.key === 'ArrowLeft' ? 1 : e.key === 'ArrowRight' ? -1 : 0;
    if (!grow) return;
    e.preventDefault();
    e.stopPropagation();
    onResize(
      clampPanel(
        n ? { w: current.w, h: sheetHeight(current) + grow * step } : { w: current.w + grow * step, h: current.h },
      ),
    );
  };

  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('lostpointercapture', end);
  handle.addEventListener('dblclick', onDoubleClick);
  handle.addEventListener('keydown', onKeyDown);
  container.append(handle);

  return {
    update(next: PanelSize): void {
      current = next;
      syncAria();
    },
    destroy(): void {
      end();
      handle.remove();
    },
  };
}

