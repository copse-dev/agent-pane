import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { access, open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse } from 'shell-quote'
import { scanShellComposition } from './command-routing.ts'

const SCRIPT_SUFFIXES: ReadonlyMap<string, RegExp> = new Map([
  ['node', /\.(?:[cm]?js|[cm]?ts)$/],
  ['python', /\.py$/],
  ['python3', /\.py$/],
  ['ruby', /\.rb$/],
  ['sh', /\.sh$/],
  ['bash', /\.(?:sh|bash)$/],
  ['zsh', /\.(?:sh|zsh)$/],
])

const MAX_SCRIPT_BYTES = 8 * 1024 * 1024
const MAX_INTERPRETER_BYTES = 512 * 1024 * 1024

async function readExecutableHeader(file: FileHandle, offset: number): Promise<Buffer | null> {
  const header = Buffer.alloc(64)
  const { bytesRead } = await file.read(header, 0, header.length, offset)
  return bytesRead === header.length ? header : null
}

function machExecutableHeader(header: Buffer, size: number): boolean {
  const cpu = process.arch === 'arm64' ? 0x0100000c : process.arch === 'x64' ? 0x01000007 : null
  const commands = header.readUInt32LE(16)
  const commandBytes = header.readUInt32LE(20)
  return (
    cpu !== null &&
    header.readUInt32LE(0) === 0xfeedfacf &&
    header.readUInt32LE(4) === cpu &&
    header.readUInt32LE(12) === 2 && // MH_EXECUTE
    header.readUInt32LE(28) === 0 &&
    commands > 0 &&
    commands <= 1024 &&
    commandBytes >= commands * 8 &&
    commandBytes <= size - 32
  )
}

/** Conservative format admission, not interpreter attestation. Unsupported headers fall back. */
async function nativeInterpreterHeader(file: FileHandle, size: number): Promise<boolean> {
  const header = await readExecutableHeader(file, 0)
  if (!header) return false
  if (process.platform === 'linux') {
    const machine = process.arch === 'arm64' ? 183 : process.arch === 'x64' ? 62 : null
    const type = header.readUInt16LE(16)
    const programOffset = header.readBigUInt64LE(32)
    const programs = header.readUInt16LE(56)
    return (
      machine !== null &&
      header.readUInt32BE(0) === 0x7f454c46 &&
      header[4] === 2 && // ELF64
      header[5] === 1 && // little endian
      header[6] === 1 &&
      header.subarray(9, 16).every((byte) => byte === 0) &&
      (type === 2 || type === 3) && // ET_EXEC or ET_DYN
      header.readUInt16LE(18) === machine &&
      header.readUInt32LE(20) === 1 &&
      header.readUInt16LE(52) === 64 &&
      header.readUInt16LE(54) === 56 &&
      programs > 0 &&
      programs <= 1024 &&
      programOffset >= 64n &&
      programOffset + BigInt(programs * 56) <= BigInt(size)
    )
  }
  if (process.platform !== 'darwin') return false
  if (machExecutableHeader(header, size)) return true
  // Common universal Mach-O: inspect the host architecture's bounded slice.
  if (header.readUInt32BE(0) !== 0xcafebabe) return false
  const architectures = header.readUInt32BE(4)
  if (architectures < 1 || architectures > 8) return false
  const table = Buffer.alloc(8 + architectures * 20)
  if ((await file.read(table, 0, table.length, 0)).bytesRead !== table.length) return false
  let supportedSlice = false
  for (let index = 0; index < architectures; index++) {
    const entry = 8 + index * 20
    const offset = table.readUInt32BE(entry + 8)
    const length = table.readUInt32BE(entry + 12)
    const alignment = table.readUInt32BE(entry + 16)
    if (
      offset < table.length ||
      length < 64 ||
      offset + length > size ||
      alignment > 30 ||
      offset % 2 ** alignment !== 0
    ) {
      return false
    }
    const slice = await readExecutableHeader(file, offset)
    if (
      slice &&
      slice.readUInt32LE(4) === table.readUInt32BE(entry) &&
      machExecutableHeader(slice, length)
    ) {
      supportedSlice = true
    }
  }
  return supportedSlice
}

function sameFileVersion(a: BigIntStats, b: BigIntStats): boolean {
  return (
    b.isFile() &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  )
}

/** Bounded asynchronous reads: script/interpreter files must not block Electron's main thread. */
async function fileIdentity(
  source: string,
  expectedPath: string,
  maxBytes: number,
  kind: 'native-interpreter' | 'script',
): Promise<string | null> {
  const path = await realpath(source)
  if (path !== expectedPath) return null
  // Check before open as well: a FIFO must never make an approval wait for a writer.
  const initial = await stat(path, { bigint: true })
  if (!initial.isFile() || initial.size > BigInt(maxBytes)) return null
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat({ bigint: true })
    if (!sameFileVersion(initial, before)) return null
    if (kind === 'native-interpreter') {
      // A stable text shim can dispatch a different binary through mutable
      // version-manager configuration. Keep it on the exact-command path.
      if (!(await nativeInterpreterHeader(file, Number(before.size)))) return null
    }
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      if (!Buffer.isBuffer(chunk)) return null
      bytes += chunk.length
      if (bytes > maxBytes) return null
      hash.update(chunk)
    }
    if (
      BigInt(bytes) !== before.size ||
      !sameFileVersion(before, await file.stat({ bigint: true })) ||
      (await realpath(source)) !== path ||
      !sameFileVersion(before, await stat(path, { bigint: true }))
    ) {
      return null
    }
    return JSON.stringify({
      path,
      device: String(before.dev),
      inode: String(before.ino),
      mode: String(before.mode),
      size: String(before.size),
      modified: String(before.mtimeNs),
      changed: String(before.ctimeNs),
      sha256: hash.digest('hex'),
    })
  } finally {
    await file.close()
  }
}

