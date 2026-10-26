import { findEntries, type SceneModel } from '../canvas/model';
import { TOUCH, matches } from './media';
import { el, clear } from './dom';
import { icon } from './icons';

export interface SearchProps {
  model: SceneModel;
  onPick: (id: number) => void;
  onClose: () => void;
}

export interface SearchHandle {
  destroy(): void;
}

export function mountSearch(container: HTMLElement, props: SearchProps): SearchHandle {
  const { model, onPick, onClose } = props;
  let query = '';
  let active = 0;
  let results = findEntries(model.search(), query);

  const scrim = el('div', { class: 'scrim' });
  scrim.addEventListener('mousedown', (e) => {
    if (e.target === scrim) onClose();
  });
  container.append(scrim);

  const resultsList = el('div', { class: 'palette-results', role: 'listbox' });
  const input = el('input', {
    placeholder: 'Jump to a file, class, function or block…',
    'aria-label': 'Search',
  }) as HTMLInputElement;

  function pick(i: number, from: typeof results = results): void {
    const r = from[i];
    if (r) onPick(r.id);
  }

  function renderResults(): void {
    clear(resultsList);
    if (results.length === 0) {
      resultsList.append(el('div', { class: 'palette-empty' }, 'No matches'));
      return;
    }
    results.forEach((r, i) => {
      const titleEl = el('span', { class: 'pr-title' }, r.title);
      if (r.detail) titleEl.append(el('span', { class: 'pr-detail' }, r.detail));
      const btn = el(
        'button',
        { role: 'option', 'aria-selected': String(i === active) },
        titleEl,
        el('span', { class: 'pr-path' }, model.trail(r.id)),
      );
      btn.addEventListener('mouseenter', () => {
        active = i;
        syncSelection();
      });
      btn.addEventListener('click', () => pick(i));
      resultsList.append(btn);
    });
  }

  function syncSelection(): void {
    resultsList.querySelectorAll('[role="option"]').forEach((el_, i) => {
      el_.setAttribute('aria-selected', String(i === active));
    });
    resultsList.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  function runSearch(): void {
    results = findEntries(model.search(), query);
    active = 0;
    renderResults();
  }

  input.addEventListener('input', () => {
    query = input.value;
    runSearch();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = Math.min(active + 1, results.length - 1);
      syncSelection();
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(active - 1, 0);
      syncSelection();
    }
    if (e.key === 'Enter') pick(active);
    if (e.key === 'Escape') onClose();
  });

  const label = el('label', { class: 'palette-input' }, icon('search', 16), input);
  if (matches(TOUCH)) {
    const closeBtn = el('button', { type: 'button', class: 'icon', 'aria-label': 'Close search' }, icon('x', 16));
    closeBtn.addEventListener('click', onClose);
    label.append(closeBtn);
  } else {
    label.append(el('kbd', {}, 'esc'));
  }

  const palette = el('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search' }, label, resultsList);
  scrim.append(palette);

  renderResults();
  input.focus();

  return {
    destroy(): void {
      scrim.remove();
    },
  };
}
