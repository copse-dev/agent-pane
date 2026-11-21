import { z } from 'zod'

/** Bounded CSS viewport sizes for the agent's isolated browser tabs. */
export const browserViewportSchema = z.object({
  width: z.number().int().min(240).max(2560).describe('Viewport width in CSS pixels (240–2560).'),
  height: z.number().int().min(240).max(1600).describe('Viewport height in CSS pixels (240–1600).'),
})

export type BrowserViewport = z.infer<typeof browserViewportSchema>
