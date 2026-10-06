/* Módulo Auditorías (Fase 1) — dashboard IRA/ILA + vistas derivadas de la
   bitácora + catálogo de motivos. Todo SOLO LECTURA salvo el catálogo de
   motivos (gated por auditorias.manage). Los KPIs y las vistas se calculan/leen
   en el backend (services/auditorias.py); aquí solo se pintan. */
import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Plus, X, Loader2, Save, Download } from "lucide-react";
import * as XLSX from "xlsx";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip,
  CartesianGrid, ReferenceLine, Legend,
} from "recharts";
import { toast } from "sonner";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, poster, putter, deleter, useWms } from "./lib";
import { Card, StatCard, Btn, Chip, cls, TableShell, tableCls, EmptyState } from "./ui";

const TABS = [
  { id: "kpis", key: "wms_aud_tab_kpis" },
  { id: "sampling", key: "wms_aud_tab_sampling" },
  { id: "ira_ila", key: "wms_aud_tab_ira_ila" },
  { id: "pick", key: "wms_aud_tab_pick" },
  { id: "putaway", key: "wms_aud_tab_putaway" },
  { id: "receiving", key: "wms_aud_tab_receiving" },
  { id: "reasons", key: "wms_aud_tab_reasons" },
];

// Columnas (claves de la fila aplanada) por familia de movimiento.
const FEED_COLS = {
  pick: ["created_at", "user_name", "order_number", "style", "color", "size", "units", "location", "box_id", "detail"],
  putaway: ["created_at", "user_name", "from", "to", "box_id", "units", "detail"],
  receiving: ["created_at", "user_name", "receiving_id", "units", "box_id", "detail"],
  ira_ila: ["created_at", "user_name", "box_id", "location", "style", "color", "size", "before", "after", "delta", "reason"],
};

const isoDaysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

const pct = (v) => (v == null ? "—" : `${v}%`);
const num = (v) => (v == null || v === "" ? "" : Number(v).toLocaleString());
const shortWhen = (iso) => (iso || "").replace("T", " ").slice(0, 16);

// Descarga un .xlsx con una o varias hojas. sheets = [{name, rows}], rows = [{col: val}].
const downloadSheets = (filename, sheets) => {
  const wb = XLSX.utils.book_new();
  sheets.forEach(({ name, rows }) => {
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{}]);
    XLSX.utils.book_append_sheet(wb, ws, String(name).slice(0, 31));
  });
  XLSX.writeFile(wb, filename);
};

export function AuditoriasModule() {
  const { t } = useLang();
  const { can } = useWms();
  const canManage = typeof can === "function" && can("auditorias.manage");

  const [tab, setTab] = useState("kpis");
  const [since, setSince] = useState(() => isoDaysAgo(30));
  const [until, setUntil] = useState(() => isoDaysAgo(0));

  return (
    <div className="space-y-5">
      {/* Controles de rango + pestañas */}
      <Card className="p-3 flex flex-wrap items-center gap-3">
        <div className="inline-flex flex-wrap gap-1 bg-muted/40 border border-border rounded-lg p-1">
          {TABS.map((x) => (
            <button
              key={x.id}
              onClick={() => setTab(x.id)}
              data-testid={`aud-tab-${x.id}`}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                tab === x.id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t(x.key)}
            </button>
          ))}
        </div>
        {tab !== "reasons" && tab !== "sampling" && (
          <div className="flex items-center gap-2 ml-auto">
            <label className="text-xs text-muted-foreground">{t("wms_aud_from")}</label>
            <input type="date" value={since} max={until} onChange={(e) => setSince(e.target.value)}
                   className={`${cls.input} w-auto`} data-testid="aud-since" />
            <label className="text-xs text-muted-foreground">{t("wms_aud_to")}</label>
            <input type="date" value={until} min={since} onChange={(e) => setUntil(e.target.value)}
                   className={`${cls.input} w-auto`} data-testid="aud-until" />
          </div>
        )}
      </Card>

      {tab === "kpis" && <KpisTab t={t} since={since} until={until} />}
      {tab === "sampling" && <SamplingTab t={t} canManage={canManage} />}
      {(tab === "pick" || tab === "putaway" || tab === "receiving" || tab === "ira_ila") && (
        <FeedTab t={t} kind={tab} since={since} until={until} />
      )}
      {tab === "reasons" && <ReasonsTab t={t} canManage={canManage} />}
    </div>
  );
}

