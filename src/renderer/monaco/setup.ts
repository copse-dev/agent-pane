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

function createMonacoWorker(label: string): Promise<Worker> {
  const editorWorker = new URL('./monaco/vs/editor/editor.worker.js', window.location.href).href
  const root = globalThis._VSCODE_FILE_ROOT!
  const bootstrap = [
    `globalThis._VSCODE_FILE_ROOT = ${JSON.stringify(root)};`,
    `await import(${JSON.stringify(editorWorker)});`,
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
  // createWebWorker hosts language services in editor.worker.js; foreign modules
  // are imported from the copied ESM `vs/` tree at runtime.
  window.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      return createMonacoWorker(label)
    },
  }
  return monaco
}
