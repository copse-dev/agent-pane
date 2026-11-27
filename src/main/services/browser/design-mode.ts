/**
 * Main-process half of Browser-pane design mode (see
 * `src/shared/browser-design-mode.ts`). The hover outline, the click capture
 * and the numbered markers for pinned elements run in an isolated world, so
 * the page's own script cannot see or call them; they share only the DOM. The
 * source-location probe is the one piece that runs in the page's world,
 * because framework dev metadata (React fibers, Vue component instances,
 * Svelte's `__svelte_meta`) lives on JavaScript expandos that an isolated
 * world cannot read. Its answer is parsed like any other page content.
 *
 * Nothing here runs with a user gesture: picking is driven by Copse, and a
 * gesture would hand the page a standing activation.
 */
import { z } from 'zod'
import {
  DESIGN_PICK_MAX_HTML_CHARS,
  DESIGN_PICK_SELECTOR_LIMIT,
  DESIGN_PICK_STYLE_VALUE_LIMIT,
  DESIGN_PICK_TEXT_LIMIT,
  zDesignGuestPick,
  zDesignSource,
  type DesignPickResult,
  type DesignTheme,
  type DesignSource,
} from '@shared/browser-design-mode.ts'

/** Isolated world for design mode; distinct from Electron's preload world (999). */
export const DESIGN_MODE_WORLD_ID = 1_077

/** Context kept around a crop so the agent sees where the element sits. */
const CROP_PADDING_CSS_PX = 12
/** Longest edge of a crop sent to the agent. */
const CROP_MAX_EDGE_PX = 1_600

interface DesignImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: { width?: number; height?: number; quality?: 'best' }): DesignImage
  toDataURL(): string
}

export interface DesignModeContents {
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  executeJavaScriptInIsolatedWorld(
    worldId: number,
    scripts: Array<{ code: string }>,
    userGesture?: boolean,
  ): Promise<unknown>
  capturePage(rect?: { x: number; y: number; width: number; height: number }): Promise<DesignImage>
  on(
    event: 'did-start-navigation',
    listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void,
  ): unknown
  on(event: 'destroyed', listener: () => void): unknown
  off(
    event: 'did-start-navigation',
    listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void,
  ): unknown
  off(event: 'destroyed', listener: () => void): unknown
}

/**
 * Shared state for one document in the design world: the pick in flight and
 * the elements picked so far (by handle), so markers can follow them.
 */
const DESIGN_STATE = `(window.__copseDesign ??= { elements: new Map(), next: 1, cancel: null, markers: null })`

