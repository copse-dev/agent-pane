import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import {
  baseSandboxConfig,
  ensureWorkspaceTmpDir,
  readOnlyWorkspaceSandboxOverlay,
  workspaceSandboxOverlay,
} from "./config.ts";
import {
  ASRT_FALLBACK_TMPDIR,
  sandboxTmpDirFor,
  withSandboxTmpEnv,
  withSandboxWrapTmpDir,
} from "./tmp-env.ts";

// Scratch probe for #4162: does the temp dir each overlay is given actually
// work under real macOS seatbelt, not just carry the right name?
const PROBE = [
  'printf "TMPDIR=%s\\n" "$TMPDIR"',
  'printf "CLAUDE_CODE_TMPDIR=%s\\n" "${CLAUDE_CODE_TMPDIR-}"',
  'if f=$(mktemp "$TMPDIR/copse-probe.XXXXXX" 2>/dev/null); then echo mktemp=ok; rm -f "$f"; else echo mktemp=fail; fi',
  'if d=$(mktemp -d 2>/dev/null); then echo mktemp-d=ok; rmdir "$d"; else echo mktemp-d=fail; fi',
  "if (: > /tmp/copse-escape-$$) 2>/dev/null; then echo system-tmp-write=allowed; rm -f /tmp/copse-escape-$$; else echo system-tmp-write=denied; fi",
].join("\n");

function probe(
  overlay: Partial<SandboxRuntimeConfig>,
  cwd: string,
): Promise<Map<string, string>> {
  const tmpDir = sandboxTmpDirFor(overlay, ensureWorkspaceTmpDir());
  return withSandboxWrapTmpDir(tmpDir, () =>
    SandboxManager.wrapWithSandboxArgv(PROBE, "/bin/sh", overlay),
  ).then(({ argv }) => {
    const [file = "", ...args] = argv;
    const result = spawnSync(file, args, {
      cwd,
      encoding: "utf8",
      env: withSandboxTmpEnv(process.env, tmpDir),
    });
    console.log(
      `[seatbelt-probe] tmpDir=${tmpDir} status=${String(result.status)}`,
    );
    console.log(result.stdout);
    if (result.stderr) console.log(`[seatbelt-probe] stderr: ${result.stderr}`);
    assert.equal(result.status, 0, result.stderr);
    const out = new Map<string, string>();
    for (const line of result.stdout.trim().split("\n")) {
      const at = line.indexOf("=");
      if (at > 0) out.set(line.slice(0, at), line.slice(at + 1));
    }
    return out;
  });
}

describe(
  "seatbelt temp-dir probe (#4162)",
  { skip: process.platform !== "darwin" },
  () => {
    it("writable overlay: TMPDIR is the workspace scratch dir and mktemp works there", async () => {
      const workspace = realpathSync(
        mkdtempSync(join(tmpdir(), "copse probe rw ")),
      );
      const before = process.env["CLAUDE_CODE_TMPDIR"];
      await SandboxManager.initialize(baseSandboxConfig(), undefined, false);
      try {
        const out = await probe(workspaceSandboxOverlay(workspace), workspace);
        assert.equal(out.get("TMPDIR"), ensureWorkspaceTmpDir());
        assert.equal(out.get("CLAUDE_CODE_TMPDIR"), ensureWorkspaceTmpDir());
        assert.equal(out.get("mktemp"), "ok");
        assert.equal(out.get("mktemp-d"), "ok");
        assert.equal(
          out.get("system-tmp-write"),
          "denied",
          "the sandbox must actually be active",
        );
        assert.equal(
          process.env["CLAUDE_CODE_TMPDIR"],
          before,
          "the wrap pin must not leak",
        );
      } finally {
        await SandboxManager.reset();
        rmSync(workspace, { recursive: true, force: true });
      }
    });

    it("read-only overlay: TMPDIR falls back to ASRT /tmp/claude", async () => {
      const workspace = realpathSync(
        mkdtempSync(join(tmpdir(), "copse probe ro ")),
      );
      const before = process.env["CLAUDE_CODE_TMPDIR"];
      await SandboxManager.initialize(baseSandboxConfig(), undefined, false);
      try {
        const out = await probe(
          readOnlyWorkspaceSandboxOverlay(workspace),
          workspace,
        );
        assert.equal(out.get("TMPDIR"), ASRT_FALLBACK_TMPDIR);
        assert.equal(
          out.get("system-tmp-write"),
          "denied",
          "the sandbox must actually be active",
        );
        // Informational: /tmp/claude may not exist on a fresh machine, which is
        // ASRT's own behaviour from before #4152 too. Logged above, not asserted.
        assert.equal(
          process.env["CLAUDE_CODE_TMPDIR"],
          before,
          "the wrap pin must not leak",
        );
      } finally {
        await SandboxManager.reset();
        rmSync(workspace, { recursive: true, force: true });
      }
    });
  },
);
