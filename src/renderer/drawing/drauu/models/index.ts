import type { Drauu } from '../drauu.ts'
import type { DrawingMode } from '../types.ts'
import type { BaseModel } from './base.ts'
import { DrawModel } from './draw.ts'
import { EllipseModel } from './ellipse.ts'
import { EraserModel } from './eraser.ts'
import { LineModel } from './line.ts'
import { RectModel } from './rect.ts'
import { StylusModel } from './stylus.ts'

export type Models = Record<DrawingMode, BaseModel<SVGElement>>

export function createModels(drauu: Drauu): Models {
  return {
    draw: new DrawModel(drauu),
    stylus: new StylusModel(drauu),
    line: new LineModel(drauu),
    rectangle: new RectModel(drauu),
    ellipse: new EllipseModel(drauu),
    eraseLine: new EraserModel(drauu),
  }
}

export { DrawModel, EllipseModel, EraserModel, LineModel, RectModel, StylusModel }