const PICK_SCRIPT = (theme: DesignTheme): string => `(() => {
  const S = ${DESIGN_STATE};
  if (S.cancel) S.cancel();
  const STYLE_KEYS = ['display', 'position', 'box-sizing', 'width', 'height', 'margin', 'padding',
    'border', 'border-radius', 'color', 'background-color', 'background-image', 'font-family',
    'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align', 'text-transform',
    'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'gap', 'grid-template-columns',
    'grid-template-rows', 'opacity', 'box-shadow', 'z-index', 'overflow', 'transform', 'cursor'];
  const ALWAYS = new Set(['display', 'width', 'height', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height']);
  const BORING = new Set(['none', 'normal', 'auto', '0px', 'static', 'visible', 'rgba(0, 0, 0, 0)',
    '0px none rgb(0, 0, 0)', 'nowrap', 'row', 'start', 'stretch', 'content-box', 'left', '1', 'clip']);
  const cap = (s, n) => (s.length > n ? s.slice(0, n) : s);
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);
  const selectorFor = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement && node !== document.body && parts.length < 8) {
      let part = node.localName;
      if (node.id && document.querySelectorAll('#' + esc(node.id)).length === 1) {
        parts.unshift(part + '#' + esc(node.id));
        break;
      }
      const classes = Array.from(node.classList).filter((c) => !/^(is-|has-)?(hover|focus|active)/.test(c)).slice(0, 2);
      if (classes.length) part += '.' + classes.map(esc).join('.');
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.localName === node.localName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return cap(parts.join(' > ') || el.localName, ${String(DESIGN_PICK_SELECTOR_LIMIT)});
  };
  const styleOf = (el) => {
    const cs = getComputedStyle(el);
    const out = {};
    for (const key of STYLE_KEYS) {
      const value = cs.getPropertyValue(key).trim();
      if (!value) continue;
      if (!ALWAYS.has(key) && BORING.has(value)) continue;
      out[key] = cap(value, ${String(DESIGN_PICK_STYLE_VALUE_LIMIT)});
    }
    return out;
  };

  return new Promise((resolve) => {
    const host = document.createElement('copse-design-overlay');
    host.setAttribute('style', 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;');
    host.style.setProperty('--copse-accent', ${JSON.stringify(theme.accent)});
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<style>' +
      '.box{position:fixed;box-sizing:border-box;border:2px solid var(--copse-accent);background:color-mix(in srgb,var(--copse-accent) 14%,transparent);border-radius:2px;display:none}' +
      '.tag{position:fixed;display:none;padding:2px 6px;border-radius:4px;background:#1b1d1f;color:#fffdf7;font:500 11px/16px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis}' +
      '</style><div class="box"></div><div class="tag"></div>';
    const box = root.querySelector('.box');
    const tag = root.querySelector('.tag');
    (document.documentElement || document.body).appendChild(host);
    let current = null;
    const show = (el) => {
      current = el;
      if (!el) { box.style.display = 'none'; tag.style.display = 'none'; return; }
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      let label = el.localName;
      if (el.id) label += '#' + el.id;
      else if (el.classList.length) label += '.' + Array.from(el.classList).slice(0, 2).join('.');
      tag.textContent = label + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
      tag.style.display = 'block';
      const above = r.top - 22;
      tag.style.left = Math.max(2, Math.min(r.left, innerWidth - 120)) + 'px';
      tag.style.top = (above >= 2 ? above : Math.min(innerHeight - 22, r.bottom + 4)) + 'px';
    };
    const at = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      return el && el !== host ? el : null;
    };
    const swallow = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
    const onMove = (e) => { const el = at(e); if (el !== current) show(el); };
    const onScroll = () => { if (current) show(current); };
    const onClick = (e) => { swallow(e); const el = at(e) || current; finish(el); };
    const onKey = (e) => {
      if (e.key === 'Escape') { swallow(e); finish(null); }
      else if (e.key === 'ArrowUp' && current && current.parentElement && current.parentElement !== document.documentElement) { swallow(e); show(current.parentElement); }
    };
    const BLOCK = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu', 'auxclick'];
    const listen = (on) => {
      const m = on ? 'addEventListener' : 'removeEventListener';
      window[m]('pointermove', onMove, true);
      window[m]('scroll', onScroll, true);
      window[m]('click', onClick, true);
      window[m]('keydown', onKey, true);
      for (const t of BLOCK) window[m](t, swallow, true);
    };
    const finish = (el) => {
      listen(false);
      host.remove();
      S.cancel = null;
      if (!el) { resolve(null); return; }
      const pickId = S.next++;
      S.elements.set(pickId, el);
      const html = el.outerHTML;
      const token = Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
      el.setAttribute('data-copse-design-pick', token);
      const r = el.getBoundingClientRect();
      const result = {
        pickId, token,
        url: cap(location.href, 4000),
        title: cap(document.title || '', 500),
        tag: cap(el.localName, 100),
        selector: selectorFor(el),
        text: cap((el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim(), ${String(DESIGN_PICK_TEXT_LIMIT)}),
        html: cap(html, ${String(DESIGN_PICK_MAX_HTML_CHARS)}),
        htmlOmittedChars: Math.max(0, html.length - ${String(DESIGN_PICK_MAX_HTML_CHARS)}),
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
        viewport: { width: innerWidth, height: innerHeight },
        styles: styleOf(el),
      };
      // Let the outline leave the compositor before main crops the frame.
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(result)));
    };
    S.cancel = () => finish(null);
    listen(true);
  });
})()`

const CANCEL_SCRIPT = `(() => { const S = window.__copseDesign; if (S && S.cancel) S.cancel(); return true; })()`

const UNTAG_SCRIPT = (token: string): string =>
  `(() => { for (const el of document.querySelectorAll('[data-copse-design-pick="${token}"]')) el.removeAttribute('data-copse-design-pick'); return true; })()`

/**
 * Runs in the page's world. Reads the dev-build hints frameworks leave on
 * nodes, nearest element first, and removes the one-shot attribute.
 */
