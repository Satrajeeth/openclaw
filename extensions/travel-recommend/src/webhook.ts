import { z } from "zod";
import { createWebhookRoute } from "../runtime-api.js";
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
  return createWebhookRoute({
    path: "/travel-ingest",

    async handler(req, res) {
      try {
        // Basic auth check
        const auth = req.headers["x-webhook-secret"];
        if (auth !== secret) {
          res.status(401).send("Unauthorized");
          return;
        }

        const parsed = PayloadSchema.parse(req.body);

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

        res.send({ success: true, count: parsed.items.length });
      } catch (err) {
        console.error(err);
        res.status(400).send("Invalid payload");
      }
    },
  });
}
