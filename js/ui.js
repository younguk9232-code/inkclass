// Helpers — DOM, modal, tiny rendering utilities.
export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") node.innerHTML = v;
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

export function template(id) {
  const t = document.getElementById(id);
  return t.content.firstElementChild.cloneNode(true);
}

export function mount(view) {
  const app = document.getElementById("app");
  app.innerHTML = "";
  app.appendChild(view);
}

export function modal({ title, body, actions }) {
  const back = el("div", { class: "modal-back" });
  const m = el("div", { class: "modal" });
  m.appendChild(el("h3", {}, title));
  if (typeof body === "string") m.appendChild(el("p", { class: "muted" }, body));
  else if (body) m.appendChild(body);
  const row = el("div", { class: "row-actions" });
  (actions || []).forEach(a => {
    const b = el("button", { class: a.primary ? "btn btn-primary" : (a.danger ? "btn btn-danger" : "btn"), onClick: () => a.onClick(close) }, a.label);
    row.appendChild(b);
  });
  m.appendChild(row);
  back.appendChild(m);
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  document.body.appendChild(back);
  function close() { back.remove(); }
  return { close, root: back };
}

export function fmtDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth()+1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
