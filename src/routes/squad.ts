import { Hono } from "hono";
import type { Env } from "../types";
import { squadRecords, weeklyRecap } from "../recap";

const r = new Hono<{ Bindings: Env }>();

/** Weekly recap. ?offset=0 is the week in progress, 1 the last finished week (default), up to a year back. */
r.get("/recap", async (c) => {
  const offset = Math.max(0, Math.min(52, Number(c.req.query("offset") ?? 1) || 0));
  return c.json(await weeklyRecap(c.env, offset));
});

/** All-time records wall. Derived from every stored game, so it is cached at the edge for ten minutes. */
r.get("/records", async (c) => {
  const key = new Request("https://cache.soulscribe.internal/squad-records-v2");
  const hit = await caches.default.match(key); if (hit) return new Response(hit.body, hit);
  const res = new Response(JSON.stringify(await squadRecords(c.env)), { headers: { "content-type": "application/json", "cache-control": "public, max-age=600" } });
  c.executionCtx.waitUntil(caches.default.put(key, res.clone()));
  return res;
});

export default r;
