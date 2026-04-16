import { z } from "zod";

export const ConfigSchema = z.object({
  storePath: z.string().default("./travel.db"),
  webhookSecret: z.string().min(1),

  // optional (for future use)
  embeddingProvider: z.string().optional(),
  maxResults: z.number().default(5),
});

export type TravelPluginConfig = z.infer<typeof ConfigSchema>;
