import type { Change, SceneDiff, Status } from '../canvas/diff';
import type { SceneModel } from '../canvas/model';
import type { Highlights } from '../core/highlights';
import type { CompareInfo, SceneNode } from '../core/types';
import { mountDiffView, type DiffViewHandle } from './DiffView';
import { TOUCH, matches } from './media';
import { KIND_LABEL, mountResizeHandle, type PanelSize, type ResizeHandleHandle } from './panel';
import { el, clear } from './dom';
import { icon } from './icons';

/** A block's name as a list shows it: its title, or for an untitled branch what its first arm tests. */
export function blockName(model: SceneModel, n: SceneNode): string {
  if (n.title) return n.title;
  const arm = (n.children ?? []).map((c) => model.node(c)).find((c) => c.kind === 'lane' && c.title);
  return arm?.title ?? KIND_LABEL[n.kind] ?? n.kind;
}

/** The file a block's code is in. */
function fileOf(model: SceneModel, n: SceneNode): string | undefined {
  for (let c: SceneNode | undefined = n; c; c = c.parent === undefined ? undefined : model.node(c.parent)) {
    if (c.span) return model.fileOf(c);
  }
  return undefined;
}

const OUTER = new Set(['repo', 'dir', 'file', 'notebook', 'doc', 'asset', 'group']);

/** How a change is listed: its block's name, the definition it is in, its kind, and where its code is. */
export function describeChange(
  diff: SceneDiff,
  c: Change,
): { name: string; context: string | null; kind: string; file: string | undefined; line: number | undefined } {
  const model = c.status === 'removed' ? diff.base : diff.head;
  const n = model.node(c.id);
  // What it is in, unless that is just the repository.
  const w = OUTER.has(n.kind) ? null : model.where(c.id);
  const where = w && w.at !== model.root ? w : null;
  // A whole file starts at its first line: no line to give.
  return {
    name: blockName(model, n),
    context: where && where.name !== n.title ? where.name : null,
    kind: KIND_LABEL[n.kind] ?? n.kind,
    file: fileOf(model, n),
    line: OUTER.has(n.kind) ? undefined : n.span?.line,
  };
}

const MARK: Record<Status, string> = { added: '+', changed: '~', removed: '−' };
const FILE_MARK: Record<string, string> = { added: 'A', modified: 'M', removed: 'D', renamed: 'R' };

export interface ChangeStepsProps {
  index: number;
  total: number;
  onStep: (delta: number) => void;
}

export interface ChangeStepsHandle {
  update(props: ChangeStepsProps): void;
  destroy(): void;
}

/** Steps through the changes: which one this is, and buttons for the previous and next. */
export function mountChangeSteps(container: HTMLElement, props: ChangeStepsProps): ChangeStepsHandle {
  const root = el('div', { class: 'change-steps' });
  container.append(root);

  function render({ index, total, onStep }: ChangeStepsProps): void {
    clear(root);
    if (!total) return;
    const label = el('span', {});
    if (index >= 0) label.append('Change ', el('strong', {}, String(index + 1)), ` of ${String(total)}`);
    else label.append(`${String(total)} change${total === 1 ? '' : 's'} in all`);
    const prev = el('button', { class: 'icon', 'aria-label': 'Previous change (P)', title: 'Previous change (P)' }, icon('chevronLeft', 15));
    prev.addEventListener('click', () => onStep(-1));
    const next = el('button', { class: 'icon', 'aria-label': 'Next change (N)', title: 'Next change (N)' }, icon('chevronRight', 15));
    next.addEventListener('click', () => onStep(1));
    root.append(label, prev, next);
  }

  render(props);
  return {
    update: render,
    destroy(): void {
      root.remove();
    },
  };
}

function setPanelSizeVars(aside: HTMLElement, size: PanelSize): void {
  aside.style.setProperty('--panel-w', `${String(size.w)}px`);
  if (size.h) aside.style.setProperty('--panel-h', `${String(size.h)}px`);
  else aside.style.removeProperty('--panel-h');
}

export interface ChangesPanelProps {
  diff: SceneDiff;
  info: CompareInfo;
  size: PanelSize;
  /** The change being read, as its index in `diff.changes` (-1: none). */
  current: number;
  onResize: (size: PanelSize) => void;
  onClose: () => void;
  onGo: (index: number) => void;
  onPeek: (id: number | null) => void;
}

