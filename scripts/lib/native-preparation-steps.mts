interface PreparationStep {
  label: string
  path: string
  /** Best-effort: a failure warns instead of aborting the install. Defaults to true. */
  required?: boolean
}

export function nativePreparationSteps(platform: NodeJS.Platform): PreparationStep[] {
  const steps: PreparationStep[] = [
    { label: 'Node version check', path: 'scripts/check-node-version.cjs' },
  ]
  if (platform === 'darwin') {
    steps.push({
      label: 'macOS native toolchain check',
      path: 'scripts/check-macos-native-toolchain.mts',
    })
    // Without assets/icons/app.icns, patch-dev-name.mts below leaves the dev
    // bundle on Electron's stock icns, so the Dock and About panel show the
    // generic Electron icon (#3486 only fixed the name/version, not the icon).
    // iconutil is finicky across macOS versions, so a failure here shouldn't
    // block `pnpm install`.
    steps.push({
      label: 'App icon generation',
      path: 'scripts/generate-icon.mts',
      required: false,
    })
  }
  // Electron 42+ downloads lazily. Prepare it during install on non-macOS hosts,
  // before WDIO needs it; macOS preparation also patches and shares the bundle.
  if (platform !== 'darwin') {
    steps.push({ label: 'Electron runtime download', path: 'node_modules/electron/install.js' })
  }
  steps.push(
    {
      label: 'Electron ChromeDriver download',
      path: 'node_modules/electron-chromedriver/download-chromedriver.js',
    },
    { label: 'Electron runtime preparation', path: 'scripts/patch-dev-name.mts' },
    { label: 'native module preparation', path: 'scripts/postinstall-native.mts' },
    { label: 'gortex preparation', path: 'scripts/fetch-gortex.mts' },
  )

  return steps
}
