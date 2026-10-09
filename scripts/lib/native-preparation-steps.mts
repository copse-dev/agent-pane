interface PreparationStep {
  label: string
  path: string
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
