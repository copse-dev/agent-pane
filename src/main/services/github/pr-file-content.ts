import { imageMimeType } from '@shared/fs/image-path.ts'

export interface GitHubFileContent {
  text: string
  image: string | null
}

/** Decode one GitHub Contents API blob without passing image bytes through UTF-8 text. */
export function decodeGitHubFileContent(path: string, encoded: string): GitHubFileContent {
  const base64 = encoded.replace(/\s/g, '')
  const mime = imageMimeType(path)
  if (mime) {
    return { text: '', image: `data:${mime};base64,${base64}` }
  }
  return { text: Buffer.from(base64, 'base64').toString('utf8'), image: null }
}

export function emptyGitHubFileContent(): GitHubFileContent {
  return { text: '', image: null }
}
