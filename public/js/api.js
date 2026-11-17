// Thin wrapper around fetch for the node's REST API.
// The UI can talk to any node (they all allow CORS), selected in the header.
let baseUrl = location.origin;

export const getNode = () => baseUrl;
export const setNode = (url) => { baseUrl = url; };

async function request(path, { method = 'GET', body, base = baseUrl, timeout = 15_000 } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  get: (path, base) => request(path, { base }),
  post: (path, body, options = {}) => request(path, { method: 'POST', body, ...options }),
};
