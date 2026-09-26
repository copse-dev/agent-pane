/**
 * Write the licence files the packaged app ships, from the build's esbuild
 * metafiles plus the production dependency closure and the vendored components.
 * Called by build.mts once every shipped bundle has been emitted; fails the
 * build when a shipped component has no licence text or is GPL-family only.
 *
 * Output, in `dist/resources/licenses/` (unpacked from app.asar, so the files
 * are plain files inside Copse.app):
 * - `THIRD_PARTY_LICENSES.txt` — every component and its licence texts.
 * - `third-party-licenses.json` — the same, for Settings → About.
 * - `LICENSES.chromium.html` — Chromium's and Node's notices, from Electron.
 * - `LICENSE.txt` — Copse's own licence.
 */
import { copyFileSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'
import {
  THIRD_PARTY_LICENSE_JSON,
  THIRD_PARTY_LICENSE_TEXT,
  THIRD_PARTY_LICENSES_DIR,
  CHROMIUM_LICENSES_FILE,
  COPSE_LICENSE_FILE,
  type ThirdPartyLicenseReport,
} from '../src/shared/third-party-licenses.mts'
import {
  buildLicenseReport,
  bundledPackageDirs,
  collectPackages,
  findLicenseProblems,
  productionPackageDirs,
  renderLicenseReportText,
} from './lib/third-party-licenses.mts'
import {
  COPIED_PACKAGES,
  ELECTRON_NOTICES,
  applyLicenseOverrides,
  markPatchedPackages,
  vendoredComponents,
} from './third-party-vendored.mts'

interface MetafileLike {
  inputs: Record<string, unknown>
}

export function licenseReportPreamble(componentCount: number): string {
  return `Copse — third-party software licences

Copse is licensed under the GNU Affero General Public License, version 3 only
(${COPSE_LICENSE_FILE} beside this file). It includes the ${String(componentCount)} third-party
components listed below, each under its own licence, which applies to that
component alone.

The Electron runtime Copse is built on also contains Chromium, Node.js and their
dependencies. Their licences are in ${CHROMIUM_LICENSES_FILE} (gzip-compressed
HTML) beside this file.

The Source Code Form of each component under the Mozilla Public License 2.0 is
available from the Source address listed with it. Any change Copse makes to a
component is noted with that component.
`
}

export function collectLicenseReport(
  rootDir: string,
  metafiles: readonly MetafileLike[],
): ThirdPartyLicenseReport {
  const root = realpathSync(rootDir)
  const copied = new Set(
    COPIED_PACKAGES.map((name) => realpathSync(join(root, 'node_modules', name))),
  )
  const packages = collectPackages({
    rootDir: root,
    bundled: bundledPackageDirs(metafiles, root),
    production: productionPackageDirs(root),
    copied,
  })
  const components = [
    ...markPatchedPackages(applyLicenseOverrides(packages, root), root),
    ...vendoredComponents(root),
  ]
  const problems = findLicenseProblems(components)
  if (problems.length > 0) {
    throw new Error(
      `[licenses] ${String(problems.length)} shipped component(s) cannot be distributed as-is:\n` +
        problems.map(({ component, problem }) => `  ${component}: ${problem}`).join('\n') +
        '\nAdd the missing text to LICENSE_OVERRIDES (scripts/third-party-vendored.mts), ' +
        'or keep the package out of the app.',
    )
  }
  return buildLicenseReport(components)
}

export function writeThirdPartyLicenses(
  rootDir: string,
  metafiles: readonly MetafileLike[],
  outDir = THIRD_PARTY_LICENSES_DIR,
): ThirdPartyLicenseReport {
  const report = collectLicenseReport(rootDir, metafiles)
  // Start empty: a file an earlier build wrote here would otherwise be packaged too.
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, THIRD_PARTY_LICENSE_JSON), `${JSON.stringify(report)}\n`)
  writeFileSync(
    join(outDir, THIRD_PARTY_LICENSE_TEXT),
    renderLicenseReportText(report, licenseReportPreamble(report.components.length)),
  )
  writeFileSync(
    join(outDir, CHROMIUM_LICENSES_FILE),
    gzipSync(readFileSync(join(rootDir, ELECTRON_NOTICES)), { level: 9 }),
  )
  copyFileSync(join(rootDir, 'LICENSE'), join(outDir, COPSE_LICENSE_FILE))
  return report
}
