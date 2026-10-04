import { json, KvStore, type Env } from "../_lib/kv-store";

export const onRequestGet = async ({ env }: EventContext<Env, string, unknown>): Promise<Response> => {
  const store = new KvStore(env.CONSOLE_KV);
  await store.ensureSeeded();
  return json({ events: await store.listEvents() });
};

// "Reset demo data": wipes KV and re-seeds leads; removes webhooks and the event log.
export const onRequestDelete = async ({ env }: EventContext<Env, string, unknown>): Promise<Response> => {
  await new KvStore(env.CONSOLE_KV).reset();
  return json({ ok: true });
};
