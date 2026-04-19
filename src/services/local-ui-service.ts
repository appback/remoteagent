import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import type { BridgeService } from "./bridge-service.js";

type JsonObject = Record<string, unknown>;

export class LocalUiService {
  private server?: http.Server;

  constructor(
    private readonly bridge: BridgeService,
    private readonly host: string,
    private readonly port: number,
  ) {}

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response).catch((error: unknown) => {
        console.error("Local UI request failed:", error);
        if (!response.headersSent) {
          this.sendJson(response, 500, { error: "Internal server error." });
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, this.host, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", `http://${this.host}:${this.port}`);
    const pathname = url.pathname;

    if (method === "GET" && pathname === "/") {
      this.sendHtml(response, INDEX_HTML);
      return;
    }

    if (method === "GET" && pathname === "/api/sessions") {
      const sessions = await this.bridge.listSessions();
      this.sendJson(response, 200, { sessions });
      return;
    }

    const eventsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
    if (method === "GET" && eventsMatch) {
      const sessionId = decodeURIComponent(eventsMatch[1]);
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? Number.parseInt(limitParam, 10) : 200;
      const events = await this.bridge.sessionEvents(sessionId, Number.isFinite(limit) ? limit : 200);
      this.sendJson(response, 200, { events });
      return;
    }

    const messageMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (method === "POST" && messageMatch) {
      const sessionId = decodeURIComponent(messageMatch[1]);
      const body = await this.readJsonBody(request);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message) {
        this.sendJson(response, 400, { error: "Message is required." });
        return;
      }

      const responses = await this.bridge.routeSessionMessage(sessionId, message);
      this.sendJson(response, 200, {
        responses: responses.map((item) => ({
          provider: item.provider,
          sessionId: item.sessionId,
          cwd: item.cwd,
          output: item.output,
        })),
      });
      return;
    }

    this.sendJson(response, 404, { error: "Not found." });
  }

  private async readJsonBody(request: IncomingMessage): Promise<JsonObject> {
    const chunks: Buffer[] = [];

    await new Promise<void>((resolve, reject) => {
      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on("end", resolve);
      request.on("error", reject);
    });

    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) {
      return {};
    }

    try {
      const parsed = JSON.parse(raw) as JsonObject;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private sendHtml(response: ServerResponse, body: string): void {
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(body);
  }

  private sendJson(response: ServerResponse, statusCode: number, body: JsonObject): void {
    response.statusCode = statusCode;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(body));
  }
}

