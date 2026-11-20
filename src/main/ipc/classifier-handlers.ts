import type { BrowserWindow } from 'electron'
import { z } from 'zod'
import { defineHandler } from './define-handler.ts'
import {
  classifierIdArgs,
  classifierIdOrNullArgs,
  classifierSaveArgs,
} from './security-handler-args.ts'
import {
  backgroundClassifierId,
  getClassifierProfile,
  listClassifierProfiles,
  saveClassifierProfile,
  removeClassifierProfile,
  screeningClassifierId,
  setBackgroundClassifier,
  setScreeningClassifier,
  testClassifierProfile,
} from '../services/classifiers/classifier-service.ts'
import { recordClassifierResultUsage } from '../services/classifiers/classifier-usage.ts'
import { localClassifiers } from '../services/classifiers/local-classifiers.ts'

export function registerClassifierHandlers(win: BrowserWindow): void {
  defineHandler(win, 'classifiers:list', z.tuple([]), () => listClassifierProfiles())
  defineHandler(win, 'classifiers:save', classifierSaveArgs, (profile) =>
    saveClassifierProfile(profile),
  )
  defineHandler(win, 'classifiers:remove', classifierIdArgs, (id) => removeClassifierProfile(id))
  defineHandler(win, 'classifiers:test', classifierIdArgs, async (id) => {
    const result = await testClassifierProfile(id)
    // The sample is a real call: tokens a provider reports for it count like any other.
    recordClassifierResultUsage(getClassifierProfile(id).label, result)
    return result
  })
  defineHandler(win, 'classifiers:screening', z.tuple([]), () => screeningClassifierId())
  defineHandler(win, 'classifiers:set-screening', classifierIdOrNullArgs, (id) =>
    setScreeningClassifier(id),
  )
  defineHandler(win, 'classifiers:background', z.tuple([]), () => backgroundClassifierId())
  defineHandler(win, 'classifiers:set-background', classifierIdOrNullArgs, (id) =>
    setBackgroundClassifier(id),
  )

  defineHandler(win, 'local-classifiers:status', z.tuple([]), () => localClassifiers().overview())
  defineHandler(win, 'local-classifiers:install', classifierIdArgs, (id) =>
    localClassifiers().install(id),
  )
  defineHandler(win, 'local-classifiers:start', classifierIdArgs, (id) =>
    localClassifiers().start(id),
  )
  defineHandler(win, 'local-classifiers:stop', classifierIdArgs, (id) =>
    localClassifiers().stop(id),
  )
  defineHandler(win, 'local-classifiers:uninstall', classifierIdArgs, (id) =>
    localClassifiers().uninstall(id),
  )
  defineHandler(win, 'local-classifiers:connect', classifierIdArgs, (id) =>
    localClassifiers().connect(id),
  )
}
