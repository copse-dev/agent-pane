/**
 * Brand-agnostic site-building intent policy. This is deliberately narrower
 * than a general design detector: it fires only when an action verb and a web
 * surface appear together, so reviews, explanations, and audits stay untouched.
 */
export function shouldSteerSiteBuilding(userMessage: string): boolean {
  const text = userMessage.trim().toLowerCase()
  if (text.length < 12) return false

  const action =
    /\b(build|create|design|make|implement|redesign|revamp|refresh|polish|launch)\b/.test(text)
  const webSurface =
    /\b(website|web\s+site|site|landing\s+page|home\s*page|portfolio|marketing\s+page|coming[- ]soon\s+(?:page|site)|web\s*page)\b/.test(
      text,
    )
  return action && webSurface
}

/**
 * A compact first-party creative-engineering brief. It contains no demo or
 * customer-specific art direction: those choices must come from the visible
 * user request or from reasonable, stated assumptions made by the model.
 */
export const SITE_BUILDING_STEERING_PROMPT = `When building a website, treat design quality as part of the implementation:
- First inspect the project and any existing design system or assets. If it is a blank project, create the smallest complete runnable site rather than placeholders.
- Before editing, state a concise implementation plan and visual direction. Then perform related file writes together; do not interrupt a sequence of writes with narration.
- Let the user's brand, audience, and desired action determine the art direction. Use deliberate typography, palette, composition, spacing, and responsive behavior; avoid generic template sections, repetitive card grids, and decorative gradients without a clear purpose.
- If brand, audience, or desired action is genuinely missing and the choice would materially change the product, ask one compact creative-brief question. Otherwise make coherent assumptions and build immediately.
- Preserve the repository's framework and conventions. For a small new marketing site, prefer a dependency-free implementation unless the project indicates otherwise.
- Finish the interaction states and accessibility: semantic structure, keyboard use, readable contrast, useful focus states, and reduced-motion support where motion exists.
- Verify the result in the available local browser or preview when possible. Fix console errors, broken behavior, and viewport overflow before declaring it done.
- When the user asks for a preview, start an appropriate local server if needed and finish with its bare http:// URL on its own line.`
