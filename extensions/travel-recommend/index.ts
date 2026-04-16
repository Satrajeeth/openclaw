import { definePluginEntry } from "./api.js";
import { ConfigSchema } from "./src/config.js";
import { TravelStore } from "./src/store.js";

declare module "openclaw/plugin-sdk/core" {
  interface PluginState {
    store: TravelStore;
  }
}

export default definePluginEntry({
  configSchema: ConfigSchema as any,
  async onBootstrap(ctx: any) {
    const config = ctx.config;

    // Initialize database
    const store = new TravelStore(config);

    // Store it in context for later use
    ctx.state.store = store;

    console.log("Travel Recommend Plugin initialized");
  },
});
