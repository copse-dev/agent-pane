import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

if (process.platform !== 'darwin')
  throw new Error('The separate packaged worker runtime is for macOS.')
const root = resolve(import.meta.dirname, '..')
const version = readFileSync(join(root, '.nvmrc'), 'utf8').trim()
const archIndex = process.argv.indexOf('--arch')
const arches = archIndex < 0 ? ['arm64', 'x64'] : [process.argv[archIndex + 1]]
for (const arch of arches) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || (arch !== 'arm64' && arch !== 'x64'))
    throw new Error('Unsupported Node release or architecture.')
  const name = `node-v${version}-darwin-${arch}`
  const archive = `${name}.tar.gz`
  const base = `https://nodejs.org/dist/v${version}/`
  async function download(file: string): Promise<Buffer> {
    const response = await fetch(new URL(file, base), { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`Could not fetch Node release asset: ${file}`)
    return Buffer.from(await response.arrayBuffer())
  }
  const checksums = (await download('SHASUMS256.txt')).toString('utf8')
  const expected = checksums
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === archive)?.[0]
  if (!expected || !/^[a-f0-9]{64}$/.test(expected))
    throw new Error('Node release checksum is missing.')
  const bytes = await download(archive)
  if (createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error('Node release checksum does not match.')
  const staging = mkdtempSync(join(tmpdir(), 'copse-worker-node-'))
  try {
    const compressed = join(staging, archive)
    writeFileSync(compressed, bytes)
    execFileSync('/usr/bin/tar', [
      '-xzf',
      compressed,
      '-C',
      staging,
      `${name}/bin/node`,
      `${name}/LICENSE`,
    ])
    const output = join(root, 'native/node-runtime/dist', arch)
    mkdirSync(output, { recursive: true })
    copyFileSync(join(staging, name, 'bin/node'), join(output, 'node'))
    copyFileSync(join(staging, name, 'LICENSE'), join(output, 'LICENSE'))
    chmodSync(join(output, 'node'), 0o755)
    writeFileSync(
      join(output, 'build.json'),
      JSON.stringify({
        version,
        arch,
        binaryHash: createHash('sha256')
          .update(readFileSync(join(output, 'node')))
          .digest('hex'),
      }) + '\n',
    )
    console.log(
      `Prepared Node ${version} for darwin-${arch}; release packaging signs it separately.`,
    )
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