export interface ChangesPanelHandle {
  update(props: ChangesPanelProps): void;
  destroy(): void;
}

/**
 * What a pull request (or comparison) changed, in the order the diagram
 * reads: grouped by file, each change a link to it, the one being read
 * marked. Files changed without changing any block (binaries, whitespace,
 * files not analyzed) are listed after.
 */
export function mountChangesPanel(container: HTMLElement, props: ChangesPanelProps): ChangesPanelHandle {
  const aside = el('aside', { class: 'inspector', 'aria-label': 'Changes' });
  const resizeHandle = mountResizeHandle(aside, { size: props.size, onResize: props.onResize });
  const body = el('div', { class: 'insp-body' });
  aside.append(body);
  container.append(aside);

  function render(p: ChangesPanelProps): void {
    const { diff, info, size, current, onClose, onGo, onPeek } = p;
    setPanelSizeVars(aside, size);
    resizeHandle.update(size);

    const touch = matches(TOUCH);
    const groups: { file: string; mark?: string; items: { c: Change; i: number; d: ReturnType<typeof describeChange> }[] }[] = [];
    diff.changes.forEach((c, i) => {
      const d = describeChange(diff, c);
      const file = d.file ?? '';
      let g = groups.find((x) => x.file === file);
      if (!g) {
        g = { file, mark: FILE_MARK[diff.fileChange(file, c.status === 'removed')?.status ?? ''], items: [] };
        groups.push(g);
      }
      g.items.push({ c, i, d });
    });
    const listed = new Set(groups.map((g) => g.file));
    const others = diff.files.filter((f) => !listed.has(f.path) && !(f.previous && listed.has(f.previous)));
    const s = diff.summary;

    clear(body);

    const kindEl = el('span', { class: 'insp-kind' }, info.kind === 'pr' ? `Pull request #${String(info.number)}` : 'Comparison');
    if (info.state) kindEl.append(' · ', el('span', {}, info.state));
    const closeBtn = el('button', { class: 'icon', 'aria-label': 'Close changes' }, icon('x', 15));
    closeBtn.addEventListener('click', onClose);
    body.append(el('div', { class: 'insp-head' }, el('header', {}, kindEl, closeBtn), el('h2', {}, info.title)));

    const link = el('a', { href: info.url, target: '_blank', rel: 'noreferrer' }, 'GitHub', icon('externalLink', 11));
    body.append(
      el('p', { class: 'change-refs' }, el('code', {}, info.baseRef), ' ← ', el('code', {}, info.headRef), link),
    );

    body.append(
      el(
        'div',
        { class: 'change-summary' },
        el('span', { class: 'added' }, `${String(s.added)} added`),
        el('span', { class: 'changed' }, `${String(s.changed)} changed`),
        el('span', { class: 'removed' }, `${String(s.removed)} removed`),
      ),
    );

    if (diff.changes.length > 0) {
      const doc = el('p', { class: 'insp-doc' }, 'In the order the diagram reads. ');
      if (touch) doc.append('Tap a change to go to it.');
      else doc.append('Press ', el('kbd', {}, 'N'), ' and ', el('kbd', {}, 'P'), ' to step through them.');
      body.append(doc);
    } else {
      body.append(
        el(
          'p',
          { class: 'insp-doc' },
          `No block of the analyzed code changed${diff.files.length ? '; the files changed are listed below.' : '.'}`,
        ),
      );
    }

    for (const g of groups) {
      const label = el('label', { class: 'change-file' });
      if (g.mark) label.append(el('span', { class: `file-mark ${g.mark}` }, g.mark));
      label.append(g.file || 'Repository');
      const list = el('div', { class: 'uses changes' });
      list.addEventListener('mouseleave', () => onPeek(null));
      for (const { c, i, d } of g.items) {
        const nameEl = el(
          'span',
          { class: 'use-name' },
          el('span', { class: `change-mark ${c.status}` }, MARK[c.status]),
        );
        if (d.context) nameEl.append(el('span', { class: 'dim' }, `${d.context} › `));
        nameEl.append(d.name, el('span', { class: 'dim' }, ` · ${d.kind.toLowerCase()}`));
        const btn = el('button', { 'aria-current': String(i === current) }, nameEl);
        if (d.line !== undefined) btn.append(el('span', { class: 'use-at' }, String(d.line)));
        btn.addEventListener('click', () => onGo(i));
        btn.addEventListener('mouseenter', () => onPeek(c.at));
        list.append(btn);
      }
      body.append(el('div', { class: 'insp-field' }, label, list));
    }

    if (others.length > 0) {
      const otherFiles = el(
        'div',
        { class: 'other-files' },
        ...others.map((f) =>
          el(
            'div',
            {},
            el('span', { class: `file-mark ${FILE_MARK[f.status]}` }, FILE_MARK[f.status]),
            f.previous ? `${f.previous} → ` : '',
            f.path,
          ),
        ),
      );
      body.append(
        el(
          'div',
          { class: 'insp-field' },
          el('label', {}, 'Also changed ', el('span', { class: 'count' }, String(others.length))),
          otherFiles,
        ),
      );
    }

    body.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  render(props);
  return {
    update: render,
    destroy(): void {
      resizeHandle.destroy();
      aside.remove();
    },
  };
}

export interface RemovedDetailsProps {
  diff: SceneDiff;
  change: Change;
  baseHighlights: Highlights;
  size: PanelSize;
  index: number;
  onResize: (size: PanelSize) => void;
  onClose: () => void;
  /** Shows the block it was in. */
  onShow: (id: number) => void;
  onStep: (delta: number) => void;
  /** Saves the block as it was, alone, as SVG. */
  onDownload: () => void;
}

export interface RemovedDetailsHandle {
  update(props: RemovedDetailsProps): void;
  destroy(): void;
}

/** A block the change removed: what it was, where it was, and its code as it was. */
export function mountRemovedDetails(container: HTMLElement, props: RemovedDetailsProps): RemovedDetailsHandle {
  const aside = el('aside', { class: 'inspector', 'aria-label': 'Removed block' });
  const resizeHandle = mountResizeHandle(aside, { size: props.size, onResize: props.onResize });
  const body = el('div', { class: 'insp-body' });
  aside.append(body);
  container.append(aside);

  let steps: ChangeStepsHandle | null = null;
  let diffView: DiffViewHandle | null = null;

  function render(p: RemovedDetailsProps): void {
    const { diff, change, baseHighlights, size, index, onClose, onShow, onStep, onDownload } = p;
    setPanelSizeVars(aside, size);
    resizeHandle.update(size);

    const model = diff.base;
    const n = model.node(change.id);
    const d = describeChange(diff, change);
    const span = n.span;

    clear(body);
    steps?.destroy();
    steps = null;
    diffView?.destroy();
    diffView = null;

    const kindEl = el('span', { class: 'insp-kind' }, d.kind);
    if (n.subtitle) kindEl.append(' · ', el('span', {}, n.subtitle));
    const closeBtn = el('button', { class: 'icon', 'aria-label': 'Close details' }, icon('x', 15));
    closeBtn.addEventListener('click', onClose);
    body.append(
      el('div', { class: 'insp-head' }, el('header', {}, kindEl, closeBtn), el('h2', { class: n.kind === 'op' ? 'mono' : undefined }, d.name)),
    );

    const showBtn = el('button', { class: 'link' }, diff.head.qualified(change.at));
    showBtn.addEventListener('click', () => onShow(change.at));
    body.append(
      el(
        'div',
        { class: 'change-status' },
        el('span', { class: 'change-badge removed' }, 'Removed'),
        el('span', {}, 'from ', showBtn),
      ),
    );

    const stepsEl = el('div');
    body.append(stepsEl);
    steps = mountChangeSteps(stepsEl, { index, total: diff.changes.length, onStep });

    const downloadBtn = el('button', { title: 'Download this block as it was, alone, as SVG' }, icon('download', 13), 'SVG');
    downloadBtn.addEventListener('click', onDownload);
    body.append(el('div', { class: 'insp-actions' }, downloadBtn));

    if (span && model.fileBytes(span.file)) {
      const label = el(
        'label',
        {},
        d.file ?? '',
        el('span', { class: 'dim' }, ` · ${span.line === span.endLine ? `line ${String(span.line)}` : `lines ${String(span.line)}–${String(span.endLine)}`} before`),
      );
      const mount = el('div');
      body.append(el('div', { class: 'insp-source' }, label, mount));
      diffView = mountDiffView(mount, { base: { model, highlights: baseHighlights, span }, head: null });
    }
  }

  render(props);
  return {
    update: render,
    destroy(): void {
      steps?.destroy();
      diffView?.destroy();
      resizeHandle.destroy();
      aside.remove();
    },
  };
}
