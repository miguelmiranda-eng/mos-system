import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { FileDown, Loader2, X, Package, Search, AlertTriangle, Trash2 } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { API, fetcher, deleter, logLoadError } from "./lib";
import { AsnStatus } from "./constants";

const STATUS_STYLES = {
  [AsnStatus.PENDING]:  { label: "PENDIENTE",       cls: "bg-blue-500/10 text-blue-400 border-blue-500/20" },
  [AsnStatus.PARTIAL]:  { label: "PARCIAL",         cls: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
  [AsnStatus.RECEIVED]: { label: "COMPLETO",        cls: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
};

export const AsnModule = () => {
  const { t } = useLang();
  const [asns, setAsns] = useState([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

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

  const filteredAsns = asns.filter(a => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (a.asn_id || "").toLowerCase().includes(q)
        || (a.po_number || "").toLowerCase().includes(q)
        || (a.vendor || "").toLowerCase().includes(q);
  });

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
          <input type="file" id="asn-import" accept=".xlsx,.xlsm,.xls" className="hidden" onChange={handleFilePick} />
          <label htmlFor="asn-import" className={`flex items-center gap-2 px-6 py-3 bg-indigo-500 text-white rounded-2xl cursor-pointer text-xs font-black uppercase tracking-widest hover:scale-105 transition-all shadow-lg ${loading ? 'opacity-50 pointer-events-none' : ''}`}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
            Importar ASN Excel
          </label>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredAsns.map(a => {
          const totalExp = (a.items || []).reduce((s, i) => s + (i.qty_expected || 0), 0);
          const totalRcv = (a.items || []).reduce((s, i) => s + (i.qty_received || 0), 0);
          const pct = totalExp > 0 ? Math.min(100, Math.round((totalRcv / totalExp) * 100)) : 0;
          const sd = STATUS_STYLES[a.status] || STATUS_STYLES[AsnStatus.PENDING];
          return (
            <div
              key={a.asn_id}
              onClick={() => openDetail(a.asn_id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') openDetail(a.asn_id); }}
              className="group relative text-left p-5 bg-card/40 border border-border/40 rounded-[2rem] hover:bg-card hover:border-primary/30 transition-all shadow-sm cursor-pointer"
            >
              <button
                onClick={(e) => { e.stopPropagation(); handleDelete(a.asn_id); }}
                className="absolute top-3 right-3 p-2 rounded-xl text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-all"
                title="Eliminar ASN"
                data-testid={`asn-delete-${a.asn_id}`}
              >
                <Trash2 className="w-4 h-4" />
              </button>
              <div className="flex justify-between items-start mb-4 pr-8">
                <div className="min-w-0">
                  <div className="text-[10px] font-black uppercase text-primary tracking-widest">ASN {a.asn_id}</div>
                  <div className="text-lg font-black uppercase tracking-tight leading-tight truncate">{a.vendor || '—'}</div>
                  {a.po_number && <div className="text-[10px] font-mono text-muted-foreground mt-1">PO {a.po_number}</div>}
                </div>
                <div className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border ${sd.cls}`}>
                  {sd.label}
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between items-center text-[10px] font-bold uppercase text-muted-foreground border-b border-border/10 pb-2">
                  <span>Líneas</span>
                  <span className="text-foreground">{a.items?.length || 0}</span>
                </div>
                <div className="flex justify-between items-center text-[10px] font-bold uppercase text-muted-foreground">
                  <span>Recibido</span>
                  <span className="text-foreground tabular-nums">{totalRcv.toLocaleString()} / {totalExp.toLocaleString()}</span>
                </div>
                <div className="h-1.5 bg-secondary/40 rounded-full overflow-hidden">
                  <div className={`h-full transition-all ${pct >= 100 ? 'bg-emerald-500' : pct > 0 ? 'bg-amber-500' : 'bg-blue-500'}`} style={{ width: `${pct}%` }} />
                </div>
                <div className="flex justify-between items-center text-[10px] font-bold uppercase text-muted-foreground">
                  <span>Registrado</span>
                  <span className="text-foreground">{a.created_at ? new Date(a.created_at).toLocaleDateString() : '—'}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {filteredAsns.length === 0 && (
        <div className="py-20 text-center bg-secondary/10 rounded-[3rem] border-2 border-dashed border-border/20">
          <FileDown className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
          <p className="text-sm font-black text-muted-foreground uppercase tracking-widest">
            {asns.length === 0 ? 'No hay ASNs registrados' : 'Sin coincidencias'}
          </p>
        </div>
      )}

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
