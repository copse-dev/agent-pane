// Print a macOS seatbelt profile for host training: the profile Copse's sandbox runtime (ASRT)
// builds for a contained command, plus the Apple GPU access Metal compute needs.
//
//   node benchmarks/risk-classifier/sandbox-profile.mjs --deny-read <dir> --allow-read <dir>... \
//     --allow-write <dir>
//
// ASRT denies every IOKit user client but IOSurface and has no option to allow the GPU, so MPS
// and MLX see no Metal device inside it. The rules appended here open only the GPU's own user
// clients and Metal's compiler service; network, file and process rules are ASRT's unchanged.
// ASRT exposes the profile only through wrapCommandWithSandboxMacOS, so this reads it back out of
// the wrapped `sandbox-exec -p '…'` command.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const runtime = dirname(
  createRequire(join(repository, 'package.json')).resolve(
    '@anthropic-ai/sandbox-runtime/package.json',
  ),
)
const { wrapCommandWithSandboxMacOS } = await import(
  pathToFileURL(join(runtime, 'dist', 'sandbox', 'macos-sandbox-utils.js')).href
)

export const GPU_RULES = `
; Apple GPU for Metal compute (MPS, MLX): the GPU's user clients and Metal's shader compiler.
(allow iokit-open
  (iokit-user-client-class "AGXDeviceUserClient")
  (iokit-user-client-class "IOGPUDeviceUserClient")
  (iokit-connection "IOGPU")
  (iokit-registry-entry-class "AGXAccelerator")
  (iokit-registry-entry-class "IOAccelerator"))
; Metal's compiler service inherits this profile and compiles shaders through kernel MIG calls.
(allow syscall-mig)
(allow mach-lookup
  (global-name "com.apple.MTLCompilerService")
  (global-name "com.apple.gpumemd.source")
  (global-name "com.apple.PowerManagement.control"))
`

function option(argv, name) {
  const values = []
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === name) values.push(argv[i + 1])
  return values
}

export function gpuProfile({ denyRead, allowRead, allowWrite }) {
  const wrapped = wrapCommandWithSandboxMacOS({
    command: 'true',
    needsNetworkRestriction: true, // no proxy ports: every outbound connection is denied
    readConfig: { denyOnly: denyRead, allowWithinDeny: allowRead },
    writeConfig: { allowOnly: allowWrite, denyWithinAllow: [] },
  })
  const start = wrapped.indexOf("-p '")
  const end = wrapped.lastIndexOf("' /bin/")
  if (start === -1 || end <= start) throw new Error('ASRT no longer wraps with sandbox-exec -p')
  const profile = wrapped.slice(start + 4, end)
  if (profile.includes("'\\''"))
    throw new Error('profile contains an escaped quote; extract it properly')
  return profile + GPU_RULES
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2)
  process.stdout.write(
    gpuProfile({
      denyRead: option(argv, '--deny-read'),
      allowRead: option(argv, '--allow-read'),
      allowWrite: option(argv, '--allow-write'),
    }),
  )
}
