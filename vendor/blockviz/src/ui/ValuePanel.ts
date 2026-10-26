import type { Edge } from '../core/types';
import type { SceneModel } from '../canvas/model';
import type { PanelSize } from './panel';
import { el, clear } from './dom';
import { icon } from './icons';

/** A step a value passes through, named as the diagram names it. */
function stepName(model: SceneModel, id: number): string {
  const n = model.node(id);
  if (n.kind === 'input') return `input ${n.title}`;
  if (n.kind === 'output') return n.title ? `result ${n.title}` : 'result';
  return n.title || n.kind;
}

/** The definition a diagram belongs to (a branch belongs to its function). */
function definition(model: SceneModel, id: number): number {
  let n = model.node(id);
  while (n.shape === 'region' && n.parent !== undefined) n = model.node(n.parent);
  return n.id;
}

export interface ValuePanelProps {
  model: SceneModel;
  owner: number;
  edges: ReadonlySet<Edge>;
  start: Edge;
  size: PanelSize;
  onClose: () => void;
  onPick: (id: number) => void;
  onPeek: (id: number | null) => void;
  /** Saves a definition alone as SVG, the value's path lit in it. */
  onDownload: (id: number) => void;
}

/**
 * A value followed through its diagram: where it is made and every step that
 * reads it, in the order they are drawn. Each step is a link to it.
 */
export interface ValuePanelHandle {
  update(props: ValuePanelProps): void;
  destroy(): void;
}

export function mountValuePanel(container: HTMLElement, props: ValuePanelProps): ValuePanelHandle {
  const aside = el('aside', { class: 'inspector', 'aria-label': 'Value details' });
  container.append(aside);

  function render(p: ValuePanelProps): void {
    aside.style.setProperty('--panel-w', `${String(p.size.w)}px`);
    if (p.size.h) aside.style.setProperty('--panel-h', `${String(p.size.h)}px`);
    else aside.style.removeProperty('--panel-h');

    const { model, owner, edges, start, onClose, onPick, onPeek, onDownload } = p;
    const list = [...edges];
    // Ports and branches only pass the value on, and a stop is where nothing reads it;
    // the steps are what read and make it.
    const step = (id: number): boolean => {
      const n = model.node(id);
      return (
        n.shape !== 'region' &&
        n.kind !== 'unused' &&
        !(n.kind === 'input' && n.parent !== undefined && model.node(n.parent).shape === 'region') &&
        !(n.kind === 'output' && n.parent !== undefined && model.node(n.parent).shape === 'region')
      );
    };
    const targets = new Set(list.map((e) => e.to));
    // Where it comes from: steps that send it but are not sent it under this name.
    const sources = [...new Set(list.map((e) => e.from))].filter((id) => !targets.has(id) && step(id));
    const order = (a: number, b: number): number =>
      (model.node(a).span?.start ?? 0) - (model.node(b).span?.start ?? 0) || model.node(a).y - model.node(b).y;
    const readers = [...targets].filter(step).sort(order);

    const row = (id: number): HTMLButtonElement => {
      const n = model.node(id);
      const btn = el('button', {}, el('span', { class: 'use-name' }, stepName(model, id)));
      if (n.subtitle) btn.append(el('span', { class: 'use-at' }, n.subtitle));
      btn.addEventListener('click', () => {
        onPick(id);
      });
      btn.addEventListener('mouseenter', () => {
        onPeek(id);
      });
      return btn;
    };

    const closeBtn = el('button', { class: 'icon', 'aria-label': 'Close details' }, icon('x', 15));
    closeBtn.addEventListener('click', onClose);

    const downloadBtn = el(
      'button',
      { title: "Download this definition alone as SVG, the value's path lit in it" },
      icon('download', 13),
      'SVG',
    );
    downloadBtn.addEventListener('click', () => {
      onDownload(definition(model, owner));
    });

    const sourcesBox = el('div', { class: 'uses' }, ...sources.map(row));
    sourcesBox.addEventListener('mouseleave', () => {
      onPeek(null);
    });

    const flowsInto = readers.length
      ? (() => {
          const box = el('div', { class: 'uses' }, ...readers.map(row));
          box.addEventListener('mouseleave', () => {
            onPeek(null);
          });
          return box;
        })()
      : el('p', { class: 'insp-doc' }, 'Nothing reads it.');

    clear(aside);
    aside.append(
      el(
        'div',
        { class: 'insp-body' },
        el('header', {}, el('span', { class: 'insp-kind' }, 'Value'), closeBtn),
        el('h2', { class: 'mono' }, start.label || 'unnamed value'),
        el('p', { class: 'insp-doc' }, `In ${model.qualified(definition(model, owner))}. Its path is highlighted in the diagram.`),
        el('div', { class: 'insp-actions' }, downloadBtn),
        el('div', { class: 'insp-field' }, el('label', {}, 'Comes from'), sourcesBox),
        el(
          'div',
          { class: 'insp-field' },
          el('label', {}, 'Flows into ', el('span', { class: 'count' }, String(readers.length))),
          flowsInto,
        ),
      ),
    );
  }

  render(props);

  return {
    update: render,
    destroy(): void {
      aside.remove();
    },
  };
}
