/** Audited finite native outputs that cannot be inferred from a literal capture call.
 * A changed producer revokes its declarations until the output paths are audited again.
 * No wildcard, arbitrary PNG literal or browser-demo reference grants ownership.
 */
export const AUDITED_NATIVE_OUTPUTS: Readonly<
  Record<string, { readonly sourceSha256: string; readonly filenames: readonly string[] }>
> = {
  'tests/e2e/acp-auth-error.e2e.ts': {
    sourceSha256: '0c153023dabfc7b1f213ea0a427df4f073a6af6cdc72271aaae4ce9b1e95e05c',
    filenames: [
      'acp-auth-error.png',
      'codex-workspace-routing-auth-error.png',
      'cursor-acp-auth-error.png',
    ],
  },
  'tests/e2e/browser-network-policy.e2e.ts': {
    sourceSha256: 'a40ad6a906edce36bdd95649d98c2725fe1008a6de8eedac1444eb47c0485fb3',
    filenames: ['browser-preview-network-policy.png', 'browser-user-new-tab.png'],
  },
  'tests/e2e/composer-surface.e2e.ts': {
    sourceSha256: '827420e25d14f6981810507442bf21dd993d2e9cb18574b0ff214f7852df5163',
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
    sourceSha256: '522bd0c11e02352b85247a035cfbefff8866d2d44b40b18f04cf8f5a2793ddd5',
    filenames: ['file-viewer-copse-strong-dark.png', 'file-viewer-copse-strong-light.png'],
  },
  'tests/e2e/footer-branch-picker.e2e.ts': {
    sourceSha256: '9df2346aa7c03ecdaa74539f312b62d0b08253b306e5073760d0db26368882c5',
    filenames: ['footer-branch-picker-compact-220.png', 'footer-branch-picker-compact-320.png'],
  },
  'tests/e2e/git-changes-thread-retention.e2e.ts': {
    sourceSha256: '242dbcc494236a37f2452dfd721e6314d41a91bf1680e5a8d990ad3e0806b6e6',
    filenames: ['git-changes-thread-retention.png'],
  },
  'tests/e2e/light-contrast-controls.e2e.ts': {
    sourceSha256: '091f450cc1519b580790f9f7292d7a705bea55e0fa9c65a0d0e99ad75a25d0ae',
    filenames: [
      'light-contrast-changes-badge-dark.png',
      'light-contrast-changes-badge-light.png',
      'light-contrast-save-button-dark.png',
      'light-contrast-save-button-light.png',
    ],
  },
  'tests/e2e/malformed-tool-call-inspector.e2e.ts': {
    sourceSha256: 'b08933dd45acf239503deb2230a55e71df1c87b3b5c96b226ee0849d22cd927a',
    filenames: ['malformed-tool-call-inspector.png', 'truncated-tool-call-inspector.png'],
  },
  'tests/e2e/markdown-ordered-list-spacing.e2e.ts': {
    sourceSha256: 'c4b1bef64a3ed494111ae6b06f0d61cff4f9bf7f8986eaaae0f655399eb9145f',
    filenames: ['markdown-ordered-list-after.png', 'markdown-ordered-list-before.png'],
  },
  'tests/e2e/mermaid-parity.e2e.ts': {
    sourceSha256: '659277b0160d3cf4ec08df4c1c9c9a2eda41f44480456d0fb83d92b56401a81d',
    filenames: [
      'mermaid-parity-class.png',
      'mermaid-parity-flowchart.png',
      'mermaid-parity-math.png',
      'mermaid-parity-sequence.png',
      'mermaid-parity-wide.png',
    ],
  },
  'tests/e2e/new-thread-default-branch.e2e.ts': {
    sourceSha256: 'ccd0524fb2894936c273af35dbcd87a3ab0aae7d716022337159169c215116af',
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
    sourceSha256: 'a4a2f58f9e9e8414b419dea33171f14aa0ae084874dcfb12beeeefd0a3f123f9',
    filenames: [
      'pane-loading-changes.png',
      'pane-loading-memories.png',
      'pane-loading-pull-requests.png',
      'pane-loading-roadmap.png',
    ],
  },
  'tests/e2e/pane-popout.e2e.ts': {
    sourceSha256: 'f5f19eb5e8fee96a434b779b9b73636deed7ee1ea5d0e6c1cc9f11ba6a98ef7a',
    filenames: [
      'pane-popout-browser.png',
      'pane-popout-changes.png',
      'pane-popout-explorer.png',
      'pane-popout-prs.png',
      'pane-popout-roadmap.png',
    ],
  },
  'tests/e2e/pr-provenance.e2e.ts': {
    sourceSha256: 'bd40ca6d2e5af5f3b5caa8ab826973ef3b36342debedd0db2d0f9ad69b9585b3',
    filenames: ['pr-native-provenance-offline-restart.png', 'pr-native-provenance.png'],
  },
  'tests/e2e/queued-held.e2e.ts': {
    sourceSha256: 'e77a734069b31da7f4c330045801eaafa4d62931c632409b70a8452ad1cdbb42',
    filenames: ['queued-held-contrast-dark.png', 'queued-held-contrast-light.png'],
  },
  'tests/e2e/queued-message-delete.e2e.ts': {
    sourceSha256: '17a68f9014690da1c32f6e8369f3cd4553d83444f7096d9f2f70c1b8042316e3',
    filenames: ['queued-actions-row-hover-dark.png', 'queued-actions-row-hover-light.png'],
  },
  'tests/e2e/scroll-to-bottom.e2e.ts': {
    sourceSha256: 'd4f4fc99dd0d5fd21520b80117afec3fef5bf2dc8090516870e03a455323b8e5',
    filenames: ['scroll-to-bottom-dark.png', 'scroll-to-bottom-light.png'],
  },
  'tests/e2e/settings-acp-agents-list.e2e.ts': {
    sourceSha256: '71431b35f09fb252e810ddeba2ec345dae901c69c453ff59dd7ab5275e4bb304',
    filenames: [
      'settings-acp-agents-list-codex-ready.png',
      'settings-acp-agents-list-page-2.png',
      'settings-acp-agents-list.png',
    ],
  },
  'tests/e2e/settings-automations.e2e.ts': {
    sourceSha256: 'fbdd02764a0dfab43472813022ccbba1a7dd34c9f7406bae1afa87cccf9ff78e',
    filenames: ['settings-automation-form-page-2.png', 'settings-automation-form.png'],
  },
  'tests/e2e/settings-classifiers-install.e2e.ts': {
    sourceSha256: 'd81e028650114e8794741a1fed1c6032747ff6ed7dd73d6bbeb0a37a79e4307d',
    filenames: [
      'settings-classifiers-install-bad-revision.png',
      'settings-classifiers-install-no-space.png',
      'settings-classifiers-install-offline.png',
    ],
  },
  'tests/e2e/settings-model-parameters.e2e.ts': {
    sourceSha256: 'b05fbb9d1ad58fa8be306b84a44868f95ffbb856298455d048f1fb4a02288424',
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
    sourceSha256: 'dacbd35c017f031fd4aee1207bf92ee413b35033d164e5f8b04fd1166b7c20e5',
    filenames: ['settings-sources-hooks-page-2.png', 'settings-sources-hooks.png'],
  },
  'tests/e2e/settings-sources-hook-test.e2e.ts': {
    sourceSha256: 'b0ae06380ae54e8cc23a7aab06a8c7e96405a0384c3325ada4b674c70cd35b5c',
    filenames: ['settings-sources-hook-test-page-2.png', 'settings-sources-hook-test.png'],
  },
  'tests/e2e/settings-terminal-history-toggle.e2e.ts': {
    sourceSha256: '91a7fdff1cbea3d01ae0369fee4387f717101c40896467e74e3cf77bc82acb2a',
    filenames: [
      'settings-terminal-history-toggle-off-page-2.png',
      'settings-terminal-history-toggle-off.png',
      'settings-terminal-history-toggle-page-2.png',
      'settings-terminal-history-toggle.png',
    ],
  },
  'tests/e2e/sidebar-other-projects-activity.e2e.ts': {
    sourceSha256: 'be90e1cb2217e5eda526ab938d2279c6611addd18fe5fa82e8067e158394ff39',
    filenames: ['sidebar-unopened-activity-1600.png', 'sidebar-unopened-activity-800.png'],
  },
  'tests/e2e/terminal-display.e2e.ts': {
    sourceSha256: '50459641070bc6c2c4db648016f6345d95817acd1e277e737d779a943d519d5e',
    filenames: ['terminal-copse-strong-dark.png', 'terminal-copse-strong-light.png'],
  },
  'tests/e2e/thread-explainer-drawing.e2e.ts': {
    sourceSha256: 'b74fdd17867723f92331f6de0fdc7e2d3ae4ac23678836c07c25ef5a4f66245f',
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
    sourceSha256: '77f582553f6468a160782bd34eee9595c967ec8dc4c3b0babfbcf2f270c12e1f',
    filenames: [
      'explainer-scenes-1-player.png',
      'explainer-scenes-1.png',
      'explainer-scenes-2-player.png',
      'explainer-scenes-2.png',
    ],
  },
  'tests/e2e/thread-explainer.e2e.ts': {
    sourceSha256: '108e6da52fc4fe67d50ce042634bb5ef862fb652cc5c17c07399b1374d8745f7',
    filenames: ['thread-explainer-player.png'],
  },
}
