import { describe, expect, it } from "vitest";
import type { TravelPluginConfig } from "./config.js";
import { TravelStore, type EntityUpsert } from "./store.js";

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

function makeEntity(overrides: Partial<EntityUpsert> = {}): EntityUpsert {
  return {
    entity_id: 1,
    name: "Default Temple",
    address: null,
    latitude: null,
    longitude: null,
    rating: null,
    reviews_count: null,
    phone: null,
    parking: null,
    description: null,
    peak_hours: null,
    links: null,
    documents_required: null,
    dress_code: null,
    category: "temple",
    sub_category: null,
    sub_sub_category: null,
    region: null,
    image_url: null,
    expires_at: null,
    hours: [],
    items: [],
    tags: [],
    ...overrides,
  };
}

describe("TravelStore", () => {
  it("upserts an entity with nested hours/items/tags", () => {
    const store = openStore();
    store.upsertEntity(
      makeEntity({
        entity_id: 1,
        name: "Sri Padmavati",
        description: "Goddess Padmavati temple",
        category: "temple",
        region: "tirupati",
        hours: [
          { day: "all", slot_index: 0, opening_time: "07:00", closing_time: "11:30", is_closed: 0 },
          { day: "all", slot_index: 1, opening_time: "12:30", closing_time: "18:00", is_closed: 0 },
        ],
        items: [
          {
            item_id: 1,
            item_name: "Sarva Darshanam",
            price_amount: null,
            price_label: "Free",
            currency: "INR",
            timing_open: null,
            timing_close: null,
            item_type: "darshan",
            signature_dish: 0,
          },
        ],
        tags: [
          { tag: "Goddess Padmavati", tag_norm: "goddess padmavati" },
          { tag: "padmavati", tag_norm: "padmavati" },
        ],
      }),
      Date.now(),
    );

    const detail = store.getEntity(1);
    expect(detail?.name).toBe("Sri Padmavati");
    expect(detail?.hours).toHaveLength(2);
    expect(detail?.items[0]?.item_name).toBe("Sarva Darshanam");
    expect(detail?.tags.map((t) => t.tag_norm).toSorted()).toEqual([
      "goddess padmavati",
      "padmavati",
    ]);
  });

  it("re-upsert replaces nested rows rather than duplicating", () => {
    const store = openStore();
    store.upsertEntity(
      makeEntity({
        entity_id: 1,
        hours: [{ day: "all", slot_index: 0, opening_time: "07:00", closing_time: "09:00", is_closed: 0 }],
        items: [
          {
            item_id: 1,
            item_name: "Old",
            price_amount: 100,
            price_label: "1",
            currency: "INR",
            timing_open: null,
            timing_close: null,
            item_type: "seva",
            signature_dish: 0,
          },
        ],
        tags: [{ tag: "Old", tag_norm: "old" }],
      }),
      Date.now(),
    );
    store.upsertEntity(
      makeEntity({
        entity_id: 1,
        hours: [{ day: "mon", slot_index: 0, opening_time: "08:00", closing_time: "10:00", is_closed: 0 }],
        items: [
          {
            item_id: 2,
            item_name: "New",
            price_amount: 200,
            price_label: "2",
            currency: "INR",
            timing_open: null,
            timing_close: null,
            item_type: "seva",
            signature_dish: 0,
          },
        ],
        tags: [{ tag: "New", tag_norm: "new" }],
      }),
      Date.now(),
    );
    const detail = store.getEntity(1);
    expect(detail?.hours).toHaveLength(1);
    expect(detail?.hours[0]?.day).toBe("mon");
    expect(detail?.items).toHaveLength(1);
    expect(detail?.items[0]?.item_name).toBe("New");
    expect(detail?.tags.map((t) => t.tag_norm)).toEqual(["new"]);
  });

  it("FTS search finds entities by name and by tag", () => {
    const store = openStore();
    store.upsertEntity(
      makeEntity({
        entity_id: 1,
        name: "Sri Padmavati Temple",
        category: "temple",
        tags: [{ tag: "Padmavati", tag_norm: "padmavati" }],
      }),
      Date.now(),
    );
    store.upsertEntity(
      makeEntity({
        entity_id: 2,
        name: "Sri Govindaraja",
        category: "temple",
        tags: [{ tag: "shiva", tag_norm: "shiva" }],
      }),
      Date.now(),
    );
    const padma = store.search({ query: "padmavati", limit: 5, now: Date.now() });
    expect(padma[0]?.entity_id).toBe(1);

    const shiva = store.search({ query: "shiva", limit: 5, now: Date.now() });
    expect(shiva[0]?.entity_id).toBe(2);
  });

  it("filters by category", () => {
    const store = openStore();
    store.upsertEntity(makeEntity({ entity_id: 1, name: "T1", category: "temple" }), Date.now());
    store.upsertEntity(makeEntity({ entity_id: 2, name: "R1", category: "restaurant" }), Date.now());
    const hits = store.search({ category: "restaurant", limit: 5, now: Date.now() });
    expect(hits.map((h) => h.entity_id)).toEqual([2]);
  });

  it("proximity search ranks by distance and respects radius", () => {
    const store = openStore();
    // Tirupati area
    store.upsertEntity(
      makeEntity({ entity_id: 1, name: "Near", latitude: 13.6288, longitude: 79.4192 }),
      Date.now(),
    );
    // Same city, ~30km away
    store.upsertEntity(
      makeEntity({ entity_id: 2, name: "Far", latitude: 13.9, longitude: 79.5 }),
      Date.now(),
    );
    // Bangalore — way outside
    store.upsertEntity(
      makeEntity({ entity_id: 3, name: "Other", latitude: 12.97, longitude: 77.59 }),
      Date.now(),
    );
    const hits = store.search({
      latitude: 13.63,
      longitude: 79.42,
      radiusKm: 50,
      limit: 5,
      now: Date.now(),
    });
    expect(hits.map((h) => h.entity_id)).toEqual([1, 2]);
    expect(hits[0]?.distance_km).toBeLessThan(1);
  });

  it("skips expired entities and deleteExpired removes them", () => {
    const store = openStore();
    const now = Date.now();
    store.upsertEntity(makeEntity({ entity_id: 1, name: "Live", expires_at: now + 60_000 }), now);
    store.upsertEntity(makeEntity({ entity_id: 2, name: "Dead", expires_at: now - 1 }), now);
    const live = store.search({ limit: 10, now });
    expect(live.map((r) => r.entity_id).toSorted()).toEqual([1]);
    expect(store.deleteExpired(now)).toBe(1);
    expect(store.getEntity(2)).toBeNull();
  });
});
