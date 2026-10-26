import type { Span } from '../core/types';
import type { SceneModel } from '../canvas/model';
import type { Highlights } from '../core/highlights';
import { codeLines, dedent, indentWidth, lineText, type CodeLine } from './code';
import { NO_LINES, within, type LineRange } from './CodeView';
import { diffLines, fold, type Gap, type LineOp } from './linediff';
import type { Source } from './store';
import { el } from './dom';

/** One version of a block's code: where it is, and how to color it. */
export interface Version {
  model: SceneModel;
  highlights: Highlights;
  span: Span;
}

/** Longer diffs fold unchanged stretches away. */
const FOLD_OVER = 40;

/** A version's lines, in the colors of `runs` (null: plain). */
const linesOf = (v: Version | null, runs: Uint32Array | null): CodeLine[] => {
  const bytes = v?.model.fileBytes(v.span.file);
  return v && bytes ? codeLines(bytes, runs, v.span, 4000, true).lines : [];
};

const SIGN = { same: ' ', add: '+', del: '−' } as const;

export interface DiffViewProps {
  base: Version | null;
  head: Version | null;
  marked?: LineRange | null;
  /** Only the lines it tints or untints update when this changes. */
  hovered?: Source<LineRange | null>;
  onLine?: (line: number) => void;
  onLineHover?: (line: number | null) => void;
}

export interface DiffViewHandle {
  update(props: DiffViewProps): void;
  destroy(): void;
}

function spanKey(v: Version | null): string {
  return v ? `${String(v.span.file)}:${String(v.span.start)}:${String(v.span.end)}` : '';
}

function lineAt(e: MouseEvent): number | null {
  const target = e.target;
  if (!(target instanceof Element)) return null;
  const line = target.closest<HTMLElement>('[data-line]');
  return line ? Number(line.dataset['line']) : null;
}

/**
 * A block's code as it changed: lines removed from the base version and
 * added in the head, among the ones kept, with syntax colors from each
 * version. Without a base the code is all new; without a head, all removed.
 * Long stretches of unchanged lines fold away (click to unfold), never the
 * `marked` lines (the selected step's, scrolled into view). Clicking or
 * pointing at a line of the head reports its line number.
 */
