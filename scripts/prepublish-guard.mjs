#!/usr/bin/env node

if (process.env.REMOTEAGENT_PUBLISH_GUARD_OK === "1") {
  process.exit(0);
}

console.error([
  "Direct npm publish is blocked for appback-remoteagent.",
  "",
  "Use the documented release path instead:",
  "  npm run release:publish",
  "",
  "Reason:",
  "- direct publish has repeatedly used the wrong npm token",
  "- appback-remoteagent must be published only through the guarded script",
  "- emergency tarball installs are not completed releases",
].join("\n"));

process.exit(1);
