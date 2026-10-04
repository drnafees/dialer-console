import type { WebhookDelivery } from "../../src/core/types";
import { json, KvStore, type Env } from "../_lib/kv-store";

// The console's own webhook endpoint. Register it in the mock API as
// https://<host>/hooks/receive with an authKey; the mock appends ?authKey=... on delivery.
export const EXPECTED_AUTH_KEY = "console-secret";

export async function receive(store: KvStore, authKey: string | null, payload: WebhookDelivery): Promise<void> {
  await store.pushEvent({ id: crypto.randomUUID(), receivedAt: new Date().toISOString(), authKeyValid: authKey === EXPECTED_AUTH_KEY, payload });
}

export const onRequestPost = async ({ request, env }: EventContext<Env, string, unknown>): Promise<Response> => {
  let payload: WebhookDelivery;
  try {
    payload = (await request.json()) as WebhookDelivery;
  } catch {
    return json({ error: "Body is not valid JSON" }, 400);
  }
  await receive(new KvStore(env.CONSOLE_KV), new URL(request.url).searchParams.get("authKey"), payload);
  return json({ received: true }, 202);
};
