import { json, KvStore, type Env } from "../_lib/kv-store";
import { receiveDelivery } from "../_lib/receiver";

export { EXPECTED_AUTH_KEY } from "../_lib/receiver";

// The console's own webhook endpoint. Accepts JSON, application/x-www-form-urlencoded
// and XML; verifies ?authKey=; dedupes; forwards to the CRM with retries.
// ?failTimes=N makes the first N forward attempts fail (demo of the retry path).
export const onRequestPost = async ({ request, env }: EventContext<Env, string, unknown>): Promise<Response> => {
  const url = new URL(request.url);
  const store = new KvStore(env.CONSOLE_KV);
  await store.ensureSeeded();
  const result = await receiveDelivery(store, {
    authKey: url.searchParams.get("authKey"),
    contentType: request.headers.get("Content-Type"),
    raw: await request.text(),
    origin: url.origin,
    failTimes: Number(url.searchParams.get("failTimes") ?? "0") || 0,
  });
  return json(result.body, result.status);
};
