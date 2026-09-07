import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Loader2, RefreshCw, Trash2, MapPin, PackageX, PackagePlus,
  Unlock, CheckCircle2, ListChecks, Download, Ban, History, PackageCheck, RotateCcw, Search, X,
  Ghost, ScanSearch, Save, Camera,
} from "lucide-react";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, poster } from "./lib";
import { Btn, Chip, Th, ModuleToolbar } from "./ui";
import PhotoInventoryTab from "./PhotoInventory";

// Panel PC de conciliación (admin): cajas faltantes + creadas para resolver, y
// el registro de ubicaciones ya conciliadas (con opción de reabrir).

const TABS = [
  { id: "pending", labelKey: "wms_recon_tab_pending", icon: PackageX },
  { id: "phantom", labelKey: "wms_recon_tab_phantom", icon: Ghost },
  { id: "second_count", labelKey: "wms_recon_tab_second_count", icon: RotateCcw },
  { id: "log", labelKey: "wms_recon_tab_log", icon: ListChecks },
  { id: "adjustments", labelKey: "wms_recon_tab_adjustments", icon: History },
  { id: "lpn", labelKey: "wms_recon_tab_lpn", icon: Ban },
  { id: "photo", labelKey: "wms_photo_inventory", icon: Camera },
];

// Tipo de ajuste (valor de dominio) → clave i18n de la etiqueta.
const ADJ_TYPE_KEYS = {
  lpn_recon_restore: "wms_recon_adj_lpn_recon_restore",
  second_count_start: "wms_recon_adj_second_count_start",
  phantom_scan: "wms_recon_adj_phantom_scan",
  recon_creadas_folded: "wms_recon_adj_recon_creadas_folded",
};

