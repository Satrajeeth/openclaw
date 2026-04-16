import Database from "better-sqlite3";
import path from "path";
import { TravelPluginConfig } from "./config";

export class TravelStore {
  private db: Database.Database;

  constructor(config: TravelPluginConfig) {
    const dbPath = path.resolve(config.storePath);
    this.db = new Database(dbPath);

    this.init();
  }

  private init() {
    // Main table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS travel_items (
        id TEXT PRIMARY KEY,
        category TEXT,
        name TEXT,
        region TEXT,
        city TEXT,
        country TEXT,
        price_tier TEXT,
        tags TEXT,
        summary TEXT,
        detail_json TEXT,
        expires_at INTEGER,
        created_at INTEGER,
        updated_at INTEGER
      );
    `);

    // Index for faster filtering
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_category ON travel_items(category);
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_region ON travel_items(region);
    `);
  }

  // Insert or update item
  upsertItem(item: any) {
    const stmt = this.db.prepare(`
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

    stmt.run(item);
  }

  // Basic search (we'll upgrade later)
  search(query: { category?: string; region?: string; limit?: number }) {
    const { category, region, limit = 5 } = query;

    let sql = `SELECT * FROM travel_items WHERE 1=1`;
    const params: any = {};

    if (category) {
      sql += ` AND category = @category`;
      params.category = category;
    }

    if (region) {
      sql += ` AND region = @region`;
      params.region = region;
    }

    sql += ` LIMIT @limit`;
    params.limit = limit;

    const stmt = this.db.prepare(sql);
    return stmt.all(params);
  }
}
