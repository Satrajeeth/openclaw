import { definePluginEntry } from "./api.js";
import { ConfigSchema, type TravelPluginConfig } from "./src/config.js";
import { TravelStore } from "./src/store.js";
import { createTravelDetailTool, createTravelRecommendTool } from "./src/tools.js";
import { createTravelWebhook } from "./src/webhook.js";

export default definePluginEntry({
  id: "travel-recommend",
  name: "Travel Recommend",
  description: "Travel recommendation engine plugin with webhook-based data ingestion.",
  configSchema: ConfigSchema as unknown as import("openclaw/plugin-sdk/core").OpenClawPluginConfigSchema,

  register(api) {
    const config = ConfigSchema.parse(api.pluginConfig ?? {}) as TravelPluginConfig;

    const store = new TravelStore(config);

    api.registerHttpRoute(createTravelWebhook(store, config));
    api.registerTool(createTravelRecommendTool(store), { name: "travel_recommend" });
    api.registerTool(createTravelDetailTool(store), { name: "travel_detail" });

    const sweep = setInterval(() => {
      try {
        store.deleteExpired(Date.now());
      } catch (err) {
        api.logger.warn?.(`travel-recommend: TTL sweep failed: ${String(err)}`);
      }
    }, config.ttlSweepIntervalMs);
    sweep.unref?.();

    api.logger.info?.("travel-recommend plugin initialized");
  },
});
