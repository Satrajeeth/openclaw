import { definePluginEntry } from "./api";
import { ConfigSchema } from "./src/config";
import { TravelStore } from "./src/store";

declare module "openclaw/plugin-sdk/core" {
  interface PluginState {
    store: TravelStore;
  }
}

export default definePluginEntry({
  configSchema: ConfigSchema,

  async init(ctx) {
    const config = ctx.config;

    // Initialize database
    const store = new TravelStore(config);

    // Store it in context for later use
    ctx.state.store = store;

    console.log("Travel Recommend Plugin initialized");
  },
});
