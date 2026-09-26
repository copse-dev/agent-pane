import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/** Use node-gyp's checksum-verified header installer, then bypass rebuild's host cache. */
export function prepareElectronHeaders(options: {
  cache: string
  version: string
  nodeGypCli: string
  offline: boolean
}): string {
  const { cache, version, nodeGypCli, offline } = options
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
    throw new Error(`Invalid installed Electron version: ${version}`)
  }
  const directory = join(cache, version)
  if (offline) {
    for (const file of [
      'installVersion',
      'include/node/node.h',
      'include/node/common.gypi',
      'include/node/config.gypi',
    ]) {
      if (!existsSync(join(directory, file))) {
        throw new Error(
          `Offline build needs Electron ${version} headers in ${directory}. Run portable-setup online first.`,
        )
      }
    }
  } else {
    const result = spawnSync(
      process.execPath,
      [
        nodeGypCli,
        'install',
        '--ensure',
        `--target=${version}`,
        '--dist-url=https://www.electronjs.org/headers',
        `--devdir=${cache}`,
      ],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          // node-gyp gives npm environment configuration precedence over argv.
          npm_package_config_node_gyp_devdir: cache,
          npm_package_config_node_gyp_target: version,
          npm_package_config_node_gyp_dist_url: 'https://www.electronjs.org/headers',
        },
      },
    )
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error('Could not prepare drive-local Electron headers')
  }
  return directory
}
