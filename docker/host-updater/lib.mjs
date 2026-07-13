// Pure helpers for the updater server — dependency-free, tested with node --test.

export const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidVersion(v) {
  return typeof v === "string" && VERSION_RE.test(v);
}

/** Replace (or append) the TAG= line, preserving everything else verbatim. */
export function rewriteTag(envContent, version) {
  const lines = envContent.split("\n");
  let found = false;
  const out = lines.map((line) => {
    if (line.startsWith("TAG=")) {
      found = true;
      return `TAG=${version}`;
    }
    return line;
  });
  if (!found) {
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    out.push(`TAG=${version}`, "");
  }
  return out.join("\n");
}

/** Minimal .env parse — KEY=VALUE lines only (matches what the installer writes). */
export function parseEnv(envContent) {
  const env = {};
  for (const line of envContent.split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

/** Installer-managed check: the apply path needs .env with INTERLOOM_DIR (absolute
 * host path for the finisher bind). Repo-managed dev stacks fail this — they update
 * by re-pulling their checkout's compose instead. */
export function managedState(envContent) {
  if (envContent === null) return { managed: false, reason: "no_env_file" };
  const env = parseEnv(envContent);
  if (!env.INTERLOOM_DIR) return { managed: false, reason: "no_interloom_dir" };
  return { managed: true };
}
