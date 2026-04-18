import { createRequire } from "node:module";
import path from "node:path";
import type { TravelPluginConfig } from "./config.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

export type TravelItem = {
  id: string;
  category: string;
  name: string;
  region: string;
  city: string;
  country: string;
  price_tier: string;
  tags: string;
  summary: string;
  detail_json: string;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
};

export type TravelCard = Omit<TravelItem, "detail_json" | "created_at">;

export type TravelSearchParams = {
  query?: string;
  category?: string;
  region?: string;
  city?: string;
  priceTier?: string;
  limit: number;
  now: number;
};

type DatabaseInstance = InstanceType<typeof Database>;

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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS travel_items (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        name TEXT NOT NULL,
        region TEXT NOT NULL DEFAULT '',
        city TEXT NOT NULL DEFAULT '',
        country TEXT NOT NULL DEFAULT '',
        price_tier TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        summary TEXT NOT NULL DEFAULT '',
        detail_json TEXT NOT NULL DEFAULT '{}',
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_travel_items_category ON travel_items(category);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_travel_items_region ON travel_items(region);`);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_travel_items_expires_at ON travel_items(expires_at);`,
    );

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS travel_items_fts USING fts5(
        name, summary, tags, region, city, country,
        content='travel_items',
        content_rowid='rowid'
      );
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS travel_items_ai AFTER INSERT ON travel_items BEGIN
        INSERT INTO travel_items_fts(rowid, name, summary, tags, region, city, country)
        VALUES (new.rowid, new.name, new.summary, new.tags, new.region, new.city, new.country);
      END;
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS travel_items_ad AFTER DELETE ON travel_items BEGIN
        INSERT INTO travel_items_fts(travel_items_fts, rowid, name, summary, tags, region, city, country)
        VALUES ('delete', old.rowid, old.name, old.summary, old.tags, old.region, old.city, old.country);
      END;
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS travel_items_au AFTER UPDATE ON travel_items BEGIN
        INSERT INTO travel_items_fts(travel_items_fts, rowid, name, summary, tags, region, city, country)
        VALUES ('delete', old.rowid, old.name, old.summary, old.tags, old.region, old.city, old.country);
        INSERT INTO travel_items_fts(rowid, name, summary, tags, region, city, country)
        VALUES (new.rowid, new.name, new.summary, new.tags, new.region, new.city, new.country);
      END;
    `);
  }

  private get upsertStmt() {
    return this.db.prepare(`
      INSERT INTO travel_items (
        id, category, name, region, city, country,
        price_tier, tags, summary, detail_json,
        expires_at, created_at, updated_at
      )
      VALUES (
        @id, @category, @name, @region, @city, @country,
        @price_tier, @tags, @summary, @detail_json,
        @expires_at, @created_at, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        category=excluded.category,
        name=excluded.name,
        region=excluded.region,
        city=excluded.city,
        country=excluded.country,
        price_tier=excluded.price_tier,
        tags=excluded.tags,
        summary=excluded.summary,
        detail_json=excluded.detail_json,
        expires_at=excluded.expires_at,
        updated_at=excluded.updated_at;
    `);
  }

  upsertBatch(items: TravelItem[]): number {
    if (items.length === 0) {
      return 0;
    }
    const stmt = this.upsertStmt;
    const tx = this.db.transaction((rows: TravelItem[]) => {
      for (const row of rows) {
        stmt.run(row);
      }
    });
    tx(items);
    return items.length;
  }

  search(params: TravelSearchParams): TravelCard[] {
    const { query, category, region, city, priceTier, limit, now } = params;
    const filters: string[] = ["(t.expires_at IS NULL OR t.expires_at > @now)"];
    const bind: Record<string, string | number> = { now, limit };

    if (category) {
      filters.push("t.category = @category");
      bind.category = category;
    }
    if (region) {
      filters.push("t.region = @region");
      bind.region = region;
    }
    if (city) {
      filters.push("t.city = @city");
      bind.city = city;
    }
    if (priceTier) {
      filters.push("t.price_tier = @priceTier");
      bind.priceTier = priceTier;
    }

    const trimmedQuery = query?.trim();
    let sql: string;
    if (trimmedQuery) {
      bind.query = toFtsQuery(trimmedQuery);
      filters.push("fts.travel_items_fts MATCH @query");
      sql = `
        SELECT t.id, t.category, t.name, t.region, t.city, t.country,
               t.price_tier, t.tags, t.summary, t.expires_at, t.updated_at
        FROM travel_items t
        INNER JOIN travel_items_fts fts ON fts.rowid = t.rowid
        WHERE ${filters.join(" AND ")}
        ORDER BY bm25(travel_items_fts)
        LIMIT @limit
      `;
    } else {
      sql = `
        SELECT t.id, t.category, t.name, t.region, t.city, t.country,
               t.price_tier, t.tags, t.summary, t.expires_at, t.updated_at
        FROM travel_items t
        WHERE ${filters.join(" AND ")}
        ORDER BY t.updated_at DESC
        LIMIT @limit
      `;
    }

    return this.db.prepare(sql).all(bind) as TravelCard[];
  }

  getById(id: string): TravelItem | null {
    const row = this.db
      .prepare(`SELECT * FROM travel_items WHERE id = @id`)
      .get({ id }) as TravelItem | undefined;
    return row ?? null;
  }

  deleteExpired(now: number): number {
    const result = this.db
      .prepare(`DELETE FROM travel_items WHERE expires_at IS NOT NULL AND expires_at <= @now`)
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
