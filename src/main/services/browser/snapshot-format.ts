/**
 * Pure helpers for the `browser_snapshot` accessibility view. The DOM walk runs
 * in the page (see DOM_SNAPSHOT_SCRIPT) and returns a flat node list; the model-
 * facing text is rendered here so it can be unit-tested without Electron.
 */

import { isRecord, recordArrayOrEmpty } from '@shared/unknown-value.ts'

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
  /** Native or ARIA disabled state for interactive controls. */
  disabled?: boolean
}

export interface PageSnapshot {
  title: string
  url: string
  nodes: AxNode[]
  truncated?: boolean
}

export function parsePageSnapshot(value: unknown): PageSnapshot {
  if (!isRecord(value)) throw new TypeError('Browser snapshot must be an object')
  const title = value['title']
  const url = value['url']
  if (typeof title !== 'string' || typeof url !== 'string') {
    throw new TypeError('Browser snapshot must include a title and URL')
  }
  const nodes: AxNode[] = []
  for (const rawNode of recordArrayOrEmpty(value['nodes'])) {
    const role = rawNode['role']
    const name = rawNode['name']
    const depth = rawNode['depth']
    if (typeof role !== 'string' || typeof name !== 'string' || typeof depth !== 'number') continue
    nodes.push({
      role,
      name,
      depth,
      ...(typeof rawNode['ref'] === 'string' ? { ref: rawNode['ref'] } : {}),
      ...(typeof rawNode['value'] === 'string' ? { value: rawNode['value'] } : {}),
      ...(rawNode['disabled'] === true ? { disabled: true } : {}),
    })
  }
  return {
    title,
    url,
    nodes,
    ...(typeof value['truncated'] === 'boolean' ? { truncated: value['truncated'] } : {}),
  }
}

const MAX_RENDERED_CHARS = 64 * 1_024
const MAX_NODE_NAME_CHARS = 16 * 1_024

function quote(text: string, maxChars = 120): string {
  const clipped = text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
  return JSON.stringify(clipped)
}

/** Render a page snapshot as an indented accessibility outline for the model. */
export function renderSnapshot(snapshot: PageSnapshot): string {
  const header = [`page: ${quote(snapshot.title || '(untitled)')}`, `url: ${snapshot.url}`]
  if (snapshot.nodes.length === 0) {
    return [...header, '(no visible accessible content)'].join('\n')
  }
  const lines: string[] = []
  let renderedChars = header.join('\n').length + 2
  let renderTruncated = false
  for (const node of snapshot.nodes) {
    const indent = '  '.repeat(Math.max(0, node.depth))
    const parts = [`- ${node.role}`]
    if (node.name) parts.push(quote(node.name, MAX_NODE_NAME_CHARS))
    if (node.value) parts.push(`= ${quote(node.value)}`)
    if (node.disabled) parts.push('[disabled]')
    if (node.ref) parts.push(`[ref=${node.ref}]`)
    const line = `${indent}${parts.join(' ')}`
    if (renderedChars + line.length + 1 > MAX_RENDERED_CHARS) {
      renderTruncated = true
      break
    }
    lines.push(line)
    renderedChars += line.length + 1
  }
  if (snapshot.truncated || renderTruncated) lines.push('… (snapshot truncated)')
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
  const interactiveRoles = new Set([
    'button','checkbox','link','menuitem','menuitemcheckbox','menuitemradio',
    'option','radio','switch','tab','treeitem',
  ]);
  const textTags = new Set(['BLOCKQUOTE','CAPTION','DD','DT','LI','P','PRE','TD','TH']);
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
      if (t === 'file') return 'file';
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
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '')
        .join(' ').replace(/\\s+/g, ' ').trim();
      if (text) return text;
    }
    const labels = Array.from(el.labels || []);
    if (labels.length > 0) {
      const text = labels.map((candidate) => candidate.textContent || '').join(' ')
        .replace(/\\s+/g, ' ').trim();
      if (text) return text;
    }
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
    if (!(el instanceof Element)) return;
    const hiddenFileInput = el instanceof HTMLInputElement && el.type === 'file';
    if (!hiddenFileInput && !visible(el)) return;
    const role = roleFor(el);
    let nextDepth = depth;
    if (role) {
      const interactive = interactiveTags.has(el.tagName) || interactiveRoles.has(role) ||
        window.getComputedStyle(el).cursor === 'pointer';
      let ref;
      if (interactive) {
        ref = 'e' + (++refCounter);
        el.setAttribute('data-copse-ref', ref);
      }
      const node = { role, name: accessibleName(el), depth };
      if (ref) node.ref = ref;
      if ((el.tagName === 'INPUT' && el.type !== 'file') || el.tagName === 'TEXTAREA') {
        if (el.value) node.value = String(el.value).slice(0, 120);
      }
      if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') {
        node.disabled = true;
      }
      nodes.push(node);
      nextDepth = depth + 1;
    } else if (textTags.has(el.tagName) || el.children.length === 0) {
      const name = accessibleName(el);
      if (name) {
        const node = { role: 'text', name, depth };
        if (window.getComputedStyle(el).cursor === 'pointer') {
          const ref = 'e' + (++refCounter);
          el.setAttribute('data-copse-ref', ref);
          node.ref = ref;
        }
        nodes.push(node);
      }
    }
    for (const child of el.children) walk(child, nextDepth);
  };
  if (document.body) walk(document.body, 0);
  return { title: document.title, url: location.href, nodes, truncated };
})()`
