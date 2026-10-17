/** Audited finite native outputs that cannot be inferred from a literal capture call.
 * A changed producer revokes its declarations until the output paths are audited again.
 * No wildcard, arbitrary PNG literal or browser-demo reference grants ownership.
 */
export const AUDITED_NATIVE_OUTPUTS: Readonly<
  Record<string, { readonly sourceSha256: string; readonly filenames: readonly string[] }>
> = {
  'tests/e2e/acp-auth-error.e2e.ts': {
    sourceSha256: 'ebb54c9234a2ba438ac6ee76d4dce25dbb12a194b5bb9ca5b21b0ee8fa421ca7',
    filenames: [
      'acp-auth-error.png',
      'codex-workspace-routing-auth-error.png',
      'cursor-acp-auth-error.png',
    ],
  },
  'tests/e2e/browser-network-policy.e2e.ts': {
    sourceSha256: 'e9444720daa404578327d2dacfd8e501307e3e8e5ab544aed64b5340ed807ac8',
    filenames: ['browser-preview-network-policy.png', 'browser-user-new-tab.png'],
  },
  'tests/e2e/composer-surface.e2e.ts': {
    sourceSha256: '175a2f7c1cded2508e6933ac30e660e68628f15df489b2994f00ef55c75fbdd0',
    filenames: [
      'composer-surface-card-dark.png',
      'composer-surface-card-light.png',
      'composer-surface-dark.png',
      'composer-surface-light.png',
    ],
  },
  'tests/e2e/context-wheel-classifier.e2e.ts': {
    sourceSha256: '42f16de57f14520051bb4937e4bc14a40dfc7dd6848c317c719cfef5545531cc',
    filenames: ['context-wheel-classifier-configured.png', 'context-wheel-classifier-none.png'],
  },
  'tests/e2e/file-viewer-changes.e2e.ts': {
    sourceSha256: 'f0f5617dda022b6b475494f99bdc3afdae3f43ede793740fbf04c9e946b20013',
    filenames: ['file-viewer-copse-strong-dark.png', 'file-viewer-copse-strong-light.png'],
  },
  'tests/e2e/footer-branch-picker.e2e.ts': {
    sourceSha256: '3e49b5f7af7af559ea5b882b40fb5032a9bfd04623c78ef153ff6b1be97364b5',
    filenames: ['footer-branch-picker-compact-220.png', 'footer-branch-picker-compact-320.png'],
  },
  'tests/e2e/git-changes-thread-retention.e2e.ts': {
    sourceSha256: '5957e129eb0899df8634d61ec67d4a487812d2b64de8e17730bf759686acd833',
    filenames: ['git-changes-thread-retention.png'],
  },
  'tests/e2e/light-contrast-controls.e2e.ts': {
    sourceSha256: 'f4172ac25d11f393a74f083c65c7fff499b448abcd9d0912f9243d14cfbe5eea',
    filenames: [
      'light-contrast-changes-badge-dark.png',
      'light-contrast-changes-badge-light.png',
      'light-contrast-save-button-dark.png',
      'light-contrast-save-button-light.png',
    ],
  },
  'tests/e2e/malformed-tool-call-inspector.e2e.ts': {
    sourceSha256: 'd34430e2f35a41a36e58b2785a4e2cebfe29f5c71472df602c4c309aa84427a3',
    filenames: ['malformed-tool-call-inspector.png', 'truncated-tool-call-inspector.png'],
  },
  'tests/e2e/markdown-ordered-list-spacing.e2e.ts': {
    sourceSha256: '7815a518ba2a0161993709e8399a7602a6c648ba07a06edd32213719522a8028',
    filenames: ['markdown-ordered-list-after.png', 'markdown-ordered-list-before.png'],
  },
  'tests/e2e/mermaid-parity.e2e.ts': {
    sourceSha256: '26c1e84377f59a8c7951734d4df7fb6aa791d50a2a5c00c11907188094c28f5b',
    filenames: [
      'mermaid-parity-class.png',
      'mermaid-parity-flowchart.png',
      'mermaid-parity-math.png',
      'mermaid-parity-sequence.png',
      'mermaid-parity-wide.png',
    ],
  },
  'tests/e2e/new-thread-default-branch.e2e.ts': {
    sourceSha256: '186346b0bb5d8249fea1532826d040d8959269b5692d86d56e74f831deb26653',
    filenames: [
      'new-thread-default-branch-explicit-sent.png',
      'new-thread-default-branch-shared-picker.png',
      'new-thread-default-branch-shared-sent.png',
      'new-thread-default-branch-startup-sent.png',
      'new-thread-default-branch-worktree-picker.png',
      'new-thread-default-branch-worktree-sent.png',
    ],
  },
  'tests/e2e/pane-loading.e2e.ts': {
    sourceSha256: '8864264a7249c65aa873ff52d3843e2d3ee54a1dfdb20f4d443a9da4ba1c5dbe',
    filenames: [
      'pane-loading-changes.png',
      'pane-loading-memories.png',
      'pane-loading-pull-requests.png',
      'pane-loading-roadmap.png',
    ],
  },
  'tests/e2e/pane-popout.e2e.ts': {
    sourceSha256: '178f18785ff0d4fabd7e3e67b25629545699ad6cc882c0011317c00a714d9a72',
    filenames: [
      'pane-popout-browser.png',
      'pane-popout-changes.png',
      'pane-popout-explorer.png',
      'pane-popout-prs.png',
      'pane-popout-roadmap.png',
    ],
  },
  'tests/e2e/pr-provenance.e2e.ts': {
    sourceSha256: 'ed9c7a08d6515fa4026ac98f7fb044a07257db1a5c71aef6e717b5f8ad3e75ee',
    filenames: ['pr-native-provenance-offline-restart.png', 'pr-native-provenance.png'],
  },
  'tests/e2e/queued-held.e2e.ts': {
    sourceSha256: '391828472c2359b42f020277995bbbd06372bb0381b71b38c28558c5b945ccfd',
    filenames: ['queued-held-contrast-dark.png', 'queued-held-contrast-light.png'],
  },
  'tests/e2e/queued-message-delete.e2e.ts': {
    sourceSha256: '3f9d4bc14052283ea360dcc5b43145e5ae196ec0945c56b7311aef5fc20efc54',
    filenames: ['queued-actions-row-hover-dark.png', 'queued-actions-row-hover-light.png'],
  },
  'tests/e2e/scroll-to-bottom.e2e.ts': {
    sourceSha256: '1287f43a04594be7a13c6837d3ad020a214c9c740b511f4fad82102b5d303d31',
    filenames: ['scroll-to-bottom-dark.png', 'scroll-to-bottom-light.png'],
  },
  'tests/e2e/settings-acp-agents-list.e2e.ts': {
    sourceSha256: '285aa2bb641ae3a670bda06c20327ad1171d818565dbdd59590f84d64a15fc5e',
    filenames: ['settings-acp-agents-list-page-2.png', 'settings-acp-agents-list.png'],
  },
  'tests/e2e/settings-automations.e2e.ts': {
    sourceSha256: '35fd65c3fc9275c2c84d4463355b051be7a33c410543ec38957dafec2076cbb0',
    filenames: ['settings-automation-form-page-2.png', 'settings-automation-form.png'],
  },
  'tests/e2e/settings-classifiers-install.e2e.ts': {
    sourceSha256: 'fb24527287815a63c8b292ba0caa1146c6e518ff48a6ee24d25d7b77ee59ce6b',
    filenames: [
      'settings-classifiers-install-bad-revision.png',
      'settings-classifiers-install-no-space.png',
      'settings-classifiers-install-offline.png',
    ],
  },
  'tests/e2e/settings-model-parameters.e2e.ts': {
    sourceSha256: '996e407f3891ac13179b81d7422e7faed193d86b0eb092bad5a350716184a16e',
    filenames: [
      'settings-model-parameters-glm-4-7-flash-page-2.png',
      'settings-model-parameters-glm-4-7-flash-page-3.png',
      'settings-model-parameters-glm-4-7-flash.png',
      'settings-model-parameters-glm-5-3-flash-page-2.png',
      'settings-model-parameters-glm-5-3-flash-page-3.png',
      'settings-model-parameters-glm-5-3-flash.png',
      'settings-model-parameters-page-2.png',
      'settings-model-parameters-page-3.png',
      'settings-model-parameters-rule-chat-model.png',
      'settings-model-parameters-verbosity.png',
      'settings-model-parameters.png',
    ],
  },
  'tests/e2e/settings-provider-hosts.e2e.ts': {
    sourceSha256: '5d93e4c4bc1f3d05bc4013c85a11157d90a22449000ad5a649af645743726b04',
    filenames: ['settings-provider-hosts-page-2.png', 'settings-provider-hosts.png'],
  },
  'tests/e2e/settings-sources-cursor-hooks.e2e.ts': {
    sourceSha256: '62b8307c1e49b33bd70325beaeaeff7997f6cbd6a52de07e116cf37600e3a7d2',
    filenames: ['settings-sources-hooks-page-2.png', 'settings-sources-hooks.png'],
  },
  'tests/e2e/settings-sources-hook-test.e2e.ts': {
    sourceSha256: 'f38a4290cf4d96fe5652380255184514411b4fbdff145a465076914cbe7ce8d5',
    filenames: ['settings-sources-hook-test-page-2.png', 'settings-sources-hook-test.png'],
  },
  'tests/e2e/settings-terminal-history-toggle.e2e.ts': {
    sourceSha256: '5ebc854edb6963bd32849d9ecb6c2cddbedfecf2ccad2dca64c98ca5ef036167',
    filenames: [
      'settings-terminal-history-toggle-off-page-2.png',
      'settings-terminal-history-toggle-off.png',
      'settings-terminal-history-toggle-page-2.png',
      'settings-terminal-history-toggle.png',
    ],
  },
  'tests/e2e/sidebar-other-projects-activity.e2e.ts': {
    sourceSha256: '752fa506ac2c57977cc59637b9732e7dacc64f7a1f47f8827f76018862bf4355',
    filenames: ['sidebar-unopened-activity-1600.png', 'sidebar-unopened-activity-800.png'],
  },
  'tests/e2e/terminal-display.e2e.ts': {
    sourceSha256: '6a2c0dd78811a4ece08255eec487c1c8828fcc9aa76810d6108cb62a62b11e0c',
    filenames: ['terminal-copse-strong-dark.png', 'terminal-copse-strong-light.png'],
  },
  'tests/e2e/thread-explainer-drawing.e2e.ts': {
    sourceSha256: 'aacf43c43da9df0fd3f495aff55d0196942496b6c49555cd63ae5a3437daebbc',
    filenames: [
      'explainer-drawing-1-player.png',
      'explainer-drawing-1.png',
      'explainer-drawing-2-player.png',
      'explainer-drawing-2.png',
      'explainer-drawing-narrow-player.png',
      'explainer-drawing-narrow.png',
      'explainer-text-alignment-player.png',
      'explainer-text-alignment.png',
    ],
  },
  'tests/e2e/thread-explainer-scenes.e2e.ts': {
    sourceSha256: '645db4888627e83686f27fb00588e7b63cd942caee4208ff6c9c0adb3913a083',
    filenames: [
      'explainer-scenes-1-player.png',
      'explainer-scenes-1.png',
      'explainer-scenes-2-player.png',
      'explainer-scenes-2.png',
    ],
  },
  'tests/e2e/thread-explainer.e2e.ts': {
    sourceSha256: 'bd627fe12695ac19fd44ab32b002e33e2a6c7260a314b54c7e4cef21f40680c5',
    filenames: ['thread-explainer-player.png'],
  },
}
