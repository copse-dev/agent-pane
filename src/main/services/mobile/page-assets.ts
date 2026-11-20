import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mobileAssetRoutes } from '../../../shared/mobile-asset-routes.ts'
import { pageAsset, pinPageAssets, type PageAsset } from './http-response.ts'

/**
 * The companion's fixed routes, read once before the listener binds so a
 * missing package asset cannot yield a half-working listener. The map is fixed
 * and contains no user path.
 *
 * The page pins its stylesheet and script by hash (see `pinPageAssets`). The
 * Mermaid frame is left exactly as built: its meta CSP pins its own inline
 * script, and it references nothing else.
 */
export function loadPageAssets(root: string): Map<string, PageAsset> {
  const routes = mobileAssetRoutes()
  const assets = new Map<string, PageAsset>()
  for (const [route, file] of routes) {
    if (route !== '/')
      assets.set(route, pageAsset(readFileSync(join(root, file.path)), file.headers))
  }
  const page = routes.get('/')
  if (!page) throw new Error('The mobile asset routes have no page')
  const html = pinPageAssets(readFileSync(join(root, page.path), 'utf8'), '/', assets)
  assets.set('/', pageAsset(Buffer.from(html, 'utf8'), page.headers))
  return assets
}
