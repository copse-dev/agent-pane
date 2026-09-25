import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'

/**
 * The file readers the Guarded YOLO harm gate hands {@link ShellHarmContext}.
 * They live beside the gate's analysis so every caller — the permission gate and
 * the escalation-review benchmark — reads scripts with the same limits.
 */

const MAX_HARM_SCRIPT_BYTES = 256 * 1024
const HARM_SCRIPT_TEXT_SAMPLE_BYTES = 8192

/** Reject NULs and dense C0 controls so binary assets are never UTF-8-lexed as shell. */
function harmScriptBytesLookBinary(bytes: Buffer): boolean {
  if (bytes.includes(0)) return true
  const sampleLen = Math.min(bytes.length, HARM_SCRIPT_TEXT_SAMPLE_BYTES)
  if (sampleLen === 0) return false
  let controls = 0
  for (let i = 0; i < sampleLen; i++) {
    const byte = bytes[i]
    if (byte === undefined) continue
    if (byte === 9 || byte === 10 || byte === 13) continue
    if (byte < 32 || byte === 127) controls++
  }
  return controls / sampleLen > 0.1
}

/** A text script's contents, or null when missing, unreadable, too large, or binary. */
export function readScriptForHarm(path: string): string | null {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > MAX_HARM_SCRIPT_BYTES) return null
    const bytes = readFileSync(path)
    if (harmScriptBytesLookBinary(bytes)) return null
    return bytes.toString('utf8')
  } catch {
    return null
  }
}

/** Leading bytes of the executable formats a compiler or linker writes. */
const EXECUTABLE_MAGIC: readonly (readonly number[])[] = [
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64-bit
  [0xce, 0xfa, 0xed, 0xfe], // Mach-O 32-bit
  [0xfe, 0xed, 0xfa, 0xcf], // Mach-O 64-bit, big-endian
  [0xfe, 0xed, 0xfa, 0xce], // Mach-O 32-bit, big-endian
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O universal
  [0x4d, 0x5a], // PE (MZ)
]

/** Whether `path` is a regular file whose first bytes mark a compiled executable. */
export function isCompiledProgram(path: string): boolean {
  let fd: number | null = null
  try {
    if (!statSync(path).isFile()) return false
    fd = openSync(path, 'r')
    const head = Buffer.alloc(4)
    const read = readSync(fd, head, 0, head.length, 0)
    return EXECUTABLE_MAGIC.some(
      (magic) => read >= magic.length && magic.every((byte, i) => head[i] === byte),
    )
  } catch {
    return false
  } finally {
    if (fd !== null) closeSync(fd)
  }
}