const SOURCE_PROBE_SCRIPT = (token: string): string => `(() => {
  const el = document.querySelector('[data-copse-design-pick="${token}"]');
  if (!el) return null;
  el.removeAttribute('data-copse-design-pick');
  const str = (v) => (typeof v === 'string' && v ? v.slice(0, 1000) : null);
  const num = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
  const nameOf = (t) => (t && (t.displayName || t.name || t.__name)) || null;
  const out = (via, file, line, column, component) => (file ? { via, file, line: num(line), column: num(column), component: str(component) } : null);
  for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 12; node = node.parentElement, depth++) {
    const d = node.dataset || {};
    if (d.inspectorRelativePath || d.inspectorPath) return out('data-inspector', d.inspectorRelativePath || d.inspectorPath, d.inspectorLine, d.inspectorColumn, null);
    if (d.source) { const m = /^(.*?)(?::(\\d+))?(?::(\\d+))?$/.exec(d.source); if (m) return out('data-source', m[1], m[2], m[3], null); }
    if (d.sourcepos) { const m = /^(\\d+):(\\d+)/.exec(d.sourcepos); if (m) return out('data-sourcepos', location.pathname, m[1], m[2], null); }
    const svelte = node.__svelte_meta && node.__svelte_meta.loc;
    if (svelte) return out('svelte', svelte.file, svelte.line, svelte.column, null);
    const vue = node.__vueParentComponent;
    if (vue && vue.type && vue.type.__file) return out('vue', vue.type.__file, null, null, nameOf(vue.type));
    if (node.__vue__ && node.__vue__.$options && node.__vue__.$options.__file) return out('vue', node.__vue__.$options.__file, null, null, node.__vue__.$options.name);
    const fiberKey = Object.keys(node).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    if (fiberKey) {
      let owner = null;
      for (let f = node[fiberKey], hops = 0; f && hops < 40; f = f.return, hops++) {
        if (!owner && typeof f.type === 'function') owner = nameOf(f.type);
        const s = f._debugSource;
        if (s && s.fileName) return out('react', s.fileName, s.lineNumber, s.columnNumber, owner);
      }
      if (owner) return { via: 'react', file: 'component ' + owner.slice(0, 200), line: null, column: null, component: owner.slice(0, 200) };
    }
  }
  return null;
})()`

/** Numbered outlines over the pinned elements, following them as the page scrolls. */
const MARKERS_SCRIPT = (ids: readonly number[], theme: DesignTheme): string => `(() => {
  const S = ${DESIGN_STATE};
  const ids = ${JSON.stringify(ids)};
  const prev = S.markers;
  if (prev) prev.dispose();
  S.markers = null;
  for (const id of Array.from(S.elements.keys())) if (!ids.includes(id)) S.elements.delete(id);
  if (ids.length === 0) return true;
  const host = document.createElement('copse-design-markers');
  host.setAttribute('style', 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483646;');
  host.style.setProperty('--copse-accent', ${JSON.stringify(theme.accent)});
  host.style.setProperty('--copse-on-accent', ${JSON.stringify(theme.onAccent)});
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = '<style>' +
    '.m{position:fixed;box-sizing:border-box;border:1.5px dashed var(--copse-accent);border-radius:2px}' +
    '.n{position:absolute;top:-10px;left:-10px;min-width:18px;height:18px;padding:0 4px;box-sizing:border-box;border-radius:9px;background:var(--copse-accent);color:var(--copse-on-accent);font:600 11px/18px system-ui,sans-serif;text-align:center}' +
    '</style>';
  const marks = ids.map((id, index) => {
    const m = document.createElement('div');
    m.className = 'm';
    const n = document.createElement('div');
    n.className = 'n';
    n.textContent = String(index + 1);
    m.appendChild(n);
    root.appendChild(m);
    return { m, el: S.elements.get(id) };
  });
  (document.documentElement || document.body).appendChild(host);
  const place = () => {
    for (const { m, el } of marks) {
      if (!el || !el.isConnected) { m.style.display = 'none'; continue; }
      const r = el.getBoundingClientRect();
      Object.assign(m.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    }
  };
  place();
  window.addEventListener('scroll', place, true);
  window.addEventListener('resize', place);
  const timer = setInterval(place, 500);
  S.markers = { dispose: () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); clearInterval(timer); host.remove(); } };
  return true;
})()`

const zMarkerIds = z.array(z.number().int().positive()).max(200)

