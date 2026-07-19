#!/usr/bin/env node
/**
 * Builds the single-file ESM bundle both plugin packagings ship —
 * `dist/interloom-mcp.js` — and copies it to `plugins/claude-code/server`
 * and `plugins/codex/server`.
 *
 * FRESHNESS: the copies under each plugin's `server` directory are
 * committed build artifacts (a documented exception — git-installable
 * plugins need the bundle present without a build step on the operator's
 * machine). Whenever anything under `packages/frontier-mcp/src` changes,
 * re-run this script (`pnpm --filter @interloom/frontier-mcp bundle`) and
 * commit the refreshed copies in the SAME commit as the source change — a
 * stale bundle is a silent regression nobody's typecheck catches. The
 * bundle smoke test (`test/bundle-smoke.test.ts`) only proves the committed
 * bundle boots and still lists the 10 tools; it cannot prove the bundle
 * matches the current source. Review diffs to the committed
 * `interloom-mcp.js` copies accordingly.
 */
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const repoRoot = path.resolve(pkgRoot, "..", "..");
const outfile = path.join(pkgRoot, "dist", "interloom-mcp.js");

await build({
  entryPoints: [path.join(pkgRoot, "src", "bin.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  external: [],
  logLevel: "info",
  // ws (a bundled CJS dep) requires Node builtins at module-eval time; ESM
  // output has no ambient `require`, so esbuild's own CJS-interop shim
  // throws "Dynamic require ... is not supported" without this. Standard
  // esbuild workaround for bundling CJS deps into a Node ESM entrypoint.
  banner: {
    js: "import { createRequire as __interloomCreateRequire } from 'node:module';\nconst require = __interloomCreateRequire(import.meta.url);",
  },
});

const destinations = [
  path.join(repoRoot, "plugins", "claude-code", "server", "interloom-mcp.js"),
  path.join(repoRoot, "plugins", "codex", "server", "interloom-mcp.js"),
];

for (const dest of destinations) {
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(outfile, dest);
  console.log(`copied bundle -> ${path.relative(repoRoot, dest)}`);
}
