import { createRequire } from "node:module";
import path from "node:path";
import type { TravelPluginConfig } from "./config.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

export type EntityRow = {
  entity_id: number;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  rating: number | null;
  reviews_count: number | null;
  phone: string | null;
  parking: string | null;
  description: string | null;
  peak_hours: string | null;
  links: string | null;
  documents_required: string | null;
  dress_code: string | null;
  category: string;
  sub_category: string | null;
  sub_sub_category: string | null;
  region: string | null;
  image_url: string | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
};

export type HoursRow = {
  entity_id: number;
  day: string;
  slot_index: number;
  opening_time: string | null;
  closing_time: string | null;
  is_closed: number;
};

export type ItemRow = {
  entity_id: number;
  item_id: number;
  item_name: string;
  price_amount: number | null;
  price_label: string | null;
  currency: string;
  timing_open: string | null;
  timing_close: string | null;
  item_type: string;
  signature_dish: number;
};

export type TagRow = {
  entity_id: number;
  tag: string;
  tag_norm: string;
};

export type EntityCard = Pick<
  EntityRow,
  | "entity_id"
  | "name"
  | "category"
  | "sub_category"
  | "region"
  | "address"
  | "latitude"
  | "longitude"
  | "rating"
  | "description"
  | "image_url"
  | "expires_at"
  | "updated_at"
> & { distance_km?: number };

export type EntityDetail = EntityRow & {
  hours: HoursRow[];
  items: ItemRow[];
  tags: TagRow[];
};

export type EntityUpsert = Omit<EntityRow, "created_at" | "updated_at"> & {
  hours: Omit<HoursRow, "entity_id">[];
  items: Omit<ItemRow, "entity_id">[];
  tags: { tag: string; tag_norm: string }[];
};

export type TravelSearchParams = {
  query?: string;
  category?: string;
  region?: string;
  subCategory?: string;
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  limit: number;
  now: number;
};

type DatabaseInstance = InstanceType<typeof Database>;

const EARTH_RADIUS_KM = 6371;

export class TravelStore {
  private db: DatabaseInstance;

  constructor(config: TravelPluginConfig) {
    const dbPath =
      config.storePath === ":memory:" ? ":memory:" : path.resolve(config.storePath);
    this.db = new Database(dbPath);
    this.init();
  }

