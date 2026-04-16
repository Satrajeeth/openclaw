import { definePluginEntry } from "./api.js";
import { ConfigSchema, type TravelPluginConfig } from "./src/config.js";
import { TravelStore } from "./src/store.js";
import { createTravelWebhook } from "./src/webhook.js";

declare module "openclaw/plugin-sdk/core" {
  interface PluginState {
    store: TravelStore;
  }
}

export default definePluginEntry({
  id: "travel-recommend",
  name: "Travel Recommend",
  description: "Travel recommendation engine plugin with automated webhooks",
  
  // Use the schema from your config file
  configSchema: ConfigSchema as unknown as import("openclaw/plugin-sdk/core").OpenClawPluginConfigSchema,

  async register(api) {
    const config = api.pluginConfig as TravelPluginConfig;

    // 1. Initialize the Store (Database)
    const store = new TravelStore(config);

    // 2. Register the Webhook route
    const webhook = createTravelWebhook(store, config.webhookSecret);
    api.registerHttpRoute(webhook);

    console.log("Travel Recommend Plugin initialized successfully with Webhook support");
  },
});
