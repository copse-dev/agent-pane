// Orchestrator-side file access never follows a checkout-controlled symlink.
// Resolve the trusted checkout root first (including macOS's /var alias),
// then inspect every component below it. Keep validation and opening in one
// synchronous operation and use O_NOFOLLOW for the final file as well.
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Resolve an existing path, rejecting traversal and symlinks below the checkout. */
export function jailPath(root: string, path: string): string {
  const absRoot = realpathSync(root)
  const target = resolve(absRoot, path || '.')
  const rel = relative(absRoot, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path is outside the change under review: ${path}`)
  }
  let current = absRoot
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part)
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`Symlink is not allowed in the change under review: ${path}`)
    }
  }
  return target
}

/**
 * Largest checkout file the orchestrator reads. Executed code can write the
 * checkout, and every reader keeps only a bounded slice, so a file this large
 * is refused before it is buffered rather than after.
 */
const MAX_CHECKOUT_FILE_BYTES = 8 * 1024 * 1024

export function readCheckoutFile(root: string, path: string): string {
  const file = jailPath(root, path)
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(fd)
    if (!info.isFile()) throw new Error(`Not a regular file: ${path}`)
    if (info.size > MAX_CHECKOUT_FILE_BYTES) {
      throw new Error(
        `File is too large to read (${String(info.size)} bytes, limit ${String(MAX_CHECKOUT_FILE_BYTES)}): ${path}`,
      )
    }
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

/** Create parents individually, checking each before descending into it. */
export function writeCheckoutFile(root: string, path: string, content: string): string {
  const absRoot = jailPath(root, '.')
  const rel = relative(absRoot, resolve(absRoot, path))
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path is outside the change under review: ${path}`)
  }
  let parent = absRoot
  for (const part of dirname(rel)
    .split(sep)
    .filter((part) => part !== '.')) {
    const next = join(parent, part)
    try {
      mkdirSync(next)
    } catch (err) {
      // An existing directory is fine; a symlink, file or other error is not.
      if (!lstatSync(next).isDirectory()) throw err
    }
    parent = jailPath(absRoot, relative(absRoot, next))
  }
  const file = join(parent, basename(rel))
  const fd = openSync(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  )
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.nlink !== 1) throw new Error(`Not a private regular file: ${path}`)
    ftruncateSync(fd, 0)
    writeFileSync(fd, content, 'utf8')
  } finally {
    closeSync(fd)
  }
  return file
}
