/**
 * Prototype-intent policy for the MCP-UI canvas.
 *
 * When someone asks for a prototype, the useful answer is something they can
 * look at and click, not a description of what it would look like. The canvas
 * (`render_html_artefact`, from the bundled `copse-canvas` MCP server) renders a
 * self-contained HTML document as a live sandboxed artefact in the Browser pane,
 * which is exactly that — but a model with a large tool list will happily answer
 * a prototype request in prose or with a file the user has to open themselves.
 * This module supplies the nudge.
 *
 * The detector is deliberately narrow, mirroring `site-building-steering.ts`: an
 * action verb AND a prototype noun must appear together, and inspection verbs
 * veto outright, so "review this prototype" and "fix the mockup spacing" stay
 * untouched.
 */

/** The bundled canvas tool's bare name (host-side it carries an MCP prefix). */
export const CANVAS_ARTEFACT_TOOL = 'render_html_artefact'

/**
 * Verbs that ask for something to be produced. `prototype` / `mock` / `wireframe`
 * / `sketch` are here as well as in the noun set because they are used both ways
 * ("prototype a settings screen", "build a prototype").
 */
const PRODUCE_VERBS =
  /\b(build|create|make|design|draft|sketch|prototype|mock|wireframe|show|demo|spin|knock|whip|throw|put|visuali[sz]e)\b/

/** Nouns that name a throwaway, look-at-it artefact rather than shipped code. */
const PROTOTYPE_NOUNS =
  /\b(prototypes?|mock[- ]?ups?|mock\s+up|wireframes?|proof\s+of\s+concept|poc|interactive\s+demo|quick\s+demo|rough\s+(?:draft|cut|version))\b/

/**
 * Verbs and question forms that ask *about* an artefact. These veto: the user
 * wants an opinion, an explanation, or a repair, and rendering a fresh canvas
 * would answer a question they did not ask.
 */
const INSPECTION =
  /\b(review|explain|audit|critique|summari[sz]e|document|refactor|debug|fix|what\s+do\s+you\s+think|thoughts\s+on|how\s+does|why\s+does|walk\s+me\s+through)\b/

/** Whether this user message is asking for a prototype the canvas should render. */
export function shouldSteerCanvasPrototype(userMessage: string): boolean {
  const text = userMessage.trim().toLowerCase()
  if (text.length < 10) return false
  if (INSPECTION.test(text)) return false
  return PRODUCE_VERBS.test(text) && PROTOTYPE_NOUNS.test(text)
}

/**
 * The steering block, parameterised by the tool name actually offered this turn.
 * The canvas tool reaches the model through the MCP registry, so its name is
 * prefixed (`mcp__copse-canvas__render_html_artefact`); naming the bare tool
 * would tell the model to call something it cannot see.
 *
 * The "new file applies without approval" line is not aspiration — the diff
 * queue exempts brand-new files from the approval prompt precisely so a
 * prototype lands and renders in one step.
 */
export function buildCanvasPrototypeSteeringPrompt(toolName: string): string {
  return `The user is asking for a prototype. Build it as one self-contained HTML document and show it in the canvas with \`${toolName}\`. Do not answer a prototype request with a description, an ASCII sketch, or code the user has to run themselves.
- Write the document to a real workspace file first (a new file such as \`prototypes/<name>.html\`) and pass its \`path\`. The prototype then stays editable and versioned, and creating a new file applies without an approval prompt. Use inline \`html\` only when writing a file is genuinely impossible.
- Inline every asset: no CDN scripts, external stylesheets, or remote images. The artefact runs fully sandboxed, with no access to the user's machine, files, or network.
- Make it concrete enough to judge: realistic content rather than lorem ipsum, working interactions for the flow being shown, and sensible responsive and light/dark behaviour.
- To iterate, edit the same file and call the tool again with the same \`path\` and the same \`title\`. The open canvas tab refreshes in place, so keep the title stable rather than collecting duplicate tabs.
- Render first, then ask. Make coherent assumptions, put something on screen, and let the user redirect from what they can see; save clarifying questions for choices the prototype cannot express.`
}
