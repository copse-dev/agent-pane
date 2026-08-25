/**
 * Decide which engine a servo-mode build resolves against, and wire it up.
 *
 * The default needs no setup at all: `tauri-shell/Cargo.toml` pins the
 * `tauri-runtime-patches` branches of the org's engine forks by rev, so a
 * fresh clone builds the patched engine with nothing checked out locally.
 *
 * The exception is engine work. Put a checkout beside the repos — `../servo`,
 * `../stylo`, siblings of agent-pane the way `../tauri-runtime-servo` already
 * is — and this writes `tauri-shell/.cargo/config.toml` redirecting those
 * crates at it. A `[patch]` in a cargo config takes precedence over the one in
 * the manifest, per crate, so the checkout wins for whatever it provides and
 * the pins keep covering the rest. Remove the checkout and the next build
 * deletes the file, which matters: a config left pointing at a directory that
 * no longer exists fails the build with cargo's error, not ours.
 *
 * Nothing here clones or patches anything. The whole point of the fork
 * branches is that cargo fetches them itself.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Where each engine crate's manifest sits inside its repository. */
const SERVO_CRATES: Record<string, string> = {
  servo: 'components/servo',
}
const STYLO_CRATES: Record<string, string> = {
  selectors: 'selectors',
  servo_arc: 'servo_arc',
  stylo: 'style',
  stylo_atoms: 'stylo_atoms',
  stylo_dom: 'stylo_dom',
  stylo_malloc_size_of: 'malloc_size_of',
  stylo_static_prefs: 'stylo_static_prefs',
  stylo_traits: 'style_traits',
}

export type EngineMode = 'artifacts-only' | 'checkout' | 'pinned'

const CONFIG_DIR = 'tauri-shell/.cargo'
const CONFIG_PATH = `${CONFIG_DIR}/config.toml`

/**
 * `true` when the caller only wants the JavaScript artifacts. CI sets this:
 * the servo-mode workflow builds the sidecar bundle to catch it rotting and
 * never goes near cargo, so resolving an engine there would be waste.
 */
export function artifactsOnly(): boolean {
  return process.env['COPSE_SERVO_ARTIFACTS_ONLY'] === '1'
}

export function prepareServoEngine(): { mode: EngineMode; detail: string } {
  if (artifactsOnly()) {
    return {
      mode: 'artifacts-only',
      detail: 'COPSE_SERVO_ARTIFACTS_ONLY=1 — engine untouched',
    }
  }

  // Siblings of the repository, which is what the manifest's own
  // `../../tauri-runtime-servo` path dependency already means.
  const overrides: string[] = []
  const found: string[] = []
  for (const [checkout, crates] of [
    ['servo', SERVO_CRATES],
    ['stylo', STYLO_CRATES],
  ] as const) {
    if (!existsSync(resolve(`../${checkout}`))) continue
    found.push(`../${checkout}`)
    for (const [crate, dir] of Object.entries(crates)) {
      overrides.push(`${crate} = { path = "../../${checkout}/${dir}" }`)
    }
  }

  if (overrides.length === 0) {
    // Leave nothing behind pointing at a checkout that has gone away.
    if (existsSync(CONFIG_PATH)) {
      rmSync(CONFIG_PATH)
      return {
        mode: 'pinned',
        detail: `no sibling checkout — removed ${CONFIG_PATH}`,
      }
    }
    return {
      mode: 'pinned',
      detail: 'no sibling checkout — using the forks pinned in Cargo.toml',
    }
  }

  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    [
      '# Written by scripts/servo-engine.mts on every `pnpm build:servo`. Not',
      '# committed: it exists only because this machine has an engine checkout',
      '# beside the repository. These entries take precedence over the',
      '# `[patch.crates-io]` pins in tauri-shell/Cargo.toml, per crate; delete',
      '# the checkout and the next build:servo removes this file.',
      '[patch.crates-io]',
      ...overrides,
      '',
    ].join('\n'),
  )
  return {
    mode: 'checkout',
    detail: `${found.join(' and ')} — wrote ${CONFIG_PATH}`,
  }
}
