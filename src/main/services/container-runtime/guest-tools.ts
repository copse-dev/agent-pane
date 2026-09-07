/**
 * Tools a container run never offers, whatever the guest's registry bootstrap
 * would otherwise decide (`docs/plans/thread-in-container.md`, decision A10).
 *
 * The GitHub and CI tools register on the desktop when `gh` is on the PATH or
 * a GitHub token is in the environment. Neither is true in the guest, so they
 * would be absent anyway — but "absent because nothing was found" is not a
 * guarantee, and four of them write to GitHub (create a PR, approve it, mark
 * it ready, enable auto-merge), which is exactly the outward effect an
 * unattended run must never have. So the worker names them and the headless
 * host unregisters them after bootstrap, before the agent sees a tool list.
 */
import { ghPrActionTools } from '../../tools/gh-pr-action-tools.ts'
import {
  ghPrFilesTool,
  ghPrListTool,
  ghPrViewTool,
  ghRunListTool,
  ghRunViewTool,
} from '../../tools/gh-tools.ts'
import {
  getCiFailureLogsTool,
  getCiStatusTool,
  waitForCiChecksTool,
} from '../../tools/github-ci-tools.ts'

export const GUEST_EXCLUDED_TOOLS: readonly string[] = [
  ...ghPrActionTools.map((tool) => tool.name),
  ghPrListTool.name,
  ghPrViewTool.name,
  ghPrFilesTool.name,
  ghRunListTool.name,
  ghRunViewTool.name,
  getCiStatusTool.name,
  waitForCiChecksTool.name,
  getCiFailureLogsTool.name,
]
