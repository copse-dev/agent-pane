// Install the browser tier's pinned Chrome for Testing build, checked against
// the sha256 values in scripts/lib/demo-chrome.mts, and point wdio.demo.conf.ts
// at it through COPSE_DEMO_CHROME_BINARY / COPSE_DEMO_CHROMEDRIVER_BINARY.
//
//   node scripts/install-demo-chrome.mts                 install; export the paths
//   node scripts/install-demo-chrome.mts --print-hashes  report sha256 values for a bump
//
// In GitHub Actions the variables go to $GITHUB_ENV for the later steps;
// elsewhere the script prints `export` lines to eval.

import { appendFile } from 'node:fs/promises'
import { isDirectExecution } from './lib/direct-execution.mts'
import {
  DEMO_CHROME_PIN,
  defaultDemoChromeRoot,
  demoChromeHashes,
  installDemoChrome,
} from './lib/demo-chrome.mts'

async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes('--print-hashes')) {
    const hashes = await demoChromeHashes(DEMO_CHROME_PIN.version)
    console.log(JSON.stringify({ version: DEMO_CHROME_PIN.version, sha256: hashes }, null, 2))
    return
  }
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(
      `The pinned demo Chrome is linux64 only (this is ${process.platform}-${process.arch}). ` +
        'Set COPSE_DEMO_CHROME_BINARY and COPSE_DEMO_CHROMEDRIVER_BINARY to a local build instead.',
    )
  }
  const install = await installDemoChrome({
    root: defaultDemoChromeRoot(),
    // Keep stdout to the `export` lines so a local shell can eval them.
    log: (line) => {
      console.error(line)
    },
  })
  const vars = {
    COPSE_DEMO_CHROME_BINARY: install.chrome,
    COPSE_DEMO_CHROMEDRIVER_BINARY: install.chromedriver,
  }
  const githubEnv = process.env['GITHUB_ENV']
  if (githubEnv) {
    await appendFile(
      githubEnv,
      Object.entries(vars)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    )
    console.log(`[demo-chrome] exported ${Object.keys(vars).join(', ')} to GITHUB_ENV`)
  } else {
    for (const [key, value] of Object.entries(vars)) {
      console.log(`export ${key}=${JSON.stringify(value)}`)
    }
  }
}

if (isDirectExecution(import.meta.url, 'install-demo-chrome')) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