/** The unsandboxed POSIX spawn uses /bin/sh -c with the inherited PATH, not a login shell. */
async function interpreterPath(
  interpreter: string,
  directory: string,
  searchPath: string | undefined,
): Promise<string | null> {
  if (interpreter.includes('/')) {
    const path = resolve(directory, interpreter)
    await access(path, constants.X_OK)
    return path
  }
  if (searchPath === undefined || process.env[`BASH_FUNC_${interpreter}%%`] !== undefined)
    return null
  for (const entry of searchPath.split(delimiter)) {
    const path = join(resolve(directory, entry), interpreter)
    try {
      if (!(await stat(path)).isFile()) continue
      await access(path, constants.X_OK)
      return path
    } catch {
      // A missing or non-executable PATH candidate does not win shell lookup.
    }
  }
  return null
}

/**
 * Literal argv only: shell evaluation must never become part of an argument grant.
 * Single-quoted source code is data, including its parentheses and dollar signs.
 */
function literalArgv(command: string): string[] | null {
  let quote: "'" | '"' | null = null
  for (let index = 0; index < command.length; index++) {
    const char = command.charAt(index)
    if (quote === "'") {
      if (char === "'") quote = null
      continue
    }
    if (char === '\\') {
      // Line continuation and trailing escapes are deliberately unsupported.
      if (!command.charAt(index + 1) || command.charAt(index + 1) === '\n') return null
      index++
      continue
    }
    if (char === quote) {
      quote = null
      continue
    }
    if (char === '"' || (quote === null && char === "'")) {
      quote = char
      continue
    }
    if (char === '$' || char === '`') return null
    if (quote === null && /[(){}~*?[\]<>#]/.test(char)) return null
  }
  if (quote !== null) return null
  try {
    const tokens = parse(command)
    return tokens.every((token) => typeof token === 'string') ? tokens : null
  } catch {
    return null
  }
}

/**
 * Scope for explicitly approved argument changes to one existing local script.
 * Interpreter options/wrappers are unsupported and retain exact-command grants.
 * An optional literal cd is fixed as part of the grant; no other shell structure
 * is accepted. Resolve and fingerprint both files at issuance and every replay,
 * keeping the script local. This is a check-time identity, not atomic execution:
 * imports, interpreter configuration and changes after this check remain outside
 * the grant's identity contract.
 */
export async function scriptReplayScope(
  command: string,
  executionRoot: string,
): Promise<string | null> {
  // The Windows spawn uses cmd.exe, whose executable resolution is a different contract.
  if (process.platform === 'win32') return null
  const composition = scanShellComposition(command)
  if (!composition) return null
  let cwd = executionRoot
  let prefix = ''
  const cdPath = process.env['CDPATH']
  let consultsCdPath = false
  let segment = composition.segments[0]
  if (composition.segments.length === 2 && composition.operators[0] === '&&') {
    prefix = composition.segments[0] ?? ''
    const cd = literalArgv(prefix)
    if (cd?.length !== 2 || cd[0] !== 'cd' || !cd[1] || cd[1].startsWith('-')) return null
    consultsCdPath = !isAbsolute(cd[1]) && !/^(?:\.{1,2})(?:\/|$)/.test(cd[1])
    if (consultsCdPath && cdPath) return null
    cwd = resolve(executionRoot, cd[1])
    segment = composition.segments[1]
  } else if (composition.segments.length !== 1 || composition.operators.length !== 0) {
    return null
  }
  if (!segment) return null
  const argv = literalArgv(segment)
  const interpreter = argv?.[0]
  const script = argv?.[1]
  if (!interpreter || !script || script.startsWith('-')) return null
  const suffix = SCRIPT_SUFFIXES.get(basename(interpreter))
  if (!suffix?.test(script)) return null
  try {
    const root = await realpath(executionRoot)
    const directory = await realpath(cwd)
    const source = resolve(directory, script)
    const path = await realpath(source)
    for (const target of [directory, path]) {
      const local = relative(root, target)
      if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return null
    }
    const searchPath = process.env['PATH']
    const executable = await interpreterPath(interpreter, directory, searchPath)
    if (!executable) return null
    const interpreterIdentity = await fileIdentity(
      executable,
      await realpath(executable),
      MAX_INTERPRETER_BYTES,
      'native-interpreter',
    )
    if (!interpreterIdentity) return null
    const scriptIdentity = await fileIdentity(source, path, MAX_SCRIPT_BYTES, 'script')
    if (
      !interpreterIdentity ||
      !scriptIdentity ||
      (await realpath(executionRoot)) !== root ||
      (await realpath(cwd)) !== directory ||
      (consultsCdPath && process.env['CDPATH'] !== cdPath) ||
      (!interpreter.includes('/') && process.env['PATH'] !== searchPath)
    ) {
      return null
    }
    return JSON.stringify({
      prefix,
      interpreter,
      directory,
      interpreterIdentity,
      scriptIdentity,
      searchPath: interpreter.includes('/') ? null : searchPath,
    })
  } catch {
    return null
  }
}
