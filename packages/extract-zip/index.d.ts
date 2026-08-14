interface ExtractOptions {
  dir: string
}

declare function extractZip(zipPath: string, options: ExtractOptions): Promise<void>

export = extractZip
