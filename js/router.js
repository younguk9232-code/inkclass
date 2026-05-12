// Tiny hash router
const routes = {};
let currentCleanup = null;

export function route(pattern, render) {
  routes[pattern] = render;
}

export function go(path) {
  location.hash = "#" + path;
}

function parseHash() {
  const raw = (location.hash || "#/").slice(1);
  const [path, qs] = raw.split("?");
  const params = {};
  if (qs) qs.split("&").forEach(p => {
    const [k, v] = p.split("=");
    params[decodeURIComponent(k)] = decodeURIComponent(v || "");
  });
  return { path, params };
}

function dispatch() {
  const { path, params } = parseHash();
  if (currentCleanup) try { currentCleanup(); } catch {}
  currentCleanup = null;

  // Match exact then prefix
  const exact = routes[path];
  if (exact) {
    currentCleanup = exact(params) || null;
    return;
  }
  // Match prefix routes with `:id`
  for (const pattern of Object.keys(routes)) {
    if (!pattern.includes(":")) continue;
    const pParts = pattern.split("/");
    const aParts = path.split("/");
    if (pParts.length !== aParts.length) continue;
    const m = {};
    let ok = true;
    for (let i = 0; i < pParts.length; i++) {
      if (pParts[i].startsWith(":")) m[pParts[i].slice(1)] = aParts[i];
      else if (pParts[i] !== aParts[i]) { ok = false; break; }
    }
    if (ok) {
      currentCleanup = routes[pattern]({ ...m, ...params }) || null;
      return;
    }
  }
  // default
  if (routes["/"]) currentCleanup = routes["/"]() || null;
}

window.addEventListener("hashchange", dispatch);
export function start() { if (!location.hash) location.hash = "#/"; dispatch(); }