// ── Dashboard IRA / ILA ───────────────────────────────────────────────────────
function KpisTab({ t, since, until }) {
  const [group, setGroup] = useState("day");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetcher(`/auditorias/kpis?since=${since}&until=${until}&group=${group}`);
      setData(d);
    } catch {
      toast.error(t("wms_aud_load_err"));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [since, until, group, t]);

  useEffect(() => { load(); }, [load]);

  const tot = data?.totals || {};
  const goal = data?.goal ?? 99;
  const chartData = (data?.series || []).map((r) => ({
    key: r.key, IRA: r.ira_pct, ILA: r.ila_pct,
  }));

  const exportXlsx = () => {
    const rows = (data?.series || []).map((r) => ({
      [t("wms_aud_col_period")]: r.key,
      [t("wms_aud_units_processed")]: r.units_processed,
      [t("wms_aud_units_ok")]: r.units_without_issues,
      "IRA %": r.ira_pct, "IRA MTD %": r.ira_mtd,
      [t("wms_aud_col_locs")]: r.locations_processed,
      [t("wms_aud_col_locs_ok")]: r.locations_without_issues,
      "ILA %": r.ila_pct, fuente: r.source,
    }));
    downloadSheets(`Auditorias_KPIs_${since}_${until}.xlsx`, [{ name: "KPIs", rows }]);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <div className="inline-flex gap-1 bg-muted/40 border border-border rounded-lg p-1">
          {["day", "week"].map((g) => (
            <button key={g} onClick={() => setGroup(g)}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${
                group === g ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}>
              {t(g === "day" ? "wms_aud_group_day" : "wms_aud_group_week")}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Btn onClick={exportXlsx} disabled={loading || !(data?.series?.length)} data-testid="aud-export-kpis">
            <Download className="w-4 h-4" />{t("wms_aud_export")}
          </Btn>
          <Btn onClick={load} disabled={loading} data-testid="aud-refresh">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {t("wms_aud_refresh")}
          </Btn>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label={t("wms_aud_ira")} value={pct(tot.ira_pct)}
          sub={`${t("wms_aud_goal")} ${goal}%`} data-testid="aud-stat-ira" />
        <StatCard label={t("wms_aud_ila")} value={pct(tot.ila_pct)}
          sub={`${t("wms_aud_goal")} ${goal}%`} data-testid="aud-stat-ila" />
        <StatCard label={t("wms_aud_units_processed")} value={num(tot.units_processed) || "0"} />
        <StatCard label={t("wms_aud_units_ok")} value={num(tot.units_without_issues) || "0"} />
      </div>

      <Card className="p-4">
        {loading ? (
          <div className="h-72 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : chartData.length === 0 ? (
          <EmptyState title={t("wms_aud_no_data")} hint={t("wms_aud_no_data_hint")} art="chart" />
        ) : (
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: -8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.15)" />
                <XAxis dataKey="key" tick={{ fontSize: 10, fill: "rgb(148,163,184)" }} interval="preserveStartEnd" />
                <YAxis domain={[80, 100]} tick={{ fontSize: 10, fill: "rgb(148,163,184)" }} unit="%" width={44} />
                <Tooltip
                  contentStyle={{ background: "#0f172a", border: "1px solid rgba(148,163,184,0.25)", borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: "#e2e8f0" }} formatter={(v) => (v == null ? "—" : `${v}%`)} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <ReferenceLine y={goal} stroke="#f59e0b" strokeDasharray="4 4"
                  label={{ value: `${t("wms_aud_goal")} ${goal}%`, fontSize: 10, fill: "#f59e0b", position: "insideTopRight" }} />
                <Line type="monotone" dataKey="IRA" stroke="#22c55e" strokeWidth={2} dot={false} connectNulls />
                <Line type="monotone" dataKey="ILA" stroke="#38bdf8" strokeWidth={2} dot={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {!loading && (data?.series || []).length > 0 && (
        <Card>
          <TableShell maxH="max-h-[460px]">
            <thead className={tableCls.thead}>
              <tr>
                {["wms_aud_col_period", "wms_aud_units_processed", "wms_aud_units_ok", "wms_aud_ira",
                  "wms_aud_mtd", "wms_aud_col_locs", "wms_aud_col_locs_ok", "wms_aud_ila"].map((k, i) => (
                  <th key={k} className={`${cls.th} ${i > 0 ? "text-right" : ""}`}>{t(k)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.series.map((r) => {
                const below = r.ira_pct != null && r.ira_pct < goal;
                return (
                  <tr key={r.key} className={tableCls.row}>
                    <td className="px-3 py-2 font-medium">{r.key}
                      {r.source === "historico" && <Chip className="ml-2" tone="info">{t("wms_aud_historic")}</Chip>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{num(r.units_processed)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{num(r.units_without_issues)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums font-semibold ${below ? "text-red-500" : "text-emerald-500"}`}>{pct(r.ira_pct)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{pct(r.ira_mtd)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{num(r.locations_processed)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{num(r.locations_without_issues)}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold">{pct(r.ila_pct)}</td>
                  </tr>
                );
              })}
            </tbody>
          </TableShell>
        </Card>
      )}
    </div>
  );
}

// ── Vistas derivadas (Case Pick / Putaway / Receiving) ────────────────────────
function FeedTab({ t, kind, since, until }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = `since=${since}&until=${until}&limit=800${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`;
      const d = await fetcher(`/auditorias/feed/${kind}?${qs}`);
      setRows(d.rows || []);
      setTotal(d.total || 0);
    } catch {
      toast.error(t("wms_aud_load_err"));
      setRows([]); setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [kind, since, until, q, t]);

  useEffect(() => { load(); }, [kind, since, until]); // eslint-disable-line react-hooks/exhaustive-deps

  const cols = FEED_COLS[kind] || [];
  const colLabel = (c) => t(`wms_aud_col_${c === "created_at" ? "date" : c === "user_name" ? "user" : c === "order_number" ? "order" : c === "box_id" ? "box" : c === "receiving_id" ? "receiving" : c}`);

  const exportXlsx = () => {
    const out = rows.map((r) => Object.fromEntries(
      cols.map((c) => [colLabel(c), c === "created_at" ? shortWhen(r[c]) : (r[c] ?? "")])));
    downloadSheets(`Auditorias_${kind}_${since}_${until}.xlsx`, [{ name: kind, rows: out }]);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") load(); }}
          placeholder={t("wms_aud_search")} className={`${cls.input} max-w-xs`} data-testid="aud-feed-search" />
        <Btn onClick={load} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          {t("wms_aud_refresh")}
        </Btn>
        <Btn onClick={exportXlsx} disabled={loading || rows.length === 0} data-testid="aud-export-feed">
          <Download className="w-4 h-4" />{t("wms_aud_export")}
        </Btn>
        <span className="text-xs text-muted-foreground ml-auto">{t("wms_aud_total")}: {total.toLocaleString()}</span>
      </div>

      <Card>
        {loading ? (
          <div className="py-16 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : rows.length === 0 ? (
          <EmptyState title={t("wms_aud_no_rows")} art="boxes" />
        ) : (
          <TableShell maxH="max-h-[560px]">
            <thead className={tableCls.thead}>
              <tr>{cols.map((c) => <th key={c} className={cls.th}>{colLabel(c)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.movement_id || i}-${i}`} className={tableCls.row}>
                  {cols.map((c) => (
                    <td key={c} className="px-3 py-1.5 text-xs">
                      {c === "created_at" ? shortWhen(r[c]) : c === "units" ? num(r[c]) : (r[c] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>
    </div>
  );
}

// ── Catálogo de motivos ───────────────────────────────────────────────────────
function ReasonsTab({ t, canManage }) {
  const [codes, setCodes] = useState([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetcher("/auditorias/config");
      setCodes(d.reason_codes || []);
      setDirty(false);
    } catch {
      toast.error(t("wms_aud_load_err"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (codes.some((c) => c.toUpperCase() === v.toUpperCase())) { toast.error(t("wms_aud_reason_dup")); return; }
    setCodes((p) => [...p, v]); setDraft(""); setDirty(true);
  };
  const remove = (c) => { setCodes((p) => p.filter((x) => x !== c)); setDirty(true); };

  const save = async () => {
    setSaving(true);
    try {
      const res = await putter("/auditorias/config", { reason_codes: codes });
      if (res.ok) { toast.success(t("wms_aud_saved")); setDirty(false); }
      else { const e = await res.json().catch(() => ({})); toast.error(e.detail || t("wms_aud_save_err")); }
    } catch {
      toast.error(t("wms_aud_save_err"));
    } finally { setSaving(false); }
  };

  if (loading) return <div className="py-16 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;

  return (
    <Card className="p-5 max-w-2xl space-y-4">
      <div>
        <h3 className="text-sm font-semibold">{t("wms_aud_reasons_title")}</h3>
        <p className="text-xs text-muted-foreground mt-0.5">{t("wms_aud_reasons_help")}</p>
      </div>

      {canManage && (
        <div className="flex gap-2">
          <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            placeholder={t("wms_aud_add_reason")} className={`${cls.input} flex-1`} data-testid="aud-reason-input" />
          <Btn onClick={add} disabled={!draft.trim()}><Plus className="w-4 h-4" />{t("add")}</Btn>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {codes.length === 0 ? (
          <span className="text-sm text-muted-foreground">{t("wms_aud_no_reasons")}</span>
        ) : codes.map((c) => (
          <span key={c} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border bg-muted text-sm">
            {c}
            {canManage && <button onClick={() => remove(c)} className="text-muted-foreground hover:text-red-500"><X className="w-3.5 h-3.5" /></button>}
          </span>
        ))}
      </div>

      {canManage && (
        <div className="flex items-center gap-2 pt-2 border-t border-border">
          <Btn variant="primary" onClick={save} disabled={saving || !dirty} data-testid="aud-reason-save">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {t("wms_aud_save")}
          </Btn>
          {dirty && <span className="text-xs text-amber-500">{t("wms_aud_unsaved")}</span>}
        </div>
      )}
    </Card>
  );
}

// ── Muestreo por caja (Sampling Results) ──────────────────────────────────────
function SamplingTab({ t, canManage }) {
  const [sessions, setSessions] = useState([]);
  const [sel, setSel] = useState(null);
  const [loading, setLoading] = useState(true);
  const [boxDraft, setBoxDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [reasons, setReasons] = useState([]);
  const [adjusting, setAdjusting] = useState(null);   // box_id en ajuste
  const [adjReason, setAdjReason] = useState("");

  const loadList = useCallback(async () => {
    setLoading(true);
    try { const d = await fetcher("/auditorias/sessions"); setSessions(d.sessions || []); }
    catch { toast.error(t("wms_aud_load_err")); }
    finally { setLoading(false); }
  }, [t]);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { fetcher("/auditorias/config").then((d) => setReasons(d.reason_codes || [])).catch(() => {}); }, []);

  const openSession = async (id) => {
    try { setSel(await fetcher(`/auditorias/sessions/${id}`)); }
    catch { toast.error(t("wms_aud_load_err")); }
  };

  const create = async () => {
    setBusy(true);
    try {
      const res = await poster("/auditorias/sessions", {});
      if (res.ok) { const s = await res.json(); await loadList(); setSel(s); }
      else toast.error(t("wms_aud_save_err"));
    } finally { setBusy(false); }
  };

  const addBox = async () => {
    const v = boxDraft.trim();
    if (!v || !sel) return;
    setBusy(true);
    try {
      const res = await poster(`/auditorias/sessions/${sel.session_id}/boxes`, { box_id: v });
      if (res.ok) { setSel(await res.json()); setBoxDraft(""); }
      else { const e = await res.json().catch(() => ({})); toast.error(e.detail || t("wms_aud_box_err")); }
    } finally { setBusy(false); }
  };

  const setCount = async (box, patch) => {
    const units = patch.counted_units != null ? patch.counted_units : box.counted_units;
    if (units == null || units === "") return;
    const body = {
      counted_units: Number(units),
      content_ok: patch.content_ok != null ? patch.content_ok : (box.content_ok !== false),
      located_ok: patch.located_ok != null ? patch.located_ok : (box.located_ok !== false),
    };
    try {
      const res = await putter(`/auditorias/sessions/${sel.session_id}/boxes/${box.box_id}`, body);
      if (res.ok) setSel(await res.json());
      else { const e = await res.json().catch(() => ({})); toast.error(e.detail || t("wms_aud_box_err")); }
    } catch { toast.error(t("wms_aud_box_err")); }
  };

  const removeBox = async (box) => {
    try { await deleter(`/auditorias/sessions/${sel.session_id}/boxes/${box.box_id}`); openSession(sel.session_id); }
    catch { toast.error(t("wms_aud_box_err")); }
  };

  const closeSession = async () => {
    if (!window.confirm(t("wms_aud_confirm_close"))) return;
    const res = await poster(`/auditorias/sessions/${sel.session_id}/close`, {});
    if (res.ok) { toast.success(t("wms_aud_session_closed_ok")); setSel(await res.json()); loadList(); }
    else toast.error(t("wms_aud_save_err"));
  };

  const applyAdjust = async (box) => {
    if (!adjReason) return;
    const res = await poster("/auditorias/adjust", {
      box_id: box.box_id, counted_units: box.counted_units, reason: adjReason,
      located_ok: box.located_ok !== false, session_id: sel.session_id,
    });
    if (res.ok) { toast.success(t("wms_aud_adjusted_ok")); setAdjusting(null); setAdjReason(""); openSession(sel.session_id); loadList(); }
    else { const e = await res.json().catch(() => ({})); toast.error(e.detail || t("wms_aud_save_err")); }
  };

  const exportXlsx = () => {
    if (!sel) return;
    const boxes = (sel.boxes || []).map((b) => ({
      Caja: b.box_id, Ubicacion: b.location, Estilo: b.style, Color: b.color, Talla: b.size,
      Sistema: b.system_units, Fisico: b.counted_units,
      Delta: b.counted ? (b.counted_units - b.system_units) : "",
      ContenidoOK: b.content_ok === false ? "NO" : "SI",
      EnUbicacion: b.located_ok === false ? "NO" : "SI",
      Ajustada: b.adjusted ? "SI" : "",
    }));
    const m = sel.metrics || {};
    const met = [
      ["Cajas muestreadas", m.boxes_sampled], ["Cajas correctas", m.boxes_correct],
      ["Con discrepancia", m.boxes_discrepancy], ["Contenido incorrecto %", m.content_bad_pct],
      ["Piezas sistema", m.system_pieces], ["Piezas fisicas", m.physical_pieces],
      ["Variacion neta", m.net_discrepancy], ["IRA %", m.ira_pct], ["ILA %", m.ila_pct],
    ].map(([Metrica, Valor]) => ({ Metrica, Valor }));
    downloadSheets(`Auditorias_Muestreo_${sel.session_id}.xlsx`,
      [{ name: "Cajas", rows: boxes }, { name: "Metricas", rows: met }]);
  };

  const editable = canManage && sel && sel.status === "open";
  const m = sel?.metrics || {};

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
      {/* Lista de sesiones */}
      <Card className="p-3 space-y-2 h-fit">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{t("wms_aud_sessions")}</h3>
          {canManage && (
            <Btn variant="primary" onClick={create} disabled={busy} data-testid="aud-new-session">
              <Plus className="w-3.5 h-3.5" />{t("wms_aud_new_session")}
            </Btn>
          )}
        </div>
        {loading ? (
          <div className="py-8 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        ) : sessions.length === 0 ? (
          <p className="text-xs text-muted-foreground py-6 text-center">{t("wms_aud_no_sessions")}</p>
        ) : (
          <div className="space-y-1 max-h-[560px] overflow-y-auto">
            {sessions.map((s) => (
              <button key={s.session_id} onClick={() => openSession(s.session_id)}
                className={`w-full text-left px-3 py-2 rounded-md border text-xs transition-colors ${
                  sel?.session_id === s.session_id ? "bg-primary/10 border-primary/40" : "bg-card border-border hover:bg-muted/40"
                }`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium tabular-nums">{shortWhen(s.created_at)}</span>
                  <Chip tone={s.status === "open" ? "warning" : "success"}>
                    {t(s.status === "open" ? "wms_aud_session_open" : "wms_aud_session_closed")}
                  </Chip>
                </div>
                <div className="text-muted-foreground mt-0.5">
                  {s.created_by_name || "—"} · {t("wms_aud_m_sampled")}: {s.metrics?.boxes_sampled ?? 0}
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>

      {/* Detalle de la sesión */}
      {!sel ? (
        <Card><EmptyState title={t("wms_aud_select_session")} art="boxes" /></Card>
      ) : (
        <div className="space-y-4">
          {/* Métricas (bloque Sampling Results) */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label={t("wms_aud_m_sampled")} value={m.boxes_sampled ?? 0} />
            <StatCard label={t("wms_aud_m_correct")} value={m.boxes_correct ?? 0} />
            <StatCard label={t("wms_aud_m_discrepancy")} value={m.boxes_discrepancy ?? 0} />
            <StatCard label={t("wms_aud_m_content_bad")} value={`${m.content_bad_pct ?? 0}%`} />
            <StatCard label={t("wms_aud_system")} value={num(m.system_pieces) || "0"} />
            <StatCard label={t("wms_aud_physical")} value={num(m.physical_pieces) || "0"} />
            <StatCard label={t("wms_aud_ira")} value={pct(m.ira_pct)} />
            <StatCard label={t("wms_aud_ila")} value={pct(m.ila_pct)} />
          </div>

          {/* Escanear caja + cerrar */}
          <div className="flex items-center gap-2">
            {editable && (
              <>
                <input value={boxDraft} onChange={(e) => setBoxDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") addBox(); }}
                  placeholder={t("wms_aud_scan_box")} className={`${cls.input} max-w-xs`}
                  autoFocus data-testid="aud-box-input" />
                <Btn onClick={addBox} disabled={busy || !boxDraft.trim()}><Plus className="w-4 h-4" />{t("wms_aud_add_box")}</Btn>
              </>
            )}
            <span className="text-xs text-muted-foreground ml-auto">
              {sel.status === "closed" ? <Chip tone="success">{t("wms_aud_session_closed")}</Chip> : null}
            </span>
            <Btn onClick={exportXlsx} disabled={!(sel.boxes || []).length} data-testid="aud-export-sampling">
              <Download className="w-4 h-4" />{t("wms_aud_export")}
            </Btn>
            {editable && (
              <Btn variant="primary" onClick={closeSession} data-testid="aud-close-session">
                {t("wms_aud_close_session")}
              </Btn>
            )}
          </div>

          {/* Tabla de cajas */}
          <Card>
            {(sel.boxes || []).length === 0 ? (
              <EmptyState title={t("wms_aud_no_boxes")} art="boxes" />
            ) : (
              <TableShell maxH="max-h-[460px]">
                <thead className={tableCls.thead}>
                  <tr>
                    {["wms_aud_col_box", "wms_aud_col_location", "wms_aud_col_style", "wms_aud_col_color", "wms_aud_col_size",
                      "wms_aud_system", "wms_aud_physical", "wms_aud_content_ok", "wms_aud_located_ok"].map((k) => (
                      <th key={k} className={cls.th}>{t(k)}</th>
                    ))}
                    {editable && <th className={cls.th} />}
                  </tr>
                </thead>
                <tbody>
                  {sel.boxes.map((b) => {
                    const delta = b.counted ? (b.counted_units - b.system_units) : null;
                    return (
                      <tr key={b.box_id} className={tableCls.row}>
                        <td className="px-3 py-1.5 text-xs font-mono font-medium">{b.box_id}</td>
                        <td className="px-3 py-1.5 text-xs">{b.location}</td>
                        <td className="px-3 py-1.5 text-xs">{b.style}</td>
                        <td className="px-3 py-1.5 text-xs">{b.color}</td>
                        <td className="px-3 py-1.5 text-xs">{b.size}</td>
                        <td className="px-3 py-1.5 text-xs text-right tabular-nums">{b.system_units}</td>
                        <td className="px-3 py-1.5 text-xs text-right tabular-nums">
                          {editable ? (
                            <input type="number" min="0" defaultValue={b.counted_units ?? ""}
                              key={`${b.box_id}-${b.counted_at || "new"}`}
                              onKeyDown={(e) => { if (e.key === "Enter") setCount(b, { counted_units: e.target.value }); }}
                              onBlur={(e) => { if (e.target.value !== "" && Number(e.target.value) !== b.counted_units) setCount(b, { counted_units: e.target.value }); }}
                              className="w-20 px-2 py-1 bg-card border border-input rounded text-right" />
                          ) : (
                            <span className={delta ? "text-red-500 font-semibold" : ""}>{b.counted_units ?? "—"}</span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-center">
                          <input type="checkbox" checked={b.content_ok !== false} disabled={!editable || !b.counted}
                            onChange={(e) => setCount(b, { content_ok: e.target.checked })} />
                        </td>
                        <td className="px-3 py-1.5 text-center">
                          <input type="checkbox" checked={b.located_ok !== false} disabled={!editable || !b.counted}
                            onChange={(e) => setCount(b, { located_ok: e.target.checked })} />
                        </td>
                        {editable && (
                          <td className="px-3 py-1.5 text-right whitespace-nowrap">
                            {b.adjusted ? (
                              <Chip tone="success">{t("wms_aud_adjusted")}</Chip>
                            ) : adjusting === b.box_id ? (
                              <span className="inline-flex items-center gap-1">
                                <select value={adjReason} onChange={(e) => setAdjReason(e.target.value)}
                                  className="text-xs border border-input rounded px-1 py-1 bg-card max-w-[160px]">
                                  <option value="">{t("wms_aud_pick_reason")}</option>
                                  {reasons.map((r) => <option key={r} value={r}>{r}</option>)}
                                </select>
                                <button onClick={() => applyAdjust(b)} disabled={!adjReason}
                                  className="text-emerald-500 disabled:opacity-40 px-1" title={t("wms_aud_apply")}>✓</button>
                                <button onClick={() => { setAdjusting(null); setAdjReason(""); }} className="text-muted-foreground"><X className="w-3.5 h-3.5" /></button>
                              </span>
                            ) : (b.counted && b.counted_units !== b.system_units) ? (
                              <button onClick={() => { setAdjusting(b.box_id); setAdjReason(""); }}
                                className="text-xs text-primary hover:underline" data-testid={`aud-adjust-${b.box_id}`}>
                                {t("wms_aud_adjust")}
                              </button>
                            ) : (
                              <button onClick={() => removeBox(b)} className="text-muted-foreground hover:text-red-500"><X className="w-3.5 h-3.5" /></button>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </TableShell>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

export default AuditoriasModule;