/** A CSS colour the renderer resolved from its accent tokens: hex or rgb()/rgba() only. */
const zCssColour = z
  .string()
  .max(60)
  .regex(/^(#[0-9a-fA-F]{3,8}|rgba?\(\s*[\d.]+%?(\s*[,\s/]\s*[\d.]+%?){2,3}\s*\))$/)

/** The app accent, so outlines and numbered markers match the tray's badges. */
const zDesignTheme = z.strictObject({ accent: zCssColour, onAccent: zCssColour })

const DEFAULT_THEME: DesignTheme = { accent: '#ff93d0', onAccent: '#1b1d1f' }

function parseTheme(raw: unknown): DesignTheme {
  if (raw === undefined) return DEFAULT_THEME
  return zDesignTheme.parse(raw)
}

function clampCrop(
  rect: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number; width: number; height: number } | null {
  const left = Math.max(0, Math.floor(rect.x - CROP_PADDING_CSS_PX))
  const top = Math.max(0, Math.floor(rect.y - CROP_PADDING_CSS_PX))
  const right = Math.min(viewport.width, Math.ceil(rect.x + rect.width + CROP_PADDING_CSS_PX))
  const bottom = Math.min(viewport.height, Math.ceil(rect.y + rect.height + CROP_PADDING_CSS_PX))
  if (right - left < 2 || bottom - top < 2) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

async function cropElement(
  contents: DesignModeContents,
  rect: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
): Promise<string | null> {
  const crop = clampCrop(rect, viewport)
  if (!crop) return null
  try {
    const image = await contents.capturePage(crop)
    if (image.isEmpty()) return null
    const { width, height } = image.getSize()
    const longest = Math.max(width, height)
    if (longest <= CROP_MAX_EDGE_PX) return image.toDataURL()
    const scale = CROP_MAX_EDGE_PX / longest
    return image.resize({ width: Math.round(width * scale), quality: 'best' }).toDataURL()
  } catch {
    return null
  }
}

async function probeSource(
  contents: DesignModeContents,
  token: string,
): Promise<DesignSource | null> {
  try {
    const parsed = zDesignSource
      .nullable()
      .safeParse(await contents.executeJavaScript(SOURCE_PROBE_SCRIPT(token), false))
    return parsed.success ? parsed.data : null
  } catch {
    // The page's world threw or went away; make sure the marker attribute does not linger.
    await contents
      .executeJavaScriptInIsolatedWorld(
        DESIGN_MODE_WORLD_ID,
        [{ code: UNTAG_SCRIPT(token) }],
        false,
      )
      .catch(() => undefined)
    return null
  }
}

/**
 * Wait for the user to click one element in the guest. Resolves `navigated`
 * when the document goes away first, since a pick on the old page can never
 * finish.
 */
export async function pickBrowserElement(
  contents: DesignModeContents,
  rawTheme?: unknown,
): Promise<DesignPickResult> {
  const theme = parseTheme(rawTheme)
  let leave: (value: 'navigated') => void = () => undefined
  const gone = new Promise<'navigated'>((resolve) => {
    leave = resolve
  })
  const onNavigate = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
    if (details.isMainFrame && !details.isSameDocument) leave('navigated')
  }
  const onDestroyed = (): void => {
    leave('navigated')
  }
  contents.on('did-start-navigation', onNavigate)
  contents.on('destroyed', onDestroyed)
  try {
    const raw = await Promise.race([
      contents.executeJavaScriptInIsolatedWorld(
        DESIGN_MODE_WORLD_ID,
        [{ code: PICK_SCRIPT(theme) }],
        false,
      ),
      gone,
    ])
    if (raw === 'navigated') return { kind: 'navigated' }
    if (raw === null || raw === undefined) return { kind: 'cancelled' }
    const { token, ...rest } = zDesignGuestPick.parse(raw)
    const [source, screenshot] = await Promise.all([
      probeSource(contents, token),
      cropElement(contents, rest.rect, rest.viewport),
    ])
    return { kind: 'picked', element: { ...rest, source, screenshot } }
  } finally {
    contents.off('did-start-navigation', onNavigate)
    contents.off('destroyed', onDestroyed)
  }
}

/** End an in-flight pick; the pending {@link pickBrowserElement} resolves `cancelled`. */
export async function cancelBrowserElementPick(contents: DesignModeContents): Promise<void> {
  await contents
    .executeJavaScriptInIsolatedWorld(DESIGN_MODE_WORLD_ID, [{ code: CANCEL_SCRIPT }], false)
    .catch(() => undefined)
}

/** Show numbered outlines on the pinned elements, in tray order; `[]` clears them. */
export async function syncBrowserDesignMarkers(
  contents: DesignModeContents,
  rawIds: unknown,
  rawTheme?: unknown,
): Promise<void> {
  const ids = zMarkerIds.parse(rawIds)
  const theme = parseTheme(rawTheme)
  await contents
    .executeJavaScriptInIsolatedWorld(
      DESIGN_MODE_WORLD_ID,
      [{ code: MARKERS_SCRIPT(ids, theme) }],
      false,
    )
    .catch(() => undefined)
}
