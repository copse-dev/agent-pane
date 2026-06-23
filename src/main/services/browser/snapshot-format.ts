/**
 * Pure helpers for the `browser_snapshot` accessibility view. The DOM walk runs
 * in the page (see DOM_SNAPSHOT_SCRIPT) and returns a flat node list; the model-
 * facing text is rendered here so it can be unit-tested without Electron.
 */

export interface AxNode {
  /** ARIA-ish role (heading, link, button, textbox, text, …). */
  role: string
  /** Accessible name / trimmed text content. */
  name: string
  /** Stable interaction ref (e.g. `e7`); present only for actionable elements. */
  ref?: string
  /** Nesting depth used for indentation. */
  depth: number
  /** Current value for inputs, if any. */
  value?: string
}

export interface PageSnapshot {
  title: string
  url: string
  nodes: AxNode[]
  truncated?: boolean
}

function quote(text: string): string {
  const clipped = text.length > 120 ? `${text.slice(0, 117)}…` : text
  return JSON.stringify(clipped)
}

/** Render a page snapshot as an indented accessibility outline for the model. */
export function renderSnapshot(snapshot: PageSnapshot): string {
  const header = [`page: ${quote(snapshot.title || '(untitled)')}`, `url: ${snapshot.url}`]
  if (snapshot.nodes.length === 0) {
    return [...header, '(no visible accessible content)'].join('\n')
  }
  const lines = snapshot.nodes.map((node) => {
    const indent = '  '.repeat(Math.max(0, node.depth))
    const parts = [`- ${node.role}`]
    if (node.name) parts.push(quote(node.name))
    if (node.value) parts.push(`= ${quote(node.value)}`)
    if (node.ref) parts.push(`[ref=${node.ref}]`)
    return `${indent}${parts.join(' ')}`
  })
  if (snapshot.truncated) lines.push('… (snapshot truncated)')
  return [...header, '', ...lines].join('\n')
}

/**
 * Script injected via `webContents.executeJavaScript`. Walks the rendered DOM,
 * tags interactive elements with `data-copse-ref`, and returns a PageSnapshot.
 * Written as a plain-function IIFE string because it executes in page context.
 */
export const DOM_SNAPSHOT_SCRIPT = `(() => {
  const MAX_NODES = 400;
  const interactiveTags = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA']);
  const roleFor = (el) => {
    const aria = el.getAttribute('role');
    if (aria) return aria;
    const tag = el.tagName;
    if (tag === 'A' && el.hasAttribute('href')) return 'link';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button') return 'button';
      return 'textbox';
    }
    if (/^H[1-6]$/.test(tag)) return 'heading';
    return null;
  };
  const visible = (el) => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const accessibleName = (el) => {
    const label = el.getAttribute('aria-label');
    if (label) return label.trim();
    if (el.tagName === 'INPUT') {
      const ph = el.getAttribute('placeholder');
      if (ph) return ph.trim();
    }
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    return text;
  };
  const nodes = [];
  let refCounter = 0;
  let truncated = false;
  const walk = (el, depth) => {
    if (nodes.length >= MAX_NODES) { truncated = true; return; }
    if (!(el instanceof Element) || !visible(el)) return;
    const role = roleFor(el);
    let nextDepth = depth;
    if (role) {
      const interactive = interactiveTags.has(el.tagName) || el.getAttribute('role') === 'button';
      let ref;
      if (interactive) {
        ref = 'e' + (++refCounter);
        el.setAttribute('data-copse-ref', ref);
      }
      const node = { role, name: accessibleName(el), depth };
      if (ref) node.ref = ref;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        if (el.value) node.value = String(el.value).slice(0, 120);
      }
      nodes.push(node);
      nextDepth = depth + 1;
    }
    for (const child of el.children) walk(child, nextDepth);
  };
  if (document.body) walk(document.body, 0);
  return { title: document.title, url: location.href, nodes, truncated };
})()`
