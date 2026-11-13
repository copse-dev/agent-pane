import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readFixtureJsonObject } from './fixture-json.ts'

export function fixtureHostPids(
  root: string,
  platform: NodeJS.Platform = process.platform,
  procRoot = '/proc',
): number[] {
  if (!root || !existsSync(join(root, 'pids.json'))) return []
  if (platform !== 'linux') {
    const data = readFixtureJsonObject(join(root, 'pids.json'))
    return [data['parent'], data['child']].filter(
      (value): value is number => typeof value === 'number' && value > 1,
    )
  }
  // bubblewrap gives the command its own PID namespace. Its recorded PIDs
  // cannot be looked up or killed in the host namespace. Identify only the
  // child by its absolute script path, then verify its host parent is the
  // expected Node command. This also avoids requiring ptrace access to cwd.
  const script = join(realpathSync(root), 'hold.cjs')
  const pids = readdirSync(procRoot).flatMap((entry) => {
    if (!/^\d+$/.test(entry) || Number(entry) <= 1) return []
    let verifiedChild: number | undefined
    try {
      const processRoot = join(procRoot, entry)
      const argv = readFileSync(join(processRoot, 'cmdline'), 'utf8').split('\0')
      if (basename(argv[0] ?? '') !== 'node' || argv[1] !== script || argv[2] !== 'child') return []
      const child = Number(entry)
      verifiedChild = child
      const parent = /^PPid:\s+(\d+)$/m.exec(readFileSync(join(processRoot, 'status'), 'utf8'))
      if (!parent?.[1] || Number(parent[1]) <= 1) return [child]
      const parentPid = Number(parent[1])
      const parentArgv = readFileSync(join(procRoot, parent[1], 'cmdline'), 'utf8').split('\0')
      return basename(parentArgv[0] ?? '') === 'node' &&
        (parentArgv[1] === 'hold.cjs' || parentArgv[1] === script)
        ? [parentPid, child]
        : [child]
    } catch (error) {
      const code: unknown =
        typeof error === 'object' && error !== null
          ? Object.getOwnPropertyDescriptor(error, 'code')?.value
          : undefined
      if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].some((ignored) => code === ignored))
        return verifiedChild === undefined ? [] : [verifiedChild]
      throw error
    }
  })
  return [...new Set(pids)]
}
