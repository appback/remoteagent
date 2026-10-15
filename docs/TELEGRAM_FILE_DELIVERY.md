# Telegram file delivery

The model emits TELEGRAM_FILE with an absolute path. RemoteAgent uploads it to the
current reply chat. ZIP files use the same document path; this patch does not create
archives automatically or modify originals.

## Connection recovery

- curl uses IPv4, a 15-second connect timeout and a 120-second total timeout.
- Upload byte metrics are collected separately from the JSON API response.
- DNS/connect/TLS setup failures (curl 6/7/35) with no reported upload can retry.
- Timeout/empty reply/send/receive failures (28/52/55/56) retry only when metrics
  explicitly confirm zero uploaded bytes. Missing metrics in these cases are uncertain.
- Maximum three total attempts, with 1.5-second and 3-second delays between connection
  retries. Telegram 429 uses the existing retry_after gate within the same budget.
- Certificate/local file errors do not trigger a network retry. When bytes were
  uploaded, a lost response leaves delivery uncertain; there is no automatic replay.
  Telegram's sendDocument has no deduplication key here.
- Normal attachments, progress attachments and encrypted Secret exports share the
  delivery function. Progress retains best-effort delivery and skips rate-limited work.
- Transport exceptions expose curl code, upload bytes and a redacted stderr line.
  The original execFile error (which includes the full token-bearing command) is
  not propagated. Generic Telegram error formatting also masks bot tokens.

An image around 2 MB failing with curl 35 is a connection failure, not evidence of a
size limit. Compression may reduce upload duration but cannot establish its root cause.

## Validation

```bash
npm run build
node scripts/selftest-telegram-upload.mjs
node scripts/selftest-telegram-update.mjs
```

Synthetic runner tests cover zero/partial/unknown uploads, safe retry classification,
TLS/certificate/local failures, metric stripping and token redaction. Telegram update
injection fails the first Secret document upload with curl 35, then checks one retry,
successful archive delivery and absence of the raw command/token in replies. These
are mock network tests, not a diagnosis of the live Telegram network or a live resend.