  private init() {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");

    // Drop legacy flat schema if present (clean replace, no migration).
    this.db.exec(`DROP TABLE IF EXISTS travel_items_fts;`);
    this.db.exec(`DROP TABLE IF EXISTS travel_items;`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        entity_id          INTEGER PRIMARY KEY,
        name               TEXT NOT NULL,
        address            TEXT,
        latitude           REAL,
        longitude          REAL,
        rating             REAL,
        reviews_count      INTEGER,
        phone              TEXT,
        parking            TEXT,
        description        TEXT,
        peak_hours         TEXT,
        links              TEXT,
        documents_required TEXT,
        dress_code         TEXT,
        category           TEXT NOT NULL,
        sub_category       TEXT,
        sub_sub_category   TEXT,
        region             TEXT,
        image_url          TEXT,
        expires_at         INTEGER,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_category   ON entities(category);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_region     ON entities(region);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_expires_at ON entities(expires_at);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_geo        ON entities(latitude, longitude);`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entity_hours (
        entity_id     INTEGER NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
        day           TEXT    NOT NULL,
        slot_index    INTEGER NOT NULL DEFAULT 0,
        opening_time  TEXT,
        closing_time  TEXT,
        is_closed     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (entity_id, day, slot_index)
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_hours_entity_day ON entity_hours(entity_id, day);`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entity_items (
        entity_id      INTEGER NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
        item_id        INTEGER NOT NULL,
        item_name      TEXT NOT NULL,
        price_amount   INTEGER,
        price_label    TEXT,
        currency       TEXT NOT NULL DEFAULT 'INR',
        timing_open    TEXT,
        timing_close   TEXT,
        item_type      TEXT NOT NULL,
        signature_dish INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (entity_id, item_id)
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_items_type  ON entity_items(item_type);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_items_price ON entity_items(price_amount);`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entity_tags (
        entity_id INTEGER NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
        tag       TEXT    NOT NULL,
        tag_norm  TEXT    NOT NULL,
        PRIMARY KEY (entity_id, tag_norm)
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tags_norm ON entity_tags(tag_norm);`);

    // Contentless FTS5 — rebuilt by upsertEntity for each touched id.
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
        name, description, address, region, sub_category, tags, items,
        content='', contentless_delete=1
      );
    `);

    // Register a deterministic JS UDF for haversine distance so we don't depend
    // on whether the bundled SQLite was compiled with math functions.
    this.db.function(
      "haversine_km",
      { deterministic: true },
      (lat1: number | null, lon1: number | null, lat2: number | null, lon2: number | null) => {
        if (
          lat1 === null ||
          lon1 === null ||
          lat2 === null ||
          lon2 === null ||
          !Number.isFinite(lat1) ||
          !Number.isFinite(lon1) ||
          !Number.isFinite(lat2) ||
          !Number.isFinite(lon2)
        ) {
          return null;
        }
        const toRad = Math.PI / 180;
        const dLat = (lat2 - lat1) * toRad;
        const dLon = (lon2 - lon1) * toRad;
        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
        return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
      },
    );
  }

  upsertEntity(input: EntityUpsert, now: number): void {
    const tx = this.db.transaction((row: EntityUpsert) => {
      this.db
        .prepare(
          `
        INSERT INTO entities (
          entity_id, name, address, latitude, longitude, rating, reviews_count,
          phone, parking, description, peak_hours, links, documents_required,
          dress_code, category, sub_category, sub_sub_category, region, image_url,
          expires_at, created_at, updated_at
        ) VALUES (
          @entity_id, @name, @address, @latitude, @longitude, @rating, @reviews_count,
          @phone, @parking, @description, @peak_hours, @links, @documents_required,
          @dress_code, @category, @sub_category, @sub_sub_category, @region, @image_url,
          @expires_at, @created_at, @updated_at
        )
        ON CONFLICT(entity_id) DO UPDATE SET
          name=excluded.name,
          address=excluded.address,
          latitude=excluded.latitude,
          longitude=excluded.longitude,
          rating=excluded.rating,
          reviews_count=excluded.reviews_count,
          phone=excluded.phone,
          parking=excluded.parking,
          description=excluded.description,
          peak_hours=excluded.peak_hours,
          links=excluded.links,
          documents_required=excluded.documents_required,
          dress_code=excluded.dress_code,
          category=excluded.category,
          sub_category=excluded.sub_category,
          sub_sub_category=excluded.sub_sub_category,
          region=excluded.region,
          image_url=excluded.image_url,
          expires_at=excluded.expires_at,
          updated_at=excluded.updated_at;
      `,
        )
        .run({ ...row, created_at: now, updated_at: now });

      this.db.prepare(`DELETE FROM entity_hours WHERE entity_id = ?`).run(row.entity_id);
      this.db.prepare(`DELETE FROM entity_items WHERE entity_id = ?`).run(row.entity_id);
      this.db.prepare(`DELETE FROM entity_tags  WHERE entity_id = ?`).run(row.entity_id);
      this.db
        .prepare(`DELETE FROM entities_fts WHERE rowid = ?`)
        .run(row.entity_id);

      const insertHours = this.db.prepare(
        `INSERT INTO entity_hours (entity_id, day, slot_index, opening_time, closing_time, is_closed)
         VALUES (@entity_id, @day, @slot_index, @opening_time, @closing_time, @is_closed)`,
      );
      for (const h of row.hours) {
        insertHours.run({ ...h, entity_id: row.entity_id });
      }

      const insertItem = this.db.prepare(
        `INSERT INTO entity_items
           (entity_id, item_id, item_name, price_amount, price_label, currency, timing_open, timing_close, item_type, signature_dish)
         VALUES
           (@entity_id, @item_id, @item_name, @price_amount, @price_label, @currency, @timing_open, @timing_close, @item_type, @signature_dish)`,
      );
      for (const it of row.items) {
        insertItem.run({ ...it, entity_id: row.entity_id });
      }

      const insertTag = this.db.prepare(
        `INSERT OR IGNORE INTO entity_tags (entity_id, tag, tag_norm) VALUES (?, ?, ?)`,
      );
      for (const t of row.tags) {
        insertTag.run(row.entity_id, t.tag, t.tag_norm);
      }

      const tagsBlob = row.tags.map((t) => t.tag).join(" ");
      const itemsBlob = row.items.map((i) => i.item_name).join(" ");
      this.db
        .prepare(
          `INSERT INTO entities_fts (rowid, name, description, address, region, sub_category, tags, items)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.entity_id,
          row.name,
          row.description ?? "",
          row.address ?? "",
          row.region ?? "",
          row.sub_category ?? "",
          tagsBlob,
          itemsBlob,
        );
    });
    tx(input);
  }

  search(params: TravelSearchParams): EntityCard[] {
    const { query, category, region, subCategory, latitude, longitude, limit, now } = params;
    const radiusKm = params.radiusKm ?? 25;
    const filters: string[] = ["(e.expires_at IS NULL OR e.expires_at > @now)"];
    const bind: Record<string, string | number> = { now, limit };

    if (category) {
      filters.push("e.category = @category");
      bind.category = category;
    }
    if (region) {
      filters.push("e.region = @region");
      bind.region = region;
    }
    if (subCategory) {
      filters.push("e.sub_category = @subCategory");
      bind.subCategory = subCategory;
    }

    const useGeo =
      typeof latitude === "number" &&
      typeof longitude === "number" &&
      Number.isFinite(latitude) &&
      Number.isFinite(longitude);

    if (useGeo) {
      const latDelta = radiusKm / 111;
      const lonDelta = radiusKm / (111 * Math.max(0.01, Math.cos((latitude * Math.PI) / 180)));
      filters.push(
        "e.latitude IS NOT NULL AND e.longitude IS NOT NULL AND e.latitude BETWEEN @minLat AND @maxLat AND e.longitude BETWEEN @minLon AND @maxLon",
      );
      bind.minLat = latitude - latDelta;
      bind.maxLat = latitude + latDelta;
      bind.minLon = longitude - lonDelta;
      bind.maxLon = longitude + lonDelta;
      bind.lat = latitude;
      bind.lon = longitude;
      bind.radiusKm = radiusKm;
    }

    const distanceExpr = useGeo
      ? `haversine_km(e.latitude, e.longitude, @lat, @lon)`
      : `NULL`;

    const trimmedQuery = query?.trim();
    let sql: string;
    if (trimmedQuery) {
      bind.query = toFtsQuery(trimmedQuery);
      filters.push("fts.entities_fts MATCH @query");
      const orderBy = useGeo
        ? `ORDER BY bm25(entities_fts) + (COALESCE(${distanceExpr}, 0) / @radiusKm) ASC`
        : `ORDER BY bm25(entities_fts)`;
      sql = `
        SELECT e.entity_id, e.name, e.category, e.sub_category, e.region, e.address,
               e.latitude, e.longitude, e.rating, e.description, e.image_url,
               e.expires_at, e.updated_at,
               ${distanceExpr} AS distance_km
        FROM entities e
        INNER JOIN entities_fts fts ON fts.rowid = e.entity_id
        WHERE ${filters.join(" AND ")}
        ${orderBy}
        LIMIT @limit
      `;
    } else {
      const orderBy = useGeo
        ? `ORDER BY distance_km ASC`
        : `ORDER BY e.updated_at DESC`;
      sql = `
        SELECT e.entity_id, e.name, e.category, e.sub_category, e.region, e.address,
               e.latitude, e.longitude, e.rating, e.description, e.image_url,
               e.expires_at, e.updated_at,
               ${distanceExpr} AS distance_km
        FROM entities e
        WHERE ${filters.join(" AND ")}
        ${orderBy}
        LIMIT @limit
      `;
    }

    const rows = this.db.prepare(sql).all(bind) as (EntityCard & { distance_km: number | null })[];
    if (useGeo) {
      return rows
        .filter((r) => r.distance_km !== null && r.distance_km <= radiusKm)
        .map((r) => ({ ...r, distance_km: Number(r.distance_km) }));
    }
    return rows.map(({ distance_km: _ignored, ...rest }) => rest);
  }

  getEntity(entityId: number): EntityDetail | null {
    const entity = this.db
      .prepare(`SELECT * FROM entities WHERE entity_id = ?`)
      .get(entityId) as EntityRow | undefined;
    if (!entity) {
      return null;
    }
    const hours = this.db
      .prepare(
        `SELECT * FROM entity_hours WHERE entity_id = ? ORDER BY day, slot_index`,
      )
      .all(entityId) as HoursRow[];
    const items = this.db
      .prepare(
        `SELECT * FROM entity_items WHERE entity_id = ? ORDER BY item_id`,
      )
      .all(entityId) as ItemRow[];
    const tags = this.db
      .prepare(`SELECT * FROM entity_tags WHERE entity_id = ? ORDER BY tag_norm`)
      .all(entityId) as TagRow[];
    return { ...entity, hours, items, tags };
  }

  deleteExpired(now: number): number {
    const result = this.db
      .prepare(`DELETE FROM entities WHERE expires_at IS NOT NULL AND expires_at <= @now`)
      .run({ now });
    return Number(result.changes ?? 0);
  }

  close(): void {
    this.db.close();
  }
}

// FTS5 MATCH is sensitive to raw punctuation; quote tokens so user input cannot
// fall into FTS operator syntax accidentally.
function toFtsQuery(raw: string): string {
  const tokens = raw
    .split(/\s+/u)
    .map((t) => t.replace(/["']/g, "").trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    return "";
  }
  return tokens.map((t) => `"${t}"*`).join(" ");
}
