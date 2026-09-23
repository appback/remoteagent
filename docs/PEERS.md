# Telegram Peer Setup

This phase implements peer registration and a Telegram roundtrip check only.
Task submission, execution approvals and result forwarding are not implemented.
No provider/model is called during setup. Both installations need this feature.

## Receiver B

In B's owner chat, use `/switch <session>` to select the receiving session, then:

```text
/peer invite
```

The invitation targets the selected session's internal ID and expires in 30
minutes. Share it only with the sending installation's owner. The BotFather button
opens BotFather; select the corresponding bot and enable Bot-to-Bot Communication
Mode. Perform this for both A and B. RemoteAgent cannot toggle that Telegram
setting using its bot token and never claims to have done so.

## Sender A

```text
/peer add hub-admin <invitation>
/peer check hub-admin
/peer
```

`add` saves the destination and offers BotFather and connection-check buttons.
`check` sends one protocol probe. A success response from Telegram's sendMessage
is not verification: A waits for B's matching acknowledgement, from the bot ID
in the invitation. Only then is the most recent roundtrip recorded as verified.
No extra getUpdates worker is started; the existing poller delivers peer messages.
Verification allows ten minutes to accommodate slow polling. Rechecks are limited
to once per minute. No automatic probe retry runs in the background.

B accepts the first valid invitation holder, binds the grant to its numeric bot
ID, and rejects other senders. Subsequent checks use that binding. B checks that
its original owner chat is still bound to the target session before replying.
If it was switched or removed, issue a new invitation for the intended session.
Verification is historical evidence, not a continuous health or mode-status check.

## Removal and Storage

```text
# A: remove the outgoing alias
/peer remove hub-admin
# B: revoke the receiving grant using the ID displayed by /peer
/peer remove <invite-id>
```

Removal changes the local installation only. Revoking B's grant prevents future
checks even if A still displays an old verification timestamp.

State is saved atomically under `DATA_DIR/peers/<numeric-bot-id>.json` with mode
600. B stores only a hash of the invitation secret. A retains the pending secret
in this protected file until a successful check or manual removal. It is removed
after acknowledgement; there is no long-lived shared token in this phase.
The feature limits each bot to 50 incoming and 50 outgoing records. Remove unused
records with `/peer remove`. Protocol and invitation text are not logged or sent
to an agent. Incoming bot messages cannot run ordinary commands or create sessions.
They also do not update user-activity polling rank or trigger the stop-batch filter.

## Verification

```sh
npm run selftest:peer
npm run selftest:telegram
```

These use synthetic identities and mocked Telegram transport. They cover expiry,
forged/duplicate acknowledgements, sender pinning, restart, revocation, missing
session, command/buttons, redaction and no provider invocation. Real BotFather
settings and real cross-server delivery require a separate two-bot test.

Telegram specification: https://core.telegram.org/bots/features#bot-to-bot-communication
