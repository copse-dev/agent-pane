import type * as Monaco from 'monaco-editor'

declare global {
  // Monaco's ESM worker loader joins `vs/...` module ids against this root.
  var _VSCODE_FILE_ROOT: string | undefined
}

function monacoVsRoot(): string {
  return new URL('./monaco/', window.location.href).href
}

function configureMonacoFileRoot(): void {
  globalThis._VSCODE_FILE_ROOT = monacoVsRoot()
}

function workerPathForLabel(label: string): string {
  switch (label) {
    case 'typescript':
    case 'javascript':
      return './monaco/vs/language/typescript/ts.worker.js'
    case 'json':
      return './monaco/vs/language/json/json.worker.js'
    case 'css':
    case 'scss':
    case 'less':
      return './monaco/vs/language/css/css.worker.js'
    case 'html':
    case 'handlebars':
    case 'razor':
      return './monaco/vs/language/html/html.worker.js'
    default:
      return './monaco/vs/editor/editor.worker.js'
  }
}

function workerEntryRelativeToMonacoRoot(label: string): string {
  return workerPathForLabel(label).replace(/^\.\/monaco\//, '')
}

function createMonacoWorker(label: string): Promise<Worker> {
  const cached = workerPromises.get(label)
  if (cached) return cached

  const promise = createMonacoWorkerOnce(label).catch((err) => {
    workerPromises.delete(label)
    throw err
  })
  workerPromises.set(label, promise)
  return promise
}

const workerPromises = new Map<string, Promise<Worker>>()

function createMonacoWorkerOnce(label: string): Promise<Worker> {
  const hostUrl = new URL('./monaco/esm-worker-host.js', window.location.href)
  hostUrl.searchParams.set('entry', workerEntryRelativeToMonacoRoot(label))
  const worker = new Worker(hostUrl, { name: label, type: 'module' })
  return new Promise((resolve, reject) => {
    worker.onmessage = (event) => {
      const data = event.data as { type?: string } | null
      if (data?.type !== 'copse-monaco-worker-ready') return
      worker.onmessage = null
      // Drop the bootstrap error handler once ready so a runtime worker error
      // later in its lifetime can't reject this already-settled promise.
      worker.onerror = null
      resolve(worker)
    }
    // `onerror` fires with an ErrorEvent if the worker bootstrap import fails.
    // Reject with a real Error carrying its message so callers (and the global
    // unhandledrejection toast) get something readable, not "[object ErrorEvent]".
    worker.onerror = (event) => {
      const detail = event instanceof ErrorEvent ? event.message : String(event)
      reject(new Error(`Monaco ${label} worker failed to load: ${detail || 'unknown error'}`))
    }
  })
}

let bundlePromise: Promise<typeof Monaco> | undefined

// Inject the standalone monaco-bundle.js (built from monaco/monaco-global.ts) and
// resolve once it has exposed the editor namespace on window. Kept out of the
// initial app.js so startup doesn't pay for the editor until a diff/file opens.
// CSP allows this: the bundle is same-origin (`script-src 'self'`).
// esbuild splits Monaco's statically-imported CSS into a sibling monaco-bundle.css
// (it used to ride along in app.css). Pull it in alongside the script so the
// editor isn't unstyled. Idempotent — only injected once.
function ensureMonacoStylesheet(): void {
  const href = new URL('./monaco-bundle.css', window.location.href).href
  if (document.querySelector(`link[rel="stylesheet"][href="${href}"]`)) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = href
  document.head.append(link)
}

function loadMonacoBundle(): Promise<typeof Monaco> {
  if (window.__copseMonaco) return Promise.resolve(window.__copseMonaco)
  if (bundlePromise) return bundlePromise
  ensureMonacoStylesheet()
  bundlePromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = new URL('./monaco-bundle.js', window.location.href).href
    script.onload = () => {
      const loaded = window.__copseMonaco
      if (loaded) resolve(loaded)
      else reject(new Error('monaco-bundle.js loaded but did not expose the editor namespace'))
    }
    script.onerror = () => {
      // Allow a later call to retry the injection rather than wedging on a
      // failed network fetch.
      bundlePromise = undefined
      script.remove()
      reject(new Error('Failed to load monaco-bundle.js'))
    }
    document.head.append(script)
  })
  return bundlePromise
}

let monacoPromise: Promise<typeof Monaco> | undefined

// Lazily load Monaco and wire its worker environment. Memoised so the bundle is
// injected and configured exactly once however many panes ask for it.
export function loadMonaco(): Promise<typeof Monaco> {
  if (monacoPromise) return monacoPromise
  monacoPromise = loadMonacoBundle().then((monaco) => {
    configureMonacoFileRoot()
    // Monaco calls getWorker for language services too; each label needs its own
    // ESM worker or requests such as TypeScript diagnostics hit the editor worker.
    window.MonacoEnvironment = {
      getWorker(_workerId: string, label: string) {
        return createMonacoWorker(label)
      },
    }
    // Diff computation uses the generic editor worker; warm it during init so the
    // first staged-diff accept doesn't race an in-flight worker bootstrap.
    void createMonacoWorker('editor').catch(() => undefined)
    return monaco
  })
  return monacoPromise
}
