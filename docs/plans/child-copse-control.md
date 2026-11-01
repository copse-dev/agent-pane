# Child Copse computer use — PARKED PROTOTYPE

**Status: parked, draft only. Do not merge or enable as a host-isolation solution.**
The temporary profile separates app state but does not confine child commands. An agent
controlling approval dialogs can authorize host execution, which fails the intended safety
requirement. This branch is preserved for its session ownership, revocation and test work.
The replacement direction is a disposable Linux GUI inside the existing Apple-container VM
runtime, with no host-control fallback. The bespoke control-window UX is not the intended
final product flow.

Implementation is stacked on computer-use PR #3945, base
`94b26e6746d79f5ab7004946d58eb6b6618fee93`.

## Problem and acceptance

Development validation needs to drive setup and agent turns in another Copse instance.
The ordinary computer-use policy blocks Copse because driving the controlling instance
could approve the agent's own requests.

- One explicit launch approval creates a fresh child profile and disposable project directory.
- Only the requesting thread can address the returned opaque child target.
- Parent and unrelated Copse instances remain blocked, including when bundle grants are saved.
- A parent-owned window provides Stop. Closing it, expiry, child exit, or disabling computer use revokes control.
- Each native request checks the retained newly launched application, including window ownership;
  stale handles cannot attach to another instance or survive helper restart.
- Capture the approval and Stop UI, and exercise real child startup and interaction on macOS.

## Authority and limits

This is an explicit host-execution capability. The agent can operate approval dialogs inside
the child and authorize actions with the user's account access. A fresh profile separates
state; it does not contain execution. The approval states this directly and cannot be remembered.

The child starts the current checkout's built Electron entry through Launch Services. It has
a fresh `COPSE_DIR`; no existing profile is copied. Installed coding agents may still use their
normal system accounts. The agent should choose the returned disposable project directory
through normal project setup. Existing instances cannot be attached.

The parent retains session ownership; desktop targets are `child:<uuid>`, never raw PIDs.
The helper retains the `NSRunningApplication` returned by a new-instance launch and checks
termination before every scoped action. Main retains the session tag on stale PID requests
so they fail closed after revocation or helper restart. A session lasts at most 30 minutes.
Tool actions remain recorded through the normal transcript.

The Stop window belongs to the parent and is excluded by the ordinary Copse block. It has
no preload, Node access, external navigation, or script. Its sole form requests session stop.
Native process termination is best effort if the helper crashes; control is still revoked,
and the child may need closing manually.

## Validation

Focused coverage: child-copse-sessions, desktop-control-service, permission-gate-desktop,
computer-use-plugin and registry-bootstrap. Browser evidence:
`tests/demo/child-copse-control.demo.ts`. Native helper compilation and real child interaction
are separate from fixture evidence. A full `pnpm run check` is mandatory because this changes
permissions and a native process boundary.

### Local evidence (2026-11-01)

- All 66 focused tests passed. The normal build and the full check's static gates passed.
- The full check reached 15,995 passing tests, 201 failures and 100 cancellations before
  its outer deadline. Several failures explicitly report sandbox-denied loopback listeners;
  the failing set has not been compared with a clean base, so the full check is not green.
- A live native launch created a distinct child PID and a real product window. Parent bundle
  targets, another thread's access, and a child-scoped request for a parent window were denied.
- The parent Stop window was captured and inspected in light and dark themes at its actual
  440 × 328 content size. DOM geometry confirmed no vertical overflow, and clicking Stop invoked
  its callback in both previews. End-to-end child revocation remains pending validation.
- The native helper reports Accessibility and Screen Recording permissions as absent. Actual
  interaction and screen capture of the child remain unverified until macOS grants them.
