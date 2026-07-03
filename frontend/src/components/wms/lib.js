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

// ─── Scanner input sanitizer ────────────────────────────────────────────────
// Some handheld scanners are configured with a preamble/prefix (e.g. "%-") or
// transmit an AIM symbology identifier before the payload. The label barcodes
// themselves are clean Code128 of the raw name/LPN, so we strip any leading
// non-alphanumeric junk before matching. Safe: every location/LPN/SKU starts
// with a letter or digit (RP10-A26, CARRO 1, BOX-000143, style 2000…).
// Only the leading prefix is removed; interior dashes/spaces (e.g. "CARRO 1")
// are preserved, and trailing whitespace is trimmed.
export const cleanScan = (raw) => (raw || "").toUpperCase().replace(/^[^A-Z0-9]+/, "").trimEnd();

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

// ─── Configurable sizes (single source of truth) ────────────────────────────
// Admins add extra sizes in "Configuración WMS → Tallas" (catalog type "sizes").
// useWmsSizes() merges those into the standard sets so EVERY size selector in the
// system (Receiving, Picking, PDA, Operator, New Order, Movements) grows without
// a deploy. Extras starting with 'Y' join the youth list; the rest join adult.
// The standard arrays above stay as the fallback shown before the fetch resolves.
const _dedupeSizes = (arr) => {
  const seen = new Set(), out = [];
  for (const s of arr) { const v = String(s || '').trim().toUpperCase(); if (v && !seen.has(v)) { seen.add(v); out.push(v); } }
  return out;
};
let _sizeExtras = null;        // cached across components
let _sizeExtrasPromise = null;
const _sizeSubs = new Set();
const _loadSizeExtras = () => {
  if (_sizeExtrasPromise) return _sizeExtrasPromise;
  _sizeExtrasPromise = fetcher('/catalogs')
    .then(d => { _sizeExtras = (d?.sizes || []).map(s => String(s.value || '').trim().toUpperCase()).filter(Boolean); })
    .catch(() => { _sizeExtras = []; })
    .finally(() => { _sizeSubs.forEach(fn => fn()); });
  return _sizeExtrasPromise;
};
// Call after adding/removing a size in the catalog UI so open screens refresh.
export const refreshWmsSizes = () => { _sizeExtras = null; _sizeExtrasPromise = null; _loadSizeExtras(); };

export const useWmsSizes = () => {
  const [extras, setExtras] = useState(_sizeExtras || []);
  useEffect(() => {
    let alive = true;
    const sync = () => { if (alive) setExtras(_sizeExtras || []); };
    _sizeSubs.add(sync);
    _loadSizeExtras().then(sync);
    return () => { alive = false; _sizeSubs.delete(sync); };
  }, []);
  const adult = _dedupeSizes([...SIZES_ORDER, ...extras.filter(s => !s.startsWith('Y'))]);
  const youth = _dedupeSizes([...YOUTH_SIZES, ...extras.filter(s => s.startsWith('Y'))]);
  const all = _dedupeSizes([...adult, ...youth]);
  return { adult, youth, all, extras };
};

// ─── WMS Context (badges + cross-module actions) ────────────────────────────
export const WmsContext = createContext({ badges: {}, refreshBadges: () => {} });
export const useWms = () => useContext(WmsContext);
