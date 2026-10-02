import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** Unpacked dependency directories that only Windows or Linux can load. */
export const FOREIGN_PAYLOADS = [
  ['node-pty', 'deps', 'winpty'],
  ['node-pty', 'third_party', 'conpty'],
  ['@anthropic-ai', 'sandbox-runtime', 'vendor', 'seccomp'],
  ['@anthropic-ai', 'sandbox-runtime', 'vendor', 'srt-win'],
] as const

/**
 * node-pty and the sandbox runtime publish Windows and Linux native payloads
 * beside their macOS ones, and asarUnpack copies all of them into the app.
 * Remove what macOS can never load, keeping every darwin node-pty prebuild,
 * and fail closed if the target architecture's prebuild is missing.
 */
export function pruneForeignMacosPayloads(nodeModules: string, arch: 'arm64' | 'x64'): void {
  const prebuilds = join(nodeModules, 'node-pty', 'prebuilds')
  if (!existsSync(join(prebuilds, `darwin-${arch}`, 'pty.node'))) {
    throw new Error(`Packaged ${arch} app lacks its node-pty prebuild`)
  }
  for (const entry of readdirSync(prebuilds)) {
    if (!entry.startsWith('darwin-')) {
      rmSync(join(prebuilds, entry), { recursive: true, force: true })
    }
  }
  for (const path of FOREIGN_PAYLOADS) {
    rmSync(join(nodeModules, ...path), { recursive: true, force: true })
  }
}
