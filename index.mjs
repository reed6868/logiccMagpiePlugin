import { createPlugin } from "./src/plugin.mjs";

export default async function LogiccPlugin({ client } = {}) {
  return createPlugin({ client });
}
