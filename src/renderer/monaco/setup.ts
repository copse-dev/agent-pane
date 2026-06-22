import * as monaco from 'monaco-editor'

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

function createMonacoWorker(label: string): Promise<Worker> {
  const workerUrl = new URL(workerPathForLabel(label), window.location.href).href
  const root = globalThis._VSCODE_FILE_ROOT!
  const bootstrap = [
    `globalThis._VSCODE_FILE_ROOT = ${JSON.stringify(root)};`,
    `await import(${JSON.stringify(workerUrl)});`,
    `globalThis.postMessage({ type: 'copse-monaco-worker-ready' });`,
  ].join('')
  const blobUrl = URL.createObjectURL(new Blob([bootstrap], { type: 'application/javascript' }))
  const worker = new Worker(blobUrl, { name: label, type: 'module' })
  return new Promise((resolve, reject) => {
    worker.onmessage = (event) => {
      if (event.data?.type !== 'copse-monaco-worker-ready') return
      worker.onmessage = null
      resolve(worker)
    }
    worker.onerror = reject
  })
}

export function initMonaco(): typeof monaco {
  configureMonacoFileRoot()
  // Monaco calls getWorker for language services too; each label needs its own
  // ESM worker or requests such as TypeScript diagnostics hit the editor worker.
  window.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      return createMonacoWorker(label)
    },
  }
  return monaco
}
