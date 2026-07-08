#!/usr/bin/env node

if (process.env.REMOTEAGENT_PUBLISH_GUARD_OK === "1") {
  process.exit(0);
}

console.error([
  "RemoteAgent publishes through the guarded release command.",
  "",
  "Command:",
  "  npm run release:publish",
  "",
  "This command checks the working tree, npm identity, package owner, build, pack, publish, and registry version.",
].join("\n"));

process.exit(1);
