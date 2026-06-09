import { createContext, useContext, useState, useEffect } from "react";
import { toast } from "sonner";
import { apiFetch, onHttpBusyChange } from "../../lib/http";

// True while any HTTP request is in flight. Lets components show a busy hint.
export const useHttpBusy = () => {
  const [busy, setBusy] = useState(false);
  useEffect(() => onHttpBusyChange(count => setBusy(count > 0)), []);
  return busy;
};

// ─── API constants ───────────────────────────────────────────────────────────
export const API = `${process.env.REACT_APP_BACKEND_URL}/api/wms`;
export const AUTH_API = `${process.env.REACT_APP_BACKEND_URL}/api/auth`;

// ─── HTTP helpers (use apiFetch → TTL cache + dedup + 401 handling) ─────────
// Default behavior: parse JSON, reject on !ok. Mutations (poster/putter) return
// the raw Response so callers can branch on res.ok and read errors.
export const fetcher = (url, options = {}) => {
  if (options.method && options.method !== 'GET' && options.body && !options.headers) {
    options.headers = { 'Content-Type': 'application/json' };
  }
  return apiFetch(`${API}${url}`, options).then(r => r.ok ? r.json() : Promise.reject(r));
};
export const poster = (url, body) => apiFetch(`${API}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export const putter = (url, body) => apiFetch(`${API}${url}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export const deleter = (url) => apiFetch(`${API}${url}`, { method: 'DELETE' }).then(r => r.ok ? r.json() : Promise.reject(r));

// ─── Error helpers — replace silent `catch {}` patterns ─────────────────────
export const logLoadError = (what) => (err) => console.error(`[WMS] Failed to load ${what}:`, err);
export const toastActionError = (what) => (err) => { console.error(`[WMS] ${what} failed:`, err); toast.error(`No se pudo ${what}`); };

// ─── Shared constants ───────────────────────────────────────────────────────
export const SIZES_ORDER = ['XS', 'S', 'M', 'L', 'XL', '2X', '3X', '4X', '5X'];
// Youth sizes. Kept separate so adult pick tickets are never shown youth rows
// (operators would get confused). The picking grid only switches to these when
// the selected style's inventory is actually youth.
export const YOUTH_SIZES = ['YXS', 'YS', 'YM', 'YL', 'YXL'];
export const ALL_SIZES = [...SIZES_ORDER, ...YOUTH_SIZES];

// ─── WMS Context (badges + cross-module actions) ────────────────────────────
export const WmsContext = createContext({ badges: {}, refreshBadges: () => {} });
export const useWms = () => useContext(WmsContext);
