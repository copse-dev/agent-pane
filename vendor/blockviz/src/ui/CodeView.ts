import type { Span } from '../core/types';
import type { SceneModel } from '../canvas/model';
import type { Highlights } from '../core/highlights';
import { codeLines, indentWidth, type CodeLine } from './code';
import type { Source } from './store';
import { el } from './dom';

/** Lines `[from, to]` of a file. */
export type LineRange = readonly [number, number];

export const within = (r: LineRange | null | undefined, no: number): boolean => !!r && no >= r[0] && no <= r[1];

/** Subscribes to nothing, which never changes. */
const never = (): (() => void) => () => {};

/** No lines, ever: nothing is hovered. */
export const NO_LINES: Source<LineRange | null> = { get: () => null, subscribe: never };

export interface CodeViewProps {
  model: SceneModel;
  highlights: Highlights;
  span: Span;
  marked?: LineRange | null;
  /** Only the lines it tints or untints update when this changes. */
  hovered?: Source<LineRange | null>;
  onLine?: (line: number) => void;
  onLineHover?: (line: number | null) => void;
}

export interface CodeViewHandle {
  update(props: CodeViewProps): void;
  destroy(): void;
}

const classOf = (cls: number, dim: boolean): string | undefined =>
  cls ? (dim ? `t${cls} faded` : `t${cls}`) : dim ? 'faded' : undefined;

function lineAt(e: MouseEvent): number | null {
  const target = e.target;
  if (!(target instanceof Element)) return null;
  const line = target.closest<HTMLElement>('[data-line]');
  return line ? Number(line.dataset['line']) : null;
}

/**
 * Source of a span with line numbers and syntax colors. Shows plain text
 * until the core has classified the file, which is usually a few ms. Long
 * lines wrap under their own indentation. `marked` lines (the selected
 * block's) are highlighted and scrolled into view, `hovered` ones (the block
 * under the pointer) tinted; clicking or pointing at a line reports it.
 */
export function mountCodeView(container: HTMLElement, props: CodeViewProps): CodeViewHandle {
  let current = props;
  let pre: HTMLPreElement | null = null;
  const lineEls = new Map<number, HTMLElement>();
  let lastHoverPoint: number | null = null;
  let lastHoverRange: LineRange | null = null;
  let unsubHighlights: (() => void) | null = null;
  let unsubHover: (() => void) | null = null;

  function updateHoverTint(nextRange: LineRange | null): void {
    for (const [lineNo, lineEl] of lineEls) {
      const was = within(lastHoverRange, lineNo);
      const now = within(nextRange, lineNo);
      if (was !== now) lineEl.classList.toggle('hovered', now);
    }
    lastHoverRange = nextRange;
  }

  function renderAll(): void {
    pre?.remove();
    lineEls.clear();
    lastHoverPoint = null;

    const { model, highlights, span, marked, onLine, onLineHover } = current;
    const runs = span.file === undefined ? undefined : highlights.peek(span.file);
    const bytes = model.fileBytes(span.file);
    const { lines, more } = bytes ? codeLines(bytes, runs ?? null, span) : { lines: [], more: 0 };
    if (!lines.length) {
      pre = null;
      return;
    }

    const digits = String(lines[lines.length - 1]!.no).length;
    const code = el('code');
    for (const line of lines) code.append(renderLine(line, within(marked, line.no)));
    const children: (Node | string)[] = [code];
    if (more > 0) children.push(el('div', { class: 'code-more' }, `… ${more.toLocaleString()} more lines`));

    const next = el(
      'pre',
      { class: onLine ? 'code interactive' : 'code', style: `--digits: ${String(digits)}` },
      ...children,
    );
    next.addEventListener('click', (e) => {
      const line = lineAt(e);
      if (line !== null && !window.getSelection()?.toString()) onLine?.(line);
    });
    next.addEventListener('mouseover', (e) => {
      const line = lineAt(e);
      if (line === lastHoverPoint) return;
      lastHoverPoint = line;
      onLineHover?.(line);
    });
    next.addEventListener('mouseleave', () => {
      if (lastHoverPoint === null) return;
      lastHoverPoint = null;
      onLineHover?.(null);
    });

    container.append(next);
    pre = next;
    lastHoverRange = (current.hovered ?? NO_LINES).get();
    for (const [lineNo, lineEl] of lineEls) lineEl.classList.toggle('hovered', within(lastHoverRange, lineNo));

    scrollMarkedIntoView();
  }

  function renderLine(line: CodeLine, marked: boolean): HTMLElement {
    const hang = `${String(indentWidth(line) + 2)}ch`;
    const src = el('span', { class: 'src', style: `padding-left: ${hang}; text-indent: -${hang}` });
    line.segs.forEach((s) => {
      const cls = classOf(s.cls, s.dim);
      src.append(cls ? el('span', { class: cls }, s.text) : document.createTextNode(s.text));
    });
    const row = el(
      'div',
      { class: marked ? 'ln marked' : 'ln', 'data-line': String(line.no) },
      el('span', { class: 'no', 'aria-hidden': 'true' }, String(line.no)),
      src,
    );
    lineEls.set(line.no, row);
    return row;
  }

  // Bring the selected block's lines into view, with some code above them.
  function scrollMarkedIntoView(): void {
    const marked = pre?.querySelector<HTMLElement>('.ln.marked');
    const scroller = pre?.closest<HTMLElement>('.insp-body');
    if (!marked || !scroller) return;
    const top = marked.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const view = scroller.clientHeight;
    if (top < scroller.scrollTop + 40 || top > scroller.scrollTop + view - 60) {
      scroller.scrollTop = Math.max(0, top - view / 3);
    }
  }

  function subscribeHighlights(): void {
    unsubHighlights?.();
    const { highlights, span } = current;
    if (span.file !== undefined) highlights.request(span.file);
    unsubHighlights = highlights.subscribe(renderAll);
  }

  function subscribeHover(): void {
    unsubHover?.();
    const hovered = current.hovered ?? NO_LINES;
    unsubHover = hovered.subscribe(() => {
      updateHoverTint(hovered.get());
    });
  }

  function update(props: CodeViewProps): void {
    current = props;
    subscribeHighlights();
    subscribeHover();
    renderAll();
  }

  update(props);

  return {
    update,
    destroy(): void {
      unsubHighlights?.();
      unsubHover?.();
      pre?.remove();
    },
  };
}
