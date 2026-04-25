# COKACDIR Notes

## What was referenced

`cokacdir` was used as a reference point for product shape, not as a codebase to mirror exactly.

The useful high-level ideas are:

- installable owner-run runtime
- Telegram as a remote control surface for an existing coding agent
- no separate hosted AI backend required
- local session persistence
- strong operator tooling around logs, processes, and files

## What `cokacdir` appears to optimize for

From its public README and local repository layout, `cokacdir` is broader than RemoteAgent.
It combines:

- Telegram bot control
- multi-provider execution
- terminal/file manager style tooling
- process management
- SSH/SFTP and other power-user utilities
- a larger installable desktop/runtime surface

That is a different product envelope from RemoteAgent.

## What RemoteAgent should borrow

The main lessons worth borrowing are operational, not cosmetic:

1. one installable runtime per owner
2. stable local state directories
3. explicit environment-driven configuration
4. practical operator commands for logs, status, and process control
5. Telegram as a client of the runtime, not the source of truth

## What RemoteAgent should not copy blindly

RemoteAgent is intentionally narrower.
It should not drift into a giant terminal/file-manager product just because `cokacdir` supports that.

RemoteAgent should stay focused on:

- personal session runtime
- Codex/Claude style provider adapters
- Telegram and future local chat UI over the same session model
- predictable session/workspace ownership
- safe process lifecycle

## Key difference in current implementation

A critical design decision for RemoteAgent is:

- server 30 is the canonical runtime for `codex_remoteagent_bot`
- local machine 21 is separate for `sqream_bot`
- runtime ownership matters more than chat UX convenience

This means RemoteAgent must care deeply about:

- which machine owns the provider session
- where the workspace actually lives
- where the runtime state is stored
- which exact process is answering Telegram

That last point became important during the image-send incident.
The bug felt like an attachment bug, but the root problem was that multiple runtime generations could coexist.

## Current conclusion

`cokacdir` is a useful reference for the installable Telegram-controlled agent idea.
But RemoteAgent should keep its own simpler model:

```text
Telegram/local UI -> single local runtime -> provider adapters -> local sessions/workspaces
```

The value is continuity across the owner's own machines and sessions, not reproducing every feature from a broader terminal product.
