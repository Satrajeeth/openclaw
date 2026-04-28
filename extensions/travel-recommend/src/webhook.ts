import type { IncomingMessage, ServerResponse } from "node:http";
import { safeEqualSecret } from "openclaw/plugin-sdk/browser-security-runtime";
import { z } from "zod";
import {
  applyBasicWebhookRequestGuards,
  createFixedWindowRateLimiter,
  createWebhookInFlightLimiter,
  readJsonWebhookBodyOrReject,
  WEBHOOK_IN_FLIGHT_DEFAULTS,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
} from "../runtime-api.js";
import type { TravelPluginConfig } from "./config.js";
import {
  normalizePhone,
  normalizePrice,
  normalizeTag,
  normalizeTime,
  sanitizeText,
} from "./sanitize.js";
import type { EntityUpsert, TravelStore } from "./store.js";

const HoursInputSchema = z.object({
  day: z.string().min(1).max(16),
  slot_index: z.number().int().nonnegative().max(16).nullish(),
  opening_time: z.string().max(16).nullish(),
  closing_time: z.string().max(16).nullish(),
  is_closed: z.boolean().nullish(),
});

const ItemInputSchema = z.object({
  item_id: z.number().int().nonnegative(),
  item_name: z.string().min(1).max(256),
  price_label: z.union([z.string().max(64), z.number()]).nullish(),
  currency: z.string().max(8).nullish(),
  timing_open: z.string().max(16).nullish(),
  timing_close: z.string().max(16).nullish(),
  item_type: z.string().min(1).max(32),
  signature_dish: z.boolean().nullish(),
});

const EntityInputSchema = z.object({
  entity_id: z.number().int().positive(),
  name: z.string().min(1).max(256),
  address: z.string().max(512).nullish(),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  rating: z.number().min(0).max(10).nullish(),
  reviews_count: z.number().int().nonnegative().nullish(),
  phone: z.union([z.string().max(64), z.number()]).nullish(),
  parking: z.string().max(32).nullish(),
  description: z.string().max(4_000).nullish(),
  peak_hours: z.string().max(512).nullish(),
  links: z.string().max(2_000).nullish(),
  documents_required: z.string().max(1_000).nullish(),
  dress_code: z.string().max(512).nullish(),
  category: z.string().min(1).max(64),
  sub_category: z.string().max(64).nullish(),
  sub_sub_category: z.string().max(64).nullish(),
  region: z.string().max(128).nullish(),
  image_url: z.string().max(2_048).nullish(),
  hours: z.array(HoursInputSchema).max(64).nullish(),
  items: z.array(ItemInputSchema).max(2_000).nullish(),
  tags: z.array(z.string().max(128)).max(64).nullish(),
  expires_at: z.number().int().nonnegative().nullish(),
});

type EntityInput = z.infer<typeof EntityInputSchema>;

export function createTravelWebhook(store: TravelStore, config: TravelPluginConfig) {
  const rateLimiter = createFixedWindowRateLimiter({
    windowMs: WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
    maxRequests: WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests,
    maxTrackedKeys: WEBHOOK_RATE_LIMIT_DEFAULTS.maxTrackedKeys,
  });
  const inFlightLimiter = createWebhookInFlightLimiter({
    maxInFlightPerKey: WEBHOOK_IN_FLIGHT_DEFAULTS.maxInFlightPerKey,
    maxTrackedKeys: WEBHOOK_IN_FLIGHT_DEFAULTS.maxTrackedKeys,
  });

  const PayloadSchema = z.object({
    entities: z.array(EntityInputSchema).min(1).max(config.maxIngestItems),
  });

  return {
    path: "/travel-ingest",
    auth: "plugin" as const,

    async handler(req: IncomingMessage, res: ServerResponse) {
      const clientKey = req.socket.remoteAddress ?? "unknown";
      const limiterKey = `/travel-ingest:${clientKey}`;

      if (
        !applyBasicWebhookRequestGuards({
          req,
          res,
          allowMethods: ["POST"],
          rateLimiter,
          rateLimitKey: limiterKey,
          requireJsonContentType: true,
        })
      ) {
        return;
      }

      if (!inFlightLimiter.tryAcquire(limiterKey)) {
        res.statusCode = 429;
        res.end("Too Many Requests");
        return;
      }

      try {
        const presented = headerValue(req.headers["x-webhook-secret"]);
        if (!presented || !safeEqualSecret(presented, config.webhookSecret)) {
          res.statusCode = 401;
          res.end("Unauthorized");
          return;
        }

        const body = await readJsonWebhookBodyOrReject({
          req,
          res,
          profile: "post-auth",
          invalidJsonMessage: "invalid request body",
        });
        if (!body.ok) {
          return;
        }

        const parsed = PayloadSchema.safeParse(body.value);
        if (!parsed.success) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(
            JSON.stringify({
              success: false,
              error: formatZodError(parsed.error),
            }),
          );
          return;
        }

        const now = Date.now();
        const rejected: { entity_id?: number; reason: string }[] = [];
        let count = 0;
        for (const entity of parsed.data.entities) {
          const upsert = toEntityUpsert(entity);
          if (!upsert) {
            rejected.push({ entity_id: entity.entity_id, reason: "invalid_after_sanitize" });
            continue;
          }
          store.upsertEntity(upsert, now);
          count += 1;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ success: true, count, rejected }));
      } catch (err) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end("Internal Server Error");
        }
        throw err;
      } finally {
        inFlightLimiter.release(limiterKey);
      }
    },
  };
}

