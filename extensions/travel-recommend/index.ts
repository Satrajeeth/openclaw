import { definePluginEntry } from "./api.js";
import { ConfigSchema, type TravelPluginConfig } from "./src/config.js";
import { TravelStore } from "./src/store.js";

declare module "openclaw/plugin-sdk/core" {
  interface PluginState {
    store: TravelStore;
  }
}

export default definePluginEntry({
  id: "travel-recommend",
  name: "Travel Recommend",
  description: "Travel recommendation engine plugin",
  configSchema: ConfigSchema as unknown as import("openclaw/plugin-sdk/core").OpenClawPluginConfigSchema,
  register(api) {
    const config = api.pluginConfig as TravelPluginConfig;

    // Initialize database
    const _store = new TravelStore(config);

    console.log("Travel Recommend Plugin initialized");
  },
});
