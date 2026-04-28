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

function createStore(): TravelStore {
  return new TravelStore(cfg());
}

const minimalEntity = {
  entity_id: 1,
  name: "Sri Padmavati",
  category: "temple",
};

describe("createTravelWebhook", () => {
  it("returns 401 and writes nothing on wrong secret", async () => {
    const store = createStore();
    const handler = createTravelWebhook(store, cfg()).handler;
    const res = createMockServerResponse();
    await handler(
      createReq({
        headers: { "x-webhook-secret": "wrong" },
        body: JSON.stringify({ entities: [minimalEntity] }),
      }),
      res,
    );
    expect(res.statusCode).toBe(401);
    expect(store.getEntity(1)).toBeNull();
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
        body: JSON.stringify({ entities: [{ entity_id: 1 }] }),
      }),
      res,
    );
    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse(String((res as unknown as { body: string }).body));
    expect(parsed.success).toBe(false);
    expect(typeof parsed.error).toBe("string");
  });

  it("ingests nested hours/items/tags and normalizes them", async () => {
    const store = createStore();
    const handler = createTravelWebhook(store, cfg()).handler;
    const res = createMockServerResponse();
    await handler(
      createReq({
        headers: { "x-webhook-secret": "test-secret" },
        body: JSON.stringify({
          entities: [
            {
              entity_id: 1,
              name: "Sri Padmavati\u2028Temple",
              category: "temple",
              region: "tirupati",
              phone: "1.80E+11",
              hours: [
                { day: "all", opening_time: "7:00 AM", closing_time: "11:30 AM" },
                { day: "all", opening_time: "12:30 PM", closing_time: "6:00 PM" },
              ],
              items: [
                { item_id: 1, item_name: "Sarva Darshanam", item_type: "darshan", price_label: "Free" },
                { item_id: 2, item_name: "Padmavathi Parinayam", item_type: "seva", price_label: "500" },
              ],
              tags: ["Goddess Padmavati", "  PADMAVATI  ", "padmavati"],
            },
          ],
        }),
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    const detail = store.getEntity(1);
    expect(detail?.name).toBe("Sri PadmavatiTemple");
    expect(detail?.phone).toBe("180000000000");
    expect(detail?.hours).toHaveLength(2);
    expect(detail?.hours[0]?.opening_time).toBe("07:00");
    expect(detail?.hours[1]?.closing_time).toBe("18:00");
    expect(detail?.items).toHaveLength(2);
    expect(detail?.items[1]?.price_amount).toBe(50_000);
    // Two casing variants of "padmavati" deduped to one tag_norm.
    expect(detail?.tags.map((t) => t.tag_norm).toSorted()).toEqual([
      "goddess padmavati",
      "padmavati",
    ]);
  });

  it("re-ingest replaces nested rows", async () => {
    const store = createStore();
    const handler = createTravelWebhook(store, cfg()).handler;
    await handler(
      createReq({
        headers: { "x-webhook-secret": "test-secret" },
        body: JSON.stringify({
          entities: [
            {
              entity_id: 7,
              name: "X",
              category: "temple",
              hours: [{ day: "all", opening_time: "07:00", closing_time: "09:00" }],
              tags: ["Old"],
            },
          ],
        }),
      }),
      createMockServerResponse(),
    );
    await handler(
      createReq({
        headers: { "x-webhook-secret": "test-secret" },
        body: JSON.stringify({
          entities: [
            {
              entity_id: 7,
              name: "X",
              category: "temple",
              hours: [{ day: "mon", opening_time: "08:00", closing_time: "10:00" }],
              tags: ["New"],
            },
          ],
        }),
      }),
      createMockServerResponse(),
    );
    const detail = store.getEntity(7);
    expect(detail?.hours).toHaveLength(1);
    expect(detail?.hours[0]?.day).toBe("mon");
    expect(detail?.tags.map((t) => t.tag_norm)).toEqual(["new"]);
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
