// Cross-tab realtime sync via BroadcastChannel.
// All teacher/student tabs in the same browser stay in sync.
import { store } from "./store.js";

const ch = new BroadcastChannel("inkclass-sync");

const listeners = new Set();

ch.onmessage = (ev) => {
  const msg = ev.data;
  if (!msg || !msg.type) return;
  // Apply to local store first if it's a state-changing message,
  // then notify view-listeners (so they can repaint specific bits without full reload).
  if (msg.type === "state-snapshot") {
    // ignore — store is the source; we use storage for snapshots
  }
  // The store is shared via localStorage in this prototype; we only need
  // to nudge listeners to re-read & repaint.
  listeners.forEach(fn => fn(msg));
};

// localStorage `storage` event also re-syncs across tabs automatically
window.addEventListener("storage", (e) => {
  if (e.key === "inkclass:v1" && e.newValue) {
    try {
      const parsed = JSON.parse(e.newValue);
      Object.assign(store.state, parsed);
      store.listeners.forEach(fn => fn(store.state));
    } catch {}
  }
});

export const sync = {
  emit(msg) { ch.postMessage(msg); },
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};
