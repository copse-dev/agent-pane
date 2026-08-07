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

// `node scripts/copy-monaco-workers.mts <dir>` populates <dir> as a Monaco root.
// Used by the demo-preview workflow to publish the shared vendor copy.
if (process.argv[1]?.endsWith('copy-monaco-workers.mts') && process.argv[2] !== undefined) {
  populateMonacoRoot(resolve(process.argv[2]))
  console.log(`[monaco] populated ${process.argv[2]}`)
}
