import {
  getIconUrlByName,
  getIconUrlForFilePath,
  type MaterialIcon,
} from 'vscode-material-icons'
import { el } from '../dom/helpers.ts'

/** Copied to `dist/renderer/material-icons` by build/dev scripts. */
export const MATERIAL_ICONS_BASE = './material-icons'

export function materialFileIconUrl(relativePath: string): string {
  return getIconUrlForFilePath(relativePath, MATERIAL_ICONS_BASE)
}

export function materialFolderIconUrl(_relativePath: string, expanded: boolean): string {
  const name = expanded ? 'folder-open' : 'folder'
  return getIconUrlByName(name, MATERIAL_ICONS_BASE)
}

export function materialIconUrl(name: MaterialIcon): string {
  return getIconUrlByName(name, MATERIAL_ICONS_BASE)
}

export function mountMaterialIcon(host: HTMLElement, url: string, label: string): void {
  host.replaceChildren(
    el('img', {
      class: 'tree-icon-img',
      src: url,
      alt: label,
      width: '16',
      height: '16',
      decoding: 'async',
    }),
  )
}
