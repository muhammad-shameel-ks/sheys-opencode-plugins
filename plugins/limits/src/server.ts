import { Plugin } from "@opencode/plugin";
import { ProviderLimitsCache } from "./cache.js";
import { isRecord } from "./http.js";
import { collectLimitsSnapshot } from "./providers/index.js";
import { LimitsRpc } from "./rpc.js";
import type { LimitsPluginOptions } from "./types.js";

function parsePluginOptions(raw: unknown): LimitsPluginOptions | undefined {
  if (!isRecord(raw)) return undefined;
  const include = Array.isArray(raw.include)
    ? raw.include.filter((item): item is string => typeof item === "string")
    : undefined;
  const exclude = Array.isArray(raw.exclude)
    ? raw.exclude.filter((item): item is string => typeof item === "string")
    : undefined;
  return include || exclude ? { include, exclude } : undefined;
}

export const LimitsServerPlugin = Plugin.define({
  id: "shey.opencode-limits.server",
  async setup(ctx) {
    const cache = new ProviderLimitsCache();
    const pluginOptions = parsePluginOptions(ctx.options);

    const registration = await ctx.rpc.register(LimitsRpc, {
      getLimits: async (input) => {
        return await collectLimitsSnapshot(
          { ctx, cache },
          { force: input.force ?? false, pluginOptions },
        );
      },
    });

    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({
        types: ["credential.updated", "credential.switched"],
        signal: controller.signal,
      })) {
        if (event.type === "credential.updated" || event.type === "credential.switched") {
          cache.invalidate();
        }
      }
    })().catch(() => {
      // Ignore abort / teardown errors when the server shuts down.
    });

    return async () => {
      controller.abort();
      await registration.dispose();
    };
  },
});

export default LimitsServerPlugin;
