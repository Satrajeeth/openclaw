import { Type } from "@sinclair/typebox";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
  type AnyAgentTool,
} from "openclaw/plugin-sdk/core";
import { wrapUntrustedTravelBlock } from "./sanitize.js";
import type { EntityCard, TravelStore } from "./store.js";

const MAX_LIMIT = 10;
const DEFAULT_LIMIT = 5;
const SUMMARY_WRAP_CHARS = 500;
const DEFAULT_RADIUS_KM = 25;

const TravelRecommendSchema = Type.Object(
  {
    query: Type.Optional(
      Type.String({
        description: "Free-text search across name, description, address, tags, items.",
      }),
    ),
    category: Type.Optional(
      Type.String({
        description: "Restrict results to a category (e.g. 'temple', 'restaurant').",
      }),
    ),
    region: Type.Optional(
      Type.String({
        description: "Exact region match (e.g. 'tirupati,tirumala').",
      }),
    ),
    subCategory: Type.Optional(
      Type.String({
        description: "Exact sub-category match.",
      }),
    ),
    latitude: Type.Optional(
      Type.Number({
        description: "User latitude for proximity ranking.",
        minimum: -90,
        maximum: 90,
      }),
    ),
    longitude: Type.Optional(
      Type.Number({
        description: "User longitude for proximity ranking.",
        minimum: -180,
        maximum: 180,
      }),
    ),
    radiusKm: Type.Optional(
      Type.Number({
        description: `Search radius in km when latitude/longitude are provided (default ${DEFAULT_RADIUS_KM}).`,
        minimum: 0.1,
        maximum: 500,
        default: DEFAULT_RADIUS_KM,
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        description: `Number of results to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
        minimum: 1,
        maximum: MAX_LIMIT,
        default: DEFAULT_LIMIT,
      }),
    ),
  },
  { additionalProperties: false },
);

const TravelDetailSchema = Type.Object(
  {
    id: Type.String({ description: "Entity id (integer string) returned by travel_recommend." }),
  },
  { additionalProperties: false },
);

export function createTravelRecommendTool(store: TravelStore): AnyAgentTool {
  return {
    name: "travel_recommend",
    label: "Travel Recommend",
    description:
      "Search the ingested travel corpus (temples, restaurants, museums, parks, stays) and return compact recommendations. Supports free-text query, category filters, and proximity ranking via latitude/longitude.",
    parameters: TravelRecommendSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const query = readStringParam(rawParams, "query");
      const category = readStringParam(rawParams, "category");
      const region = readStringParam(rawParams, "region");
      const subCategory = readStringParam(rawParams, "subCategory");
      const latitude = readNumberParam(rawParams, "latitude");
      const longitude = readNumberParam(rawParams, "longitude");
      const rawRadius = readNumberParam(rawParams, "radiusKm");
      const radiusKm = clampRadius(rawRadius);
      const rawLimit = readNumberParam(rawParams, "limit", { integer: true });
      const limit = clampLimit(rawLimit);

      const cards = store.search({
        query,
        category,
        region,
        subCategory,
        latitude,
        longitude,
        radiusKm,
        limit,
        now: Date.now(),
      });

      const text = renderCardsAsUntrustedBlock(cards);
      const details = cards.map(toCardSummary);

      return {
        content: [{ type: "text" as const, text }],
        details: { count: cards.length, items: details },
      };
    },
  };
}

export function createTravelDetailTool(store: TravelStore): AnyAgentTool {
  return {
    name: "travel_detail",
    label: "Travel Detail",
    description:
      "Fetch the full detail payload (hours, items, tags) for a single travel entity by id.",
    parameters: TravelDetailSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const id = readStringParam(rawParams, "id", { required: true });
      const entityId = Number.parseInt(id, 10);
      if (!Number.isFinite(entityId) || entityId <= 0) {
        return jsonResult({ found: false, id });
      }
      const detail = store.getEntity(entityId);
      if (!detail) {
        return jsonResult({ found: false, id });
      }

      const summaryText = wrapUntrustedTravelBlock({
        label: `Travel entity ${detail.entity_id} (${detail.category})`,
        text: `${detail.name}\n${detail.description ?? ""}`,
        maxChars: SUMMARY_WRAP_CHARS,
      });

      return {
        content: [{ type: "text" as const, text: summaryText }],
        details: {
          found: true,
          entity: {
            entity_id: detail.entity_id,
            name: detail.name,
            address: detail.address,
            latitude: detail.latitude,
            longitude: detail.longitude,
            rating: detail.rating,
            reviews_count: detail.reviews_count,
            phone: detail.phone,
            parking: detail.parking,
            description: detail.description,
            peak_hours: detail.peak_hours,
            links: detail.links,
            documents_required: detail.documents_required,
            dress_code: detail.dress_code,
            category: detail.category,
            sub_category: detail.sub_category,
            sub_sub_category: detail.sub_sub_category,
            region: detail.region,
            image_url: detail.image_url,
            expires_at: detail.expires_at,
          },
          hours: detail.hours.map((h) => ({
            day: h.day,
            slot_index: h.slot_index,
            opening_time: h.opening_time,
            closing_time: h.closing_time,
            is_closed: h.is_closed === 1,
          })),
          items: detail.items.map((it) => ({
            item_id: it.item_id,
            item_name: it.item_name,
            price_amount: it.price_amount,
            price_label: it.price_label,
            currency: it.currency,
            timing_open: it.timing_open,
            timing_close: it.timing_close,
            item_type: it.item_type,
            signature_dish: it.signature_dish === 1,
          })),
          tags: detail.tags.map((t) => t.tag),
        },
      };
    },
  };
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(raw)));
}

function clampRadius(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_RADIUS_KM;
  }
  return Math.min(500, Math.max(0.1, raw));
}

function renderCardsAsUntrustedBlock(cards: EntityCard[]): string {
  if (cards.length === 0) {
    return wrapUntrustedTravelBlock({
      label: "Travel recommendations",
      text: "(no matching items)",
    });
  }
  const lines: string[] = [];
  cards.forEach((card, index) => {
    const distance =
      typeof card.distance_km === "number" ? `${card.distance_km.toFixed(1)} km` : "";
    const header = [
      `#${index + 1} ${card.name}`,
      card.category,
      card.region ?? "",
      distance,
    ]
      .filter(Boolean)
      .join(" — ");
    lines.push(header);
    if (card.description) {
      lines.push(card.description);
    }
  });
  return wrapUntrustedTravelBlock({
    label: "Travel recommendations",
    text: lines.join("\n"),
    maxChars: 4_000,
  });
}

function toCardSummary(card: EntityCard) {
  return {
    id: String(card.entity_id),
    entity_id: card.entity_id,
    name: card.name,
    category: card.category,
    sub_category: card.sub_category,
    region: card.region,
    address: card.address,
    latitude: card.latitude,
    longitude: card.longitude,
    rating: card.rating,
    description: card.description,
    image_url: card.image_url,
    distance_km: card.distance_km ?? null,
  };
}
