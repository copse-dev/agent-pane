export const storageMarkup = `
          <section class="settings-section" data-section="storage">
            <h3>Storage</h3>
            <p class="settings-section-desc">
              What Copse keeps on disk for each local project, and what it costs. Nothing here
              changes how the agent behaves, it is where you go to see what has accumulated and
              reclaim space.
            </p>

            <label class="storage-project-field">
              <span>Project</span>
              <select id="storage-project-select" aria-label="Storage project"></select>
            </label>
            <p class="field-hint storage-project-path" id="storage-project-path"></p>

            <fieldset class="sources-worktrees-fieldset">
              <legend>Worktrees</legend>
              <p class="settings-fieldset-desc">
                Linked Git checkouts of this project. Copse creates one per isolated thread so
                agents can work without touching your checkout; each row shows the thread it was
                created for, when it was last used, and what it costs on disk. Open its thread or a
                terminal there, remove ignored package-manager directories, or delete the whole
                checkout. Deleting one also removes its branch when the branch is fully merged.
              </p>
              <div id="sources-worktrees-selection" class="sources-worktrees-selection" hidden>
                <label><input id="sources-worktrees-select-all" type="checkbox"> Select all</label>
                <span id="sources-worktrees-selected-count" aria-live="polite"></span>
                <div id="sources-worktrees-bulk-actions" hidden>
                  <button type="button" id="sources-worktrees-cleanup" class="sources-worktree-action-btn">Clean up…</button>
                  <button type="button" id="sources-worktrees-delete" class="sources-worktree-action-btn sources-worktree-delete-btn">Delete</button>
                </div>
              </div>
              <div id="sources-worktrees-list" class="sources-group">
                <span class="sources-empty">Loading…</span>
              </div>
              <span class="lmstudio-test-status" id="sources-worktrees-status" role="status" aria-live="polite"></span>
            </fieldset>
          </section>
`
