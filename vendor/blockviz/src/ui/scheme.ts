/**
 * Light or dark: the reader's choice, remembered, or else the system's
 * setting, followed as it changes. The page's colors follow the root's
 * `color-scheme` (styles.css writes each as `light-dark()`), which a choice
 * sets through its `data-scheme`; index.html sets that from the remembered
 * choice before the page is first drawn.
 */
const KEY = 'blockviz.scheme';
const system = window.matchMedia('(prefers-color-scheme: dark)');
const changed = new Set<() => void>();

let choice = ((): 'light' | 'dark' | null => {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
})();

/** Set by an embedding host (Copse): overrides the system/remembered choice
 * entirely while non-null, so the page always follows the host's own theme. */
let embeddedDark: boolean | null = null;

/** Whether the page is dark, right now. */
export const isDark = () => (embeddedDark !== null ? embeddedDark : choice ? choice === 'dark' : system.matches);

/** Called by an embedding host to set dark/light directly. */
export function setEmbeddedDark(dark: boolean): void {
  if (embeddedDark === dark) return;
  embeddedDark = dark;
  // Tokens this module doesn't override stay correct via `light-dark()`.
  document.documentElement.dataset.scheme = dark ? 'dark' : 'light';
  for (const listener of changed) listener();
}

/** Calls `listener` whenever light/dark might have changed (a choice, or the system). */
export function subscribe(listener: () => void): () => void {
  changed.add(listener);
  system.addEventListener('change', listener);
  return () => {
    changed.delete(listener);
    system.removeEventListener('change', listener);
  };
}

/** Switches to the other scheme. Choosing the system's own forgets the choice, so the page follows the system again. */
export function toggleScheme() {
  const next = isDark() ? 'light' : 'dark';
  choice = next === (system.matches ? 'dark' : 'light') ? null : next;
  try {
    if (choice) localStorage.setItem(KEY, choice);
    else localStorage.removeItem(KEY);
  } catch { /* remembered for this visit only */ }
  if (choice) document.documentElement.dataset.scheme = choice;
  else delete document.documentElement.dataset.scheme;
  for (const listener of changed) listener();
}
