# G2 Voice Rebuild

## Acceptance Contract

- Capture only through Even Hub SDK `audioControl(true, AudioInputSource.Glasses)`
  and `onEvenHubEvent().audioEvent.audioPcm`. No browser microphone, substitute
  recorder, fixed transcript, demo fallback or microphone on the Mac.
- One G2 device instance and event subscription. Connection is single-flight;
  connected/connecting buttons cannot create another connection.
- Startup restores server authentication and connects the G2 SDK. S010 is the
  only allowed target, selected automatically. Internal IDs and diagnostics are
  not the primary screen.
- Record -> stop -> local speech recognition -> editable transcript -> send.
  No repeated confirmation dialogs. Never execute a transcript before Send.
- Local whisper.cpp consumes SDK PCM (16 kHz, signed 16-bit LE, mono). Audio is
  never sent to an external speech provider; temporary audio/transcripts are
  removed after success, cancellation and failure. No transcript is invented.
- Refresh/rotation and Even app credential restoration from the existing v0.4
  implementation are preserved. Browser Web Speech APIs are not used.
- First pairing opens a Telegram bot deep link carrying only the public OAuth
  user code. An owner-bound Approve/Reject button completes the existing device
  grant; access/refresh tokens are returned only through the OAuth token endpoint.
  Pairing does not start, stop, reset or switch a Codex session. Expired, denied,
  consumed, unapproved-client and wrong-owner decisions fail closed.
- Results return through G2 REST and glasses display, not Telegram. Telegram
  remains an independent route and is not evidence that G2 audio works.

## Work Status

1. SDK and existing implementation audit: complete.
2. Independent authenticated PCM transcription endpoint: implemented and tested.
3. Device lifecycle, actual recording and usable UI: implemented and tested.
4. Unit, API, real-browser, local recognizer validation: passed; details below.
5. Physical G2 microphone and relaunch validation: requires the physical device.

The maintained app source is `clients/even-g2`. Existing Mac app files and the
running RemoteAgent are not overwritten during development. Publishing or
restarting is not a substitute for physical audio validation.

## Verified, 2026-10-23 KST

- Server/API/OAuth/speech/runtime-lock tests: 30 passed.
- App unit tests: 58 passed, including SDK connection lifecycle and refresh.
- App real-browser tests: 9 passed, including native SDK audio frames, long
  press/release, no-audio rejection, decoder error preserving the draft, no
  automatic execution, result display on glasses, reconnect, and 320/390/1280 px.
- Telegram injection: passed owner-bound approval and existing-session preservation.
- Real OAuth device grant/refresh rotation/replay-family revocation: passed in a
  browser against the independent G2 server.
- Mac60 isolated HTTP test: real local Korean recognition, authenticated PCM
  endpoint and a synthetic session adapter passed. A 3.79-second macOS-generated
  Korean sample transcribed exactly. Warm decode took 432 ms; cold startup took
  7.18 seconds in a separate test. These are not promises of physical G2 latency.
- Build, typecheck and `.ehpk` packaging: passed. Minimum Even app version 2.2.10;
  `g2-microphone` permission is declared. No phone microphone permission.

Actual G2 microphone quality, background behavior, external Telegram deep-link
handling and host storage persistence across physical app upgrades remain device
checks. These checks do not claim physical-device success.

## Deployment, 2026-10-23 KST

RemoteAgent 0.32.0 is published on npm and installed on Mac60 using the canonical
release script, with local whisper.cpp enabled. G2 v0.5.0 is registered as a
Private build of `com.daone.gtwobasic`; it has not been promoted to beta/public.
S010 and existing state, secrets, allowed target and OAuth identity were preserved.
See RELEASING.md for exact commands, artifact hash and rollback backup.

On the physical device, update the Private app to v0.5.0. Existing credentials
are restored when the Even host retains them. If first pairing is needed, open
the app's Telegram approval link and use Approve in `@mac_mini_even_bot`, then
return to the app. No copying an approval code or browser form is needed.
Use the G2 long-press/release gesture or recording button, review the recognized
draft, and press Send. The instruction is sent only to S010; results return to
the app and glasses. Physical recording, pairing and upgrade persistence still
require this device check.

## Prepare Speech on Mac60

Run on Mac60, from the built RemoteAgent checkout or installed package directory:

```bash
node scripts/prepare-g2-speech.mjs \
  --whisper-bin /opt/homebrew/bin/whisper-cli \
  --model-dir /Users/appback/.cache/remoteagent-speech
```

The script verifies the local executable, prepares the multilingual small model
and pins the upstream SHA-1 `55356645c2b361a969dfd0ef2c5a50d530afd8d5`.
It does not change `.env`, restart a service or contact an external speech API.
Preparation and isolated recognition were executed on Mac60. The model is about
466 MiB. Audio/transcript temporary directories are private and removed after
success, failure or cancellation; only the public model weights are cached.

## Approved Activation Flow

After operator approval, release and publish through RELEASING.md, then use the
exact newly published version in the deployment command. Example for 0.32.0:

```bash
G2_SPEECH_MODEL=/Users/appback/.cache/remoteagent-speech/ggml-small.bin \
  npm run release:deploy -- 0.32.0 60
```

The helper checks idle work, snapshots the actual npm artifact for rollback,
installs the exact release, and applies only the speech executable/model paths.
It keeps the current G2 issuer, refresh grants, S010 allowlist and target key.
It does not re-enable dot or change another server. Publish the private Even app
package only after approval; packaging alone is not uploading or activation.

## Audio API

`GET /api/v1/capabilities` requires G2 OAuth and reports whether audio is configured.
`POST /api/v1/audio/transcriptions?targetId=<allowed-target-id>` requires the same
bearer token and `Content-Type: audio/pcm`. Body: SDK PCM bytes, 0.2 to 60 seconds,
maximum 1,920,000 bytes. Response: `{text,durationMs,processingMs}`. This endpoint
does not enqueue work. The user confirms text before the existing idempotent
`POST /api/v1/requests` route is called.

Only one local decoder runs at once; concurrent speech returns `SPEECH_BUSY`.
Missing decoder/model disables speech without stopping Telegram or text requests.
No speech, bad format, oversized input, disallowed target, decoder failure and
client cancellation are distinct failures, never substituted canned instructions.
