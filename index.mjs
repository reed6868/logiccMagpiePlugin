export default async function LogiccPlugin() {
  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider.logicc ??= {
        name: "Logicc",
        npm: "@ai-sdk/openai-compatible",
        api: "https://app.logicc.com/api",
        models: {},
      };
    },
  };
}
