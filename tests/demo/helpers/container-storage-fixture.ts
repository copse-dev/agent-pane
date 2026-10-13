import { createFakeApi } from '../../../src/renderer/fake-api.test-support.ts'
import { createStorageMaintenancePanel } from '../../../src/renderer/views/storage-maintenance-panel.ts'
import { mountConfirmDialog } from '../../../src/renderer/views/confirm-dialog.ts'
import { emptyContainerStorage } from '@shared/types/storage-cleanup.ts'
import { el, qsRequired } from '../../../src/renderer/dom/helpers.ts'

const api = createFakeApi()
const busy = new URLSearchParams(location.search).has('busy')
api.storage.maintenance = async () => ({
  retention: { enabled: true, days: 30 },
  areas: [
    { area: 'runs', bytes: 0, entries: 0, busy: false },
    { area: 'builds', bytes: 0, entries: 0, busy: false },
  ],
  containers: {
    ...emptyContainerStorage(),
    available: true,
    busy,
    builderRunning: true,
    totalBytes: 69.49 * 1024 ** 3,
    snapshotsBytes: 53.37 * 1024 ** 3,
    containersBytes: 15.07 * 1024 ** 3,
    builderDiskBytes: 15.07 * 1024 ** 3,
    blobsBytes: 1.01 * 1024 ** 3,
    otherBytes: 0.04 * 1024 ** 3,
    builderCacheBytes: 4420000000,
    builderReclaimableBytes: 4420000000,
    snapshotCount: 22,
    unmatchedSnapshots: 15,
    images: [
      {
        name: 'copse-worker:local',
        bytes: 598000000,
        snapshotBytes: 2.81 * 1024 ** 3,
        eligible: false,
      },
      {
        name: 'copse-worker:e2e',
        bytes: 334000000,
        snapshotBytes: 2.09 * 1024 ** 3,
        eligible: true,
      },
    ],
  },
})
api.storage.containerCleanup = async () => ({ removed: 1, bytes: 1024 ** 3, skipped: 0 })
mountConfirmDialog()
const panel = createStorageMaintenancePanel(api)
const app = qsRequired(document, '#app')
app.classList.add('storage-fixture')
const content = el('div', { class: 'settings-content' })
const section = el('section', { class: 'settings-section active' })
section.append(panel.element)
content.append(section)
app.append(content)
void panel.refresh()
