import type { SceneNode } from '../core/types';
import type { SceneModel } from '../canvas/model';
import type { Highlights } from '../core/highlights';
import { mountCodeView, type CodeViewHandle, type LineRange } from './CodeView';
import { KIND_LABEL, mountResizeHandle, type PanelSize, type ResizeHandleHandle } from './panel';
import type { SceneDiff } from '../canvas/diff';
import { mountChangeSteps, describeChange } from './ChangesPanel';
import { mountDiffView, type DiffViewHandle } from './DiffView';
import { derive, type Source } from './store';
import { el, clear } from './dom';
import { icon } from './icons';

export { clampPanel, DEFAULT_PANEL, type PanelSize } from './panel';

/** Reading a change (a pull request): how the code on screen differs from its base version. */
export interface InspectorChange {
  diff: SceneDiff;
  baseHighlights: Highlights;
  /** The change being read, as its index in `diff.changes` (-1: the block is not one). */
  index: number;
  onStep: (delta: number) => void;
  /** Goes to a change, by its index. */
  onChange: (index: number) => void;
}

function renderList(label: string, values: string[] | undefined, mono = true): HTMLElement | null {
  if (!values?.length) return null;
  return el(
    'div',
    { class: 'insp-field' },
    el('label', {}, label),
    el('div', { class: 'chips' }, ...values.map((v) => el('span', { class: mono ? 'chip mono' : 'chip' }, v))),
  );
}

/** What a change did to a block, and where it is among the changes. */
function renderChangeLine(compare: InspectorChange, node: SceneNode): HTMLElement[] {
  const { diff } = compare;
  const status = diff.status(node.id);
  const inside = diff.inside(node.id);
  const through = inside ? 0 : diff.through(node.id);
  const plural = (n: number): string => (n === 1 ? '' : 's');
  const says = status === 'added'
    ? 'New in this change'
    : inside
    ? `${String(inside)} change${plural(inside)} inside`
    : through
    ? `Leads into code with ${String(through)} change${plural(through)}`
    : status
    ? 'Its code changed'
    : 'Unchanged';
  const removed = diff.removedIn(node.id);

  const status_ = el('div', { class: 'change-status' });
  if (status) status_.append(el('span', { class: `change-badge ${status}` }, status === 'added' ? 'Added' : 'Changed'));
  status_.append(el('span', {}, says));

  const steps = el('div');
  mountChangeSteps(steps, { index: compare.index, total: diff.changes.length, onStep: compare.onStep });

  const out = [status_, steps];
  if (removed.length > 0) {
    const list = el(
      'div',
      { class: 'uses changes' },
      ...removed.map((c) => {
        const d = describeChange(diff, c);
        const btn = el(
          'button',
          {},
          el(
            'span',
            { class: 'use-name' },
            el('span', { class: 'change-mark removed' }, '−'),
            d.name,
            el('span', { class: 'dim' }, ` · ${d.kind.toLowerCase()}`),
          ),
        );
        if (d.line !== undefined) btn.append(el('span', { class: 'use-at' }, String(d.line)));
        btn.addEventListener('click', () => {
          compare.onChange(diff.indexOf(c.id, true));
        });
        return btn;
      }),
    );
    out.push(
      el(
        'div',
        { class: 'insp-field' },
        el('label', {}, 'Removed from here ', el('span', { class: 'count' }, String(removed.length))),
        list,
      ),
    );
  }
  return out;
}

/** What a use is, when it is not a call. */
const USE_KIND: Record<string, string> = { symbol: 'component', class: 'methods', file: 'imports' };

