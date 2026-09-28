# Webaton frontend bridge (initial integration)

Webaton and Telegram use the same BridgeService session records, events and
provider execution. The optional API listens only on 127.0.0.1:3795.
Enable it with WEBATON_BRIDGE_TOKEN (at least 32 characters); configure the same
secret in Webaton's backend environment. Never expose it to browser JavaScript.
WEBATON_BRIDGE_PORT optionally changes the port on both services.

Endpoints, all requiring Authorization: Bearer:
- GET /sessions
- GET /sessions/:id/events
- POST /sessions/:id/messages {"message":"..."}
- POST /sessions/:id/stop {}

Webaton must retain its owner authentication and proxy these endpoints server-side.
Browser Origin headers are rejected; requests are bounded to 16 KiB / 4000 message
characters. Message requests currently wait for the provider response; event polling
can read session logs independently. This is a personal owner API, not multitenant.

Validation: npm run build; node scripts/selftest-webaton.mjs.
No running installation is upgraded by adding this source.

Remaining: web session creation, progress UI, browser MCP action/observation
integration, Gemini provider adapter, and live end-to-end browser task validation.
Jev remains in the existing RemoteAgent execution/review path.
