import { cpSync, copyFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ESM_WORKER_HOST_SRC = resolve('src/renderer/monaco/esm-worker-host.js')

/** ESM worker ids used by Monaco's editor host vs filenames shipped in the ESM bundle. */
const WORKER_ALIASES: ReadonlyArray<[dest: string, src: string]> = [
  ['language/typescript/tsWorker.js', 'language/typescript/ts.worker.js'],
  ['language/json/jsonWorker.js', 'language/json/json.worker.js'],
  ['language/css/cssWorker.js', 'language/css/css.worker.js'],
  ['language/html/htmlWorker.js', 'language/html/html.worker.js'],
]

/**
 * Copy Monaco's ESM `vs/` tree for worker runtime. The renderer bundles the editor
 * as ESM; workers dynamically import `vs/...` modules and must not load AMD `min/vs`
 * workers (those call `define()` and fail with "define is not defined").
 */
export function copyMonacoWorkers(rendererOutDir: string): void {
  populateMonacoRoot(resolve(rendererOutDir, 'monaco'))
}

/**
 * Fill `monacoDest` with the tree `monaco/setup.ts` expects to find under its
 * root: `vs/`, `external/`, the worker aliases, and the ESM worker host.
 *
 * Split out from {@link copyMonacoWorkers} so the demo-preview workflow can
 * publish one shared copy (`vendor/monaco/<version>/`) for every PR preview to
 * point at, instead of committing 34MB per preview per push into the
 * `demo-previews` branch.
 */
export function populateMonacoRoot(monacoDest: string): void {
  const vsDest = resolve(monacoDest, 'vs')
  cpSync(resolve('node_modules/monaco-editor/esm/vs'), vsDest, { recursive: true })
  // Language workers import from `../../../external/...` (sibling of `vs/`, not inside it).
  cpSync(resolve('node_modules/monaco-editor/esm/external'), resolve(monacoDest, 'external'), {
    recursive: true,
  })

  for (const [destRel, srcRel] of WORKER_ALIASES) {
    const src = resolve(vsDest, srcRel)
    const dest = resolve(vsDest, destRel)
    if (!existsSync(src)) {
      throw new Error(`Missing Monaco ESM worker source: ${srcRel}`)
    }
    if (existsSync(dest)) continue
    copyFileSync(src, dest)
  }

  copyFileSync(ESM_WORKER_HOST_SRC, resolve(monacoDest, 'esm-worker-host.js'))
}

/**
 * How `src/renderer/index.html` spells the Monaco root it expects beside itself.
 * `monaco/setup.ts` resolves its own URLs from the injected base, but the
 * diff editor's stylesheet is a plain `<link>` in the template — nothing reads
 * the global on its behalf, so pointing the build at a shared tree without
 * rewriting the markup leaves that one request aimed at a directory the demo
 * build no longer emits (the first published preview 404'd on exactly that).
 */
const LOCAL_MONACO_PREFIX = './monaco/'

/**
 * Point a built `index.html` at a Monaco tree served from `baseUrl` instead of
 * the `monaco/` directory beside it: rewrite the static asset references, then
 * declare the base for the lazy loader in `monaco/setup.ts`.
 *
 * Throws when the markup has no local reference left to rewrite — that means
 * the template moved and this function is now silently doing nothing, which is
 * the failure it exists to prevent.
 */
export function pointHtmlAtMonacoBase(html: string, baseUrl: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  if (!html.includes(LOCAL_MONACO_PREFIX)) {
    throw new Error(
      `index.html has no ${LOCAL_MONACO_PREFIX} reference to repoint at ${base} — ` +
        'if the template dropped it, drop this rewrite too',
    )
  }
  if (!html.includes('</head>')) {
    throw new Error('index.html has no </head> to inject the Monaco base into')
  }
  const repointed = html.replaceAll(LOCAL_MONACO_PREFIX, base)
  // A meta, not an inline script: the page ships `script-src 'self'` with no
  // `unsafe-inline`, so a `<script>window.…=…</script>` is refused outright and
  // the base silently never arrives. Escape the quotes rather than trusting the
  // URL — this is markup, and JSON.stringify does not produce HTML.
  const content = base.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  const inject = `<meta name="copse-monaco-base" content="${content}" />`
  return repointed.replace('</head>', `  ${inject}\n  </head>`)
}

// `node scripts/copy-monaco-workers.mts <dir>` populates <dir> as a Monaco root.
// Used by the demo-preview workflow to publish the shared vendor copy.
if (process.argv[1]?.endsWith('copy-monaco-workers.mts') && process.argv[2] !== undefined) {
  populateMonacoRoot(resolve(process.argv[2]))
  console.log(`[monaco] populated ${process.argv[2]}`)
}
