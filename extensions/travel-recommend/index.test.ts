import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import plugin from "./index.js";

describe("travel-recommend plugin", () => {
  it("registers the webhook route and the two agent tools", async () => {
    const registerHttpRoute = vi.fn();
    const registerTool = vi.fn();
    const api = createTestPluginApi({
      id: "travel-recommend",
      name: "Travel Recommend",
      source: "test",
      pluginConfig: {
        storePath: ":memory:",
        webhookSecret: "test-secret",
      },
      registerHttpRoute,
      registerTool,
    });

    await plugin.register(api);

    expect(registerHttpRoute).toHaveBeenCalledTimes(1);
    expect(registerHttpRoute.mock.calls[0]?.[0]?.path).toBe("/travel-ingest");
    expect(registerTool).toHaveBeenCalledTimes(2);
    expect(registerTool.mock.calls.map((call) => call[1]?.name)).toEqual([
      "travel_recommend",
      "travel_detail",
    ]);
  });
});
