import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'

const LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  rb: 'ruby',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  swift: 'swift',
  kt: 'kotlin',
  md: 'markdown',
  mdx: 'markdown',
  json: 'json',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  toml: 'ini',
  xml: 'xml',
  sql: 'sql',
  graphql: 'graphql',
}

export function detectLanguage(filePath: string): string {
  const lower = filePath.split('/').pop()?.toLowerCase() ?? ''
  if (lower === 'dockerfile') return 'dockerfile'
  if (lower === 'makefile') return 'makefile'
  return LANG[lower.split('.').pop() ?? ''] ?? 'plaintext'
}

export async function openWorkspaceFile(
  store: AppStore,
  api: ApiClient,
  path: string,
): Promise<void> {
  const content = await api.fs.readFile(path)
  store.setState({
    openFile: { path, content, language: detectLanguage(path) },
    panelTab: 'file',
    rightPanelMode: 'explorer',
    filesPaneOpen: true,
  })
  store.emit('panel_changed')
  store.emit('right_panel_mode_changed')
  store.emit('files_pane_changed')
}