/** The places that use a block, each a link to it. */
function renderUsedBy(
  model: SceneModel,
  id: number,
  onGo: (id: number) => void,
  onPeek: (id: number | null) => void,
): HTMLElement | null {
  const users = model.users(id);
  if (!users.length) return null;
  let all = false;

  const field = el('div', { class: 'insp-field' });
  const label = el('label', {}, 'Used by ');
  if (users.length > 1) label.append(el('span', { class: 'count' }, String(users.length)));
  field.append(label);

  function row(u: number): HTMLButtonElement {
    const n = model.node(u);
    const where = model.where(u);
    const file = model.fileOf(n);
    const kind = USE_KIND[n.kind];
    const nameEl = el('span', { class: 'use-name' }, where?.name ?? n.title);
    if (kind) {
      nameEl.append(
        el('span', { class: 'dim' }, ` · ${kind}${n.title !== model.node(id).title ? ` ${n.title}` : ''}`),
      );
    }
    const btn = el(
      'button',
      { title: n.code || (n.span && model.source(n.span)) || n.title },
      nameEl,
    );
    if (file && n.span) btn.append(el('span', { class: 'use-at' }, `${file.split('/').pop()}:${String(n.span.line)}`));
    btn.addEventListener('click', () => {
      onGo(u);
    });
    btn.addEventListener('mouseenter', () => {
      onPeek(u);
    });
    return btn;
  }

  function renderRows(): void {
    const shown = all ? users : users.slice(0, 8);
    const uses = el('div', { class: 'uses' }, ...shown.map(row));
    uses.addEventListener('mouseleave', () => {
      onPeek(null);
    });
    field.querySelectorAll('.uses, .more').forEach((n) => n.remove());
    field.append(uses);
    if (users.length > shown.length) {
      const more = el('button', { class: 'more' }, `Show all ${String(users.length)}`);
      more.addEventListener('click', () => {
        all = true;
        renderRows();
      });
      field.append(more);
    }
  }
  renderRows();
  return field;
}

export interface InspectorProps {
  model: SceneModel;
  highlights: Highlights;
  node: SceneNode;
  /** When reading a change: its block's status, the change steps, and code shown as it changed. */
  compare?: InspectorChange;
  /** The block under the pointer in the diagram: its lines are tinted. */
  hover: Source<number | null>;
  size: PanelSize;
  onResize: (size: PanelSize) => void;
  onClose: () => void;
  onZoom: () => void;
  onGo: (id: number) => void;
  /** A line of the source was clicked: select the block drawn for it. */
  onPick: (id: number) => void;
  /** The pointer is on a line: point out its block in the diagram. */
  onPeek: (id: number | null) => void;
  /** Saves the block alone as SVG. */
  onDownload: () => void;
}

export interface InspectorHandle {
  update(props: InspectorProps): void;
  destroy(): void;
}

/** Removes common indentation so nested code reads naturally. */
function dedent(text: string): string {
  const lines = text.split('\n');
  if (lines.length < 2) return text;
  const rest = lines.slice(1).filter((l) => l.trim());
  const indent = Math.min(...rest.map((l) => /^\s*/.exec(l)![0].length));
  return [lines[0], ...lines.slice(1).map((l) => l.slice(Math.min(indent, /^\s*/.exec(l)![0].length)))].join('\n');
}

