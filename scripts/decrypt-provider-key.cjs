// Decrypt a stored provider API key out of a Copse profile, for tooling that
// needs to hand the key to a process that cannot read it itself.
//
// Why this exists: keys are encrypted with Electron's `safeStorage`, which on
// macOS binds the ciphertext to a Keychain item derived from the *app name* —
// so only Electron, presenting itself as "Copse", can decrypt them. The Tauri
// sidecar stubs `safeStorage` out entirely (`decryptString` throws), so the
// Servo stack cannot read a stored key at all. The perf harness therefore
// decrypts once here and passes the value to both stacks in the environment,
// where `resolveApiKey`'s env fallback picks it up identically.
//
//   electron scripts/decrypt-provider-key.cjs <provider> <settings.json>
//
// Writes the key to stdout and nothing else. Refuses to run when stdout is a
// terminal, so a stray invocation cannot print a secret into a scrollback
// buffer or a captured session log.
const { app, safeStorage } = require('electron')
const { readFileSync } = require('node:fs')

// Must match src/main/app-init.ts, or safeStorage looks up the wrong Keychain
// item and the decrypt fails with a misleading "unavailable".
app.setName('Copse')

const provider = process.argv[2] ?? 'openrouter'
const settingsPath = process.argv[3]

function fail(message, code) {
  console.error(`[decrypt-provider-key] ${message}`)
  app.exit(code)
}

app.whenReady().then(() => {
  app.dock?.hide()
  if (process.stdout.isTTY) {
    return fail('refusing to write a secret to a terminal — redirect stdout', 2)
  }
  if (typeof settingsPath !== 'string') {
    return fail('usage: decrypt-provider-key.cjs <provider> <settings.json>', 2)
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return fail('safeStorage reports no OS keyring on this machine', 3)
  }
  let record
  try {
    record = JSON.parse(readFileSync(settingsPath, 'utf8'))?.apiKey?.[provider]
  } catch (error) {
    return fail(`cannot read ${settingsPath}: ${String(error)}`, 4)
  }
  if (!record || typeof record.enc !== 'string' || !record.enc) {
    return fail(`no stored ${provider} key in ${settingsPath}`, 5)
  }
  try {
    const buf = Buffer.from(record.enc, 'base64')
    process.stdout.write(
      record.plain === true ? buf.toString('utf8') : safeStorage.decryptString(buf),
    )
  } catch (error) {
    return fail(
      `decrypt failed (wrong Keychain identity, or key from another machine): ${String(error)}`,
      6,
    )
  }
  app.exit(0)
})
