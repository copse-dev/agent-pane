import { onWindowWidthChange } from './media';
import { el, clear, on } from './dom';
import { icon } from './icons';

export interface Crumb {
  id: number;
  i: number;
  title: string;
}

/** Long paths keep their first and last steps and fold the middle into a menu,
 * folding more (keeping fewer last steps) while the path is wider than its room;
 * at the last fold, names shrink with an ellipsis. */
const FOLDS = [
  { over: 5, keep: 3 },
  { over: 3, keep: 2 },
  { over: 2, keep: 1 },
];

export interface BreadcrumbsHandle {
  update(crumbs: Crumb[]): void;
  destroy(): void;
}

/** The containers the view is in, root first; each goes back out to it. */
export function mountBreadcrumbs(
  container: HTMLElement,
  { onGo }: { onGo: (c: Crumb) => void },
): BreadcrumbsHandle {
  const box = el('div', { class: 'crumbs' });
  container.append(box);

  let open = false;
  let closeMenuListener: (() => void) | null = null;

  function closeMenu(): void {
    if (!open) return;
    open = false;
    closeMenuListener?.();
    closeMenuListener = null;
  }

  function renderAtLevel(crumbs: Crumb[], level: number): void {
    box.className = level === FOLDS.length - 1 ? 'crumbs squeeze' : 'crumbs';
    const foldDef = FOLDS[level];
    const fold = foldDef && crumbs.length > foldDef.over;
    const hidden = fold ? crumbs.slice(1, crumbs.length - foldDef.keep) : [];
    const shown: (Crumb | null)[] = fold
      ? [crumbs[0] ?? null, null, ...crumbs.slice(crumbs.length - foldDef.keep)]
      : crumbs;

    clear(box);
    shown.forEach((c, k) => {
      const span = el('span', { class: 'crumb' });
      if (k > 0) span.append(icon('chevronRight', 13));
      if (c) {
        const btn = el('button', {}, c.title);
        btn.addEventListener('click', () => {
          onGo(c);
        });
        span.append(btn);
      } else {
        const foldSpan = el('span', { class: 'crumb-fold' });
        const toggle = el(
          'button',
          {
            'aria-label': `${String(hidden.length)} more`,
            'aria-expanded': String(open),
            title: hidden.map((h) => h.title).join(' › '),
          },
          '…',
        );
        toggle.addEventListener('click', () => {
          if (open) closeMenu();
          else openMenu(foldSpan, hidden);
        });
        foldSpan.append(toggle);
        span.append(foldSpan);
      }
      box.append(span);
    });
  }

  function openMenu(foldSpan: HTMLElement, hidden: Crumb[]): void {
    open = true;
    const menu = el(
      'span',
      { class: 'crumb-menu', role: 'menu' },
      ...hidden.map((h) => {
        const item = el('button', { role: 'menuitem' }, h.title);
        item.addEventListener('click', () => {
          closeMenu();
          onGo(h);
        });
        return item;
      }),
    );
    foldSpan.append(menu);
    closeMenuListener = on(window, 'pointerdown', (e) => {
      if (!foldSpan.contains(e.target as Node)) closeMenu();
    });
  }

  let lastCrumbs: Crumb[] = [];

  function update(crumbs: Crumb[]): void {
    lastCrumbs = crumbs;
    closeMenu();
    // Each new path or window width starts from the roomiest folding, then folds
    // further (synchronously, in the same pass this component's own React
    // version spread across re-renders) until it fits or hits the last level.
    let level = 0;
    renderAtLevel(crumbs, level);
    while (box.scrollWidth > box.clientWidth + 1 && level < FOLDS.length - 1) {
      level++;
      renderAtLevel(crumbs, level);
    }
  }

  // A resize re-measures from the roomiest folding, for the crumbs on screen.
  const unwatchWidth = onWindowWidthChange(() => {
    update(lastCrumbs);
  });

  return {
    update,
    destroy(): void {
      closeMenu();
      unwatchWidth();
      box.remove();
    },
  };
}
