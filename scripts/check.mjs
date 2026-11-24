// Adapted from the community plugin contract checker: no sign-in or network.
import * as entry from "../index.mjs";
import manifest from "../package.json" with { type: "json" };
if (manifest.type !== "module" || manifest.main !== "./index.mjs") throw new Error("Invalid package entry");
const plugins = Object.values(entry).filter(x => typeof x === "function");
if (plugins.length !== 1 || Object.keys(entry).length !== 1) throw new Error("Expected one plugin export");
const hooks = await plugins[0]({});
const config = {};
await hooks.config(config);
if (config.provider?.logicc?.npm !== "@ai-sdk/openai-compatible" ||
    hooks.auth?.provider !== "logicc" || typeof hooks.auth.loader !== "function" ||
    typeof hooks.auth.refresh !== "function" || typeof hooks.provider?.models !== "function" ||
    hooks.provider.id !== "logicc" || !hooks.auth.methods.every(m => m.type === "oauth" && typeof m.authorize === "function")) {
  throw new Error("Logicc plugin hook contract is invalid");
}
console.log("Logicc Magpie plugin contract: OK");