function toEntityUpsert(input: EntityInput): EntityUpsert | null {
  const name = sanitizeText(input.name, 256);
  const category = sanitizeText(input.category, 64);
  if (!name || !category) {
    return null;
  }

  const hoursRows: EntityUpsert["hours"] = [];
  const slotCounters = new Map<string, number>();
  for (const h of input.hours ?? []) {
    const day = sanitizeText(h.day, 16).toLowerCase();
    if (!day) {
      continue;
    }
    const explicitSlot = h.slot_index;
    const slot = explicitSlot ?? slotCounters.get(day) ?? 0;
    slotCounters.set(day, slot + 1);
    hoursRows.push({
      day,
      slot_index: slot,
      opening_time: h.opening_time ? normalizeTime(h.opening_time) || null : null,
      closing_time: h.closing_time ? normalizeTime(h.closing_time) || null : null,
      is_closed: h.is_closed ? 1 : 0,
    });
  }

  const itemRows: EntityUpsert["items"] = [];
  const seenItemIds = new Set<number>();
  for (const it of input.items ?? []) {
    if (seenItemIds.has(it.item_id)) {
      continue;
    }
    seenItemIds.add(it.item_id);
    const itemName = sanitizeText(it.item_name, 256);
    const itemType = sanitizeText(it.item_type, 32).toLowerCase();
    if (!itemName || !itemType) {
      continue;
    }
    const price = normalizePrice(it.price_label ?? null);
    itemRows.push({
      item_id: it.item_id,
      item_name: itemName,
      price_amount: price.amount,
      price_label: price.label || null,
      currency: sanitizeText(it.currency ?? "INR", 8) || "INR",
      timing_open: it.timing_open ? normalizeTime(it.timing_open) || null : null,
      timing_close: it.timing_close ? normalizeTime(it.timing_close) || null : null,
      item_type: itemType,
      signature_dish: it.signature_dish ? 1 : 0,
    });
  }

  const tagRows: EntityUpsert["tags"] = [];
  const seenTagNorms = new Set<string>();
  for (const raw of input.tags ?? []) {
    const tag = sanitizeText(raw, 128);
    const tagNorm = normalizeTag(tag);
    if (!tagNorm || seenTagNorms.has(tagNorm)) {
      continue;
    }
    seenTagNorms.add(tagNorm);
    tagRows.push({ tag, tag_norm: tagNorm });
  }

  return {
    entity_id: input.entity_id,
    name,
    address: emptyToNull(sanitizeText(input.address ?? "", 512)),
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    rating: input.rating ?? null,
    reviews_count: input.reviews_count ?? null,
    phone: emptyToNull(normalizePhone(input.phone ?? null)),
    parking: emptyToNull(sanitizeText(input.parking ?? "", 32)),
    description: emptyToNull(sanitizeText(input.description ?? "", 4_000)),
    peak_hours: emptyToNull(sanitizeText(input.peak_hours ?? "", 512)),
    links: emptyToNull(sanitizeText(input.links ?? "", 2_000)),
    documents_required: emptyToNull(sanitizeText(input.documents_required ?? "", 1_000)),
    dress_code: emptyToNull(sanitizeText(input.dress_code ?? "", 512)),
    category,
    sub_category: emptyToNull(sanitizeText(input.sub_category ?? "", 64)),
    sub_sub_category: emptyToNull(sanitizeText(input.sub_sub_category ?? "", 64)),
    region: emptyToNull(sanitizeText(input.region ?? "", 128)),
    image_url: emptyToNull(sanitizeText(input.image_url ?? "", 2_048)),
    expires_at: input.expires_at ?? null,
    hours: hoursRows,
    items: itemRows,
    tags: tagRows,
  };
}

function emptyToNull(value: string): string | null {
  return value ? value : null;
}

function headerValue(raw: string | string[] | undefined): string {
  if (Array.isArray(raw)) {
    return raw[0]?.trim() ?? "";
  }
  return typeof raw === "string" ? raw.trim() : "";
}

function formatZodError(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) {
    return "invalid request";
  }
  const path = first.path.length > 0 ? `${first.path.join(".")}: ` : "";
  return `${path}${first.message}`;
}
