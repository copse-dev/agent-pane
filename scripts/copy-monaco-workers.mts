import { cpSync, copyFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

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
  const vsDest = resolve(rendererOutDir, 'monaco/vs')
  cpSync(resolve('node_modules/monaco-editor/esm/vs'), vsDest, { recursive: true })

  for (const [destRel, srcRel] of WORKER_ALIASES) {
    const src = resolve(vsDest, srcRel)
    const dest = resolve(vsDest, destRel)
    if (!existsSync(src)) {
      throw new Error(`Missing Monaco ESM worker source: ${srcRel}`)
    }
    if (existsSync(dest)) continue
    copyFileSync(src, dest)
  }
}
