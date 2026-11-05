// Evaluates `.dockerignore` the way BuildKit selects the build context
// (moby/patternmatcher and the tonistiigi/fsutil walk in BuildKit 0.33), so
// policy tests can check what a build receives without running Docker.
import { posix } from "node:path";

// Go's filepath.Clean for slash paths: no empty, "." or resolvable ".."
// segments and no trailing slash.
function clean(path) {
  const normalized = posix.normalize(path);
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

// "**" spans any number of directories (none included), "*" and "?" stay
// within one, and character classes pass through as in Go.
function compile(pattern) {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      i += pattern[i + 2] === "/" ? 2 : 1;
      source += i + 1 === pattern.length ? ".*" : "(.*/)?";
    } else if (ch === "*") {
      source += "[^/]*";
    } else if (ch === "?") {
      source += "[^/]";
    } else if (".+()|{}$".includes(ch)) {
      source += `\\${ch}`;
    } else if (ch === "\\") {
      if (i + 1 === pattern.length) throw new Error(`trailing backslash in ${pattern}`);
      source += `\\${pattern[++i]}`;
    } else {
      source += ch;
    }
  }
  return new RegExp(`${source}$`);
}

export function readDockerignore(text) {
  const rules = [];
  for (const line of text.replace(/^﻿/, "").split("\n")) {
    // Only a "#" in the first column starts a comment.
    if (line.startsWith("#")) continue;
    let pattern = line.trim();
    const exception = pattern.startsWith("!");
    if (exception) pattern = pattern.slice(1).trim();
    if (!pattern) continue;
    pattern = clean(pattern);
    if (pattern.length > 1 && pattern.startsWith("/")) pattern = pattern.slice(1);
    rules.push({ exception, pattern, regexp: compile(pattern) });
  }
  return rules;
}

// The last rule that matches the path, or one of its parent directories,
// decides; a "!" exception puts the path back.
function excluded(rules, path) {
  const parents = path.split("/").slice(0, -1);
  let matched = false;
  for (const rule of rules) {
    if (rule.exception !== matched) continue;
    let hit = rule.regexp.test(path);
    for (let depth = 1; !hit && depth <= parents.length; depth++) {
      hit = rule.regexp.test(parents.slice(0, depth).join("/"));
    }
    if (hit) matched = !rule.exception;
  }
  return matched;
}

// An exception's path without a trailing "/**" or "/*".
const exceptionPrefix = (rule) => rule.pattern.replace(/\/\*\*$/, "").replace(/\/\*$/, "");

// BuildKit skips an excluded directory only while every exception is a plain
// path. With one wildcard exception it walks every excluded directory, and
// the last matching rule decides for each file inside.
export function skipsExcludedDirectories(rules) {
  return rules.every((rule) => !rule.exception || !/[*[\]?^\\]/.test(exceptionPrefix(rule)));
}

export function inBuildContext(rules, path) {
  const parts = path.split("/");
  if (skipsExcludedDirectories(rules)) {
    for (let depth = 1; depth < parts.length; depth++) {
      const dir = parts.slice(0, depth).join("/");
      const reopened = rules.some((rule) => rule.exception && `${exceptionPrefix(rule)}/`.startsWith(`${dir}/`));
      if (!reopened && excluded(rules, dir)) return false;
    }
  }
  return !excluded(rules, path);
}
