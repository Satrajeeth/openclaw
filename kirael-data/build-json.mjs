#!/usr/bin/env node
// One-off: read the 4 CSVs and emit kirael.json matching the
// /travel-ingest webhook payload shape. Run: node kirael-data/build-json.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "kirael.json");

const SHEET6 = join(HERE, "Copy of entities_info - Sheet6.csv");
const SHEET7 = join(HERE, "Copy of entities_info - Sheet7.csv");
const SHEET8 = join(HERE, "Copy of entities_info - Sheet8.csv");
const SHEET9 = join(HERE, "Copy of entities_info - Sheet9.csv");

function parseCsv(text) {
  // RFC 4180-ish: fields can be quoted, "" escapes a literal quote,
  // commas + newlines are allowed inside quoted fields.
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r") {
      // swallow, handled by \n
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop trailing empty row if file ends with newline.
  if (rows.length && rows.at(-1).length === 1 && rows.at(-1)[0] === "") {
    rows.pop();
  }
  return rows;
}

function readCsvAsObjects(path) {
  const rows = parseCsv(readFileSync(path, "utf8"));
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    for (let i = 0; i < headers.length; i++) {
      obj[headers[i]] = (r[i] ?? "").trim();
    }
    return obj;
  });
}

function nullIfEmpty(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

function numberOrNull(v) {
  const s = nullIfEmpty(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function intOrNull(v) {
  const n = numberOrNull(v);
  return n === null ? null : Math.trunc(n);
}

function lowerOrNull(v) {
  const s = nullIfEmpty(v);
  return s === null ? null : s.toLowerCase();
}

function isClosedFlag(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "closed";
}

function splitTiming(raw) {
  const s = nullIfEmpty(raw);
  if (s === null) return { open: null, close: null };
  // Examples seen: "5:00 AM - 9:00 AM", "5-7 AM", or empty.
  // Split on common dash variants; if it doesn't split cleanly, leave nulls.
  const parts = s.split(/\s*[-–—to]+\s*/i).filter(Boolean);
  if (parts.length >= 2) {
    return { open: parts[0], close: parts[1] };
  }
  return { open: s, close: null };
}

const entitiesRaw = readCsvAsObjects(SHEET6);
const hoursRaw = readCsvAsObjects(SHEET7);
const itemsRaw = readCsvAsObjects(SHEET8);
const tagsRaw = readCsvAsObjects(SHEET9);

const byId = new Map();
for (const r of entitiesRaw) {
  const entity_id = intOrNull(r.entity_id);
  if (entity_id === null) continue;
  byId.set(entity_id, {
    entity_id,
    name: nullIfEmpty(r.Name) ?? "(unnamed)",
    address: nullIfEmpty(r.Address),
    latitude: numberOrNull(r.Latitude),
    longitude: numberOrNull(r.Longitude),
    rating: numberOrNull(r.Rating),
    reviews_count: intOrNull(r.Reviews),
    phone: nullIfEmpty(r.phone_number),
    parking: nullIfEmpty(r["Parking availability"]),
    description: nullIfEmpty(r.Desciption ?? r.Description),
    peak_hours: nullIfEmpty(r["Peak hours"]),
    links: nullIfEmpty(r.Links),
    documents_required: nullIfEmpty(r["Documents required"]),
    dress_code: nullIfEmpty(r["Dress code"]),
    // The CSV has three category levels. The plugin filters on `category`,
    // which is most useful when set to the bucket label ("temple",
    // "restaurant", ...). Use sub_category for that and keep the broader
    // "Place to visit" CSV column as-is (lowercased) only if no sub_category.
    category: lowerOrNull(r.sub_category) ?? lowerOrNull(r.Category) ?? "unknown",
    sub_category: lowerOrNull(r.sub_sub_category),
    sub_sub_category: null,
    region: nullIfEmpty(r.region),
    image_url: nullIfEmpty(r.Image_url),
    expires_at: null,
    hours: [],
    items: [],
    tags: [],
  });
}

// Hours: assign slot_index per (entity, day).
const slotCounter = new Map();
for (const r of hoursRaw) {
  const entity_id = intOrNull(r.entity_id);
  if (entity_id === null) continue;
  const ent = byId.get(entity_id);
  if (!ent) continue;
  const day = (nullIfEmpty(r.day) ?? "all").toLowerCase();
  const key = `${entity_id}|${day}`;
  const slot_index = slotCounter.get(key) ?? 0;
  slotCounter.set(key, slot_index + 1);
  ent.hours.push({
    day,
    slot_index,
    opening_time: nullIfEmpty(r.opening_time),
    closing_time: nullIfEmpty(r.closing_time),
    is_closed: isClosedFlag(r.is_closed),
  });
}

for (const r of itemsRaw) {
  const entity_id = intOrNull(r.entity_id);
  const item_id = intOrNull(r.item_id);
  if (entity_id === null || item_id === null) continue;
  const ent = byId.get(entity_id);
  if (!ent) continue;
  const { open, close } = splitTiming(r.timing);
  ent.items.push({
    item_id,
    item_name: nullIfEmpty(r.item_name) ?? "(unnamed)",
    price_label: nullIfEmpty(r.price),
    timing_open: open,
    timing_close: close,
    item_type: lowerOrNull(r["item type"]) ?? "unknown",
    signature_dish: isClosedFlag(r["signature dish"]),
  });
}

for (const r of tagsRaw) {
  const entity_id = intOrNull(r.entity_id);
  if (entity_id === null) continue;
  const ent = byId.get(entity_id);
  if (!ent) continue;
  // Sheet9 reuses the column name "sub_sub_category" but each row is a tag.
  const tag = nullIfEmpty(r.sub_sub_category) ?? nullIfEmpty(r.tag);
  if (tag === null) continue;
  ent.tags.push(tag);
}

const entities = [...byId.values()].sort((a, b) => a.entity_id - b.entity_id);
const payload = { entities };

writeFileSync(OUT, JSON.stringify(payload, null, 2));
const counts = {
  entities: entities.length,
  hours: entities.reduce((n, e) => n + e.hours.length, 0),
  items: entities.reduce((n, e) => n + e.items.length, 0),
  tags: entities.reduce((n, e) => n + e.tags.length, 0),
};
console.log(`wrote ${OUT}`);
console.log(counts);
