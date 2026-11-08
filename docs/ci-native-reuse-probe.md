# Bounded CI metadata reuse event probe

This temporary PR exercises real pull-request events with the complete Copse CI workflow. Its base includes the production change from PR #4288 plus a three-condition allowlist substitution for this controlled base branch. Main and its branch rules are unchanged. All verification workloads remain real and unchanged. The source run must finish successfully before one title/body edit can attempt to reuse its native results. No statuses are copied; no no-op jobs replace verification. This fixture is not intended to merge.
