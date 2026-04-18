import { Type } from "@sinclair/typebox";
import {
  jsonResult,
  optionalStringEnum,
  readNumberParam,
  readStringParam,
  type AnyAgentTool,
} from "openclaw/plugin-sdk/core";
import { wrapUntrustedTravelBlock } from "./sanitize.js";
import type { TravelCard, TravelStore } from "./store.js";

const TRAVEL_CATEGORIES = [
  "destination",
  "restaurant",
  "temple",
  "stay",
  "event",
  "route",
] as const;
const PRICE_TIERS = ["budget", "mid", "luxury"] as const;

const MAX_LIMIT = 10;
const DEFAULT_LIMIT = 5;
const SUMMARY_WRAP_CHARS = 500;

const TravelRecommendSchema = Type.Object(
  {
    query: Type.String({
      description: "Free-text search across name, summary, tags, and location.",
    }),
    category: optionalStringEnum(TRAVEL_CATEGORIES, {
      description: "Restrict results to a travel category.",
    }),
    region: Type.Optional(
      Type.String({
        description: "Exact region/state match (e.g. 'Andhra Pradesh').",
      }),
    ),
    city: Type.Optional(
      Type.String({
        description: "Exact city match.",
      }),
    ),
    priceTier: optionalStringEnum(PRICE_TIERS, {
      description: "Restrict results to a price tier.",
    }),
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
    id: Type.String({ description: "Travel item id returned by travel_recommend." }),
  },
  { additionalProperties: false },
);

export function createTravelRecommendTool(store: TravelStore): AnyAgentTool {
  return {
    name: "travel_recommend",
    label: "Travel Recommend",
    description:
      "Search the ingested travel corpus (destinations, restaurants, temples, stays, events, routes) and return compact recommendations.",
    parameters: TravelRecommendSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const query = readStringParam(rawParams, "query", { required: true });
      const category = readStringParam(rawParams, "category");
      const region = readStringParam(rawParams, "region");
      const city = readStringParam(rawParams, "city");
      const priceTier = readStringParam(rawParams, "priceTier");
      const rawLimit = readNumberParam(rawParams, "limit", { integer: true });
      const limit = clampLimit(rawLimit);

      const cards = store.search({
        query,
        category,
        region,
        city,
        priceTier,
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
    description: "Fetch the full detail payload for a single travel item by id.",
    parameters: TravelDetailSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const id = readStringParam(rawParams, "id", { required: true });
      const row = store.getById(id);
      if (!row) {
        return jsonResult({ found: false, id });
      }

      const detail = parseJsonSafe(row.detail_json);
      const summaryText = wrapUntrustedTravelBlock({
        label: `Travel item ${row.id} (${row.category})`,
        text: `${row.name}\n${row.summary}`,
        maxChars: SUMMARY_WRAP_CHARS,
      });

      return {
        content: [{ type: "text" as const, text: summaryText }],
        details: {
          found: true,
          item: {
            id: row.id,
            category: row.category,
            name: row.name,
            region: row.region,
            city: row.city,
            country: row.country,
            price_tier: row.price_tier,
            tags: parseJsonSafe(row.tags) ?? [],
            summary: row.summary,
            expires_at: row.expires_at,
            detail: detail ?? {},
          },
        },
      };
    },
  };
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(raw)));
}

function renderCardsAsUntrustedBlock(cards: TravelCard[]): string {
  if (cards.length === 0) {
    return wrapUntrustedTravelBlock({
      label: "Travel recommendations",
      text: "(no matching items)",
    });
  }
  const lines: string[] = [];
  cards.forEach((card, index) => {
    const header = [`#${index + 1} ${card.name}`, card.category, locationOf(card), card.price_tier]
      .filter(Boolean)
      .join(" — ");
    lines.push(header);
    if (card.summary) lines.push(card.summary);
  });
  return wrapUntrustedTravelBlock({
    label: "Travel recommendations",
    text: lines.join("\n"),
    maxChars: 4_000,
  });
}

function locationOf(card: TravelCard): string {
  return [card.city, card.region, card.country].filter(Boolean).join(", ");
}

function toCardSummary(card: TravelCard) {
  return {
    id: card.id,
    category: card.category,
    name: card.name,
    region: card.region,
    city: card.city,
    country: card.country,
    price_tier: card.price_tier,
    tags: parseJsonSafe(card.tags) ?? [],
    summary: card.summary,
  };
}

function parseJsonSafe(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
