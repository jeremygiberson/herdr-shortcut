// A fake fetch for the Shortcut API: routes map "METHOD /path" (without /api/v3) to a value or a function.
export function fakeApi(routes = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const path = new URL(url).pathname.replace(/^\/api\/v3/, "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, headers: init.headers ?? {}, body });
    const key = `${method} ${path}`;
    let r = key in routes ? routes[key] : { status: 404, headers: {}, body: { message: `no route for ${key}` } };
    if (typeof r === "function") r = await r(body, url);
    const isShape = r && typeof r === "object" && !Array.isArray(r) && "status" in r && ("body" in r || "headers" in r);
    const { status = 200, headers = {}, body: out } = isShape ? r : { body: r };
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const text = out === undefined ? "" : JSON.stringify(out);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (n) => lower[String(n).toLowerCase()] ?? null },
      json: async () => JSON.parse(text),
      text: async () => text,
    };
  };
  fetch.calls = calls;
  return fetch;
}
