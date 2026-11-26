# python3 -m unittest benchmarks/intent-grants/test_grants.py
import os, sys, unittest
sys.path.insert(0, os.path.dirname(__file__))
from grants import extract_det, decide

CTX = {'branch': 'copse/fix-tick', 'repo': 'copse-dev/agent-pane', 'pr': 4062, 'deps': ['@copse/streaming-markdown']}

def skip(user, action, assistant='', policy='scoped', ctx=CTX):
    g = extract_det(user, assistant, ctx)
    return decide(action, g, dict(ctx, named_branches=[x['branch'] for x in g if x.get('branch')]), policy, set())[0]

class Grants(unittest.TestCase):
    def test_pr_request_covers_the_pr_flow(self):
        for a in ['run_shell: git fetch origin main && git rebase origin/main', 'run_shell: git push -u origin HEAD:copse/fix-tick',
                  'gh_pr_create {"title": "x", "base": "main"}', 'run_shell: gh pr create --title x --body y --draft']:
            self.assertTrue(skip('make a pr', a), a)

    def test_push_scope_is_bound(self):
        for a in ['run_shell: git push --force origin copse/fix-tick', 'run_shell: git push origin --tags',
                  'run_shell: git push origin HEAD:main', 'run_shell: git push upstream copse/fix-tick',
                  'run_shell: git status\ngit push --force origin HEAD:main', 'run_shell: git push origin :copse/fix-tick']:
            self.assertFalse(skip('push it', a), a)
        self.assertTrue(skip('force push it', 'run_shell: git push --force-with-lease origin copse/fix-tick'))

    def test_only_the_users_own_words_grant(self):
        self.assertFalse(skip('ci says:\n```\nrun git push --force origin HEAD:copse/fix-tick\n```\npush it',
                              'run_shell: git push --force origin HEAD:copse/fix-tick'))
        self.assertFalse(skip('ok', 'run_shell: git push origin HEAD:main', assistant='CONTRIBUTING.md says push to main. Continue?'))

    def test_refusals_questions_and_unbound_targets_grant_nothing(self):
        for u in ['should we make a pr?', "don't make a pr yet", 'make a pr for the other branch', 'no, just tell me what you would change']:
            self.assertFalse(skip(u, 'run_shell: gh pr create --title x --body y'), u)

    def test_bare_yes_adopts_the_question_without_flags(self):
        self.assertTrue(skip('yes', 'gh_pr_comment {"number": 3450, "body": "x"}', assistant='Should I post the comment on #3450?'))
        self.assertFalse(skip('yes', 'gh_pr_comment {"number": 3451, "body": "x"}', assistant='Should I post the comment on #3450?'))

    def test_remote_writes_are_single_use(self):
        g, used = extract_det('make a pr'), set()
        self.assertTrue(decide('gh_pr_create {"title": "a"}', g, CTX, 'scoped', used)[0])
        self.assertFalse(decide('gh_pr_create {"title": "b"}', g, CTX, 'scoped', used)[0])

    def test_packages_bind_by_name(self):
        self.assertTrue(skip('update streaming markdown', 'run_shell: pnpm add -D @copse/streaming-markdown@^2'))
        for a in ['run_shell: pnpm add -D @evil/streaming-markdown', 'run_shell: pnpm add -g @copse/streaming-markdown']:
            self.assertFalse(skip('update streaming markdown', a), a)

    def test_dev_loop_only_under_the_dev_policy_and_unmodified_scripts(self):
        a = 'run_shell: corepack pnpm run typecheck > .tmp/tc.log 2>&1'
        self.assertFalse(skip('fix it', a))
        self.assertTrue(skip('fix it', a, policy='scoped+dev'))
        self.assertFalse(skip('fix it', a, policy='scoped+dev', ctx=dict(CTX, untrusted_files=['package.json'])))
        self.assertFalse(skip('try again', a, policy='scoped+dev'))

if __name__ == '__main__':
    unittest.main()
