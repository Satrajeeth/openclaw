import { describe, expect, it } from "vitest";
import type { TravelPluginConfig } from "./config.js";
import { TravelStore, type TravelItem } from "./store.js";

function openStore(): TravelStore {
  const cfg = {
    storePath: ":memory:",
    webhookSecret: "s",
    maxResults: 5,
    ttlSweepIntervalMs: 60_000,
    maxIngestItems: 100,
  } satisfies TravelPluginConfig;
  return new TravelStore(cfg);
}

function makeItem(overrides: Partial<TravelItem> = {}): TravelItem {
  const now = Date.now();
  return {
    id: "i1",
    category: "temple",
    name: "Default Name",
    region: "",
    city: "",
    country: "",
    price_tier: "",
    tags: "[]",
    summary: "",
    detail_json: "{}",
    expires_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("TravelStore", () => {
  it("upserts rows in bulk inside a transaction", () => {
    const store = openStore();
    const count = store.upsertBatch([
      makeItem({ id: "a", name: "Alpha" }),
      makeItem({ id: "b", name: "Beta" }),
    ]);
    expect(count).toBe(2);
    expect(store.getById("a")?.name).toBe("Alpha");
    expect(store.getById("b")?.name).toBe("Beta");
  });

  it("rolls back the whole batch when one row is invalid", () => {
    const store = openStore();
    store.upsertBatch([makeItem({ id: "keep", name: "Keep" })]);
    expect(() =>
      store.upsertBatch([
        makeItem({ id: "new", name: "New" }),
        // violate NOT NULL on category by passing `null` disguised as undefined
        makeItem({ id: "bad", category: null as unknown as string }),
      ]),
    ).toThrow();
    expect(store.getById("new")).toBeNull();
    expect(store.getById("keep")?.name).toBe("Keep");
  });

  it("FTS search ranks direct keyword matches above unrelated rows", () => {
    const store = openStore();
    store.upsertBatch([
      makeItem({ id: "t1", name: "Tirupati Temple", summary: "Hilltop temple in Andhra" }),
      makeItem({ id: "r1", category: "restaurant", name: "Seaside Cafe", summary: "Grill and drinks" }),
    ]);
    const hits = store.search({ query: "temple", limit: 5, now: Date.now() });
    expect(hits[0]?.id).toBe("t1");
    expect(hits.map((h) => h.id)).not.toContain("r1");
  });

  it("pre-filters category and region before FTS", () => {
    const store = openStore();
    store.upsertBatch([
      makeItem({ id: "t1", category: "temple", region: "Andhra", name: "Tirupati" }),
      makeItem({ id: "t2", category: "temple", region: "Tamil Nadu", name: "Madurai" }),
    ]);
    const hits = store.search({ category: "temple", region: "Andhra", limit: 5, now: Date.now() });
    expect(hits.map((h) => h.id)).toEqual(["t1"]);
  });

  it("skips expired rows and deleteExpired removes them", () => {
    const store = openStore();
    const now = Date.now();
    store.upsertBatch([
      makeItem({ id: "live", name: "Live", expires_at: now + 60_000 }),
      makeItem({ id: "dead", name: "Dead", expires_at: now - 1 }),
    ]);
    const live = store.search({ limit: 10, now });
    expect(live.map((r) => r.id).sort()).toEqual(["live"]);
    expect(store.deleteExpired(now)).toBe(1);
    expect(store.getById("dead")).toBeNull();
  });

  it("orders by updated_at DESC when no query is supplied", () => {
    const store = openStore();
    store.upsertBatch([
      makeItem({ id: "old", name: "Old", updated_at: 10, created_at: 10 }),
      makeItem({ id: "new", name: "New", updated_at: 20, created_at: 20 }),
    ]);
    const hits = store.search({ limit: 10, now: Date.now() });
    expect(hits.map((h) => h.id)).toEqual(["new", "old"]);
  });
});