// Tipos de stock fantasma (ver services/phantom_scan.py). El delta es siempre
// "unidades en duda": lo que el papel afirma y el piso quizá no respalda.
const PHANTOM_TIPOS = {
  saldo_sin_cajas: { labelKey: "wms_recon_ph_saldo_sin_cajas", chip: "bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/25" },
  cajas_de_papel: { labelKey: "wms_recon_ph_cajas_de_papel", chip: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/25" },
  sin_identidad: { labelKey: "wms_recon_ph_sin_identidad", chip: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-500/10 dark:text-violet-300 dark:border-violet-500/25" },
};
const PHANTOM_MAX_ROWS = 500;

const fmt = (iso) => {
  if (!iso) return "-";
  const d = new Date(iso);
  return isNaN(d) ? String(iso).slice(0, 16) : d.toLocaleString("es-MX", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
};

export const ReconciliationModule = () => {
  const { t } = useLang();
  const [tab, setTab] = useState("pending");
  const [pending, setPending] = useState(null);
  const [log, setLog] = useState(null);
  const [lpn, setLpn] = useState(null);
  const [adj, setAdj] = useState(null);
  const [phantom, setPhantom] = useState(null);
  const [phantomTipo, setPhantomTipo] = useState(null);   // filtro por tipo (chip)
  const [phantomDrafts, setPhantomDrafts] = useState({}); // registros editados sin guardar
  const [scanning, setScanning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [locationSearch, setLocationSearch] = useState("");

  // Etiqueta de un tipo de fantasma: traducida si es conocido, cruda si no.
  const phantomLabel = (tipo) => (PHANTOM_TIPOS[tipo] ? t(PHANTOM_TIPOS[tipo].labelKey) : tipo);
  // "x de y" cuando hay filtro activo; solo "x" si no.
  const nOfM = (n, m, filtered) => (filtered ? t("wms_recon_n_of_m", { n, m }) : n);
  const filteredTag = (q) => <span className="ml-1 text-muted-foreground font-normal">{t("wms_recon_filtered_by", { q })}</span>;

  const loadPending = useCallback(async () => {
    setLoading(true);
    try { setPending(await fetcher("/recon/pending")); }
    catch { toast.error(t("wms_recon_load_err")); }
    finally { setLoading(false); }
  }, [t]);
  const loadLog = useCallback(async () => {
    setLoading(true);
    try { setLog(await fetcher("/recon/log")); }
    catch { toast.error(t("wms_recon_log_err")); }
    finally { setLoading(false); }
  }, [t]);

  const loadLpn = useCallback(async () => {
    setLoading(true);
    try { setLpn(await fetcher("/recon/lpn-locations")); }
    catch { toast.error(t("wms_recon_lpn_err")); }
    finally { setLoading(false); }
  }, [t]);

  const loadAdj = useCallback(async () => {
    setLoading(true);
    try { setAdj(await fetcher("/recon/adjustments")); }
    catch { toast.error(t("wms_recon_adj_err")); }
    finally { setLoading(false); }
  }, [t]);

  const loadPhantom = useCallback(async () => {
    setLoading(true);
    try { setPhantom(await fetcher("/recon/phantom")); }
    catch { toast.error(t("wms_recon_phantom_err")); }
    finally { setLoading(false); }
  }, [t]);

  useEffect(() => {
    if ((tab === "pending" || tab === "second_count") && !pending) loadPending();
    if ((tab === "log" || tab === "second_count") && !log) loadLog();
    if (tab === "lpn" && !lpn) loadLpn();
    if ((tab === "adjustments" || tab === "second_count") && !adj) loadAdj();
    if (tab === "phantom" && !phantom) loadPhantom();
  }, [tab, pending, log, lpn, adj, phantom, loadPending, loadLog, loadLpn, loadAdj, loadPhantom]);

  const runPhantomScan = async () => {
    if (!window.confirm(t("wms_recon_scan_confirm"))) return;
    setScanning(true);
    try {
      const res = await poster("/recon/phantom/scan", {});
      if (res.ok) {
        const d = await res.json();
        toast.success(t("wms_recon_scan_result", { count: d.count, nuevos: d.nuevos, resueltos: d.resueltos }));
        loadPhantom(); setAdj(null);
      } else { const e = await res.json().catch(() => ({})); toast.error(e.detail || t("error")); }
    } catch { toast.error(t("wms_conn_error")); }
    finally { setScanning(false); }
  };

  const savePhantomRegistro = async (item) => {
    const registro = (phantomDrafts[item.phantom_id] ?? "").trim();
    try {
      const res = await poster("/recon/phantom/registro", { phantom_id: item.phantom_id, registro });
      if (res.ok) {
        toast.success(t("wms_recon_registry_saved"));
        setPhantom(p => p && { ...p, items: p.items.map(x => x.phantom_id === item.phantom_id ? { ...x, registro } : x) });
        setPhantomDrafts(d => { const n = { ...d }; delete n[item.phantom_id]; return n; });
      } else { const e = await res.json().catch(() => ({})); toast.error(e.detail || t("error")); }
    } catch { toast.error(t("wms_conn_error")); }
  };

  const atenderPhantom = async (item) => {
    if (!window.confirm(t("wms_recon_attend_confirm", { location: item.location }))) return;
    try {
      const res = await poster("/recon/phantom/atender", {
        phantom_id: item.phantom_id,
        registro: (phantomDrafts[item.phantom_id] ?? item.registro ?? "").trim(),
      });
      if (res.ok) {
        toast.success(t("wms_recon_attended", { location: item.location }));
        setPhantom(p => p && { ...p, items: p.items.filter(x => x.phantom_id !== item.phantom_id) });
      } else { const e = await res.json().catch(() => ({})); toast.error(e.detail || t("error")); }
    } catch { toast.error(t("wms_conn_error")); }
  };

  // Ubicaciones con cajas faltantes agrupadas — candidatas a segundo conteo,
  // con su estado actual (bloqueada = aun conciliada, liberada = lista para recontar)
  // y, si ya se liberaron antes, el conteo anterior (al liberar) vs el nuevo
  // (actual, tras el reconteo) para ver si hubo diferencia.
  const lockedLocations = useMemo(() => new Set((log?.locations || []).map(l => l.location)), [log]);
  const reconciledAtByLoc = useMemo(() => {
    const m = new Map();
    for (const l of (log?.locations || [])) m.set(l.location, l.reconciled_at);
    return m;
  }, [log]);
  const lastSecondCountByLoc = useMemo(() => {
    const m = new Map();
    for (const a of (adj?.adjustments || [])) {
      if (a.type !== "second_count_start") continue;
      for (const l of (a.locations || [])) {
        const prev = m.get(l.location);
        if (!prev || new Date(a.created_at) > new Date(prev.created_at)) {
          m.set(l.location, { cajas: l.cajas, unidades: l.unidades, created_at: a.created_at });
        }
      }
    }
    return m;
  }, [adj]);
  const secondCountLocations = useMemo(() => {
    if (!pending) return [];
    const byLoc = new Map();
    for (const b of pending.faltantes) {
      const loc = b.recon_missing_from || t("wms_recon_unknown_loc");
      const g = byLoc.get(loc) || { location: loc, cajas: 0, unidades: 0 };
      g.cajas += 1;
      g.unidades += b.units || 0;
      byLoc.set(loc, g);
    }
    return [...byLoc.values()]
      .map(g => {
        const locked = lockedLocations.has(g.location);
        const lastLiberated = lastSecondCountByLoc.get(g.location);
        // Se reconto si, tras liberarla, la ubicacion volvio a quedar bloqueada
        // con una conciliacion mas reciente que la liberacion.
        const recountedAt = reconciledAtByLoc.get(g.location);
        const recounted = !!(lastLiberated && locked && recountedAt && new Date(recountedAt) > new Date(lastLiberated.created_at));
        return {
          ...g, locked,
          anterior: lastLiberated ? lastLiberated.cajas : g.cajas,
          nuevo: recounted ? g.cajas : null,
          diff: recounted ? (lastLiberated.cajas - g.cajas) : null,
        };
      })
      .sort((a, b) => b.cajas - a.cajas);
  }, [pending, lockedLocations, lastSecondCountByLoc, reconciledAtByLoc, t]);
  const lockedCount = secondCountLocations.filter(l => l.locked).length;

  const [startingSecondCount, setStartingSecondCount] = useState(false);
  const startSecondCount = async () => {
    if (!secondCountLocations.length) return;
    if (!window.confirm(t("wms_recon_release_confirm", { n: secondCountLocations.length }))) return;
    setStartingSecondCount(true);
    try {
      const res = await poster("/recon/second-count/start", {});
      if (res.ok) {
        const data = await res.json();
        toast.success(t("wms_recon_released_n", { n: data.count }));
        loadLog(); loadAdj();
      } else { const e = await res.json().catch(() => ({})); toast.error(e.detail || t("error")); }
    } catch { toast.error(t("wms_conn_error")); }
    finally { setStartingSecondCount(false); }
  };

  const resolve = async (box_id, action) => {
    let location;
    if (action === "assign") {
      location = window.prompt(t("wms_recon_assign_prompt", { box: box_id }));
      if (!location) return;
    } else if (action === "delete") {
      if (!window.confirm(t("wms_recon_delete_confirm", { box: box_id }))) return;
    }
    try {
      const res = await poster("/recon/resolve", { box_id, action, location });
      if (res.ok) { toast.success(action === "delete" ? t("wms_recon_box_deleted") : t("wms_recon_box_assigned")); loadPending(); }
      else { const e = await res.json().catch(() => ({})); toast.error(e.detail || t("error")); }
    } catch { toast.error(t("wms_conn_error")); }
  };

  const [exporting, setExporting] = useState(false);
  const exportExcel = async () => {
    setExporting(true);
    try {
      // Trae datos frescos para que el export sea completo, sin importar la pestaña.
      const [pen, lg, lp, ph] = await Promise.all([
        fetcher("/recon/pending"), fetcher("/recon/log"), fetcher("/recon/lpn-locations"),
        fetcher("/recon/phantom").catch(() => ({ items: [] })),
      ]);
      const wb = XLSX.utils.book_new();

      // Stock fantasma primero: es la lista de caminata.
      const fantasmas = (ph.items || []).map(i => ({
        Ubicacion: i.location, Tipo: phantomLabel(i.tipo),
        Transito: i.transito ? "SI" : "", Style: i.style, Color: i.color, Talla: i.size,
        Lote: [i.lote_coo, i.lote_fabric].filter(Boolean).join(" · "),
        "Unid. renglon": i.units_renglon, "Unid. cajas": i.units_cajas, Cajas: i.cajas,
        "En duda": i.delta, Registro: i.registro || "",
        "Cajas (muestra)": (i.box_ids || []).join(", "),
        "Conteo fisico": "", "Contado por": "", Fecha: "",
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(fantasmas.length ? fantasmas : [{}]), "Stock fantasma");

      const conciliadas = (lg.locations || []).map(l => ({
        Ubicacion: l.location, "Conciliada por": l.reconciled_by_name || "",
        Fecha: l.reconciled_at ? fmt(l.reconciled_at) : "",
        Confirmadas: l.counts?.confirmadas ?? "", Movidas: l.counts?.movidas ?? "",
        Creadas: l.counts?.creadas ?? "", Faltantes: l.counts?.faltantes ?? "",
        Escaneadas: l.counts?.escaneadas ?? "",
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(conciliadas.length ? conciliadas : [{}]), "Conciliadas");

      const faltantes = (pen.faltantes || []).map(b => ({
        Caja: b.box_id, Style: b.style, Color: b.color, Talla: b.size, Unidades: b.units,
        "Esperada en": b.recon_missing_from, "Marcada por": b.recon_flagged_by,
        Fecha: b.recon_flagged_at ? fmt(b.recon_flagged_at) : "",
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(faltantes.length ? faltantes : [{}]), "Faltantes");

      const creadas = (pen.creadas || []).map(b => ({
        Caja: b.box_id, Ubicacion: b.location, Unidades: b.units,
        "Creada por": b.recon_counted_by, Fecha: b.recon_counted_at ? fmt(b.recon_counted_at) : "",
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(creadas.length ? creadas : [{}]), "Creadas");

      const bloqueadas = (lp.locations || []).map(l => ({
        Ubicacion: l.location, "Cajas LPN": l.cajas, Unidades: l.unidades,
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(bloqueadas.length ? bloqueadas : [{}]), "Bloqueadas LPN");

      const stamp = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, `conciliacion_${stamp}.xlsx`);
      toast.success(t("wms_excel_exported"));
    } catch { toast.error(t("wms_export_err")); }
    finally { setExporting(false); }
  };

  const reopen = async (location) => {
    if (!window.confirm(t("wms_recon_reopen_confirm", { location }))) return;
    try {
      const res = await poster("/recon/reopen", { location });
      if (res.ok) { toast.success(t("wms_recon_reopened", { location })); loadLog(); }
      else { const e = await res.json().catch(() => ({})); toast.error(e.detail || t("error")); }
    } catch { toast.error(t("wms_conn_error")); }
  };

  const searchQ = locationSearch.trim().toUpperCase();

  return (
    <div className="space-y-5">
      <ModuleToolbar
        right={tab === "photo" ? null : (
          <>
            {/* Buscador de locaciones */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none"
      />
              <input
                id="recon-location-search"
                type="text"
                value={locationSearch}
                onChange={e => setLocationSearch(e.target.value)}
                placeholder={t("wms_recon_search_loc_placeholder")}
                className="pl-8 pr-7 py-1.5 text-sm font-mono rounded-md bg-card border border-input focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors w-44 placeholder:text-muted-foreground/60"
              />
              {locationSearch && (
                <button
                  onClick={() => setLocationSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            <Btn onClick={exportExcel} disabled={exporting}>
              {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} {t("export_excel")}
            </Btn>
            <button onClick={() => {
                if (tab === "pending") loadPending();
                else if (tab === "phantom") loadPhantom();
                else if (tab === "second_count") { loadPending(); loadLog(); }
                else if (tab === "log") loadLog();
                else if (tab === "adjustments") loadAdj();
                else loadLpn();
              }}
              className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
              <RefreshCw className={`w-5 h-5 ${loading ? "animate-spin" : ""}`} />
            </button>
          </>
        )}
      />

      <div className="flex gap-1 border-b border-border">
        {TABS.map(tb => {
          const Icon = tb.icon;
          const badge = tb.id === "pending" && pending ? (pending.faltantes_count + pending.creadas_count)
            : tb.id === "phantom" && phantom ? phantom.count
            : tb.id === "second_count" && pending ? lockedCount
            : tb.id === "log" && log ? log.count
            : tb.id === "adjustments" && adj ? adj.count
            : tb.id === "lpn" && lpn ? lpn.count : null;
          return (
            <button key={tb.id} onClick={() => setTab(tb.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors
                ${tab === tb.id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
              <Icon className="w-4 h-4" /> {t(tb.labelKey)}
              {badge != null && <span className="px-1.5 py-0.5 rounded-full bg-muted text-xs tabular-nums">{badge}</span>}
            </button>
          );
        })}
      </div>

      {/* ── Por resolver ── */}
      {tab === "pending" && pending && (
        <div className="space-y-5">
          <section className="border border-border rounded-lg bg-card overflow-hidden">
            <div className="px-3 py-2 bg-muted/40 border-b border-border text-xs font-semibold flex items-center gap-2">
              <PackageX className="w-4 h-4 text-red-600 dark:text-red-400" />
              {t("wms_recon_missing_header", { n: searchQ ? pending.faltantes.filter(b => (b.recon_missing_from || "").toUpperCase().includes(searchQ)).length : pending.faltantes_count })}
              {searchQ && filteredTag(locationSearch)}
            </div>
            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 border-b border-border sticky top-0 z-10"><tr>
                  <Th>{t("wms_box")}</Th><Th>Style</Th><Th>Color</Th><Th>{t("wms_label_size")}</Th><Th right>{t("wms_recon_units_short")}</Th>
                  <Th>{t("wms_recon_expected_in")}</Th><Th>{t("wms_recon_flagged_by")}</Th><Th right>{t("action_label")}</Th>
                </tr></thead>
                <tbody>
                  {pending.faltantes
                    .filter(b => !searchQ || (b.recon_missing_from || "").toUpperCase().includes(searchQ))
                    .map((b, i) => (
                    <tr key={i} className="border-t border-border/60 hover:bg-muted/40 transition-colors text-xs">
                      <td className="px-3 py-2 font-mono">{b.box_id}</td>
                      <td className="px-3 py-2">{b.style}</td><td className="px-3 py-2">{b.color}</td><td className="px-3 py-2">{b.size}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{b.units}</td>
                      <td className="px-3 py-2 font-mono">
                        <span className={searchQ && (b.recon_missing_from || "").toUpperCase().includes(searchQ) ? "text-primary font-semibold" : ""}>
                          {b.recon_missing_from}
                        </span>
                      </td>
                      <td className="px-3 py-2">{b.recon_flagged_by}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <button onClick={() => resolve(b.box_id, "assign")} title={t("wms_recon_assign_to_loc")} className="p-1.5 rounded-md text-blue-600 dark:text-blue-400 hover:bg-blue-500/10"><MapPin className="w-4 h-4" /></button>
                        <button onClick={() => resolve(b.box_id, "delete")} title={t("wms_recon_delete_lost")} className="p-1.5 rounded-md text-red-600 dark:text-red-400 hover:bg-red-500/10"><Trash2 className="w-4 h-4" /></button>
                      </td>
                    </tr>
                  ))}
                  {pending.faltantes.filter(b => !searchQ || (b.recon_missing_from || "").toUpperCase().includes(searchQ)).length === 0 &&
                    <tr><td colSpan={8} className="px-3 py-3 text-xs text-muted-foreground">{searchQ ? t("wms_recon_no_missing_match", { q: locationSearch }) : t("wms_recon_no_missing")}</td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          <section className="border border-border rounded-lg bg-card overflow-hidden">
            <div className="px-3 py-2 bg-muted/40 border-b border-border text-xs font-semibold flex items-center gap-2">
              <PackagePlus className="w-4 h-4 text-amber-600 dark:text-amber-400" />
              {t("wms_recon_created_header", { n: searchQ ? pending.creadas.filter(b => (b.location || "").toUpperCase().includes(searchQ)).length : pending.creadas_count })}
              {searchQ && filteredTag(locationSearch)}
            </div>
            <div className="overflow-x-auto max-h-80 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 border-b border-border sticky top-0 z-10"><tr>
                  <Th>{t("wms_box")}</Th><Th>{t("location")}</Th><Th right>{t("wms_recon_units_short")}</Th><Th>{t("wms_recon_created_by")}</Th><Th>{t("date")}</Th><Th right>{t("action_label")}</Th>
                </tr></thead>
                <tbody>
                  {pending.creadas
                    .filter(b => !searchQ || (b.location || "").toUpperCase().includes(searchQ))
                    .map((b, i) => (
                    <tr key={i} className="border-t border-border/60 hover:bg-muted/40 transition-colors text-xs">
                      <td className="px-3 py-2 font-mono">{b.box_id}</td>
                      <td className="px-3 py-2 font-mono">
                        <span className={searchQ && (b.location || "").toUpperCase().includes(searchQ) ? "text-primary font-semibold" : ""}>
                          {b.location}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{b.units}</td>
                      <td className="px-3 py-2">{b.recon_counted_by}</td>
                      <td className="px-3 py-2">{fmt(b.recon_counted_at)}</td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => resolve(b.box_id, "delete")} title={t("wms_recon_delete_btn")} className="p-1.5 rounded-md text-red-600 dark:text-red-400 hover:bg-red-500/10"><Trash2 className="w-4 h-4" /></button>
                      </td>
                    </tr>
                  ))}
                  {pending.creadas.filter(b => !searchQ || (b.location || "").toUpperCase().includes(searchQ)).length === 0 &&
                    <tr><td colSpan={6} className="px-3 py-3 text-xs text-muted-foreground">{searchQ ? t("wms_recon_no_created_match", { q: locationSearch }) : t("wms_recon_no_created")}</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {/* ── Stock fantasma ── */}
      {tab === "phantom" && (
        loading && !phantom ? <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        : phantom && (() => {
          const filtered = phantom.items
            .filter(i => !phantomTipo || i.tipo === phantomTipo)
            .filter(i => !searchQ || i.location.toUpperCase().includes(searchQ));
          const shown = filtered.slice(0, PHANTOM_MAX_ROWS);
          const noMatchParts = [t("wms_recon_no_matches")];
          if (searchQ) noMatchParts.push(t("wms_recon_with_query", { q: locationSearch }));
          if (phantomTipo) noMatchParts.push(t("wms_recon_of_type", { type: phantomLabel(phantomTipo) }));
          return (
          <div className="space-y-4">
            <div className="border border-border rounded-lg bg-card overflow-hidden">
              <div className="px-3 py-2 bg-muted/40 border-b border-border flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 text-xs font-semibold">
                  <Ghost className="w-4 h-4 text-violet-600 dark:text-violet-400" />
                  {t("wms_recon_phantom_pending", { n: nOfM(filtered.length, phantom.count, searchQ || phantomTipo) })}
                  {phantom.last_scan && <span className="text-muted-foreground font-normal">{t("wms_recon_last_scan", { date: fmt(phantom.last_scan) })}</span>}
                </div>
                <Btn onClick={runPhantomScan} disabled={scanning}>
                  {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <ScanSearch className="w-4 h-4" />}
                  {t("wms_recon_scan_now")}
                </Btn>
              </div>
              <div className="px-3 py-2 text-xs text-muted-foreground border-b border-border">
                {t("wms_recon_phantom_intro_a")} <b className="text-foreground">{t("wms_recon_registry")}</b> {t("wms_recon_phantom_intro_b")}
              </div>
              <div className="px-3 py-2 flex flex-wrap gap-2 border-b border-border">
                {Object.entries(PHANTOM_TIPOS).map(([k, cfg]) => {
                  const r = phantom.resumen?.[k];
                  const active = phantomTipo === k;
                  return (
                    <button key={k} onClick={() => setPhantomTipo(active ? null : k)}
                      className={`px-2.5 py-1 rounded-md border text-xs font-medium transition-colors ${cfg.chip} ${active ? "ring-2 ring-primary/60" : "opacity-80 hover:opacity-100"}`}>
                      {t(cfg.labelKey)}: {r?.n ?? 0} · {t("wms_recon_units_in_doubt", { u: (r?.unidades ?? 0).toLocaleString() })}
                    </button>
                  );
                })}
                {phantomTipo && (
                  <button onClick={() => setPhantomTipo(null)} className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground">
                    <X className="w-3 h-3 inline" /> {t("wms_recon_remove_filter")}
                  </button>
                )}
              </div>
              <div className="overflow-x-auto max-h-[34rem] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 border-b border-border sticky top-0 z-10"><tr>
                    <Th>{t("location")}</Th><Th>{t("wms_type")}</Th><Th>{t("wms_recon_material")}</Th><Th>{t("wms_recon_lot")}</Th>
                    <Th right>{t("wms_recon_row")}</Th><Th right>{t("wms_boxes")}</Th><Th right>{t("wms_recon_in_doubt")}</Th>
                    <Th>{t("wms_recon_registry")}</Th><Th right>{t("action_label")}</Th>
                  </tr></thead>
                  <tbody>
                    {shown.map((it) => {
                      const chipCls = PHANTOM_TIPOS[it.tipo]?.chip || "bg-secondary text-foreground border-border";
                      const draft = phantomDrafts[it.phantom_id];
                      const dirty = draft !== undefined && draft !== (it.registro || "");
                      return (
                        <tr key={it.phantom_id} className="border-t border-border/60 hover:bg-muted/40 transition-colors text-xs align-top">
                          <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">
                            <span className={searchQ && it.location.toUpperCase().includes(searchQ) ? "text-primary" : ""}>{it.location}</span>
                            {it.transito && <span className="ml-1.5 px-1.5 py-0.5 rounded-md border bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:border-blue-500/25 text-[10px] font-medium">{t("wms_recon_transit")}</span>}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap"><span className={`px-2 py-0.5 rounded-md border text-xs font-medium ${chipCls}`}>{phantomLabel(it.tipo)}</span></td>
                          <td className="px-3 py-2">
                            {it.tipo === "sin_identidad"
                              ? <span className="text-muted-foreground italic">{it.cajas === 1 ? t("wms_recon_unidentified_one") : t("wms_recon_unidentified_many", { n: it.cajas })}</span>
                              : <>{it.style} <span className="text-muted-foreground">{it.color} / {it.size}</span></>}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">{[it.lote_coo, it.lote_fabric].filter(Boolean).join(" · ") || "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{(it.units_renglon ?? 0).toLocaleString()}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{(it.units_cajas ?? 0).toLocaleString()} <span className="text-muted-foreground">/{it.cajas}c</span></td>
                          <td className="px-3 py-2 text-right tabular-nums font-medium text-red-600 dark:text-red-400">{(it.delta ?? 0).toLocaleString()}</td>
                          <td className="px-3 py-2 min-w-[14rem]">
                            <div className="flex items-center gap-1">
                              <input
                                type="text"
                                value={draft ?? it.registro ?? ""}
                                onChange={e => setPhantomDrafts(d => ({ ...d, [it.phantom_id]: e.target.value }))}
                                onKeyDown={e => { if (e.key === "Enter" && dirty) savePhantomRegistro(it); }}
                                placeholder={t("wms_recon_count_found_placeholder")}
                                className="w-full px-2 py-1 text-xs rounded-md bg-card border border-input focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors placeholder:text-muted-foreground/60"
                              />
                              {dirty && (
                                <button onClick={() => savePhantomRegistro(it)} title={t("wms_recon_save_registry")}
                                  className="p-1.5 rounded-md text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 shrink-0">
                                  <Save className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                            {it.registro_por && <div className="mt-0.5 text-xs text-muted-foreground">{it.registro_por} · {fmt(it.registro_at)}</div>}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <button onClick={() => atenderPhantom(it)} title={t("wms_recon_attend_title")}
                              className="p-1.5 rounded-md text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 inline-flex items-center gap-1">
                              <CheckCircle2 className="w-4 h-4" /> <span className="text-xs font-medium">{t("wms_recon_attend")}</span>
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                    {filtered.length === 0 && (
                      <tr><td colSpan={9} className="px-3 py-4 text-xs text-muted-foreground">
                        {phantom.items.length === 0
                          ? t("wms_recon_queue_empty")
                          : `${noMatchParts.join(" ")}.`}
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              {filtered.length > PHANTOM_MAX_ROWS && (
                <div className="px-3 py-2 text-xs text-muted-foreground border-t border-border">
                  {t("wms_recon_showing_first", { shown: PHANTOM_MAX_ROWS.toLocaleString(), total: filtered.length.toLocaleString() })}
                </div>
              )}
            </div>
          </div>
          );
        })()
      )}

      {/* ── Segundo conteo ── */}
      {tab === "second_count" && (
        loading && !pending ? <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        : pending && (() => {
          const filteredSC = secondCountLocations.filter(l => !searchQ || l.location.toUpperCase().includes(searchQ));
          return (
          <div className="border border-border rounded-lg bg-card overflow-hidden">
            <div className="px-3 py-2 bg-muted/40 border-b border-border flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs font-semibold">
                <RotateCcw className="w-4 h-4 text-fuchsia-600 dark:text-fuchsia-400" />
                {t("wms_recon_sc_header", { n: nOfM(filteredSC.length, secondCountLocations.length, searchQ), locked: filteredSC.filter(l => l.locked).length })}
                {searchQ && filteredTag(locationSearch)}
              </div>
              <Btn onClick={startSecondCount} disabled={startingSecondCount || lockedCount === 0}>
                {startingSecondCount ? <Loader2 className="w-4 h-4 animate-spin" /> : <Unlock className="w-4 h-4" />}
                {lockedCount > 0 ? t("wms_recon_release_n", { n: lockedCount }) : t("wms_recon_release")}
              </Btn>
            </div>
            <div className="px-3 py-2 text-xs text-muted-foreground border-b border-border">
              {t("wms_recon_sc_intro")}
            </div>
            <div className="overflow-x-auto max-h-[32rem] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 border-b border-border sticky top-0 z-10"><tr>
                  <Th>{t("location")}</Th><Th right>{t("wms_recon_prev_count")}</Th><Th right>{t("wms_recon_new_count")}</Th><Th right>{t("wms_difference")}</Th>
                  <Th right>{t("wms_label_units")}</Th><Th>{t("status")}</Th>
                </tr></thead>
                <tbody>
                  {filteredSC.map((l, i) => (
                    <tr key={i} className="border-t border-border/60 hover:bg-muted/40 transition-colors text-xs">
                      <td className="px-3 py-2 font-mono font-medium">
                        <span className={searchQ && l.location.toUpperCase().includes(searchQ) ? "text-primary" : ""}>
                          {l.location}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-red-600 dark:text-red-400">{l.anterior}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {l.nuevo === null ? <span className="text-muted-foreground">—</span> : l.nuevo}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium">
                        {l.diff === null ? <span className="text-muted-foreground font-normal">—</span>
                          : l.diff > 0 ? <span className="text-emerald-600 dark:text-emerald-400">-{l.diff}</span>
                          : l.diff === 0 ? <span className="text-muted-foreground">0</span>
                          : <span className="text-red-600 dark:text-red-400">+{-l.diff}</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{l.unidades.toLocaleString()}</td>
                      <td className="px-3 py-2">
                        {l.nuevo !== null
                          ? <Chip tone="info">{t("wms_recon_recounted")}</Chip>
                          : l.locked
                          ? <Chip tone="warning">{t("wms_recon_locked")}</Chip>
                          : <Chip tone="success">{t("wms_recon_released_ready")}</Chip>}
                      </td>
                    </tr>
                  ))}
                  {filteredSC.length === 0 && <tr><td colSpan={6} className="px-3 py-3 text-xs text-muted-foreground">{searchQ ? t("wms_recon_no_loc_match", { q: locationSearch }) : t("wms_recon_no_pending_missing")}</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          );
        })()
      )}

      {/* ── Registro ── */}
      {tab === "log" && log && (() => {
        const filteredLog = log.locations.filter(l => !searchQ || l.location.toUpperCase().includes(searchQ));
        return (
        <div className="border border-border rounded-lg bg-card overflow-hidden">
          <div className="px-3 py-2 bg-muted/40 border-b border-border text-xs font-semibold flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            {t("wms_recon_log_header", { n: nOfM(filteredLog.length, log.count, searchQ) })}
            {searchQ && filteredTag(locationSearch)}
          </div>
          <div className="overflow-x-auto max-h-[32rem] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 border-b border-border sticky top-0 z-10"><tr>
                <Th>{t("location")}</Th><Th>{t("wms_recon_reconciled_by")}</Th><Th>{t("date")}</Th>
                <Th right>{t("wms_recon_confirmed_short")}</Th><Th right>{t("wms_recon_moved")}</Th><Th right>{t("wms_recon_created")}</Th><Th right>{t("wms_recon_missing")}</Th><Th right>{t("action_label")}</Th>
              </tr></thead>
              <tbody>
                {filteredLog.map((l, i) => (
                  <tr key={i} className="border-t border-border/60 hover:bg-muted/40 transition-colors text-xs">
                    <td className="px-3 py-2 font-mono font-medium">
                      <span className={searchQ && l.location.toUpperCase().includes(searchQ) ? "text-primary" : ""}>
                        {l.location}
                      </span>
                    </td>
                    <td className="px-3 py-2">{l.reconciled_by_name}</td>
                    <td className="px-3 py-2">{fmt(l.reconciled_at)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.counts?.confirmadas ?? "-"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.counts?.movidas ?? "-"}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-amber-600 dark:text-amber-400">{l.counts?.creadas ?? "-"}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-red-600 dark:text-red-400">{l.counts?.faltantes ?? "-"}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => reopen(l.location)} title={t("wms_recon_reopen")} className="p-1.5 rounded-md text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 inline-flex items-center gap-1">
                        <Unlock className="w-4 h-4" /> <span className="text-xs font-medium">{t("wms_recon_reopen")}</span>
                      </button>
                    </td>
                  </tr>
                ))}
                {filteredLog.length === 0 && <tr><td colSpan={8} className="px-3 py-3 text-xs text-muted-foreground">{searchQ ? t("wms_recon_no_matches_q", { q: locationSearch }) : t("wms_recon_none_reconciled")}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        );
      })()}

      {/* ── Inventario por foto ── */}
      {tab === "photo" && <PhotoInventoryTab />}

      {/* ── Ajustes de cajas ── */}
      {tab === "adjustments" && (
        loading && !adj ? <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        : adj && (
          adj.count === 0 ? <p className="text-center text-muted-foreground py-10">{t("wms_recon_no_adjustments")}</p>
          : <div className="space-y-4">
            {adj.adjustments.map((a, i) => (
              <div key={i} className="border border-border rounded-lg bg-card overflow-hidden">
                <div className="px-3 py-2 bg-muted/40 border-b border-border flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-xs font-semibold">
                    <PackageCheck className="w-4 h-4 text-blue-600 dark:text-blue-400" /> {ADJ_TYPE_KEYS[a.type] ? t(ADJ_TYPE_KEYS[a.type]) : a.type}
                  </div>
                  <div className="text-xs text-muted-foreground">{fmt(a.created_at)} · {a.created_by}</div>
                </div>
                <div className="px-3 py-2 text-xs text-muted-foreground border-b border-border">
                  <b className="text-foreground">{a.count}</b> {t("wms_recon_boxes_lc")} · <b className="text-foreground">{(a.units || 0).toLocaleString()}</b> u · {a.reason}
                </div>
                {a.type !== "second_count_start" && (
                  <div className="px-3 py-2 flex flex-wrap gap-2 border-b border-border">
                    {(a.locations || []).map((l, j) => (
                      <span key={j} className="px-2 py-1 rounded-md bg-muted border border-border text-xs font-mono">
                        {l.location}: {l.cajas}c / {l.unidades}u
                      </span>
                    ))}
                  </div>
                )}
                {a.type === "second_count_start" ? (
                  <div className="overflow-x-auto max-h-96 overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50 border-b border-border sticky top-0 z-10"><tr>
                        <Th>{t("location")}</Th><Th right>{t("wms_recon_missing")}</Th><Th right>{t("wms_recon_units_short")}</Th>
                        <Th>{t("wms_recon_first_count_h")}</Th><Th>{t("wms_recon_reconciled_by")}</Th><Th>{t("wms_recon_first_count_date")}</Th>
                      </tr></thead>
                      <tbody>
                        {(a.locations || []).map((l, j) => (
                          <tr key={j} className="border-t border-border/60 hover:bg-muted/40 transition-colors text-xs">
                            <td className="px-3 py-2 font-mono font-medium">{l.location}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-red-600 dark:text-red-400">{l.cajas}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{l.unidades}</td>
                            <td className="px-3 py-2 font-mono">
                              {l.first_count
                                ? `${l.first_count.confirmadas ?? 0} / ${l.first_count.movidas ?? 0} / ${l.first_count.creadas ?? 0} / ${l.first_count.faltantes ?? 0}`
                                : "-"}
                            </td>
                            <td className="px-3 py-2">{l.first_count_by || "-"}</td>
                            <td className="px-3 py-2">{fmt(l.first_count_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="overflow-x-auto max-h-72 overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50 border-b border-border sticky top-0 z-10"><tr>
                        <Th>{t("wms_recon_box_lpn")}</Th><Th>{t("location")}</Th><Th>Style</Th><Th>Color</Th><Th>{t("wms_label_size")}</Th><Th right>{t("wms_recon_units_short")}</Th>
                      </tr></thead>
                      <tbody>
                        {(a.boxes || []).map((b, k) => (
                          <tr key={k} className="border-t border-border/60 hover:bg-muted/40 transition-colors text-xs">
                            <td className="px-3 py-2 font-mono">{b.box_id}</td>
                            <td className="px-3 py-2 font-mono">{b.location}</td>
                            <td className="px-3 py-2">{b.style}</td><td className="px-3 py-2">{b.color}</td>
                            <td className="px-3 py-2">{b.size}</td><td className="px-3 py-2 text-right tabular-nums">{b.units}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      )}

      {/* ── Bloqueadas por LPN ── */}
      {tab === "lpn" && (
        loading && !lpn ? <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        : lpn && (() => {
          const filteredLpn = lpn.locations.filter(l => !searchQ || l.location.toUpperCase().includes(searchQ));
          return (
          <div className="border border-border rounded-lg bg-card overflow-hidden">
            <div className="px-3 py-2 bg-muted/40 border-b border-border text-xs font-semibold flex items-center gap-2">
              <Ban className="w-4 h-4 text-amber-600 dark:text-amber-400" />
              {t("wms_recon_lpn_header", { n: nOfM(filteredLpn.length, lpn.count, searchQ) })}
              {searchQ && filteredTag(locationSearch)}
            </div>
            <div className="px-3 py-2 text-xs text-muted-foreground border-b border-border">
              {t("wms_recon_lpn_intro")}
            </div>
            <div className="overflow-x-auto max-h-[32rem] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 border-b border-border sticky top-0 z-10"><tr><Th>{t("location")}</Th><Th right>{t("wms_recon_lpn_boxes")}</Th><Th right>{t("wms_label_units")}</Th></tr></thead>
                <tbody>
                  {filteredLpn.map((l, i) => (
                    <tr key={i} className="border-t border-border/60 hover:bg-muted/40 transition-colors text-xs">
                      <td className="px-3 py-2 font-mono font-medium">
                        <span className={searchQ && l.location.toUpperCase().includes(searchQ) ? "text-primary" : ""}>
                          {l.location}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{l.cajas.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{(l.unidades || 0).toLocaleString()}</td>
                    </tr>
                  ))}
                  {filteredLpn.length === 0 && <tr><td colSpan={3} className="px-3 py-3 text-xs text-muted-foreground">{searchQ ? t("wms_recon_no_matches_q", { q: locationSearch }) : t("wms_recon_no_lpn")}</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          );
        })()
      )}
    </div>
  );
};
