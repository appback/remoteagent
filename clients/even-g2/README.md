# Even G2 / S010

Version 0.5.0. This directory is the maintained source; the existing Mac copy
is not overwritten during development. The package ID remains
`com.daone.gtwobasic` to preserve Even app storage when updating.

## Use

1. On first launch, select Connect and open the Telegram approval link. The
   configured bot shows the requested targets and Approve/Reject buttons. Only
   the configured owner can approve. No browser form or copied approval code.
2. Return to the app. Future launches restore the rotating refresh token using
   the Even SDK host-app storage; the access token stays in memory.
3. Hold the G2 temple/ring input to record, then release, or use the Record/Stop
   button. Recording uses only the glasses microphone through the official SDK.
4. Review/edit the recognized text and select Send. Recording or transcribing
   never executes an instruction automatically. The only target is S010.
5. Responses appear in the app and on the glasses; swipe or use page buttons.

The SDK supplies 16 kHz signed 16-bit LE mono PCM, not speech-to-text. The
authenticated RemoteAgent endpoint decodes it with local whisper.cpp on Mac60.
No phone microphone, browser SpeechRecognition/getUserMedia, external speech
API key, model on the phone, canned transcript or mock runtime is used.

The SDK storage API does not promise hardware-backed encryption. It is not
described as Keychain. Refresh tokens rotate, replay revokes the token family,
and Disconnect removes the local credential and requests server revocation.

## Build and Verify

From this directory:

```bash
npm ci --ignore-scripts
npm test
npm run test:ui
npm run pack
npm run dev -- --port 5187 --strictPort
```

`test:ui` builds before running Playwright. Set `PLAYWRIGHT_EXECUTABLE` to an
installed Chromium binary when the default Playwright browser is unavailable.
Browser tests use the actual SDK with a synthetic native host and intercepted
HTTPS responses; they do not call production Telegram or a production session.
The build output is `g2-basic.ehpk`. App and server must both be updated to use
button approval and PCM transcription. An old server cannot accept the new
pairing or audio routes.

Ordinary desktop browsers can preview layout but cannot connect to real G2
hardware. The native bridge is supplied by the Even app, minimum version 2.2.10.

## References

- [Official audio/input APIs](https://hub.evenrealities.com/docs/build/device-apis)
- [Official manifest permissions](https://hub.evenrealities.com/docs/ship/packaging)
- `../../docs/G2_REBUILD.md`: server setup, acceptance criteria and validation.

`public/even.ico` is the Even Hub site favicon from
`https://hub.evenrealities.com/favicon.ico`, retained locally without a third-party
runtime image request.