const INDEX_HTML = String.raw`<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>remoteagent</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101318;
      --panel: #171b22;
      --panel-2: #1e2430;
      --line: #2b3342;
      --text: #f5f7fb;
      --muted: #9ca7b8;
      --accent: #4ec9b0;
      --accent-2: #6fb1ff;
      --danger: #ff7a7a;
    }

    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    .app {
      display: grid;
      grid-template-columns: 320px 1fr;
      min-height: 100vh;
    }

    .sidebar {
      border-right: 1px solid var(--line);
      background: var(--panel);
      padding: 16px;
    }

    .content {
      display: grid;
      grid-template-rows: auto 1fr auto;
      min-height: 100vh;
    }

    .header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--line);
      background: rgba(23, 27, 34, 0.9);
      position: sticky;
      top: 0;
      backdrop-filter: blur(8px);
    }

    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 18px; }
    .subtle { color: var(--muted); }

    .session-list {
      margin-top: 16px;
      display: grid;
      gap: 8px;
    }

    button, textarea {
      font: inherit;
    }

    .session-item,
    .send-button,
    .refresh-button {
      border: 1px solid var(--line);
      border-radius: 8px;
    }

    .session-item {
      width: 100%;
      background: var(--panel-2);
      color: var(--text);
      text-align: left;
      padding: 12px;
      cursor: pointer;
    }

    .session-item.active {
      border-color: var(--accent-2);
      box-shadow: inset 0 0 0 1px var(--accent-2);
    }

    .session-item strong {
      display: block;
      margin-bottom: 2px;
    }

    .session-item .meta {
      color: var(--muted);
      font-size: 12px;
      word-break: break-word;
    }

    .toolbar {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-top: 12px;
    }

    .refresh-button,
    .send-button {
      background: var(--panel-2);
      color: var(--text);
      padding: 9px 12px;
      cursor: pointer;
    }

    .send-button {
      background: var(--accent);
      border-color: var(--accent);
      color: #08120f;
      font-weight: 600;
    }

    .refresh-button:disabled,
    .send-button:disabled,
    .session-item:disabled {
      opacity: 0.6;
      cursor: default;
    }

    .events {
      padding: 20px;
      display: grid;
      gap: 12px;
      align-content: start;
      overflow: auto;
    }

    .event {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: var(--panel);
    }

    .event .meta {
      margin-bottom: 8px;
      color: var(--muted);
      font-size: 12px;
    }

    .event pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    .composer {
      border-top: 1px solid var(--line);
      padding: 16px 20px;
      background: var(--panel);
    }

    textarea {
      width: 100%;
      min-height: 120px;
      resize: vertical;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: #0f141c;
      color: var(--text);
    }

    .composer-row {
      margin-top: 10px;
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
    }

    .status {
      color: var(--muted);
      min-height: 20px;
    }

    .status.error {
      color: var(--danger);
    }

    .empty {
      color: var(--muted);
      padding: 8px 0;
    }

    @media (max-width: 900px) {
      .app {
        grid-template-columns: 1fr;
      }

      .sidebar {
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <h1>remoteagent</h1>
      <p class="subtle">Local session console</p>
      <div class="toolbar">
        <button id="refreshSessions" class="refresh-button" type="button">Refresh</button>
      </div>
      <div id="sessionList" class="session-list"></div>
    </aside>
    <main class="content">
      <header class="header">
        <h2 id="sessionTitle">No session selected</h2>
        <p id="sessionMeta" class="subtle">Choose a session from the left.</p>
      </header>
      <section id="events" class="events">
        <div class="empty">No events yet.</div>
      </section>
      <section class="composer">
        <textarea id="messageInput" placeholder="Send a message to the selected session"></textarea>
        <div class="composer-row">
          <div id="status" class="status"></div>
          <button id="sendMessage" class="send-button" type="button">Send</button>
        </div>
      </section>
    </main>
  </div>
  <script>
    const state = {
      sessions: [],
      selectedSessionId: null,
      sending: false,
    };

    const elements = {
      sessionList: document.getElementById("sessionList"),
      sessionTitle: document.getElementById("sessionTitle"),
      sessionMeta: document.getElementById("sessionMeta"),
      events: document.getElementById("events"),
      messageInput: document.getElementById("messageInput"),
      sendMessage: document.getElementById("sendMessage"),
      refreshSessions: document.getElementById("refreshSessions"),
      status: document.getElementById("status"),
    };

    elements.refreshSessions.addEventListener("click", () => {
      void loadSessions();
    });

    elements.sendMessage.addEventListener("click", () => {
      void sendMessage();
    });

    async function fetchJson(url, options) {
      const response = await fetch(url, options);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Request failed.");
      }
      return data;
    }

    function setStatus(message, isError = false) {
      elements.status.textContent = message || "";
      elements.status.classList.toggle("error", isError);
    }

    function renderSessions() {
      const sessions = state.sessions;
      elements.sessionList.innerHTML = "";

      if (sessions.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No sessions found.";
        elements.sessionList.appendChild(empty);
        return;
      }

      for (const session of sessions) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "session-item";
        if (session.sessionId === state.selectedSessionId) {
          button.classList.add("active");
        }
        button.innerHTML = [
          "<strong>" + escapeHtml(session.publicId) + " · " + escapeHtml(session.mode) + "</strong>",
          "<div class=\"meta\">" + escapeHtml(session.workspace) + "</div>",
          "<div class=\"meta\">updated " + escapeHtml(session.updatedAt) + "</div>",
        ].join("");
        button.addEventListener("click", () => {
          state.selectedSessionId = session.sessionId;
          renderSessions();
          renderSessionHeader();
          void loadEvents();
        });
        elements.sessionList.appendChild(button);
      }
    }

    function renderSessionHeader() {
      const session = state.sessions.find((item) => item.sessionId === state.selectedSessionId);
      if (!session) {
        elements.sessionTitle.textContent = "No session selected";
        elements.sessionMeta.textContent = "Choose a session from the left.";
        return;
      }

      elements.sessionTitle.textContent = session.publicId + " · " + session.mode;
      elements.sessionMeta.textContent = session.workspace;
    }

    function renderEvents(events) {
      elements.events.innerHTML = "";
      if (!events.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No events yet.";
        elements.events.appendChild(empty);
        return;
      }

      for (const event of events) {
        const card = document.createElement("article");
        card.className = "event";
        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = event.timestamp + " · " + event.provider + " · " + event.direction;
        const body = document.createElement("pre");
        body.textContent = event.text || "";
        card.appendChild(meta);
        card.appendChild(body);
        elements.events.appendChild(card);
      }

      elements.events.scrollTop = elements.events.scrollHeight;
    }

    async function loadSessions() {
      setStatus("Loading sessions...");
      const data = await fetchJson("/api/sessions");
      state.sessions = data.sessions || [];

      if (!state.selectedSessionId && state.sessions.length > 0) {
        state.selectedSessionId = state.sessions[0].sessionId;
      }
      if (state.selectedSessionId && !state.sessions.some((item) => item.sessionId === state.selectedSessionId)) {
        state.selectedSessionId = state.sessions[0] ? state.sessions[0].sessionId : null;
      }

      renderSessions();
      renderSessionHeader();
      await loadEvents();
      setStatus("");
    }

    async function loadEvents() {
      if (!state.selectedSessionId) {
        renderEvents([]);
        return;
      }

      const data = await fetchJson("/api/sessions/" + encodeURIComponent(state.selectedSessionId) + "/events?limit=200");
      renderEvents(data.events || []);
    }

    async function sendMessage() {
      if (!state.selectedSessionId || state.sending) {
        return;
      }

      const message = elements.messageInput.value.trim();
      if (!message) {
        setStatus("Write a message first.", true);
        return;
      }

      state.sending = true;
      elements.sendMessage.disabled = true;
      setStatus("Sending...");

      try {
        await fetchJson("/api/sessions/" + encodeURIComponent(state.selectedSessionId) + "/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        });
        elements.messageInput.value = "";
        await loadSessions();
        setStatus("Sent.");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Failed to send.", true);
      } finally {
        state.sending = false;
        elements.sendMessage.disabled = false;
      }
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;")
        .replaceAll("'", "&#39;");
    }

    void loadSessions().catch((error) => {
      setStatus(error instanceof Error ? error.message : "Failed to load sessions.", true);
    });
  </script>
</body>
</html>
`;
