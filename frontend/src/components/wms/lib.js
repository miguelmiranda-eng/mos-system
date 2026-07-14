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
// Notación canónica ÚNICA del sistema: tallas grandes como 2X/3X/4X/5X (NO 2XL).
// Es la forma que se guarda en Mongo Y la que se muestra en todo selector. Los
// importadores (SIZES_MAP en import_router.py) normalizan cualquier variante
// (2XL, XXL, "2 XL") a esta forma.
export const SIZES_ORDER = ['XS', 'S', 'M', 'L', 'XL', '2X', '3X', '4X', '5X'];
// Youth sizes. Kept separate so adult pick tickets are never shown youth rows
// (operators would get confused). The picking grid only switches to these when
// the selected style's inventory is actually youth.
export const YOUTH_SIZES = ['YXS', 'YS', 'YM', 'YL', 'YXL'];
// Toddler sizes (2T–5T). Llegan de Printavo/imports; se muestran como fila
// propia en los grids cuando el ticket/estilo las trae (igual que youth).
export const TODDLER_SIZES = ['2T', '3T', '4T', '5T'];
export const ALL_SIZES = [...SIZES_ORDER, ...YOUTH_SIZES, ...TODDLER_SIZES];

// Clasificadores de grupo compartidos (una sola definición para todo el WMS).
export const isYouthSize = (s) => String(s || '').toUpperCase().startsWith('Y');
export const isToddlerSize = (s) => /^[2-5]T$/.test(String(s || '').toUpperCase());
export const isAdultSize = (s) => !!s && !isYouthSize(s) && !isToddlerSize(s);

// ─── Configurable sizes (single source of truth) ────────────────────────────
// Admins add extra sizes in "Configuración WMS → Tallas" (catalog type "sizes").
// useWmsSizes() merges those into the standard sets so EVERY size selector in the
// system (Receiving, Picking, PDA, Operator, New Order, Movements) grows without
// a deploy. Extras starting with 'Y' join youth, los NT (2T–5T) van a toddler,
// el resto a adult. Los arreglos estándar son el fallback antes del fetch.
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
  const adult = _dedupeSizes([...SIZES_ORDER, ...extras.filter(isAdultSize)]);
  const youth = _dedupeSizes([...YOUTH_SIZES, ...extras.filter(isYouthSize)]);
  const toddler = _dedupeSizes([...TODDLER_SIZES, ...extras.filter(isToddlerSize)]);
  const all = _dedupeSizes([...adult, ...youth, ...toddler]);
  return { adult, youth, toddler, all, extras };
};

// ─── Configurable colors (curated catalog) ──────────────────────────────────
// Los colores viven en "Configuración WMS → Colores" (catalog type "colors").
// useWmsColors() los expone para que TODO selector de color (Receiving, UPC,
// etc.) muestre los colores curados aunque todavía no existan en inventario
// (ej. "ANCHORE", "FLAX" recién dados de alta). Mismo patrón que useWmsSizes.
let _colorCatalog = null;          // cached across components
let _colorCatalogPromise = null;
const _colorSubs = new Set();
const _loadColorCatalog = () => {
  if (_colorCatalogPromise) return _colorCatalogPromise;
  _colorCatalogPromise = fetcher('/catalogs')
    .then(d => { _colorCatalog = (d?.colors || []).map(c => String(c.value || '').trim()).filter(Boolean); })
    .catch(() => { _colorCatalog = []; })
    .finally(() => { _colorSubs.forEach(fn => fn()); });
  return _colorCatalogPromise;
};
// Call after adding/removing a color in the catalog UI so open screens refresh.
export const refreshWmsColors = () => { _colorCatalog = null; _colorCatalogPromise = null; _loadColorCatalog(); };

export const useWmsColors = () => {
  const [colors, setColors] = useState(_colorCatalog || []);
  useEffect(() => {
    let alive = true;
    const sync = () => { if (alive) setColors(_colorCatalog || []); };
    _colorSubs.add(sync);
    _loadColorCatalog().then(sync);
    return () => { alive = false; _colorSubs.delete(sync); };
  }, []);
  return colors;
};

// ─── Catálogo curado COMPLETO (todos los tipos) ─────────────────────────────
// Un solo /catalogs expone customers/colors/styles/sizes/descriptions/countries/
// fabrics curados. useWmsCatalogs() los entrega ya en arreglos de strings, para
// FUSIONARLOS con las listas del sistema/inventario en cualquier módulo y no
// ocultar valores reales no catalogados. El líder limpia typos en la config.
let _catalogs = null;               // { type: [{value,...}] } crudo de /catalogs
let _catalogsPromise = null;
const _catSubs = new Set();
const _loadCatalogs = () => {
  if (_catalogsPromise) return _catalogsPromise;
  _catalogsPromise = fetcher('/catalogs')
    .then(d => { _catalogs = d || {}; })
    .catch(() => { _catalogs = {}; })
    .finally(() => { _catSubs.forEach(fn => fn()); });
  return _catalogsPromise;
};
export const refreshWmsCatalogs = () => { _catalogs = null; _catalogsPromise = null; _loadCatalogs(); };

export const useWmsCatalogs = () => {
  const [cat, setCat] = useState(_catalogs || {});
  useEffect(() => {
    let alive = true;
    const sync = () => { if (alive) setCat(_catalogs || {}); };
    _catSubs.add(sync);
    _loadCatalogs().then(sync);
    return () => { alive = false; _catSubs.delete(sync); };
  }, []);
  const vals = (t) => (cat[t] || []).map(x => String(x?.value ?? x ?? '').trim()).filter(Boolean);
  return {
    customers: vals('customers'), colors: vals('colors'), styles: vals('styles'),
    sizes: vals('sizes'), descriptions: vals('descriptions'),
    countries: vals('countries'), fabrics: vals('fabrics'),
  };
};

// Fusiona listas (curado + sistema) sin duplicados (case-insensitive). Curado
// primero, luego lo del sistema que falte. Compartido por los módulos WMS.
export const mergeUnique = (...lists) => {
  const seen = new Set(), out = [];
  for (const l of lists) for (const c of (l || [])) {
    const v = String(c || '').trim(), k = v.toUpperCase();
    if (v && !seen.has(k)) { seen.add(k); out.push(v); }
  }
  return out;
};

// ─── WMS Context (badges + cross-module actions) ────────────────────────────
export const WmsContext = createContext({ badges: {}, refreshBadges: () => {} });
export const useWms = () => useContext(WmsContext);