export function mountDiffView(container: HTMLElement, props: DiffViewProps): DiffViewHandle {
  let current = props;
  let pre: HTMLPreElement | null = null;
  let identity = '';
  let unfolded = new Set<string>();
  const lineEls = new Map<number, HTMLElement>();
  let lastHoverPoint: number | null = null;
  let lastHoverRange: LineRange | null = null;
  const unsubHighlights: (() => void)[] = [];
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

    const { base, head, marked, onLine, onLineHover } = current;
    const baseRuns = base?.span.file === undefined ? undefined : base.highlights.peek(base.span.file);
    const headRuns = head?.span.file === undefined ? undefined : head.highlights.peek(head.span.file);
    const before = { lines: linesOf(base, baseRuns ?? null), text: linesOf(base, null).map(lineText) };
    const after = { lines: linesOf(head, headRuns ?? null), text: linesOf(head, null).map(lineText) };
    // Diffed by text alone: neither colors arriving nor the marked lines moving compute it again.
    const ops = diffLines(before.text, after.text);
    if (!ops.length) {
      pre = null;
      return;
    }
    // Both versions lose the same indentation, so moved code shows its new depth.
    const cut = dedent([...before.lines, ...after.lines]);
    const oldLines = cut.slice(0, before.lines.length);
    const newLines = cut.slice(before.lines.length);
    const keep = (o: LineOp): boolean => o.b >= 0 && within(marked, newLines[o.b]!.no);
    const rows = ops.length > FOLD_OVER ? fold(ops, 3, keep) : ops;

    const out: (LineOp | Gap)[] = [];
    for (const r of rows) {
      const key = `${String(r.a)}:${String(r.b)}`;
      if (r.kind === 'gap' && unfolded.has(key)) {
        const i = ops.findIndex((o) => o.a === r.a && o.b === r.b);
        out.push(...ops.slice(i, i + r.count));
      } else out.push(r);
    }
    const shown = out.filter((r): r is LineOp => r.kind !== 'gap');
    const lastNo = Math.max(1, ...shown.map((o) => (o.kind === 'del' ? oldLines[o.a]!.no : newLines[o.b]!.no)));

    const code = el('code');
    for (const r of out) {
      if (r.kind === 'gap') {
        const key = `${String(r.a)}:${String(r.b)}`;
        const gap = el(
          'div',
          { class: 'ln gap', title: 'Show these lines' },
          el('span', { class: 'no', 'aria-hidden': 'true' }, '⋯'),
          el('span', { class: 'sign' }),
          el('span', { class: 'src' }, `${String(r.count)} unchanged lines`),
        );
        gap.addEventListener('click', () => {
          unfolded = new Set([...unfolded, key]);
          renderAll();
        });
        code.append(gap);
        continue;
      }
      const line = r.kind === 'del' ? oldLines[r.a]! : newLines[r.b]!;
      code.append(renderLine(line, r.kind, r.kind !== 'del' && within(marked, line.no)));
    }

    const next = el('pre', {
      class: `code diff${onLine ? ' interactive' : ''}`,
      style: `--digits: ${String(String(lastNo).length)}`,
    });
    next.append(code);
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

  function renderLine(line: CodeLine, kind: LineOp['kind'], marked: boolean): HTMLElement {
    // A removed line is not in the code on screen: it has no number to report.
    const head = kind !== 'del';
    const hang = `${String(indentWidth(line) + 2)}ch`;
    const src = el('span', { class: 'src', style: `padding-left: ${hang}; text-indent: -${hang}` });
    line.segs.forEach((s) => {
      const cls = s.cls ? (s.dim ? `t${String(s.cls)} faded` : `t${String(s.cls)}`) : s.dim ? 'faded' : undefined;
      src.append(cls ? el('span', { class: cls }, s.text) : document.createTextNode(s.text));
    });
    const row = el(
      'div',
      {
        class: `ln ${kind}${marked ? ' marked' : ''}`,
        ...(head ? { 'data-line': String(line.no) } : {}),
      },
      el('span', { class: 'no', 'aria-hidden': 'true' }, String(line.no)),
      el('span', { class: 'sign', ...(kind === 'same' ? {} : { 'aria-label': kind === 'add' ? 'added' : 'removed' }) }, SIGN[kind]),
      src,
    );
    if (head) lineEls.set(line.no, row);
    return row;
  }

  function scrollMarkedIntoView(): void {
    const target =
      pre?.querySelector<HTMLElement>('.ln.marked') ?? pre?.querySelector<HTMLElement>('.ln.add, .ln.del');
    const scroller = pre?.closest<HTMLElement>('.insp-body');
    if (!target || !scroller) return;
    const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const view = scroller.clientHeight;
    if (top < scroller.scrollTop + 40 || top > scroller.scrollTop + view - 60) {
      scroller.scrollTop = Math.max(0, top - view / 3);
    }
  }

  function subscribeHighlights(): void {
    for (const unsub of unsubHighlights.splice(0)) unsub();
    const { base, head } = current;
    if (base && base.span.file !== undefined) {
      base.highlights.request(base.span.file);
      unsubHighlights.push(base.highlights.subscribe(renderAll));
    }
    if (head && head.span.file !== undefined) {
      head.highlights.request(head.span.file);
      unsubHighlights.push(head.highlights.subscribe(renderAll));
    }
  }

  function subscribeHover(): void {
    unsubHover?.();
    const hovered = current.hovered ?? NO_LINES;
    unsubHover = hovered.subscribe(() => {
      updateHoverTint(hovered.get());
    });
  }

  function update(props: DiffViewProps): void {
    current = props;
    const nextIdentity = `${spanKey(props.base)}|${spanKey(props.head)}`;
    if (nextIdentity !== identity) {
      identity = nextIdentity;
      unfolded = new Set();
    }
    subscribeHighlights();
    subscribeHover();
    renderAll();
  }

  update(props);

  return {
    update,
    destroy(): void {
      for (const unsub of unsubHighlights.splice(0)) unsub();
      unsubHover?.();
      pre?.remove();
    },
  };
}
