import { execFileSync } from 'node:child_process'
import { access, cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = 'jonathankingston/search-mcp'
const OUT_DIR = resolve('vendor/search-mcp')
const MIN_FILES = ['src/index.ts', 'src/duckduck.ts', 'src/markdown.ts']

async function vendorReady(): Promise<boolean> {
  try {
    for (const rel of MIN_FILES) {
      await access(join(OUT_DIR, rel))
    }
    return true
  } catch {
    return false
  }
}

async function copyTree(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const from = join(src, entry.name)
    const to = join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyTree(from, to)
      continue
    }
    await cp(from, to)
  }
}

async function main(): Promise<void> {
  if (process.env.SKIP_SEARCH_MCP_FETCH === '1') {
    console.log('[fetch-search-mcp] SKIP_SEARCH_MCP_FETCH=1 — skipping')
    return
  }

  const tmpRoot = join(tmpdir(), `copse-panel-search-mcp-${Date.now()}`)
  const cloneDir = join(tmpRoot, 'repo')

  try {
    await mkdir(tmpRoot, { recursive: true })
    console.log(`[fetch-search-mcp] cloning ${REPO}`)
    execFileSync('git', ['clone', '--depth', '1', `https://github.com/${REPO}.git`, cloneDir], {
      stdio: 'inherit',
    })

    await rm(OUT_DIR, { recursive: true, force: true })
    await copyTree(cloneDir, OUT_DIR)

    const sizeKb = ((await stat(OUT_DIR)).size / 1024).toFixed(1)
    console.log(`[fetch-search-mcp] installed ${OUT_DIR} (${sizeKb} KB)`)
  } catch (err) {
    if (await vendorReady()) {
      console.warn(
        `[fetch-search-mcp] could not update from ${REPO}; using bundled vendor/search-mcp`,
      )
      if (err instanceof Error) console.warn(`[fetch-search-mcp] ${err.message}`)
      return
    }
    throw err
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('[fetch-search-mcp]', err instanceof Error ? err.message : err)
  process.exit(1)
})
