import { z } from "zod";

const DEFAULT_TTL_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_INGEST_ITEMS = 5_000;

export const ConfigSchema = z.object({
  storePath: z.string().optional(),
  webhookSecret: z.string().min(1),

  maxResults: z.number().int().positive().default(5),
  ttlSweepIntervalMs: z.number().int().positive().default(DEFAULT_TTL_SWEEP_INTERVAL_MS),
  maxIngestItems: z.number().int().positive().default(DEFAULT_MAX_INGEST_ITEMS),

  // reserved for future use
  embeddingProvider: z.string().optional(),
});

export type TravelPluginConfig = z.infer<typeof ConfigSchema>;
