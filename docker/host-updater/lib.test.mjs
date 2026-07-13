import test from "node:test";
import assert from "node:assert/strict";
import { isValidVersion, rewriteTag, parseEnv, managedState } from "./lib.mjs";

test("accepts CI-stamped versions and latest, rejects shell metacharacters", () => {
  assert.equal(isValidVersion("2026.07.12-27d3674"), true);
  assert.equal(isValidVersion("latest"), true);
  assert.equal(isValidVersion("v1; rm -rf /"), false);
  assert.equal(isValidVersion(""), false);
  assert.equal(isValidVersion("-starts-with-dash"), false);
  assert.equal(isValidVersion(undefined), false);
});

test("rewriteTag replaces the TAG line and preserves everything else", () => {
  const env = "NETWORK_URL=https://x\nDOCKER_ORG=cameron59061\nTAG=latest\nGPU=0\n";
  const out = rewriteTag(env, "2026.07.12-27d3674");
  assert.match(out, /^TAG=2026\.07\.12-27d3674$/m);
  assert.doesNotMatch(out, /^TAG=latest$/m);
  assert.match(out, /^DOCKER_ORG=cameron59061$/m);
  assert.match(out, /^GPU=0$/m);
});

test("rewriteTag appends when no TAG line exists", () => {
  const out = rewriteTag("NETWORK_URL=https://x\n", "abc");
  assert.match(out, /^TAG=abc$/m);
});

test("parseEnv reads installer-written keys and ignores comments", () => {
  const env = parseEnv("TAG=latest\nINTERLOOM_DIR=/home/josh/.interloom\nGPU=1\n# HF_TOKEN=hf_x\n");
  assert.equal(env.INTERLOOM_DIR, "/home/josh/.interloom");
  assert.equal(env.GPU, "1");
  assert.equal(env.TAG, "latest");
  assert.equal(Object.keys(env).length, 3);
});

test("managedState reports no_env_file when .env is missing", () => {
  assert.deepEqual(managedState(null), { managed: false, reason: "no_env_file" });
});

test("managedState reports no_interloom_dir when .env lacks INTERLOOM_DIR", () => {
  const env = "TAG=latest\nDOCKER_ORG=cameron59061\nGPU=0\n";
  assert.deepEqual(managedState(env), { managed: false, reason: "no_interloom_dir" });
});

test("managedState reports managed true (no reason key) for installer-shaped .env", () => {
  const env = "TAG=latest\nINTERLOOM_DIR=/home/josh/.interloom\nGPU=1\n";
  const result = managedState(env);
  assert.equal(result.managed, true);
  assert.equal("reason" in result, false);
});
