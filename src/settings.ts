import type { Env } from "./types";

export async function getSetting<T = string>(env: Env, key: string): Promise<T | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first<{ value: string }>().catch(() => null);
  if (!row) return null;
  try { return JSON.parse(row.value) as T; } catch { return row.value as unknown as T; }
}
export async function setSetting(env: Env, key: string, value: unknown) {
  if (value === null || value === undefined || value === "") return env.DB.prepare("DELETE FROM settings WHERE key=?").bind(key).run();
  return env.DB.prepare("INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES (?,?,unixepoch())").bind(key, JSON.stringify(value)).run();
}