export function mountInspector(container: HTMLElement, props: InspectorProps): InspectorHandle {
  const aside = el('aside', { class: 'inspector', 'aria-label': 'Block details' });
  const resizeHandle: ResizeHandleHandle = mountResizeHandle(aside, { size: props.size, onResize: props.onResize });
  const body = el('div', { class: 'insp-body' });
  aside.append(body);
  container.append(aside);

  let embedded: CodeViewHandle | DiffViewHandle | null = null;

  function render(p: InspectorProps): void {
    const { model, highlights, node, hover, size, compare, onClose, onZoom, onGo, onPick, onPeek, onDownload } = p;

    aside.style.setProperty('--panel-w', `${String(size.w)}px`);
    if (size.h) aside.style.setProperty('--panel-h', `${String(size.h)}px`);
    else aside.style.removeProperty('--panel-h');
    resizeHandle.update(size);

    const owner = model.owner(node);
    const target = node.link ?? node.ref;
    const def = target !== undefined && target !== node.id ? model.node(target) : null;
    const span = node.span;
    const file = model.fileOf(node);
    // A step is read in the definition around it, its own lines marked.
    const view = model.sourceView(node);
    const hasSource = !!view && !!model.fileBytes(view.span.file);
    const marked: LineRange | null = view && span && view.root !== node ? [span.line, span.endLine] : null;
    // Read by the code's lines themselves: the panel does not re-render as the pointer moves.
    const hovered = derive(hover, (id): LineRange | null => {
      const h = id !== null ? model.node(id) : null;
      return view && h?.span && h.id !== view.root.id && h.span.file === view.span.file
        && h.span.start >= view.span.start && h.span.end <= view.span.end
        ? [h.span.line, h.span.endLine]
        : null;
    });
    const pickLine = (line: number): void => onPick(model.blockAt(view!.root, line).id);
    const peekLine = (line: number | null): void => {
      const b = line === null ? null : model.blockAt(view!.root, line);
      onPeek(b && b !== view!.root ? b.id : null);
    };
    const where = view && view.root !== node && view.root.kind !== 'file' ? view.root.title : null;
    // In a change, code is shown as it changed: the whole definition around the block, folded, its lines kept.
    const diff = compare?.diff;
    const changed = !!diff && !!view && (diff.status(view.root.id) !== null || diff.inside(view.root.id) > 0);
    const baseRoot = changed ? diff!.baseOf(view!.root.id) : undefined;
    const baseSpan = baseRoot !== undefined ? diff!.base.node(baseRoot).span : undefined;
    const rootSpan = view?.root.span ?? view?.span;
    const kind = KIND_LABEL[node.kind] ?? node.kind;
    const effects = node.effects?.filter((e) => !e.startsWith('__'));

    clear(body);

    const head = el('div', { class: 'insp-head' });
    const kindEl = el('span', { class: 'insp-kind' }, kind);
    if (node.subtitle) kindEl.append(' · ', el('span', {}, node.subtitle));
    const closeBtn = el('button', { class: 'icon', 'aria-label': 'Close details' }, icon('x', 15));
    closeBtn.addEventListener('click', onClose);
    head.append(el('header', {}, kindEl, closeBtn), el('h2', { class: node.kind === 'op' ? 'mono' : undefined }, node.title || kind));
    body.append(head);

    if (node.doc) body.append(el('p', { class: 'insp-doc' }, node.doc));
    if (compare) body.append(...renderChangeLine(compare, node));

    const actions = el('div', { class: 'insp-actions' });
    if (owner) {
      const btn = el('button', {}, icon('maximize2', 13), 'Zoom in');
      btn.addEventListener('click', onZoom);
      actions.append(btn);
    }
    if (def) {
      const btn = el(
        'button',
        {},
        icon('arrowUpRight', 13),
        `Go to ${def.kind === 'class' ? 'class' : 'definition'}`,
        el('span', { class: 'dim' }, def.title),
      );
      btn.addEventListener('click', () => {
        onGo(def.id);
      });
      actions.append(btn);
    }
    const downloadBtn = el('button', { title: 'Download this block alone as SVG' }, icon('download', 13), 'SVG');
    downloadBtn.addEventListener('click', onDownload);
    actions.append(downloadBtn);
    body.append(actions);

    const usedBy = renderUsedBy(model, node.id, onGo, onPeek);
    if (usedBy) body.append(usedBy);
    for (const [label, values, mono] of [
      ['Inputs', node.inputs, true],
      ['Outputs', node.outputs, true],
      ['Tags', node.badges, false],
      ['Side effects', effects, false],
    ] as const) {
      const list = renderList(label, values, mono);
      if (list) body.append(list);
    }

    if (node.rows && node.rows.length > 0) {
      const rows = el(
        'div',
        { class: 'rows' },
        ...node.rows.slice(0, 80).map((r) =>
          r.heading
            ? el('div', { class: 'row-heading' }, r.key)
            : el('div', { class: 'row' }, el('code', {}, r.key), ...(r.value ? [el('span', {}, ` = ${r.value}`)] : [])),
        ),
      );
      body.append(el('div', { class: 'insp-field' }, el('label', {}, `${String(node.rows.length)} entries`), rows));
    }

    embedded?.destroy();
    embedded = null;
    if (hasSource || node.code) {
      const sourceLabel = el('label', {});
      if (file) {
        sourceLabel.append(file);
        if (span) {
          sourceLabel.append(
            el(
              'span',
              { class: 'dim' },
              `${where ? ` · in ${where}` : ''} · ${span.line === span.endLine ? `line ${String(span.line)}` : `lines ${String(span.line)}–${String(span.endLine)}`}`,
            ),
          );
        }
      } else {
        sourceLabel.append('Code');
      }
      const source = el('div', { class: 'insp-source' }, sourceLabel);
      const mount = el('div');
      source.append(mount);
      body.append(source);

      if (hasSource && changed && rootSpan) {
        embedded = mountDiffView(mount, {
          head: { model, highlights, span: rootSpan },
          base: baseSpan && diff!.base.fileBytes(baseSpan.file)
            ? { model: diff!.base, highlights: compare!.baseHighlights, span: baseSpan }
            : null,
          marked,
          hovered,
          onLine: pickLine,
          onLineHover: peekLine,
        });
      } else if (hasSource) {
        embedded = mountCodeView(mount, {
          model,
          highlights,
          span: view!.span,
          marked,
          hovered,
          onLine: pickLine,
          onLineHover: peekLine,
        });
      } else {
        source.append(el('pre', { class: 'code plain' }, dedent(node.code!)));
      }
    }
  }

  render(props);

  return {
    update: render,
    destroy(): void {
      embedded?.destroy();
      resizeHandle.destroy();
      aside.remove();
    },
  };
}
