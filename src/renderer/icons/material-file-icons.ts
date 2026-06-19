import {
  getIconForDirectoryPath,
  getIconUrlByName,
  getIconUrlForFilePath,
  isMaterialIconName,
  type MaterialIcon,
} from 'vscode-material-icons'
import { el } from '../dom/helpers.ts'

/** Copied to `dist/renderer/material-icons` by build/dev scripts. */
export const MATERIAL_ICONS_BASE = './material-icons'

function openFolderIcon(closed: MaterialIcon): MaterialIcon {
  const open = `${closed}-open`
  if (isMaterialIconName(open)) return open
  if (closed === 'folder-root') return 'folder-root-open'
  return 'folder-open'
}

export function materialFileIconUrl(relativePath: string): string {
  return getIconUrlForFilePath(relativePath, MATERIAL_ICONS_BASE)
}

export function materialFolderIconUrl(relativePath: string, expanded: boolean): string {
  const closed = getIconForDirectoryPath(relativePath)
  const name = expanded ? openFolderIcon(closed) : closed
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
