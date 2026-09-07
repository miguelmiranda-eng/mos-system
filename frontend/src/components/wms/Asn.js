import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { FileDown, FileUp, Loader2, X, Package, Search, AlertTriangle, Trash2, Pencil, Plus, Check, CheckCircle2, RotateCcw, Lock } from "lucide-react";
import * as XLSX from "xlsx";
import { saveAs } from "file-saver";
import { useLang } from "../../contexts/LanguageContext";
import { API, fetcher, deleter, putter, poster, logLoadError } from "./lib";
import { AsnStatus } from "./constants";
import { StatCard, Btn, EmptyState, ModuleToolbar } from "./ui";

const STATUS_STYLES = {
  [AsnStatus.PENDING]:  { labelKey: "wms_asn_st_pending",  cls: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:border-blue-500/25",             tabCls: "bg-card text-foreground shadow-sm",    dot: "bg-blue-500" },
  [AsnStatus.PARTIAL]:  { labelKey: "wms_asn_st_partial", cls: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/25",       tabCls: "bg-card text-foreground shadow-sm",   dot: "bg-amber-500" },
  [AsnStatus.RECEIVED]: { labelKey: "wms_asn_st_received", cls: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/25", tabCls: "bg-card text-foreground shadow-sm", dot: "bg-emerald-500" },
};

const TABS = [
  { id: 'all',                 labelKey: 'wms_asn_tab_all' },
  { id: AsnStatus.PENDING,     labelKey: 'wms_status_pending' },
  { id: AsnStatus.PARTIAL,     labelKey: 'wms_status_in_progress' },
  { id: AsnStatus.RECEIVED,    labelKey: 'wms_status_completed' },
];

// Tipo de discrepancia: el valor se guarda/compara tal cual; sólo se traduce al mostrar.
const DISC_TYPE_KEY = { SOBRANTE: 'wms_asn_disc_surplus', FALTANTE: 'wms_asn_disc_shortage' };

export const AsnModule = ({ currentUser }) => {
  const { t } = useLang();
  // Admin y Super Usuario pueden crear/editar/reabrir ASN.
  const isSupersu = ['admin', 'supersu'].includes(currentUser?.role);
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

  // SKU → ASN trace (Fase 2)
  const [showTrace, setShowTrace] = useState(false);
  const [traceQuery, setTraceQuery] = useState("");
  const [traceResults, setTraceResults] = useState(null);
  const [traceLoading, setTraceLoading] = useState(false);

  // Captura MANUAL de una entrada (ASN o BPO) — tabla tipo Excel. Las columnas
  // están alineadas al formato de receiving (style/color/talla/país/fabric/cant.)
  // para que receiving reciba directo contra el número de entrada.
  const NEW_LINE = () => ({ part_number: '', color: '', size: '', country: '', fabric: '', qty_expected: '' });
  const [showCreate, setShowCreate] = useState(false);
  const [savingCreate, setSavingCreate] = useState(false);
  const [createDraft, setCreateDraft] = useState(null);
  const openCreate = () => { setCreateDraft({ asn_id: '', tipo: 'ASN', vendor: '', po_number: '', expected_date: '', items: [NEW_LINE()] }); setShowCreate(true); };
  const setCLine = (i, f, v) => setCreateDraft(d => ({ ...d, items: d.items.map((it, j) => j === i ? { ...it, [f]: v } : it) }));
  const addCLine = () => setCreateDraft(d => ({ ...d, items: [...d.items, NEW_LINE()] }));
  const rmCLine = (i) => setCreateDraft(d => ({ ...d, items: d.items.filter((_, j) => j !== i) }));
  const submitCreate = async () => {
    const d = createDraft;
    if (!d.asn_id.trim()) { toast.error(t('wms_asn_entry_num_req')); return; }
    const items = d.items.filter(it => (it.part_number || '').trim()).map(it => ({
      part_number: it.part_number, color: it.color, size: it.size,
      country: it.country, fabric: it.fabric, qty_expected: parseInt(it.qty_expected, 10) || 0,
    }));
    if (!items.length) { toast.error(t('wms_asn_min_line_style')); return; }
    setSavingCreate(true);
    try {
      const res = await poster('/asn', { asn_id: d.asn_id.trim(), tipo: d.tipo, vendor: d.vendor, po_number: d.po_number, expected_date: d.expected_date, items });
      const r = await res.json().catch(() => ({}));
      if (res.ok) { toast.success(t('wms_asn_entry_created', { id: d.asn_id })); setShowCreate(false); setCreateDraft(null); loadAsns(); }
      else toast.error(r.detail || t('wms_asn_entry_create_err'));
    } catch (err) { logLoadError('create entry')(err); toast.error(t('wms_conn_error')); }
    finally { setSavingCreate(false); }
  };

  const runTrace = async () => {
    const q = traceQuery.trim();
    if (!q) return;
    setTraceLoading(true); setTraceResults(null);
    try {
      const data = await fetcher(`/asn/trace-sku?q=${encodeURIComponent(q)}`);
      setTraceResults(data);
    } catch (err) {
      logLoadError('trace sku')(err);
      toast.error(t('wms_asn_trace_err'));
    } finally { setTraceLoading(false); }
  };

  // Edit mode (super-user only)
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(null);   // { vendor, po_number, expected_date, items: [...] }
  const [savingEdit, setSavingEdit] = useState(false);

  const startEdit = () => {
    const a = detailData?.asn;
    if (!a) return;
    setEditDraft({
      vendor: a.vendor || '',
      po_number: a.po_number || '',
      expected_date: a.expected_date || '',
      items: (a.items || []).map(it => ({
        line_no: it.line_no,
        part_number: it.part_number || '',
        description: it.description || '',
        country: it.country || '',
        brand: it.brand || '',
        qty_expected: it.qty_expected || 0,
        qty_received: it.qty_received || 0,
      })),
    });
    setEditing(true);
  };
  const cancelEdit = () => { setEditing(false); setEditDraft(null); };

  // Finish the receiving process (records discrepancies even if expected != received).
  const [closing, setClosing] = useState(false);
  const refreshDetail = async () => {
    const fresh = await fetcher(`/asn/${encodeURIComponent(detailFor)}`);
    setDetailData(fresh);
    loadAsns();
  };
  const closeReceiving = async () => {
    if (!window.confirm(t('wms_asn_close_confirm'))) return;
    const note = window.prompt(t('wms_asn_close_note_prompt'), "") ?? "";
    setClosing(true);
    try {
      const res = await poster(`/asn/${encodeURIComponent(detailFor)}/close`, { note });
      if (!res.ok) { const e = await res.json().catch(() => ({})); toast.error(e.detail || t('wms_asn_close_err')); return; }
      toast.success(t('wms_asn_closed_ok'));
      await refreshDetail();
    } catch (err) { logLoadError('close asn')(err); toast.error(t('wms_conn_error')); }
    finally { setClosing(false); }
  };
  const reopenReceiving = async () => {
    if (!window.confirm(t('wms_asn_reopen_confirm'))) return;
    setClosing(true);
    try {
      const res = await poster(`/asn/${encodeURIComponent(detailFor)}/reopen`, {});
      if (!res.ok) { const e = await res.json().catch(() => ({})); toast.error(e.detail || t('wms_asn_reopen_err')); return; }
      toast.success(t('wms_asn_reopened_ok'));
      await refreshDetail();
    } catch (err) { logLoadError('reopen asn')(err); toast.error(t('wms_conn_error')); }
    finally { setClosing(false); }
  };
  const setItem = (i, field, value) =>
    setEditDraft(d => ({ ...d, items: d.items.map((it, j) => j === i ? { ...it, [field]: value } : it) }));
  const addItem = () =>
    setEditDraft(d => ({ ...d, items: [...d.items, { part_number: '', description: '', country: '', brand: '', color: '', size: '', fabric: '', qty_expected: 0, qty_received: 0 }] }));
  const removeItem = (i) =>
    setEditDraft(d => ({ ...d, items: d.items.filter((_, j) => j !== i) }));

  const saveEdit = async () => {
    if (!editDraft) return;
    const items = editDraft.items
      .filter(it => (it.part_number || '').trim())
      .map(it => ({
        line_no: it.line_no,
        part_number: it.part_number,
        description: it.description,
        country: it.country,
        brand: it.brand,
        color: it.color || '',
        size: it.size || '',
        fabric: it.fabric || '',
        qty_expected: parseInt(it.qty_expected, 10) || 0,
      }));
    if (items.length === 0) { toast.error(t('wms_asn_min_line_pn')); return; }
    setSavingEdit(true);
    try {
      const res = await putter(`/asn/${encodeURIComponent(detailFor)}`, {
        vendor: editDraft.vendor, po_number: editDraft.po_number, expected_date: editDraft.expected_date,
        tipo: editDraft.tipo, items,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t('wms_asn_save_err'));
        return;
      }
      toast.success(t('wms_asn_updated'));
      setEditing(false); setEditDraft(null);
      const fresh = await fetcher(`/asn/${encodeURIComponent(detailFor)}`);
      setDetailData(fresh);
      loadAsns();
    } catch (err) {
      logLoadError('update ASN')(err);
      toast.error(t('wms_conn_error'));
    } finally { setSavingEdit(false); }
  };

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
        toast.error(t('wms_asn_http_err', { status: res.status, msg: errMsg(err.detail, t('wms_asn_read_file_err')) }));
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
        toast.success(t('wms_asn_imported'));
        setPendingFile(null);
        loadAsns();
      }
    } catch (err) {
      console.error("[ASN inspect] connection error", err);
      toast.error(t('wms_conn_error'));
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
        toast.error(t('wms_asn_http_err', { status: res.status, msg: errMsg(data.detail, t('wms_asn_import_fail')) }));
        return;
      }
      toast.success(t('wms_asn_imported_detail', { id: data.asn_id, lines: data.items_count, qty: data.total_qty_expected }));
      setPendingFile(null);
      setSheetChoices(null);
      setChosenSheet("");
      loadAsns();
    } catch (err) {
      console.error("[ASN import] connection error", err);
      toast.error(t('wms_conn_error'));
    } finally { setLoading(false); }
  };

  const handleDelete = async (asnId, opts = {}) => {
    const a = asns.find(x => x.asn_id === asnId);
    const totalRcv = (a?.items || []).reduce((s, i) => s + (i.qty_received || 0), 0);
    const msg = totalRcv > 0
      ? t('wms_asn_delete_confirm_received', { id: asnId, n: totalRcv.toLocaleString() })
      : t('wms_asn_delete_confirm', { id: asnId });
    if (!window.confirm(msg)) return;
    try {
      await deleter(`/asn/${encodeURIComponent(asnId)}`);
      toast.success(t('wms_asn_deleted', { id: asnId }));
      if (opts.closeDetail) { setDetailFor(null); setDetailData(null); }
      loadAsns();
    } catch (err) {
      toast.error(t('wms_asn_delete_err'));
    }
  };

  // Export the currently visible list (respects active tab + search) into a
  // 2-sheet xlsx: "ASNs" (one row per ASN, summary) + "Líneas" (one row per
  // packing-list item, with progress per line). Detail items are fetched on
  // demand since the /asn list endpoint already includes them.
  const handleExport = async () => {
    if (filteredAsns.length === 0) {
      toast.error(t('wms_asn_export_empty'));
      return;
    }
    try {
      const labelOf = (st) => (STATUS_STYLES[st] ? t(STATUS_STYLES[st].labelKey) : (st || "").toUpperCase());
      const asnRows = filteredAsns.map(a => {
        const items = a.items || [];
        const exp = items.reduce((s, i) => s + (Number(i.qty_expected) || 0), 0);
        const rcv = items.reduce((s, i) => s + (Number(i.qty_received) || 0), 0);
        const pct = exp > 0 ? Math.min(100, Math.round((rcv / exp) * 100)) : 0;
        return {
          ASN: a.asn_id || "",
          Vendor: a.vendor || "",
          PO: a.po_number || "",
          [t('status')]: labelOf(a.status),
          [t('wms_lines')]: items.length,
          [t('wms_expected')]: exp,
          [t('wms_received')]: rcv,
          [t('wms_asn_progress_pct')]: pct,
          [t('wms_asn_registered')]: a.created_at ? new Date(a.created_at).toLocaleString() : "",
          [t('wms_asn_source_sheet')]: a.source_sheet || "",
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
          [t('wms_line')]: it.line_no || "",
          'Part Number': it.part_number || "",
          [t('description')]: it.description || "",
          [t('wms_country')]: it.country || "",
          [t('wms_brand')]: it.brand || "",
          [t('wms_expected')]: exp,
          [t('wms_received')]: rcv,
          [t('wms_asn_progress_pct')]: pct,
        };
      }));

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(asnRows), 'ASNs');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(itemRows), t('wms_lines'));
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const tag = activeTab === 'all' ? t('wms_asn_tab_all').toLowerCase() : labelOf(activeTab).toLowerCase().replace(/\s+/g, '-');
      saveAs(blob, `asn_${tag}_${new Date().toISOString().split('T')[0]}.xlsx`);
      toast.success(t('wms_asn_exported', { a: asnRows.length, b: itemRows.length }));
    } catch (err) {
      console.error("[ASN export] error", err);
      toast.error(t('wms_export_err'));
    }
  };

  const openDetail = async (asnId) => {
    setDetailFor(asnId);
    setDetailLoading(true);
    setDetailData(null);
    setEditing(false); setEditDraft(null);
    try {
      const data = await fetcher(`/asn/${encodeURIComponent(asnId)}`);
      setDetailData(data);
    } catch (err) {
      logLoadError('ASN detail')(err);
      toast.error(t('wms_asn_load_err'));
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
      <ModuleToolbar
        right={
          <>
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
              <input
                placeholder={t('wms_asn_search_ph')}
                value={query}
                onChange={e => setQuery(e.target.value)}
                className="pl-9 pr-3 py-2 bg-card border border-input rounded-md text-sm text-foreground w-64 placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors"
              />
            </div>
            <Btn
              onClick={handleExport}
              disabled={filteredAsns.length === 0}
              title={t('wms_asn_export_title')}
              data-testid="asn-export"
            >
              <FileUp className="w-4 h-4" />
              {t('wms_export')}
            </Btn>
            <Btn
              onClick={() => { setShowTrace(true); setTraceResults(null); setTraceQuery(""); }}
              title={t('wms_asn_trace_title')}
            >
              <Search className="w-4 h-4" />
              {t('wms_asn_trace_btn')}
            </Btn>
            {isSupersu && (
              <Btn onClick={openCreate} title={t('wms_asn_new_title')} data-testid="asn-new">
                <Plus className="w-4 h-4" /> {t('wms_asn_new_btn')}
              </Btn>
            )}
            <input type="file" id="asn-import" accept=".xlsx,.xlsm,.xls,.pdf" className="hidden" onChange={handleFilePick} />
            <label htmlFor="asn-import" className={`inline-flex items-center justify-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground border border-transparent rounded-md cursor-pointer text-sm font-medium hover:opacity-90 transition-colors ${loading ? 'opacity-50 pointer-events-none' : ''}`}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
            {t('wms_asn_import_btn')}
          </label>
          </>
        }
      />

      {/* Nueva entrada — captura tipo Excel (ASN o BPO). El módulo NO es un
          Radix Dialog, así que un overlay simple funciona sin bloquear clics. */}
      {showCreate && createDraft && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => !savingCreate && setShowCreate(false)}>
          <div className="w-full max-w-4xl max-h-[90vh] overflow-y-auto bg-card border border-border rounded-xl shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-border sticky top-0 bg-card z-10">
              <h3 className="font-bold text-base flex items-center gap-2"><Plus className="w-5 h-5" /> {t('wms_asn_new_modal_title')}</h3>
              <button onClick={() => setShowCreate(false)} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <label className="text-xs font-semibold text-muted-foreground flex flex-col gap-1">{t('wms_asn_entry_number')} *
                  <input value={createDraft.asn_id} onChange={e => setCreateDraft(d => ({ ...d, asn_id: e.target.value }))} className="h-8 px-2 bg-card border border-input rounded-md text-sm" placeholder={t('wms_asn_entry_ph')} />
                </label>
                <label className="text-xs font-semibold text-muted-foreground flex flex-col gap-1">{t('wms_type')}
                  <select value={createDraft.tipo} onChange={e => setCreateDraft(d => ({ ...d, tipo: e.target.value }))} className="h-8 px-2 bg-card border border-input rounded-md text-sm">
                    <option value="ASN">ASN</option>
                    <option value="BPO">BPO</option>
                  </select>
                </label>
                <label className="text-xs font-semibold text-muted-foreground flex flex-col gap-1">{t('wms_asn_vendor')}
                  <input value={createDraft.vendor} onChange={e => setCreateDraft(d => ({ ...d, vendor: e.target.value.toUpperCase() }))} className="h-8 px-2 bg-card border border-input rounded-md text-sm" />
                </label>
                <label className="text-xs font-semibold text-muted-foreground flex flex-col gap-1">PO #
                  <input value={createDraft.po_number} onChange={e => setCreateDraft(d => ({ ...d, po_number: e.target.value }))} className="h-8 px-2 bg-card border border-input rounded-md text-sm" />
                </label>
                <label className="text-xs font-semibold text-muted-foreground flex flex-col gap-1">{t('wms_asn_eta')}
                  <input type="date" value={createDraft.expected_date} onChange={e => setCreateDraft(d => ({ ...d, expected_date: e.target.value }))} className="h-8 px-2 bg-card border border-input rounded-md text-sm" />
                </label>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-semibold text-muted-foreground">{t('wms_asn_lines_fmt')}</h4>
                  <Btn onClick={addCLine}><Plus className="w-3.5 h-3.5" /> {t('wms_add_line')}</Btn>
                </div>
                <div className="border border-border rounded-lg overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 border-b border-border">
                      <tr>
                        <th className="px-2 py-2 text-left text-xs font-semibold text-muted-foreground">Style / Part #</th>
                        <th className="px-2 py-2 text-left text-xs font-semibold text-muted-foreground">{t('wms_label_color')}</th>
                        <th className="px-2 py-2 text-left text-xs font-semibold text-muted-foreground">{t('wms_label_size')}</th>
                        <th className="px-2 py-2 text-left text-xs font-semibold text-muted-foreground">{t('wms_country')}</th>
                        <th className="px-2 py-2 text-left text-xs font-semibold text-muted-foreground">Fabric</th>
                        <th className="px-2 py-2 text-right text-xs font-semibold text-muted-foreground">{t('quantity')}</th>
                        <th className="px-2 py-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {createDraft.items.map((it, i) => (
                        <tr key={i}>
                          <td className="p-1.5"><input value={it.part_number} onChange={e => setCLine(i, 'part_number', e.target.value.toUpperCase())} className="w-full h-8 px-2 bg-card border border-input rounded-md text-xs font-mono" /></td>
                          <td className="p-1.5"><input value={it.color} onChange={e => setCLine(i, 'color', e.target.value.toUpperCase())} className="w-full h-8 px-2 bg-card border border-input rounded-md text-xs" /></td>
                          <td className="p-1.5"><input value={it.size} onChange={e => setCLine(i, 'size', e.target.value.toUpperCase())} className="w-20 h-8 px-2 bg-card border border-input rounded-md text-xs" /></td>
                          <td className="p-1.5"><input value={it.country} onChange={e => setCLine(i, 'country', e.target.value.toUpperCase())} className="w-24 h-8 px-2 bg-card border border-input rounded-md text-xs" /></td>
                          <td className="p-1.5"><input value={it.fabric} onChange={e => setCLine(i, 'fabric', e.target.value.toUpperCase())} className="w-28 h-8 px-2 bg-card border border-input rounded-md text-xs" /></td>
                          <td className="p-1.5"><input type="number" min="0" value={it.qty_expected} onChange={e => setCLine(i, 'qty_expected', e.target.value)} className="w-24 h-8 px-2 bg-card border border-input rounded-md text-xs text-right tabular-nums" /></td>
                          <td className="p-1.5 text-center"><button onClick={() => rmCLine(i)} className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded"><Trash2 className="w-3.5 h-3.5" /></button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <button onClick={() => setShowCreate(false)} className="px-3 py-1.5 text-sm rounded-md text-muted-foreground hover:text-foreground">{t('cancel')}</button>
                <button onClick={submitCreate} disabled={savingCreate} className="px-4 py-1.5 text-sm font-semibold rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5">
                  {savingCreate ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} {t('wms_asn_save_entry')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Status tabs */}
      <div className="flex flex-wrap gap-1 p-1 bg-muted/50 rounded-lg w-fit border border-border">
        {TABS.map(tab => {
          const isActive = activeTab === tab.id;
          const sd = STATUS_STYLES[tab.id];
          const count = tabCounts[tab.id] ?? 0;
          const baseCls = isActive
            ? (sd?.tabCls || 'bg-card text-foreground shadow-sm')
            : 'text-muted-foreground hover:text-foreground hover:bg-muted';
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${baseCls}`}
              data-testid={`asn-tab-${tab.id}`}
            >
              {sd && <span className={`w-1.5 h-1.5 rounded-full ${sd.dot}`} />}
              {t(tab.labelKey)}
              <span className={`text-xs tabular-nums ${isActive ? 'opacity-90' : 'opacity-60'}`}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* List view */}
      <div className="border border-border rounded-lg bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 border-b border-border">
              <tr>
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">ASN</th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">Vendor</th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">PO</th>
                <th className="px-3 py-2.5 text-center text-xs font-semibold text-muted-foreground">{t('status')}</th>
                <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_lines')}</th>
                <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_asn_rcv_exp')}</th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground w-40">{t('wms_asn_progress')}</th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_asn_registered')}</th>
                <th className="px-3 py-2.5 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {filteredAsns.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-16 text-center">
                    <p className="text-sm font-semibold text-foreground/80">
                      {asns.length === 0 ? t('wms_asn_none') : t('wms_asn_no_match_tab')}
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
                      className="hover:bg-muted/40 cursor-pointer transition-colors"
                      data-testid={`asn-row-${a.asn_id}`}
                    >
                      <td className="px-3 py-2.5 font-mono font-medium text-foreground text-xs">{a.asn_id}</td>
                      <td className="px-3 py-2.5 text-xs truncate max-w-[220px]" title={a.vendor}>{a.vendor || '—'}</td>
                      <td className="px-3 py-2.5 text-xs font-mono text-muted-foreground">{a.po_number || '—'}</td>
                      <td className="px-3 py-2.5 text-center">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium whitespace-nowrap border ${sd.cls}`}>
                          {t(sd.labelKey)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-xs font-medium">{a.items?.length || 0}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-xs font-medium">
                        <span className={pct >= 100 ? 'text-emerald-600 dark:text-emerald-400' : totalRcv > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}>
                          {totalRcv.toLocaleString()}
                        </span>
                        <span className="text-muted-foreground"> / {totalExp.toLocaleString()}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden min-w-[60px]">
                            <div className={`h-full transition-all ${pct >= 100 ? 'bg-emerald-500' : pct > 0 ? 'bg-amber-500' : 'bg-blue-500'}`} style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-xs font-mono font-medium tabular-nums w-9 text-right">{pct}%</span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-xs font-mono text-muted-foreground whitespace-nowrap">
                        {a.created_at ? new Date(a.created_at).toLocaleDateString() : '—'}
                      </td>
                      <td className="px-3 py-2.5">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDelete(a.asn_id); }}
                          className="p-1.5 rounded-md text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-colors"
                          title={t('wms_asn_delete_btn')}
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
          <div className="bg-card border border-border rounded-lg w-full max-w-lg shadow-xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between p-5 border-b border-border/20">
              <div className="min-w-0">
                <h3 className="font-semibold text-sm">{t('wms_asn_pick_sheet')}</h3>
                <p className="text-xs text-muted-foreground truncate">{sheetChoices.filename}</p>
              </div>
              <button onClick={() => { setSheetChoices(null); setPendingFile(null); }} className="p-2 hover:bg-secondary rounded-lg transition-all">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              {sheetChoices.sheets.map(s => (
                <label key={s.name} className={`block p-4 rounded-lg border cursor-pointer transition-colors ${chosenSheet === s.name ? 'border-primary bg-primary/5' : 'border-border/60 hover:border-border'}`}>
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
                      <div className="font-mono text-sm font-medium truncate">{s.name}</div>
                      <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-3">
                        <span>{t('wms_asn_sheet_kind', { kind: s.kind })}</span>
                        <span>ASN: <b className="text-foreground">{s.detected_asn_id || '—'}</b></span>
                        <span>{t('wms_asn_sheet_customer')} <b className="text-foreground">{s.detected_customer || '—'}</b></span>
                        <span>{t('wms_asn_sheet_lines')} <b className="text-foreground">{s.row_count}</b></span>
                      </div>
                      {s.detected_columns && Object.keys(s.detected_columns).length > 0 && (
                        <div className="text-xs text-muted-foreground/80 mt-1 flex flex-wrap gap-x-2 gap-y-0.5 font-mono">
                          {Object.entries(s.detected_columns).map(([f, col]) => (
                            <span key={f}>
                              <span>{f}</span>=<b className="text-foreground">{col}</b>
                            </span>
                          ))}
                        </div>
                      )}
                      {(s.missing_required || []).length > 0 && (
                        <div className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400 mt-1">
                          <AlertTriangle className="w-3 h-3" /> {t('wms_asn_missing_cols', { cols: (s.missing_required || []).join(', ') })}
                        </div>
                      )}
                      {!s.detected_asn_id && (
                        <div className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 mt-1">
                          <AlertTriangle className="w-3 h-3" /> {t('wms_asn_no_id_detected')}
                        </div>
                      )}
                    </div>
                  </div>
                </label>
              ))}
              <div className="flex gap-2 pt-2">
                <Btn
                  variant="primary"
                  onClick={handleConfirmImport}
                  disabled={!chosenSheet || loading}
                  className="flex-1 py-2.5"
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
                  {t('wms_import')}
                </Btn>
                <Btn
                  onClick={() => { setSheetChoices(null); setPendingFile(null); }}
                  className="py-2.5"
                >
                  {t('cancel')}
                </Btn>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Detail modal */}
      {detailFor && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-card border border-border rounded-lg w-full max-w-5xl max-h-[85vh] flex flex-col shadow-xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between p-5 border-b border-border/20">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
                  <Package className="w-5 h-5 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-semibold text-sm truncate flex items-center gap-2">
                    ASN {detailFor}
                    {detailData?.asn?.closed && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-xs font-medium bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/25"><Lock className="w-3 h-3" /> {t('wms_asn_closed_badge')}</span>
                    )}
                  </h3>
                  {detailData?.asn && (
                    <p className="text-xs text-muted-foreground truncate">
                      <span className="text-foreground">{detailData.asn.vendor || '—'}</span>
                      {detailData.asn.po_number && <> · PO {detailData.asn.po_number}</>}
                      {detailData.asn.source_sheet && <> · {detailData.asn.source_sheet}</>}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {isSupersu && !editing && detailData && (
                  <button
                    onClick={startEdit}
                    className="p-2 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-lg transition-all"
                    title={t('wms_asn_edit_title')}
                    data-testid="asn-detail-edit"
                  >
                    <Pencil className="w-5 h-5" />
                  </button>
                )}
                {editing && (
                  <>
                    <Btn
                      variant="primary"
                      onClick={saveEdit}
                      disabled={savingEdit}
                    >
                      {savingEdit ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} {t('save')}
                    </Btn>
                    <Btn variant="ghost" onClick={cancelEdit}>
                      {t('cancel')}
                    </Btn>
                  </>
                )}
                {!editing && detailData && !detailData.asn?.closed && (
                  <Btn
                    variant="primary"
                    onClick={closeReceiving}
                    disabled={closing}
                    title={t('wms_asn_close_btn_title')}
                    data-testid="asn-close-receiving"
                  >
                    {closing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} {t('wms_asn_close_btn')}
                  </Btn>
                )}
                {!editing && detailData?.asn?.closed && isSupersu && (
                  <Btn
                    onClick={reopenReceiving}
                    disabled={closing}
                    title={t('wms_asn_reopen_title')}
                  >
                    {closing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />} {t('wms_asn_reopen_btn')}
                  </Btn>
                )}
                {!editing && (
                  <button
                    onClick={() => handleDelete(detailFor, { closeDetail: true })}
                    className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-all"
                    title={t('wms_asn_delete_btn')}
                    data-testid="asn-detail-delete"
                  >
                    <Trash2 className="w-5 h-5" />
                  </button>
                )}
                <button onClick={() => { setDetailFor(null); setDetailData(null); cancelEdit(); }} className="p-2 hover:bg-secondary rounded-lg transition-all">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto custom-scrollbar">
              {detailLoading ? (
                <div className="flex items-center justify-center py-20">
                  <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                </div>
              ) : detailData ? (
                <div className="p-5 space-y-6">
                  {/* Trazabilidad: summary cards + recepciones agregadas */}
                  {detailData.summary && (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <StatCard label={t('wms_received')} value={(detailData.summary.units_received ?? detailData.summary.total_units ?? 0).toLocaleString()} />
                      <StatCard label={t('wms_in_inventory')} value={(detailData.summary.units_in_stock || 0).toLocaleString()} sub={t('wms_boxes_count', { n: detailData.summary.boxes_in_stock || 0 })} />
                      <StatCard label={t('wms_asn_out_consumed')} value={(detailData.summary.units_out || 0).toLocaleString()} />
                      <StatCard label={t('wms_locations')} value={(detailData.summary.by_location || detailData.summary.distinct_locations || []).length} />
                      {detailData.summary.first_received_at && (
                        <div className="md:col-span-2 p-3 rounded-lg bg-card border border-border">
                          <div className="text-xs font-medium text-muted-foreground mb-0.5">{t('wms_asn_reception_period')}</div>
                          <div className="text-xs font-mono">
                            {new Date(detailData.summary.first_received_at).toLocaleString()}
                            {' → '}
                            {new Date(detailData.summary.last_received_at).toLocaleString()}
                          </div>
                        </div>
                      )}
                      {(detailData.summary.receivers || []).length > 0 && (
                        <div className="md:col-span-2 p-3 rounded-lg bg-card border border-border">
                          <div className="text-xs font-medium text-muted-foreground mb-0.5">{t('wms_asn_receivers')}</div>
                          <div className="text-xs flex flex-wrap gap-1.5">
                            {(detailData.summary.receivers || []).map(r => (
                              <span key={r} className="px-2 py-0.5 bg-muted border border-border rounded-md text-xs font-medium">
                                {r}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Inventario restante por ubicación (trazabilidad) */}
                  {(detailData.summary?.by_location || []).length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold text-muted-foreground mb-2">{t('wms_asn_remaining_by_loc')}</h4>
                      <div className="border border-border rounded-lg overflow-hidden">
                        <table className="w-full text-sm">
                          <thead className="bg-muted/50 border-b border-border">
                            <tr>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('location')}</th>
                              <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_boxes')}</th>
                              <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_label_units')}</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/60">
                            {detailData.summary.by_location.map(l => (
                              <tr key={l.location} className="hover:bg-muted/40">
                                <td className="px-3 py-2.5 text-xs font-mono">{l.location}</td>
                                <td className="px-3 py-2.5 text-xs text-right tabular-nums">{(l.boxes || 0).toLocaleString()}</td>
                                <td className="px-3 py-2.5 text-xs text-right tabular-nums font-bold">{(l.units || 0).toLocaleString()}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Eventos de recepción (1 row por receiving_id) */}
                  {detailData.receivings && detailData.receivings.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold text-muted-foreground mb-2">
                        {t('wms_asn_receiving_events', { n: detailData.receivings.length })}
                      </h4>
                      <div className="border border-border rounded-lg overflow-hidden">
                        <table className="w-full text-sm">
                          <thead className="bg-muted/50 border-b border-border">
                            <tr>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('date')}</th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">Receiving ID</th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_style_sku')}</th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_asn_color_size')}</th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_asn_lot')}</th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('location')}</th>
                              <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_boxes')}</th>
                              <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_label_units')}</th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_asn_received_by')}</th>
                              <th className="px-3 py-2.5 w-10"></th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/60">
                            {detailData.receivings.map(r => (
                              <tr key={r.receiving_id} className="hover:bg-muted/40">
                                <td className="px-3 py-2.5 text-xs font-mono text-muted-foreground whitespace-nowrap">{r.created_at ? new Date(r.created_at).toLocaleString() : '—'}</td>
                                <td className="px-3 py-2.5 text-xs font-mono font-bold text-primary">{r.receiving_id}</td>
                                <td className="px-3 py-2.5 text-xs font-mono">{r.style || r.sku || '—'}</td>
                                <td className="px-3 py-2.5 text-xs">{r.color || '—'} · {r.size || '—'}</td>
                                <td className="px-3 py-2.5 text-xs font-mono text-muted-foreground">{r.lot_number || '—'}</td>
                                <td className="px-3 py-2.5 text-xs font-mono">{r.inv_location || '—'}</td>
                                <td className="px-3 py-2.5 text-right text-xs tabular-nums font-medium">{(r.boxes || []).length}</td>
                                <td className="px-3 py-2.5 text-right text-xs tabular-nums font-medium">{(r.total_units || 0).toLocaleString()}</td>
                                <td className="px-3 py-2.5 text-xs text-muted-foreground">{r.received_by_name || '—'}</td>
                                <td className="px-3 py-2.5 text-right">
                                  {isSupersu && !detailData?.asn?.closed && (
                                    <button
                                      onClick={async (e) => {
                                        e.stopPropagation();
                                        if (!window.confirm(t('wms_asn_delete_receipt_confirm', { id: r.receiving_id }))) return;
                                        try {
                                          await deleter(`/receiving/${encodeURIComponent(r.receiving_id)}`);
                                          toast.success(t('wms_asn_receipt_deleted'));
                                          refreshDetail();
                                        } catch (err) {
                                          toast.error(t('wms_asn_receipt_delete_err'));
                                        }
                                      }}
                                      className="p-1.5 rounded text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-all"
                                      title={t('wms_asn_delete_receipt')}
                                    >
                                      <Trash2 className="w-4 h-4" />
                                    </button>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Editable header fields (super-user edit mode) */}
                  {editing && editDraft && (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">{t('wms_asn_vendor')}</label>
                        <input value={editDraft.vendor} onChange={e => setEditDraft(d => ({ ...d, vendor: e.target.value }))}
                          className="w-full mt-1 h-9 px-3 bg-card border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors" />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">PO #</label>
                        <input value={editDraft.po_number} onChange={e => setEditDraft(d => ({ ...d, po_number: e.target.value }))}
                          className="w-full mt-1 h-9 px-3 bg-card border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors" />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">{t('wms_asn_expected_date')}</label>
                        <input value={editDraft.expected_date} onChange={e => setEditDraft(d => ({ ...d, expected_date: e.target.value }))}
                          className="w-full mt-1 h-9 px-3 bg-card border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors" />
                      </div>
                    </div>
                  )}

                  {/* Discrepancy log */}
                  {!editing && (() => {
                    const asn = detailData.asn || {};
                    const disc = asn.closed
                      ? (asn.discrepancies || [])
                      : (asn.items || []).map(it => {
                          const exp = it.qty_expected || 0, rcv = it.qty_received || 0, d = rcv - exp;
                          return d !== 0 ? { line_no: it.line_no, part_number: it.part_number, qty_expected: exp, qty_received: rcv, difference: d, type: d > 0 ? 'SOBRANTE' : 'FALTANTE' } : null;
                        }).filter(Boolean);
                    return (
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <h4 className="text-xs font-semibold text-muted-foreground">
                            {t('wms_asn_disc_log')} {asn.closed ? '' : <span className="text-amber-600/80 dark:text-amber-400/80 font-normal">{t('wms_asn_live')}</span>}
                          </h4>
                          {disc.length > 0 && <span className="text-xs font-medium text-amber-600 dark:text-amber-400">{t('wms_asn_n_lines', { n: disc.length })}</span>}
                        </div>
                        {asn.closed && (
                          <div className="mb-2 text-xs text-muted-foreground bg-muted/40 border border-border rounded-lg p-3">
                            {t('wms_asn_closed_by')} <b className="text-foreground/80">{asn.closed_by_name || '—'}</b>
                            {asn.closed_at && <> · {new Date(asn.closed_at).toLocaleString()}</>}
                            {asn.closure_note && <div className="mt-1 italic">“{asn.closure_note}”</div>}
                          </div>
                        )}
                        {disc.length === 0 ? (
                          <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200/70 dark:border-emerald-500/25 rounded-lg p-3">
                            <CheckCircle2 className="w-4 h-4" /><span className="text-xs font-medium">{t('wms_asn_no_disc')}</span>
                          </div>
                        ) : (
                          <div className="border border-border rounded-lg overflow-hidden">
                            <table className="w-full text-sm">
                              <thead className="bg-muted/50 border-b border-border">
                                <tr>
                                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">#</th>
                                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">Part Number</th>
                                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_expected')}</th>
                                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_received')}</th>
                                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_asn_difference')}</th>
                                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_type')}</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-border/60">
                                {disc.map((d, i) => (
                                  <tr key={i} className="hover:bg-muted/40">
                                    <td className="px-3 py-2.5 text-xs font-mono text-muted-foreground">{d.line_no}</td>
                                    <td className="px-3 py-2.5 text-xs font-mono font-medium">{d.part_number}</td>
                                    <td className="px-3 py-2.5 text-xs text-right tabular-nums">{(d.qty_expected || 0).toLocaleString()}</td>
                                    <td className="px-3 py-2.5 text-xs text-right tabular-nums">{(d.qty_received || 0).toLocaleString()}</td>
                                    <td className={`px-3 py-2.5 text-xs text-right tabular-nums font-medium ${d.difference > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}`}>{d.difference > 0 ? '+' : ''}{d.difference.toLocaleString()}</td>
                                    <td className="px-3 py-2.5"><span className={`px-2 py-0.5 rounded-md border text-xs font-medium whitespace-nowrap ${d.difference > 0 ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/25' : 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/25'}`}>{DISC_TYPE_KEY[d.type] ? t(DISC_TYPE_KEY[d.type]) : d.type}</span></td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* Expected vs received table */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-xs font-semibold text-muted-foreground">{t('wms_asn_pl_lines')}</h4>
                      {editing && (
                        <Btn onClick={addItem}>
                          <Plus className="w-3.5 h-3.5" /> {t('wms_add_line')}
                        </Btn>
                      )}
                    </div>
                    <div className="border border-border rounded-lg overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-muted/50 border-b border-border">
                          <tr>
                            <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">#</th>
                            <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">Part Number</th>
                            <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('description')}</th>
                            <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_country')}</th>
                            <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_brand')}</th>
                            <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_expected')}</th>
                            <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_received')}</th>
                            {!editing && <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_in_inventory')}</th>}
                            <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground w-32">{editing ? '' : t('progress')}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/60">
                          {editing && editDraft ? (
                            editDraft.items.map((it, i) => (
                              <tr key={i} className="hover:bg-muted/40">
                                <td className="p-2 text-xs font-mono text-muted-foreground">{i + 1}</td>
                                <td className="p-2"><input value={it.part_number} onChange={e => setItem(i, 'part_number', e.target.value.toUpperCase())} className="w-full h-8 px-2 bg-card border border-input rounded-md text-xs font-mono focus:outline-none focus:border-primary" /></td>
                                <td className="p-2"><input value={it.description} onChange={e => setItem(i, 'description', e.target.value)} className="w-full h-8 px-2 bg-card border border-input rounded-md text-xs focus:outline-none focus:border-primary" /></td>
                                <td className="p-2"><input value={it.country} onChange={e => setItem(i, 'country', e.target.value.toUpperCase())} className="w-20 h-8 px-2 bg-card border border-input rounded-md text-xs font-mono focus:outline-none focus:border-primary" /></td>
                                <td className="p-2"><input value={it.brand} onChange={e => setItem(i, 'brand', e.target.value.toUpperCase())} className="w-24 h-8 px-2 bg-card border border-input rounded-md text-xs focus:outline-none focus:border-primary" /></td>
                                <td className="p-2"><input type="number" min="0" value={it.qty_expected} onChange={e => setItem(i, 'qty_expected', e.target.value)} className="w-24 h-8 px-2 bg-card border border-input rounded-md text-xs text-right tabular-nums focus:outline-none focus:border-primary" /></td>
                                <td className="p-2 text-xs text-right tabular-nums text-muted-foreground">{(it.qty_received || 0).toLocaleString()}</td>
                                <td className="p-2 text-center">
                                  <button onClick={() => removeItem(i)} className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded" title={t('wms_remove_line')}><Trash2 className="w-3.5 h-3.5" /></button>
                                </td>
                              </tr>
                            ))
                          ) : (
                            (detailData.asn?.items || []).map(it => {
                              const exp = it.qty_expected || 0;
                              const rcv = it.qty_received || 0;
                              const pct = exp > 0 ? Math.min(100, Math.round((rcv / exp) * 100)) : 0;
                              const done = rcv >= exp;
                              return (
                                <tr key={it.line_no} className="hover:bg-muted/40">
                                  <td className="px-3 py-2.5 text-xs font-mono text-muted-foreground">{it.line_no}</td>
                                  <td className="px-3 py-2.5 text-xs font-mono font-medium">{it.part_number}</td>
                                  <td className="px-3 py-2.5 text-xs text-foreground max-w-[260px] truncate" title={it.description}>{it.description}</td>
                                  <td className="px-3 py-2.5 text-xs font-mono">{it.country || '—'}</td>
                                  <td className="px-3 py-2.5 text-xs">{it.brand || '—'}</td>
                                  <td className="px-3 py-2.5 text-xs text-right tabular-nums font-bold">{exp.toLocaleString()}</td>
                                  <td className={`px-3 py-2.5 text-xs text-right tabular-nums font-medium ${done ? 'text-emerald-600 dark:text-emerald-400' : rcv > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>{rcv.toLocaleString()}</td>
                                  <td className="px-3 py-2.5 text-xs text-right tabular-nums font-medium">{((detailData.summary?.by_line || []).find(l => l.line_no === it.line_no)?.qty_in_stock ?? 0).toLocaleString()}</td>
                                  <td className="px-3 py-2.5">
                                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                                      <div className={`h-full ${done ? 'bg-emerald-500' : rcv > 0 ? 'bg-amber-500' : 'bg-blue-500/40'}`} style={{ width: `${pct}%` }} />
                                    </div>
                                    <div className="text-xs text-muted-foreground mt-0.5">{pct}%</div>
                                  </td>
                                </tr>
                              );
                            })
                          )}
                        </tbody>
                      </table>
                    </div>
                    {editing && <p className="text-xs text-muted-foreground/60 mt-2 italic">{t('wms_asn_received_col_note')}</p>}
                  </div>

                  {/* Received boxes */}
                  <div>
                    <h4 className="text-xs font-semibold text-muted-foreground mb-2">
                      {t('wms_asn_boxes_received', { n: detailData.boxes?.length || 0 })}
                    </h4>
                    {(!detailData.boxes || detailData.boxes.length === 0) ? (
                      <div className="text-center py-10 text-sm text-muted-foreground">
                        {t('wms_asn_no_boxes_yet')}
                      </div>
                    ) : (
                      <div className="border border-border rounded-lg overflow-hidden">
                        <table className="w-full text-sm">
                          <thead className="bg-muted/50 border-b border-border">
                            <tr>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">Box ID</th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('wms_style_sku')}</th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">Color / Size</th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('location')}</th>
                              <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">{t('wms_label_units')}</th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('status')}</th>
                              <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{t('date')}</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/60">
                            {detailData.boxes.map(b => (
                              <tr key={b.box_id} className="hover:bg-muted/40">
                                <td className="px-3 py-2.5 text-xs font-mono font-medium">{b.box_id}</td>
                                <td className="px-3 py-2.5 text-xs font-mono">{b.style || b.sku}</td>
                                <td className="px-3 py-2.5 text-xs">{b.color || '—'} / {b.size || '—'}</td>
                                <td className="px-3 py-2.5 text-xs font-mono">{b.location || '—'}</td>
                                <td className="px-3 py-2.5 text-xs text-right tabular-nums font-medium">{(b.units || 0).toLocaleString()}</td>
                                <td className="px-3 py-2.5 text-xs">{b.status || '—'}</td>
                                <td className="px-3 py-2.5 text-xs text-muted-foreground">{b.created_at ? new Date(b.created_at).toLocaleString() : '—'}</td>
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

      {/* SKU → ASN trace modal (Fase 2) */}
      {showTrace && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-card border border-border rounded-lg w-full max-w-3xl max-h-[85vh] flex flex-col shadow-xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between p-5 border-b border-border/20">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                  <Search className="w-5 h-5 text-muted-foreground" />
                </div>
                <div>
                  <h3 className="font-semibold text-sm">{t('wms_asn_trace_modal_title')}</h3>
                  <p className="text-xs text-muted-foreground">{t('wms_asn_trace_modal_sub')}</p>
                </div>
              </div>
              <button onClick={() => setShowTrace(false)} className="p-2 hover:bg-secondary rounded-lg transition-all"><X className="w-5 h-5" /></button>
            </div>

            <div className="p-5 border-b border-border/20 flex gap-2">
              <input
                autoFocus
                value={traceQuery}
                onChange={(e) => setTraceQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') runTrace(); }}
                placeholder={t('wms_asn_trace_ph')}
                className="flex-1 h-10 px-3 bg-card border border-input rounded-md text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring transition-colors"
              />
              <Btn variant="primary" onClick={runTrace} disabled={traceLoading || !traceQuery.trim()} className="px-6 h-10">
                {traceLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} {t('search')}
              </Btn>
            </div>

            <div className="flex-1 overflow-auto custom-scrollbar p-5">
              {traceLoading ? (
                <div className="flex items-center justify-center py-16"><Loader2 className="w-7 h-7 animate-spin text-muted-foreground" /></div>
              ) : !traceResults ? (
                <EmptyState art="scan" title={t('wms_asn_trace_empty_title')}
                  hint={t('wms_asn_trace_empty_hint')} />
              ) : traceResults.groups.length === 0 ? (
                <div className="text-center py-16 text-sm text-muted-foreground">{t('wms_asn_trace_no_match', { q: traceResults.query })}</div>
              ) : (
                <div className="space-y-3">
                  <div className="text-xs font-medium text-muted-foreground">{t('wms_asn_trace_found', { boxes: traceResults.total_boxes, groups: traceResults.groups.length })}</div>
                  {traceResults.groups.map(g => (
                    <div key={g.asn_reference} className="border border-border rounded-lg p-4">
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-semibold text-sm">{g.asn_reference}</span>
                          {g.vendor && <span className="text-xs text-muted-foreground truncate">· {g.vendor}</span>}
                          {!g.exists && g.asn_reference !== '(SIN ASN)' && <span className="text-xs px-1.5 py-0.5 rounded-md font-medium bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/25">{t('wms_asn_deleted_badge')}</span>}
                        </div>
                        <div className="flex items-center gap-4 text-right">
                          <div>
                            <div className="text-xs font-medium text-muted-foreground">{t('wms_in_inventory')}</div>
                            <div className="text-lg font-semibold tracking-tight tabular-nums">{(g.units_in_stock || 0).toLocaleString()}</div>
                          </div>
                          <div>
                            <div className="text-xs font-medium text-muted-foreground">{t('wms_asn_total_boxes')}</div>
                            <div className="text-lg font-semibold tracking-tight tabular-nums">{g.boxes_in_stock || 0}/{g.boxes || 0}</div>
                          </div>
                        </div>
                      </div>
                      {(g.locations || []).length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {g.locations.map(l => (
                            <span key={l} className="px-2 py-0.5 bg-muted border border-border rounded-md text-xs font-mono">{l}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
