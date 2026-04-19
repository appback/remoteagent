import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

type BodyInitLike =
  | string
  | Buffer
  | ArrayBuffer
  | ArrayBufferView
  | URLSearchParams
  | null
  | undefined;

function normalizeBody(body: BodyInitLike): Buffer | undefined {
  if (body == null) {
    return undefined;
  }

  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }

  if (body instanceof URLSearchParams) {
    return Buffer.from(body.toString(), "utf8");
  }

  if (Buffer.isBuffer(body)) {
    return body;
  }

  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }

  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }

  throw new TypeError("Unsupported fetch body type.");
}

export async function telegramFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const target = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url,
  );

  const requestInit = init ?? {};
  const method = requestInit.method ?? (input instanceof Request ? input.method : "GET");
  const headers = new Headers(input instanceof Request ? input.headers : undefined);

  if (requestInit.headers) {
    const extra = new Headers(requestInit.headers);
    extra.forEach((value, key) => headers.set(key, value));
  }

  const rawBody = requestInit.body ?? (input instanceof Request ? await input.arrayBuffer() : undefined);
  const body = normalizeBody(rawBody as BodyInitLike);
  if (body && !headers.has("content-length")) {
    headers.set("content-length", String(body.byteLength));
  }

  return await new Promise<Response>((resolve, reject) => {
    const client = target.protocol === "http:" ? http : https;
    const req = client.request(target, {
      method,
      headers: Object.fromEntries(headers.entries()),
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on("end", () => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) {
            responseHeaders.set(key, value.join(", "));
          } else if (value !== undefined) {
            responseHeaders.set(key, value);
          }
        }

        resolve(new Response(Buffer.concat(chunks), {
          status: res.statusCode ?? 500,
          statusText: res.statusMessage ?? "",
          headers: responseHeaders,
        }));
      });
    });

    req.on("error", reject);

    if (requestInit.signal) {
      if (requestInit.signal.aborted) {
        req.destroy(new Error("The operation was aborted."));
        return;
      }

      requestInit.signal.addEventListener("abort", () => {
        req.destroy(new Error("The operation was aborted."));
      }, { once: true });
    }

    if (body) {
      req.write(body);
    }
    req.end();
  });
}
