import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { sanitizeText } from "./sanitize.js";
import { TravelStore } from "./store.js";

const TravelItemSchema = z.object({
  id: z.string(),
  category: z.string(),
  name: z.string(),
  region: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  price_tier: z.string().optional(),
  tags: z.array(z.string()).optional(),
  summary: z.string().optional(),
  detail_json: z.any().optional(),
  expires_at: z.number().optional(),
});

const PayloadSchema = z.object({
  items: z.array(TravelItemSchema),
});

export function createTravelWebhook(store: TravelStore, secret: string) {
  return {
    path: "/travel-ingest",
    auth: "plugin" as const,

    async handler(req: IncomingMessage, res: ServerResponse) {
      try {
        // Basic auth check
        const auth = req.headers["x-webhook-secret"];
        if (auth !== secret) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }

        // Read body
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString());

        const parsed = PayloadSchema.parse(body);
        const now = Date.now();

        for (const item of parsed.items) {
          store.upsertItem({
            id: item.id,
            category: item.category,
            name: sanitizeText(item.name, 100),
            region: item.region ?? "",
            city: item.city ?? "",
            country: item.country ?? "",
            price_tier: item.price_tier ?? "",
            tags: JSON.stringify(item.tags ?? []),
            summary: sanitizeText(item.summary ?? "", 500),
            detail_json: JSON.stringify(item.detail_json ?? {}),
            expires_at: item.expires_at ?? null,
            created_at: now,
            updated_at: now,
          });
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, count: parsed.items.length }));
      } catch (err) {
        console.error(err);
        res.writeHead(400);
        res.end("Invalid payload");
      }
    },
  };
}
