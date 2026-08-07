import type * as Monaco from 'monaco-editor'

declare global {
  // Monaco's ESM worker loader joins `vs/...` module ids against this root.
  var _VSCODE_FILE_ROOT: string | undefined
}

declare global {
  /**
   * Where Monaco's `vs/` tree and worker host are served from, as a URL.
   *
   * Unset in the shipped app, which carries its own copy next to the bundle.
   * The demo build sets it so many PR previews can share one published copy
   * instead of each committing the 34MB ESM tree into the `demo-previews`
   * branch — see `.github/workflows/demo-preview.yml`.
   */
  var __COPSE_MONACO_BASE__: string | undefined
}

/**
 * Every Monaco asset path derives from here, so relocating the tree is a
 * one-line change rather than a hunt through hardcoded './monaco/' strings.
 * Always ends in a slash, so `new URL(relative, root)` resolves within it.
 */
function monacoVsRoot(): string {
  const configured = globalThis.__COPSE_MONACO_BASE__
  if (typeof configured === 'string' && configured.length > 0) {
    return new URL(configured.endsWith('/') ? configured : `${configured}/`, window.location.href)
      .href
  }
  return new URL('./monaco/', window.location.href).href
}

function configureMonacoFileRoot(): void {
  globalThis._VSCODE_FILE_ROOT = monacoVsRoot()
}

/** Worker entry, relative to {@link monacoVsRoot}. */
function workerEntryRelativeToMonacoRoot(label: string): string {
  switch (label) {
    case 'typescript':
    case 'javascript':
      return 'vs/language/typescript/ts.worker.js'
    case 'json':
      return 'vs/language/json/json.worker.js'
    case 'css':
    case 'scss':
    case 'less':
      return 'vs/language/css/css.worker.js'
    case 'html':
    case 'handlebars':
    case 'razor':
      return 'vs/language/html/html.worker.js'
    default:
      return 'vs/editor/editor.worker.js'
  }
}

function createMonacoWorker(label: string): Promise<Worker> {
  const cached = workerPromises.get(label)
  if (cached) return cached

  const promise = createMonacoWorkerOnce(label).catch((err: unknown) => {
    workerPromises.delete(label)
    throw err
  })
  workerPromises.set(label, promise)
  return promise
}

const workerPromises = new Map<string, Promise<Worker>>()

function createMonacoWorkerOnce(label: string): Promise<Worker> {
  // Resolved against the Monaco root, not the page: when the tree is shared
  // (demo previews), the host must load from beside the `vs/` it imports.
  const hostUrl = new URL('esm-worker-host.js', monacoVsRoot())
  hostUrl.searchParams.set('entry', workerEntryRelativeToMonacoRoot(label))
  const worker = new Worker(hostUrl, { name: label, type: 'module' })
  return new Promise((resolve, reject) => {
    worker.onmessage = (event): void => {
      const data: unknown = event.data
      if (typeof data !== 'object' || data === null || !('type' in data)) return
      if (data.type !== 'copse-monaco-worker-ready') return
      worker.onmessage = null
      // Drop the bootstrap error handler once ready so a runtime worker error
      // later in its lifetime can't reject this already-settled promise.
      worker.onerror = null
      resolve(worker)
    }
    // `onerror` fires with an ErrorEvent if the worker bootstrap import fails.
    // Reject with a real Error carrying its message so callers (and the global
    // unhandledrejection toast) get something readable, not "[object ErrorEvent]".
    worker.onerror = (event): void => {
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
    script.onload = (): void => {
      const loaded = window.__copseMonaco
      if (loaded) resolve(loaded)
      else reject(new Error('monaco-bundle.js loaded but did not expose the editor namespace'))
    }
    script.onerror = (): void => {
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

/**
 * Turn off the TypeScript/JavaScript language service's validation.
 *
 * Copse uses Monaco purely as a read-only diff/file viewer — it never offers
 * type-checking or IntelliSense. Left on, the TS worker builds a type-checking
 * program over every `.ts`/`.js` model, including the throwaway diff models the
 * Changes/PR panes create and dispose per file selection. When a semantic-
 * diagnostics pass lands on a model that the next selection already disposed,
 * the TS compiler throws its internal `Could not find source file: '<uri>'`,
 * which escapes as an unhandledrejection toast. Disabling both validations
 * stops the worker from ever computing diagnostics, removing the whole class.
 */
function configureMonacoLanguageDefaults(monaco: typeof Monaco): void {
  for (const defaults of [
    monaco.typescript.typescriptDefaults,
    monaco.typescript.javascriptDefaults,
  ]) {
    defaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
      noSuggestionDiagnostics: true,
    })
    defaults.setEagerModelSync(false)
  }
}

// Lazily load Monaco and wire its worker environment. Memoised so the bundle is
// injected and configured exactly once however many panes ask for it.
export function loadMonaco(): Promise<typeof Monaco> {
  if (monacoPromise) return monacoPromise
  monacoPromise = loadMonacoBundle().then(async (monaco) => {
    configureMonacoFileRoot()
    configureMonacoLanguageDefaults(monaco)
    // Monaco calls getWorker for language services too; each label needs its own
    // ESM worker or requests such as TypeScript diagnostics hit the editor worker.
    window.MonacoEnvironment = {
      getWorker(_workerId: string, label: string): Promise<Worker> {
        return createMonacoWorker(label)
      },
    }
    // Diff computation uses the generic editor worker. Await it before resolving
    // so panes that mount on `loadMonaco()` (Changes / PR) never setModel while
    // the worker is still bootstrapping — that race left reveals as no-ops.
    await ensureMonacoEditorWorker()
    return monaco
  })
  return monacoPromise
}

/**
 * Resolve once the generic editor worker is ready for diff computation.
 * Caps wait at 2s so a broken/unavailable Worker cannot stall Monaco load.
 */
export function ensureMonacoEditorWorker(): Promise<void> {
  if (typeof Worker === 'undefined') return Promise.resolve()
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    createMonacoWorker('editor').then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      timeoutId = setTimeout(() => {
        resolve()
      }, 2_000)
    }),
  ]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  })
}
