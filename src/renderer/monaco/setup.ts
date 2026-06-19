import * as monaco from 'monaco-editor'

export function initMonaco(): typeof monaco {
  // Point Monaco workers at the copied vs/ directory
  window.MonacoEnvironment = {
    getWorkerUrl(_moduleId: string, label: string) {
      if (label === 'json') return './monaco/vs/language/json/json.worker.js'
      if (label === 'css' || label === 'scss' || label === 'less')
        return './monaco/vs/language/css/css.worker.js'
      if (label === 'html') return './monaco/vs/language/html/html.worker.js'
      if (label === 'typescript' || label === 'javascript')
        return './monaco/vs/language/typescript/ts.worker.js'
      return './monaco/vs/editor/editor.worker.js'
    },
  }
  return monaco
}
