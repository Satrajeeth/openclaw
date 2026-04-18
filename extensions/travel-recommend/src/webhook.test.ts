import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { createMockServerResponse } from "../../../test/helpers/plugins/mock-http-response.js";
import type { TravelPluginConfig } from "./config.js";
import { TravelStore } from "./store.js";
import { createTravelWebhook } from "./webhook.js";

type MockReq = IncomingMessage & { socket: { remoteAddress: string } };

function createReq(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}): MockReq {
  const req = new EventEmitter() as MockReq;
  req.method = options.method ?? "POST";
  req.url = "/travel-ingest";
  req.headers = {
    "content-type": "application/json",
    ...options.headers,
  };
  req.socket = { remoteAddress: "127.0.0.1" } as MockReq["socket"];
  (req as unknown as { destroy: () => void; destroyed: boolean }).destroyed = false;
  (req as unknown as { destroy: () => void; destroyed: boolean }).destroy = () => {
    (req as unknown as { destroyed: boolean }).destroyed = true;
    req.emit("close");
  };
  const bodyBuf = options.body
    ? Buffer.isBuffer(options.body)
      ? options.body
      : Buffer.from(options.body)
    : undefined;
  void Promise.resolve().then(() => {
    if (bodyBuf) {
      req.emit("data", bodyBuf);
    }
    req.emit("end");
  });
  return req;
}

function createStore(): TravelStore {
  const cfg = {
    storePath: ":memory:",
    webhookSecret: "test-secret",
    maxResults: 5,
    ttlSweepIntervalMs: 60_000,
    maxIngestItems: 10,
  } satisfies TravelPluginConfig;
  return new TravelStore(cfg);
}

function cfg(overrides: Partial<TravelPluginConfig> = {}): TravelPluginConfig {
  return {
    storePath: ":memory:",
    webhookSecret: "test-secret",
    maxResults: 5,
    ttlSweepIntervalMs: 60_000,
    maxIngestItems: 10,
    ...overrides,
  };
}

describe("createTravelWebhook", () => {
  it("returns 401 and writes nothing on wrong secret", async () => {
    const store = createStore();
    const handler = createTravelWebhook(store, cfg()).handler;
    const res = createMockServerResponse();
    await handler(
      createReq({
        headers: { "x-webhook-secret": "wrong" },
        body: JSON.stringify({ items: [{ id: "1", category: "x", name: "x" }] }),
      }),
      res,
    );
    expect(res.statusCode).toBe(401);
    expect(store.getById("1")).toBeNull();
  });

  it("returns 415 when content-type is not JSON", async () => {
    const store = createStore();
    const handler = createTravelWebhook(store, cfg()).handler;
    const res = createMockServerResponse();
    await handler(
      createReq({
        headers: { "content-type": "text/plain", "x-webhook-secret": "test-secret" },
        body: "hello",
      }),
      res,
    );
    expect(res.statusCode).toBe(415);
  });

  it("returns 405 for non-POST methods", async () => {
    const store = createStore();
    const handler = createTravelWebhook(store, cfg()).handler;
    const res = createMockServerResponse();
    await handler(
      createReq({ method: "GET", headers: { "x-webhook-secret": "test-secret" } }),
      res,
    );
    expect(res.statusCode).toBe(405);
  });

  it("returns 400 with error detail for schema violations", async () => {
    const store = createStore();
    const handler = createTravelWebhook(store, cfg()).handler;
    const res = createMockServerResponse();
    await handler(
      createReq({
        headers: { "x-webhook-secret": "test-secret" },
        body: JSON.stringify({ items: [{ id: "1" }] }),
      }),
      res,
    );
    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse(String((res as unknown as { body: string }).body));
    expect(parsed.success).toBe(false);
    expect(typeof parsed.error).toBe("string");
  });

  it("writes sanitized rows on happy path", async () => {
    const store = createStore();
    const handler = createTravelWebhook(store, cfg()).handler;
    const res = createMockServerResponse();
    await handler(
      createReq({
        headers: { "x-webhook-secret": "test-secret" },
        body: JSON.stringify({
          items: [
            {
              id: "t1",
              category: "temple",
              name: "Tirupati\u2028Temple",
              region: "Andhra",
              summary: "Hill\u0000top",
            },
          ],
        }),
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    const stored = store.getById("t1");
    expect(stored?.name).toBe("TirupatiTemple");
    expect(stored?.summary).toBe("Hilltop");
    expect(stored?.region).toBe("Andhra");
  });

  it("returns 413 when the body exceeds the configured limit", async () => {
    const store = createStore();
    const handler = createTravelWebhook(store, cfg()).handler;
    const res = createMockServerResponse();
    const oversized = Buffer.alloc(2 * 1024 * 1024, 0x20);
    await handler(
      createReq({
        headers: { "x-webhook-secret": "test-secret" },
        body: oversized,
      }),
      res,
    );
    expect(res.statusCode).toBe(413);
  });
});
