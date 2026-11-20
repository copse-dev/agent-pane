import type { BrowserWindow } from 'electron'
import { z } from 'zod'
import { machineSharingSchema, machineSshHostIdSchema } from '@shared/machines.ts'
import { defineHandler } from './define-handler.ts'
import { machineManager } from '../services/machines/machine-service.ts'

export function registerMachineHandlers(win: BrowserWindow): void {
  defineHandler(win, 'machines:state', z.tuple([]), async () => {
    const manager = machineManager()
    await manager.refresh()
    return manager.snapshot()
  })
  defineHandler(win, 'machines:pair', z.tuple([z.string().min(1).max(2048)]), (code) =>
    machineManager().pair(code),
  )
  defineHandler(
    win,
    'machines:pair-over-ssh',
    z.tuple([z.string().min(1).max(2048), machineSshHostIdSchema]),
    (code, hostId) => machineManager().pair(code, hostId),
  )
  defineHandler(win, 'machines:remove', z.tuple([z.uuid()]), (id) => machineManager().remove(id))
  defineHandler(win, 'machines:share', z.tuple([machineSharingSchema]), (sharing) =>
    machineManager().share(sharing),
  )
  defineHandler(win, 'machines:invitation', z.tuple([]), () => machineManager().invitation())
  defineHandler(win, 'machines:revoke', z.tuple([z.uuid()]), (id) => machineManager().revoke(id))
}
