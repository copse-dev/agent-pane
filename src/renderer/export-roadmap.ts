import type { RoadmapExportFormat } from '@shared/roadmap/export.ts'
import type { ApiClient } from '../preload/api.d.ts'

export { ROADMAP_EXPORT_FORMATS, type RoadmapExportFormat } from '@shared/roadmap/export.ts'

/** Human-readable label for a roadmap export format, used in the picker menu. */
export function roadmapExportFormatLabel(format: RoadmapExportFormat): string {
  switch (format) {
    case 'md':
      return 'Markdown (.md)'
    case 'html':
      return 'HTML (.html)'
    case 'mhtml':
      return 'Web archive (.mhtml)'
    case 'jsonl':
      return 'JSON Lines (.jsonl)'
  }
}

/** Export the active project's roadmap and trigger a browser download. */
export async function downloadRoadmapExport(
  api: ApiClient,
  format: RoadmapExportFormat,
): Promise<void> {
  const result = await api.roadmap.export(format)
  const a = document.createElement('a')
  a.href = result.dataUrl
  a.download = result.filename
  a.click()
}
