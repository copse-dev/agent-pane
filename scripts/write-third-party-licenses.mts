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
 * - `LICENSE.txt` — Copse's own licence.
 *
 * electron-builder retains Electron's `LICENSES.chromium.html` beside the
 * packaged runtime. It is deliberately not duplicated in this directory.
 */
import { copyFileSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  findNoticeProblems,
  formatNoticeProblems,
  parseNotices,
} from './lib/third-party-notices.mts'
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
dependencies. electron-builder retains their licences in ${CHROMIUM_LICENSES_FILE}
beside the packaged runtime.

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
  // THIRD_PARTY_NOTICES.md records how Copse meets each non-attribution licence;
  // this is the one place the complete shipped set exists, bundles included.
  // Vendored components (fonts, gortex's Go modules) are covered by prose
  // sections, not per-package entries.
  const noticeProblems = findNoticeProblems(
    parseNotices(readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')),
    components.filter((component) => component.shippedAs.some((how) => how !== 'vendored')),
    { complete: true },
  )
  if (noticeProblems.length > 0) {
    throw new Error(`[licenses] ${formatNoticeProblems(noticeProblems)}`)
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
  copyFileSync(join(rootDir, 'LICENSE'), join(outDir, COPSE_LICENSE_FILE))
  return report
}
