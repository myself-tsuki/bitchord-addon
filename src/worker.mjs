// Cloudflare Workers entry point (recommended host). Also works on Deno and Bun
// via their `export default { fetch }` support.
import { handle } from "./addon.mjs";

export default {
  fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },
};
