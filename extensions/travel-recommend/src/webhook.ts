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
import { sanitizeText } from "./sanitize.js";
import type { TravelItem, TravelStore } from "./store.js";

const TravelItemSchema = z.object({
  id: z.string().min(1).max(256),
  category: z.string().min(1).max(64),
  name: z.string().min(1).max(256),
  region: z.string().max(128).optional(),
  city: z.string().max(128).optional(),
  country: z.string().max(128).optional(),
  price_tier: z.string().max(32).optional(),
  tags: z.array(z.string().max(64)).max(32).optional(),
  summary: z.string().max(2_000).optional(),
  detail_json: z.unknown().optional(),
  expires_at: z.number().int().nonnegative().optional(),
});

type IngestItem = z.infer<typeof TravelItemSchema>;

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
    items: z.array(TravelItemSchema).min(1).max(config.maxIngestItems),
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
        if (!body.ok) return;

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
        const rows: TravelItem[] = [];
        const rejected: { id?: string; reason: string }[] = [];
        for (const item of parsed.data.items) {
          const row = toTravelRow(item, now);
          if (row) rows.push(row);
          else rejected.push({ id: item.id, reason: "invalid_after_sanitize" });
        }

        const count = store.upsertBatch(rows);

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

function toTravelRow(item: IngestItem, now: number): TravelItem | null {
  const name = sanitizeText(item.name, 200);
  if (!name) {
    return null;
  }
  const category = sanitizeText(item.category, 64);
  if (!category) {
    return null;
  }
  return {
    id: item.id,
    category,
    name,
    region: sanitizeText(item.region ?? "", 128),
    city: sanitizeText(item.city ?? "", 128),
    country: sanitizeText(item.country ?? "", 128),
    price_tier: sanitizeText(item.price_tier ?? "", 32),
    tags: JSON.stringify((item.tags ?? []).map((t) => sanitizeText(t, 64)).filter(Boolean)),
    summary: sanitizeText(item.summary ?? "", 500),
    detail_json: JSON.stringify(item.detail_json ?? {}),
    expires_at: item.expires_at ?? null,
    created_at: now,
    updated_at: now,
  };
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
