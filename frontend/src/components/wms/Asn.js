import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { FileDown, FileUp, Loader2, X, Package, Search, AlertTriangle, Trash2 } from "lucide-react";
import * as XLSX from "xlsx";
import { saveAs } from "file-saver";
import { useLang } from "../../contexts/LanguageContext";
import { API, fetcher, deleter, logLoadError } from "./lib";
import { AsnStatus } from "./constants";

const STATUS_STYLES = {
  [AsnStatus.PENDING]:  { label: "PENDIENTE",  cls: "bg-blue-500/10 text-blue-400 border-blue-500/20",         tabCls: "bg-blue-500 text-white",    dot: "bg-blue-400" },
  [AsnStatus.PARTIAL]:  { label: "EN PROCESO", cls: "bg-amber-500/10 text-amber-400 border-amber-500/20",      tabCls: "bg-amber-500 text-white",   dot: "bg-amber-400" },
  [AsnStatus.RECEIVED]: { label: "COMPLETADO", cls: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20", tabCls: "bg-emerald-500 text-white", dot: "bg-emerald-400" },
};

const TABS = [
  { id: 'all',                 label: 'Todos' },
  { id: AsnStatus.PENDING,     label: 'Pendiente' },
  { id: AsnStatus.PARTIAL,     label: 'En Proceso' },
  { id: AsnStatus.RECEIVED,    label: 'Completado' },
];

export const AsnModule = () => {
  const { t } = useLang();
  const [asns, setAsns] = useState([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState('all'); // 'all' | pending | partial | received

  // Two-step upload state
  const [pendingFile, setPendingFile] = useState(null);
  const [sheetChoices, setSheetChoices] = useState(null); // {sheets: [...], filename}
  const [chosenSheet, setChosenSheet] = useState("");

  // Detail modal
  const [detailFor, setDetailFor] = useState(null);   // asn_id
  const [detailData, setDetailData] = useState(null); // {asn, boxes}
  const [detailLoading, setDetailLoading] = useState(false);

  const loadAsns = useCallback(async () => {
    try {
      const data = await fetcher("/asn");
      setAsns(data || []);
    } catch (err) { logLoadError('ASNs')(err); }
  }, []);

  useEffect(() => { loadAsns(); }, [loadAsns]);

  // Render FastAPI's "detail" field as a string: it can be a plain string, a
  // single validation error object, or an array of validation errors. Passing
  // an object/array directly into <Toaster/> renders an object as a React
  // child → React error #31 → black screen. Always coerce to string.
  const errMsg = (detail, fallback) => {
    if (!detail) return fallback;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      return detail.map(d => (d && d.msg) ? `${(d.loc || []).join('.')}: ${d.msg}` : String(d)).join(' · ');
    }
    if (detail && typeof detail === "object" && detail.msg) return detail.msg;
    try { return JSON.stringify(detail); } catch { return fallback; }
  };

  // Phase 1: inspect file → get available sheets
  const handleFilePick = async (e) => {
    const file = e.target.files[0];
    e.target.value = ""; // allow re-picking same file
    if (!file) return;
    setLoading(true);
    setPendingFile(file);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${API}/asn/import`, { method: "POST", body: fd, credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error("[ASN inspect] failed", res.status, err);
        toast.error(`Error ${res.status}: ${errMsg(err.detail, "no se pudo leer el archivo")}`);
        setPendingFile(null);
        return;
      }
      const data = await res.json();
      if (data.action === "select_sheet") {
        // Prefer a sheet that has all required columns + ASN# + rows
        const usable = data.sheets.filter(s => (s.missing_required || []).length === 0);
        const best = usable.find(s => s.detected_asn_id && s.row_count > 0)
                  || usable[0]
                  || data.sheets[0];
        setChosenSheet(best?.name || "");
        setSheetChoices(data);
      } else {
        toast.success("ASN importado");
        setPendingFile(null);
        loadAsns();
      }
    } catch (err) {
      console.error("[ASN inspect] connection error", err);
      toast.error("Error de conexión");
      setPendingFile(null);
    } finally { setLoading(false); }
  };

  // Phase 2: confirm sheet → import
  const handleConfirmImport = async () => {
    if (!pendingFile || !chosenSheet) return;
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", pendingFile);
      const url = `${API}/asn/import?sheet_name=${encodeURIComponent(chosenSheet)}`;
      const res = await fetch(url, { method: "POST", body: fd, credentials: "include" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error("[ASN import] failed", res.status, data);
        toast.error(`Error ${res.status}: ${errMsg(data.detail, "no se pudo importar")}`);
        return;
      }
      toast.success(`ASN ${data.asn_id} importado · ${data.items_count} líneas · ${data.total_qty_expected} pzs`);
      setPendingFile(null);
      setSheetChoices(null);
      setChosenSheet("");
      loadAsns();
    } catch (err) {
      console.error("[ASN import] connection error", err);
      toast.error("Error de conexión");
    } finally { setLoading(false); }
  };

  const handleDelete = async (asnId, opts = {}) => {
    const a = asns.find(x => x.asn_id === asnId);
    const totalRcv = (a?.items || []).reduce((s, i) => s + (i.qty_received || 0), 0);
    const msg = totalRcv > 0
      ? `El ASN ${asnId} tiene ${totalRcv.toLocaleString()} pzs ya recibidas. Las cajas no se eliminan, solo se pierde el vínculo con el ASN.\n\n¿Eliminar de todos modos?`
      : `¿Eliminar el ASN ${asnId}?`;
    if (!window.confirm(msg)) return;
    try {
      await deleter(`/asn/${encodeURIComponent(asnId)}`);
      toast.success(`ASN ${asnId} eliminado`);
      if (opts.closeDetail) { setDetailFor(null); setDetailData(null); }
      loadAsns();
    } catch (err) {
      toast.error("No se pudo eliminar el ASN");
    }
  };

  // Export the currently visible list (respects active tab + search) into a
  // 2-sheet xlsx: "ASNs" (one row per ASN, summary) + "Líneas" (one row per
  // packing-list item, with progress per line). Detail items are fetched on
  // demand since the /asn list endpoint already includes them.
  const handleExport = async () => {
    if (filteredAsns.length === 0) {
      toast.error("No hay ASNs para exportar");
      return;
    }
    try {
      const labelOf = (st) => STATUS_STYLES[st]?.label || (st || "").toUpperCase();
      const asnRows = filteredAsns.map(a => {
        const items = a.items || [];
        const exp = items.reduce((s, i) => s + (Number(i.qty_expected) || 0), 0);
        const rcv = items.reduce((s, i) => s + (Number(i.qty_received) || 0), 0);
        const pct = exp > 0 ? Math.min(100, Math.round((rcv / exp) * 100)) : 0;
        return {
          ASN: a.asn_id || "",
          Vendor: a.vendor || "",
          PO: a.po_number || "",
          Estado: labelOf(a.status),
          'Líneas': items.length,
          Esperado: exp,
          Recibido: rcv,
          'Avance %': pct,
          Registrado: a.created_at ? new Date(a.created_at).toLocaleString() : "",
          'Hoja origen': a.source_sheet || "",
        };
      });
      const itemRows = filteredAsns.flatMap(a => (a.items || []).map(it => {
        const exp = Number(it.qty_expected) || 0;
        const rcv = Number(it.qty_received) || 0;
        const pct = exp > 0 ? Math.min(100, Math.round((rcv / exp) * 100)) : 0;
        return {
          ASN: a.asn_id || "",
          Vendor: a.vendor || "",
          PO: a.po_number || "",
          Línea: it.line_no || "",
          'Part Number': it.part_number || "",
          'Descripción': it.description || "",
          'País': it.country || "",
          Marca: it.brand || "",
          Esperado: exp,
          Recibido: rcv,
          'Avance %': pct,
        };
      }));

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(asnRows), 'ASNs');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(itemRows), 'Líneas');
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const tag = activeTab === 'all' ? 'todos' : labelOf(activeTab).toLowerCase().replace(/\s+/g, '-');
      saveAs(blob, `asn_${tag}_${new Date().toISOString().split('T')[0]}.xlsx`);
      toast.success(`${asnRows.length} ASN(s) · ${itemRows.length} líneas exportadas`);
    } catch (err) {
      console.error("[ASN export] error", err);
      toast.error("Error al exportar");
    }
  };

  const openDetail = async (asnId) => {
    setDetailFor(asnId);
    setDetailLoading(true);
    setDetailData(null);
    try {
      const data = await fetcher(`/asn/${encodeURIComponent(asnId)}`);
      setDetailData(data);
    } catch (err) {
      logLoadError('ASN detail')(err);
      toast.error("No se pudo cargar el ASN");
      setDetailFor(null);
    } finally { setDetailLoading(false); }
  };

  const searched = asns.filter(a => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (a.asn_id || "").toLowerCase().includes(q)
        || (a.po_number || "").toLowerCase().includes(q)
        || (a.vendor || "").toLowerCase().includes(q);
  });

  // Counts per tab respect the search box but ignore the active tab itself.
  const tabCounts = {
    all: searched.length,
    [AsnStatus.PENDING]:  searched.filter(a => a.status === AsnStatus.PENDING).length,
    [AsnStatus.PARTIAL]:  searched.filter(a => a.status === AsnStatus.PARTIAL).length,
    [AsnStatus.RECEIVED]: searched.filter(a => a.status === AsnStatus.RECEIVED).length,
  };

  const filteredAsns = activeTab === 'all'
    ? searched
    : searched.filter(a => a.status === activeTab);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-2xl font-black uppercase tracking-tighter">Gestion de ASN</h2>
          <p className="text-xs text-muted-foreground font-bold uppercase tracking-widest">Pre-recibo y reconciliacion de packing list</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              placeholder="Buscar ASN / PO / Vendor"
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="pl-9 pr-3 py-2 bg-background border border-border rounded-xl text-sm text-foreground w-64 focus:outline-none focus:border-primary"
            />
          </div>
          <button
            onClick={handleExport}
            disabled={filteredAsns.length === 0}
            className="flex items-center gap-2 px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl text-xs font-black uppercase tracking-widest disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg"
            title="Exportar la lista actual (respeta tab + buscador)"
            data-testid="asn-export"
          >
            <FileUp className="w-4 h-4" />
            Exportar
          </button>
          <input type="file" id="asn-import" accept=".xlsx,.xlsm,.xls" className="hidden" onChange={handleFilePick} />
          <label htmlFor="asn-import" className={`flex items-center gap-2 px-6 py-3 bg-indigo-500 text-white rounded-2xl cursor-pointer text-xs font-black uppercase tracking-widest hover:scale-105 transition-all shadow-lg ${loading ? 'opacity-50 pointer-events-none' : ''}`}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
            Importar ASN Excel
          </label>
        </div>
      </div>

      {/* Status tabs */}
      <div className="flex flex-wrap gap-2 p-1 bg-secondary/20 rounded-2xl w-fit border border-border/40">
        {TABS.map(tab => {
          const isActive = activeTab === tab.id;
          const sd = STATUS_STYLES[tab.id];
          const count = tabCounts[tab.id] ?? 0;
          const baseCls = isActive
            ? (sd?.tabCls || 'bg-primary text-primary-foreground')
            : 'text-muted-foreground hover:text-foreground hover:bg-secondary/40';
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-5 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 ${baseCls} ${isActive ? 'shadow-lg' : ''}`}
              data-testid={`asn-tab-${tab.id}`}
            >
              {sd && <span className={`w-1.5 h-1.5 rounded-full ${sd.dot}`} />}
              {tab.label}
              <span className={`text-[10px] tabular-nums ${isActive ? 'opacity-90' : 'opacity-60'}`}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* List view */}
      <div className="border border-border/40 rounded-2xl bg-card/40 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary/40 border-b border-border/30">
              <tr>
                <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">ASN</th>
                <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Vendor</th>
                <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">PO</th>
                <th className="p-3 text-center text-[10px] font-black uppercase tracking-widest text-muted-foreground">Estado</th>
                <th className="p-3 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground">Líneas</th>
                <th className="p-3 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground">Recibido / Esperado</th>
                <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground w-40">Avance</th>
                <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Registrado</th>
                <th className="p-3 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/10">
              {filteredAsns.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-20 text-center">
                    <FileDown className="w-10 h-10 text-muted-foreground/30 mx-auto mb-2" />
                    <p className="text-xs font-black text-muted-foreground uppercase tracking-widest">
                      {asns.length === 0 ? 'No hay ASNs registrados' : 'Sin coincidencias en esta pestaña'}
                    </p>
                  </td>
                </tr>
              ) : (
                filteredAsns.map(a => {
                  const totalExp = (a.items || []).reduce((s, i) => s + (i.qty_expected || 0), 0);
                  const totalRcv = (a.items || []).reduce((s, i) => s + (i.qty_received || 0), 0);
                  const pct = totalExp > 0 ? Math.min(100, Math.round((totalRcv / totalExp) * 100)) : 0;
                  const sd = STATUS_STYLES[a.status] || STATUS_STYLES[AsnStatus.PENDING];
                  return (
                    <tr
                      key={a.asn_id}
                      onClick={() => openDetail(a.asn_id)}
                      className="hover:bg-primary/5 cursor-pointer transition-colors"
                      data-testid={`asn-row-${a.asn_id}`}
                    >
                      <td className="p-3 font-mono font-black text-primary text-[12px]">{a.asn_id}</td>
                      <td className="p-3 text-[12px] font-bold truncate max-w-[220px]" title={a.vendor}>{a.vendor || '—'}</td>
                      <td className="p-3 text-[11px] font-mono text-muted-foreground">{a.po_number || '—'}</td>
                      <td className="p-3 text-center">
                        <span className={`inline-block px-2.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest border ${sd.cls}`}>
                          {sd.label}
                        </span>
                      </td>
                      <td className="p-3 text-right tabular-nums font-mono font-bold text-[11px]">{a.items?.length || 0}</td>
                      <td className="p-3 text-right tabular-nums font-mono font-bold text-[11px]">
                        <span className={pct >= 100 ? 'text-emerald-400' : totalRcv > 0 ? 'text-amber-400' : 'text-muted-foreground'}>
                          {totalRcv.toLocaleString()}
                        </span>
                        <span className="text-muted-foreground"> / {totalExp.toLocaleString()}</span>
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-secondary/40 rounded-full overflow-hidden min-w-[60px]">
                            <div className={`h-full transition-all ${pct >= 100 ? 'bg-emerald-500' : pct > 0 ? 'bg-amber-500' : 'bg-blue-500'}`} style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-[10px] font-mono font-black tabular-nums w-9 text-right">{pct}%</span>
                        </div>
                      </td>
                      <td className="p-3 text-[11px] font-mono text-muted-foreground whitespace-nowrap">
                        {a.created_at ? new Date(a.created_at).toLocaleDateString() : '—'}
                      </td>
                      <td className="p-3">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDelete(a.asn_id); }}
                          className="p-1.5 rounded text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-all"
                          title="Eliminar ASN"
                          data-testid={`asn-delete-${a.asn_id}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Sheet picker dialog (Phase 1 → Phase 2) */}
      {sheetChoices && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-card border border-border/50 rounded-3xl w-full max-w-lg shadow-2xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between p-5 border-b border-border/20">
              <div className="min-w-0">
                <h3 className="font-black uppercase tracking-tighter text-sm">Selecciona la hoja</h3>
                <p className="text-[11px] text-muted-foreground font-bold truncate">{sheetChoices.filename}</p>
              </div>
              <button onClick={() => { setSheetChoices(null); setPendingFile(null); }} className="p-2 hover:bg-secondary rounded-lg transition-all">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              {sheetChoices.sheets.map(s => (
                <label key={s.name} className={`block p-4 rounded-2xl border cursor-pointer transition-all ${chosenSheet === s.name ? 'border-primary bg-primary/5' : 'border-border/40 hover:border-border'}`}>
                  <div className="flex items-start gap-3">
                    <input
                      type="radio"
                      name="sheet"
                      value={s.name}
                      checked={chosenSheet === s.name}
                      onChange={() => setChosenSheet(s.name)}
                      className="mt-1"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-sm font-bold truncate">{s.name}</div>
                      <div className="text-[11px] text-muted-foreground mt-1 flex flex-wrap gap-x-3">
                        <span className="uppercase tracking-wider">tipo: {s.kind}</span>
                        <span>ASN: <b className="text-foreground">{s.detected_asn_id || '—'}</b></span>
                        <span>cliente: <b className="text-foreground">{s.detected_customer || '—'}</b></span>
                        <span>líneas: <b className="text-foreground">{s.row_count}</b></span>
                      </div>
                      {s.detected_columns && Object.keys(s.detected_columns).length > 0 && (
                        <div className="text-[10px] text-muted-foreground/80 mt-1 flex flex-wrap gap-x-2 gap-y-0.5 font-mono">
                          {Object.entries(s.detected_columns).map(([f, col]) => (
                            <span key={f}>
                              <span className="uppercase">{f}</span>=<b className="text-foreground">{col}</b>
                            </span>
                          ))}
                        </div>
                      )}
                      {(s.missing_required || []).length > 0 && (
                        <div className="flex items-center gap-1 text-[10px] text-red-400 mt-1">
                          <AlertTriangle className="w-3 h-3" /> Faltan columnas: {(s.missing_required || []).join(', ')}
                        </div>
                      )}
                      {!s.detected_asn_id && (
                        <div className="flex items-center gap-1 text-[10px] text-amber-400 mt-1">
                          <AlertTriangle className="w-3 h-3" /> No se detectó número de ASN en esta hoja
                        </div>
                      )}
                    </div>
                  </div>
                </label>
              ))}
              <div className="flex gap-2 pt-2">
                <button
                  onClick={handleConfirmImport}
                  disabled={!chosenSheet || loading}
                  className="flex-1 px-4 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-black uppercase tracking-wider disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
                  Importar
                </button>
                <button
                  onClick={() => { setSheetChoices(null); setPendingFile(null); }}
                  className="px-4 py-2.5 bg-secondary text-foreground rounded-xl text-sm font-bold uppercase"
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Detail modal */}
      {detailFor && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-card border border-border/50 rounded-3xl w-full max-w-5xl max-h-[85vh] flex flex-col shadow-2xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between p-5 border-b border-border/20">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-2xl bg-indigo-500/10 flex items-center justify-center flex-shrink-0">
                  <Package className="w-5 h-5 text-indigo-400" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-black uppercase tracking-tighter text-sm truncate">ASN {detailFor}</h3>
                  {detailData?.asn && (
                    <p className="text-[11px] text-muted-foreground font-bold truncate">
                      <span className="text-primary">{detailData.asn.vendor || '—'}</span>
                      {detailData.asn.po_number && <> · PO {detailData.asn.po_number}</>}
                      {detailData.asn.source_sheet && <> · {detailData.asn.source_sheet}</>}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => handleDelete(detailFor, { closeDetail: true })}
                  className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-all"
                  title="Eliminar ASN"
                  data-testid="asn-detail-delete"
                >
                  <Trash2 className="w-5 h-5" />
                </button>
                <button onClick={() => { setDetailFor(null); setDetailData(null); }} className="p-2 hover:bg-secondary rounded-lg transition-all">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto custom-scrollbar">
              {detailLoading ? (
                <div className="flex items-center justify-center py-20">
                  <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
                </div>
              ) : detailData ? (
                <div className="p-5 space-y-6">
                  {/* Trazabilidad: summary cards + recepciones agregadas */}
                  {detailData.summary && (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div className="p-4 rounded-2xl bg-emerald-500/5 border border-emerald-500/20">
                        <div className="text-[9px] font-black uppercase tracking-widest text-muted-foreground">Unidades recibidas</div>
                        <div className="text-2xl font-black tabular-nums text-emerald-400">{(detailData.summary.total_units || 0).toLocaleString()}</div>
                      </div>
                      <div className="p-4 rounded-2xl bg-blue-500/5 border border-blue-500/20">
                        <div className="text-[9px] font-black uppercase tracking-widest text-muted-foreground">Cajas (LPNs)</div>
                        <div className="text-2xl font-black tabular-nums text-blue-400">{(detailData.summary.total_boxes || 0).toLocaleString()}</div>
                      </div>
                      <div className="p-4 rounded-2xl bg-purple-500/5 border border-purple-500/20">
                        <div className="text-[9px] font-black uppercase tracking-widest text-muted-foreground">Recepciones</div>
                        <div className="text-2xl font-black tabular-nums text-purple-400">{detailData.summary.total_receivings || 0}</div>
                      </div>
                      <div className="p-4 rounded-2xl bg-amber-500/5 border border-amber-500/20">
                        <div className="text-[9px] font-black uppercase tracking-widest text-muted-foreground">Ubicaciones</div>
                        <div className="text-2xl font-black tabular-nums text-amber-400">{(detailData.summary.distinct_locations || []).length}</div>
                      </div>
                      {detailData.summary.first_received_at && (
                        <div className="md:col-span-2 p-3 rounded-xl bg-secondary/30 border border-border/30">
                          <div className="text-[9px] font-black uppercase tracking-widest text-muted-foreground mb-0.5">Periodo de recepción</div>
                          <div className="text-[11px] font-mono">
                            {new Date(detailData.summary.first_received_at).toLocaleString()}
                            {' → '}
                            {new Date(detailData.summary.last_received_at).toLocaleString()}
                          </div>
                        </div>
                      )}
                      {(detailData.summary.receivers || []).length > 0 && (
                        <div className="md:col-span-2 p-3 rounded-xl bg-secondary/30 border border-border/30">
                          <div className="text-[9px] font-black uppercase tracking-widest text-muted-foreground mb-0.5">Receptores</div>
                          <div className="text-[11px] font-bold flex flex-wrap gap-1.5">
                            {(detailData.summary.receivers || []).map(r => (
                              <span key={r} className="px-2 py-0.5 bg-indigo-500/10 text-indigo-400 rounded text-[10px] uppercase tracking-wider">
                                {r}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Eventos de recepción (1 row por receiving_id) */}
                  {detailData.receivings && detailData.receivings.length > 0 && (
                    <div>
                      <h4 className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-2">
                        Eventos de recepción ({detailData.receivings.length})
                      </h4>
                      <div className="border border-border/30 rounded-2xl overflow-hidden">
                        <table className="w-full text-sm">
                          <thead className="bg-secondary/40">
                            <tr>
                              <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Fecha</th>
                              <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Receiving ID</th>
                              <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Style / SKU</th>
                              <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Color · Talla</th>
                              <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Lote</th>
                              <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Ubicación</th>
                              <th className="p-3 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground">Cajas</th>
                              <th className="p-3 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground">Unidades</th>
                              <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Recibido por</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/10">
                            {detailData.receivings.map(r => (
                              <tr key={r.receiving_id} className="hover:bg-secondary/30">
                                <td className="p-3 text-[11px] font-mono text-muted-foreground whitespace-nowrap">{r.created_at ? new Date(r.created_at).toLocaleString() : '—'}</td>
                                <td className="p-3 text-[11px] font-mono font-bold text-primary">{r.receiving_id}</td>
                                <td className="p-3 text-[11px] font-mono">{r.style || r.sku || '—'}</td>
                                <td className="p-3 text-[11px]">{r.color || '—'} · {r.size || '—'}</td>
                                <td className="p-3 text-[11px] font-mono text-muted-foreground">{r.lot_number || '—'}</td>
                                <td className="p-3 text-[11px] font-mono text-emerald-400">{r.inv_location || '—'}</td>
                                <td className="p-3 text-right text-[11px] tabular-nums font-bold">{(r.boxes || []).length}</td>
                                <td className="p-3 text-right text-[11px] tabular-nums font-bold text-emerald-400">{(r.total_units || 0).toLocaleString()}</td>
                                <td className="p-3 text-[11px] text-muted-foreground">{r.received_by_name || '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Expected vs received table */}
                  <div>
                    <h4 className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-2">Líneas del packing list</h4>
                    <div className="border border-border/30 rounded-2xl overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-secondary/40">
                          <tr>
                            <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">#</th>
                            <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Part Number</th>
                            <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Descripción</th>
                            <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">País</th>
                            <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Marca</th>
                            <th className="p-3 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground">Esperado</th>
                            <th className="p-3 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground">Recibido</th>
                            <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground w-32">Progreso</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/10">
                          {(detailData.asn?.items || []).map(it => {
                            const exp = it.qty_expected || 0;
                            const rcv = it.qty_received || 0;
                            const pct = exp > 0 ? Math.min(100, Math.round((rcv / exp) * 100)) : 0;
                            const done = rcv >= exp;
                            return (
                              <tr key={it.line_no} className="hover:bg-secondary/30">
                                <td className="p-3 text-xs font-mono text-muted-foreground">{it.line_no}</td>
                                <td className="p-3 text-xs font-mono font-black text-primary">{it.part_number}</td>
                                <td className="p-3 text-xs text-foreground max-w-[260px] truncate" title={it.description}>{it.description}</td>
                                <td className="p-3 text-xs font-mono">{it.country || '—'}</td>
                                <td className="p-3 text-xs">{it.brand || '—'}</td>
                                <td className="p-3 text-xs text-right tabular-nums font-bold">{exp.toLocaleString()}</td>
                                <td className={`p-3 text-xs text-right tabular-nums font-bold ${done ? 'text-emerald-400' : rcv > 0 ? 'text-amber-400' : 'text-muted-foreground'}`}>{rcv.toLocaleString()}</td>
                                <td className="p-3">
                                  <div className="h-1.5 bg-secondary/40 rounded-full overflow-hidden">
                                    <div className={`h-full ${done ? 'bg-emerald-500' : rcv > 0 ? 'bg-amber-500' : 'bg-blue-500/40'}`} style={{ width: `${pct}%` }} />
                                  </div>
                                  <div className="text-[10px] font-bold text-muted-foreground mt-0.5">{pct}%</div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Received boxes */}
                  <div>
                    <h4 className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-2">
                      Cajas recibidas ({detailData.boxes?.length || 0})
                    </h4>
                    {(!detailData.boxes || detailData.boxes.length === 0) ? (
                      <div className="text-center py-10 text-xs text-muted-foreground/40 font-bold uppercase tracking-widest italic">
                        Aún no se ha recibido material para este ASN
                      </div>
                    ) : (
                      <div className="border border-border/30 rounded-2xl overflow-hidden">
                        <table className="w-full text-sm">
                          <thead className="bg-secondary/40">
                            <tr>
                              <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Box ID</th>
                              <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Style / SKU</th>
                              <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Color / Size</th>
                              <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Ubicación</th>
                              <th className="p-3 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground">Unidades</th>
                              <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Estado</th>
                              <th className="p-3 text-left text-[10px] font-black uppercase tracking-widest text-muted-foreground">Fecha</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/10">
                            {detailData.boxes.map(b => (
                              <tr key={b.box_id} className="hover:bg-secondary/30">
                                <td className="p-3 text-xs font-mono font-bold">{b.box_id}</td>
                                <td className="p-3 text-xs font-mono">{b.style || b.sku}</td>
                                <td className="p-3 text-xs">{b.color || '—'} / {b.size || '—'}</td>
                                <td className="p-3 text-xs font-mono">{b.location || '—'}</td>
                                <td className="p-3 text-xs text-right tabular-nums font-bold">{(b.units || 0).toLocaleString()}</td>
                                <td className="p-3 text-xs">{b.status || '—'}</td>
                                <td className="p-3 text-xs text-muted-foreground">{b.created_at ? new Date(b.created_at).toLocaleString() : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
