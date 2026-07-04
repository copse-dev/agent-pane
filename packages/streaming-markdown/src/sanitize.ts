import DOMPurify from 'dompurify'

// Defense-in-depth over the hand-assembled HTML that `renderMarkdown()` emits.
// The renderer already escapes prose and validates link hrefs, but it builds
// HTML by string concatenation, which is inherently fragile. Passing every
// rendered fragment through DOMPurify (a vetted, fuzzed sanitizer) before it
// reaches `innerHTML` guarantees that anything outside the small, known set of
// tags/attributes the renderer is supposed to produce — including any payload
// that slips through the regex assembly — is stripped.
//
// The allowlist is intentionally narrow: it mirrors exactly what the renderer
// outputs (prose + GFM tables + highlighted code + mermaid scaffolding). Mermaid
// SVG is generated later, directly by the mermaid library, so it never passes
// through here.
const ALLOWED_TAGS = [
  'a',
  'p',
  'br',
  'hr',
  'strong',
  'em',
  'code',
  'pre',
  'span',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'blockquote',
  // Benign raw inline HTML the renderer passes through unescaped (see
  // BENIGN_RAW_INLINE_TAG_RE in escape.ts) — attribute-less phrasing tags only.
  'b',
  'i',
  'u',
  's',
  'del',
  'ins',
  'sub',
  'sup',
  'kbd',
  'mark',
  // GFM task-list checkboxes (#614). The renderer only ever emits the fixed,
  // read-only form `<input type="checkbox" disabled [checked]>` inside an
  // `<li class="task-list-item">`. Only `type`/`checked`/`disabled` are allowed
  // below, and the `uponSanitizeElement` hook drops any non-checkbox `<input>`,
  // so no interactive/form payload can survive.
  'input',
  // Remote-agent artifact images. The renderer only ever emits the locked-down
  // form `<img class="remote-artifact-image" data-remote-artifact-path="…" …>`
  // (no `src`); `hydrateRemoteArtifactImages()` resolves the `src` to a
  // data:/blob: URL *after* sanitization. The `uponSanitizeElement` hook below
  // drops any other `<img>`, so arbitrary LLM `<img>` can never survive.
  'img',
]

// `data-browser-link` flags links the renderer routes through the in-app browser
// (see `browser-links.ts`); `class` carries highlight.js and mermaid hooks.
// The `data-remote-artifact-*`/`alt`/`loading` attributes belong to the
// artifact-image element above. `src` is deliberately NOT allowed: the renderer
// never emits one, and letting it through would re-open `<img src=… onerror=…>`
// style payloads. Hydration sets `src` programmatically post-sanitization.
const ALLOWED_ATTR = [
  'href',
  'target',
  'rel',
  'class',
  'data-browser-link',
  'data-workspace-link',
  'data-ordered-marker',
  'data-remote-artifact-path',
  'data-remote-artifact-agent-id',
  'alt',
  'loading',
  // Task-list checkbox attributes (#614) — read-only booleans, no XSS surface.
  'type',
  'checked',
  'disabled',
]

// Only this exact class marks a renderer-produced artifact image. Any `<img>`
// whose class differs (including LLM-authored `<img>` that slipped through the
// regex assembly) is removed entirely by the hook below.
const REMOTE_ARTIFACT_IMAGE_CLASS = 'remote-artifact-image'

let imgHookInstalled = false

function installImgHook(): void {
  if (imgHookInstalled) return
  imgHookInstalled = true
  DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'input') {
      const el = node as Element
      // Only the renderer's read-only task-list checkbox is allowed; drop any
      // other `<input>` (text fields, buttons, image inputs) entirely and force
      // the checkbox read-only so it can never be a real form control.
      if (el.getAttribute('type') !== 'checkbox') {
        el.remove()
        return
      }
      el.setAttribute('disabled', '')
      return
    }
    if (data.tagName !== 'img') return
    const el = node as Element
    // Class-gate: drop any image that is not the renderer's artifact image.
    if (el.getAttribute('class') !== REMOTE_ARTIFACT_IMAGE_CLASS) {
      el.remove()
      return
    }
    // Defense-in-depth: artifact images carry no `src` until hydration runs.
    // Strip any `src` an attacker might have smuggled in alongside the class.
    el.removeAttribute('src')
  })
}

const DOUBLE_ENCODED_NBSP_RE = /&amp;(?:nbsp|#160|#x0*a);/gi

/** Sanitize rendered-markdown HTML before it is assigned to `innerHTML`. */
export function sanitizeRenderedMarkdown(html: string): string {
  installImgHook()
  const sanitized = DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR })
  // Any path that escaped a model-emitted &nbsp; before decode would surface literal
  // "&nbsp;" text; normalize those back to real NBSP before innerHTML assignment.
  return sanitized.replace(DOUBLE_ENCODED_NBSP_RE, '\u00A0')
}
