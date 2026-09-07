import { useState } from "react";
import {
  Activity, PackageSearch, Layers, History, Search, Loader2,
  AlertTriangle, CheckCircle2, RefreshCw, FlaskConical, XCircle, Download, Ghost, Barcode,
} from "lucide-react";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { saveAs } from "file-saver";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, poster } from "./lib";
import { Btn, Th, Chip, tableCls } from "./ui";

// Módulo de Auditoría — admin nivel 5 y supersu (el backend valida con
// require_admin_level(5) y rechaza al resto con 403). Cuatro vistas: salud del
// sistema, trazabilidad por caja, balance por SKU y búsqueda de movimientos.

const TABS = [
  { id: "health", labelKey: "wms_audit_tab_health", icon: Activity },
  { id: "fantasmas", labelKey: "wms_audit_tab_phantom_rows", icon: Ghost },
  { id: "skucat", labelKey: "wms_audit_tab_sku_catalog", icon: Barcode },
  { id: "selftest", labelKey: "wms_audit_tab_selftest", icon: FlaskConical },
  { id: "box", labelKey: "wms_audit_tab_box", icon: PackageSearch },
  { id: "sku", labelKey: "wms_audit_tab_sku", icon: Layers },
  { id: "movements", labelKey: "wms_audit_tab_movements", icon: History },
];

const fmtDate = (iso) => {
  if (!iso) return "-";
  const d = new Date(iso);
  return isNaN(d) ? String(iso).slice(0, 16) : d.toLocaleString("es-MX", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
};

// Descarga un .xlsx con una o varias hojas. sheets = [{name, rows}]. Cliente-side
// con SheetJS, mismo patrón que Analytics/Art. Nombre de hoja acotado a 31 chars
// (límite de Excel).
const downloadXlsx = (sheets, filename) => {
  const wb = XLSX.utils.book_new();
  sheets.forEach(({ name, rows }) => {
    const ws = XLSX.utils.json_to_sheet(rows && rows.length ? rows : [{ "": "(sin datos)" }]);
    XLSX.utils.book_append_sheet(wb, ws, String(name).slice(0, 31));
  });
  const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  saveAs(new Blob([buf], { type: "application/octet-stream" }), filename);
};
const today = () => new Date().toISOString().split("T")[0];

const Card = ({ title, value, tone = "default", sub }) => (
  <div className={`p-4 rounded-lg border ${tone === "bad" ? "border-red-200 bg-red-50 dark:border-red-500/25 dark:bg-red-500/10" : tone === "good" ? "border-emerald-200 bg-emerald-50 dark:border-emerald-500/25 dark:bg-emerald-500/10" : "border-border bg-card"}`}>
    <div className="text-xs font-medium text-muted-foreground">{title}</div>
    <div className={`text-2xl font-semibold tracking-tight tabular-nums mt-1 ${tone === "bad" ? "text-red-600 dark:text-red-400" : tone === "good" ? "text-emerald-600 dark:text-emerald-400" : "text-foreground"}`}>{value}</div>
    {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
  </div>
);

const Td = ({ children, right, mono }) => (
  <td className={`px-3 py-2 text-xs ${right ? "text-right tabular-nums" : ""} ${mono ? "font-mono" : ""}`}>{children}</td>
);

// Cajita del desglose de cajas (recibidas → consumidas → deberían quedar).
const BoxStat = ({ label, value, sub, tone = "default" }) => (
  <div className={`px-3 py-2 rounded-lg border text-center min-w-[96px] ${
    tone === "bad" ? "border-red-200 bg-red-50 dark:border-red-500/25 dark:bg-red-500/10"
      : tone === "good" ? "border-emerald-200 bg-emerald-50 dark:border-emerald-500/25 dark:bg-emerald-500/10"
        : tone === "accent" ? "border-primary/40 bg-primary/10" : "border-border bg-card"}`}>
    <div className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground">{label}</div>
    <div className={`text-lg font-semibold tabular-nums ${
      tone === "bad" ? "text-red-600 dark:text-red-400"
        : tone === "good" ? "text-emerald-600 dark:text-emerald-400"
          : tone === "accent" ? "text-primary" : "text-foreground"}`}>{value}</div>
    {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
  </div>
);

// ─── Tab 1: Salud ────────────────────────────────────────────────────────────
const HealthTab = () => {
  const { t } = useLang();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    try {
      setData(await fetcher("/audit/health"));
    } catch { toast.error(t("wms_audit_health_err")); }
    finally { setLoading(false); }
  };

  const exportExcel = () => {
    if (!data) return;
    const tot = data.totales || {};
    const resumen = [
      { Métrica: "Unidades (inventario)", Valor: tot.inventario_unidades, Extra: `${tot.inventario_filas} filas` },
      { Métrica: "Unidades (cajas vivas)", Valor: tot.cajas_unidades, Extra: `${tot.cajas_vivas} cajas` },
      { Métrica: "Celdas con drift", Valor: data.drift?.celdas, Extra: `${data.drift?.unidades_abs} u de diferencia` },
      { Métrica: "Tickets con picks sin descontar", Valor: data.sin_descontar?.tickets, Extra: "" },
      { Métrica: "Asignado > en mano", Valor: data.negativos_allocated, Extra: "" },
      { Métrica: "Filas en 0 con cajas", Valor: data.ceros_con_cajas, Extra: "" },
      { Métrica: "Cajas pendientes +14 días", Valor: data.cajas_pendientes_14d, Extra: "" },
    ];
    const drift = (data.drift?.top || []).map(d => ({
      "Ubicación": d.location, "Style": d.style, "Color": d.color, "Talla": d.size,
      "Inventario": d.inventario, "Cajas": d.cajas, "Diferencia": d.diff,
    }));
    const undeducted = (data.sin_descontar?.top || []).map(t2 => ({
      "Ticket": t2.ticket_id, "Orden": t2.order, "Style": t2.style, "Color": t2.color,
      "Status": t2.status, "Pickeado": t2.picked, "Creado": t2.created_at,
    }));
    downloadXlsx(
      [{ name: "Resumen", rows: resumen }, { name: "Drift", rows: drift },
       { name: "Picks sin descontar", rows: undeducted }],
      `Salud_Sistema_${today()}.xlsx`);
    toast.success(t("wms_excel_exported"));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Btn variant="primary" onClick={run} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          {t("wms_audit_run_full_check")}
        </Btn>
        {data && <Btn onClick={exportExcel}><Download className="w-4 h-4" /> {t("export_excel")}</Btn>}
        {data && <span className="text-xs text-muted-foreground">{t("wms_audit_generated_at", { date: fmtDate(data.generated_at) })}</span>}
      </div>
      {!data && !loading && (
        <p className="text-sm text-muted-foreground">{t("wms_audit_health_intro")}</p>
      )}
      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card title={t("wms_audit_units_inventory")} value={data.totales.inventario_unidades.toLocaleString()} sub={t("wms_audit_rows_count", { n: data.totales.inventario_filas.toLocaleString() })} />
            <Card title={t("wms_audit_units_live_boxes")} value={data.totales.cajas_unidades.toLocaleString()} sub={t("wms_boxes_count", { n: data.totales.cajas_vivas.toLocaleString() })} />
            <Card title={t("wms_audit_drift_title")} value={t("wms_audit_cells_count", { n: data.drift.celdas.toLocaleString() })}
              tone={data.drift.celdas > 0 ? "bad" : "good"} sub={t("wms_audit_units_diff", { n: data.drift.unidades_abs.toLocaleString() })} />
            <Card title={t("wms_audit_undeducted_picks")} value={data.sin_descontar.tickets} tone={data.sin_descontar.tickets > 0 ? "bad" : "good"} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Card title={t("wms_audit_allocated_gt_onhand")} value={data.negativos_allocated} tone={data.negativos_allocated > 0 ? "bad" : "good"} />
            <Card title={t("wms_audit_zero_rows_with_boxes")} value={data.ceros_con_cajas} tone={data.ceros_con_cajas > 0 ? "bad" : "good"} />
            <Card title={t("wms_audit_pending_boxes_14d")} value={data.cajas_pendientes_14d} tone={data.cajas_pendientes_14d > 0 ? "bad" : "good"} />
          </div>

          {data.drift.top.length > 0 && (
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-muted/50 border-b border-border text-xs font-semibold text-muted-foreground flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400" /> {t("wms_audit_worst_drift_cells", { n: data.drift.top.length })}
              </div>
              <div className="overflow-x-auto max-h-80 overflow-y-auto">
                <table className="w-full">
                  <thead className={tableCls.thead}><tr>
                    <Th>{t("location")}</Th><Th>Style</Th><Th>Color</Th><Th>{t("wms_label_size")}</Th>
                    <Th right>{t("wms_audit_inventory")}</Th><Th right>{t("wms_boxes")}</Th><Th right>{t("wms_difference")}</Th>
                  </tr></thead>
                  <tbody>
                    {data.drift.top.map((d, i) => (
                      <tr key={i} className="border-t border-border/60 hover:bg-muted/40 transition-colors">
                        <Td mono>{d.location}</Td><Td>{d.style}</Td><Td>{d.color}</Td><Td>{d.size}</Td>
                        <Td right>{d.inventario.toLocaleString()}</Td><Td right>{d.cajas.toLocaleString()}</Td>
                        <Td right><span className={d.diff > 0 ? "text-amber-600 dark:text-amber-400 font-medium" : "text-red-600 dark:text-red-400 font-medium"}>{d.diff > 0 ? "+" : ""}{d.diff.toLocaleString()}</span></Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {data.sin_descontar.top.length > 0 && (
            <div className="border border-red-200 dark:border-red-500/25 rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-red-50 dark:bg-red-500/10 border-b border-red-200 dark:border-red-500/25 text-xs font-semibold flex items-center gap-2 text-red-700 dark:text-red-300">
                <AlertTriangle className="w-4 h-4" /> {t("wms_audit_tickets_undeducted")}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead><tr><Th>Ticket</Th><Th>{t("order")}</Th><Th>Style</Th><Th>Color</Th><Th>Status</Th><Th right>{t("wms_picked")}</Th><Th>{t("wms_created")}</Th></tr></thead>
                  <tbody>
                    {data.sin_descontar.top.map((tk, i) => (
                      <tr key={i} className="border-t border-border/60 hover:bg-muted/40 transition-colors">
                        <Td mono>{tk.ticket_id}</Td><Td>{tk.order}</Td><Td>{tk.style}</Td><Td>{tk.color}</Td>
                        <Td>{tk.status}</Td><Td right>{tk.picked.toLocaleString()}</Td><Td>{fmtDate(tk.created_at)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {data.drift.celdas === 0 && data.sin_descontar.tickets === 0 && (
            <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 text-sm font-medium">
              <CheckCircle2 className="w-5 h-5" /> {t("wms_audit_consistent")}
            </div>
          )}
        </>
      )}
    </div>
  );
};

// ─── Tab: Simulación (self-test) ─────────────────────────────────────────────
const SIM_PARAMS = [
  ["boxes", "wms_boxes"], ["units_per_box", "wms_audit_units_per_box"], ["pick_units", "wms_audit_units_to_pick"],
];

const SelfTestTab = () => {
  const { t } = useLang();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [params, setParams] = useState({ boxes: 3, units_per_box: 10, pick_units: 20 });

  const run = async () => {
    setLoading(true); setData(null);
    try {
      const res = await poster("/audit/self-test", params);
      if (res.ok) setData(await res.json());
      else { const e = await res.json().catch(() => ({})); toast.error(e.detail || t("wms_audit_sim_err")); }
    } catch { toast.error(t("wms_conn_error")); }
    finally { setLoading(false); }
  };

  return (
    <div className="space-y-4">
      <div className="p-4 rounded-lg border border-border bg-card text-sm text-muted-foreground">
        {t("wms_audit_sim_intro_a")} <b className="text-foreground">{t("wms_audit_sim_cycle")}</b> {t("wms_audit_sim_intro_b")}{" "}
        <b className="text-foreground">{t("wms_audit_sim_cleans")}</b> {t("wms_audit_sim_intro_c")}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        {SIM_PARAMS.map(([k, lblKey]) => (
          <div key={k}>
            <div className="text-xs font-medium text-muted-foreground mb-1">{t(lblKey)}</div>
            <input type="number" min="1" value={params[k]}
              onChange={e => setParams({ ...params, [k]: parseInt(e.target.value) || 1 })}
              className="w-28 px-3 py-2 bg-card border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring" />
          </div>
        ))}
        <Btn variant="primary" onClick={run} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FlaskConical className="w-4 h-4" />}
          {t("wms_audit_run_sim")}
        </Btn>
      </div>

      {data && (
        <>
          <div className={`flex items-center gap-2 text-lg font-semibold ${data.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
            {data.ok ? <CheckCircle2 className="w-6 h-6" /> : <XCircle className="w-6 h-6" />}
            {data.ok
              ? t("wms_audit_sim_all_ok", { passed: data.passed, total: data.total })
              : t("wms_audit_sim_failed", { passed: data.passed, total: data.total })}
          </div>
          <div className="space-y-2">
            {data.steps.map(s => (
              <div key={s.step} className={`p-3 rounded-lg border flex items-start gap-3 ${s.status === "PASS" ? "border-emerald-200 bg-emerald-50 dark:border-emerald-500/25 dark:bg-emerald-500/10" : "border-red-200 bg-red-50 dark:border-red-500/25 dark:bg-red-500/10"}`}>
                {s.status === "PASS"
                  ? <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                  : <XCircle className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />}
                <div className="min-w-0">
                  <div className="text-sm font-semibold">{s.step}. {s.name}</div>
                  <div className="text-xs text-muted-foreground">{s.detail}</div>
                  <div className="text-xs font-mono mt-1">
                    <span className="text-muted-foreground">{t("wms_audit_got")}</span> {s.got}
                    {s.status === "FAIL" && <span className="text-red-600 dark:text-red-400"> · {t("wms_audit_expected_label")} {s.expected}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="text-xs text-muted-foreground flex items-center gap-2">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
            {t("wms_audit_sim_cleanup", { items: Object.entries(data.cleanup).map(([k, v]) => `${v} ${k}`).join(", ") })}
          </div>
        </>
      )}
    </div>
  );
};

// ─── Tab 2: Caja ─────────────────────────────────────────────────────────────
const BoxTab = () => {
  const { t } = useLang();
  const [boxId, setBoxId] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const run = async (e) => {
    e?.preventDefault();
    if (!boxId.trim()) return;
    setLoading(true); setData(null);
    try {
      setData(await fetcher(`/audit/box/${encodeURIComponent(boxId.trim())}`));
    } catch { toast.error(t("wms_audit_box_not_found")); }
    finally { setLoading(false); }
  };

  const b = data?.box;
  return (
    <div className="space-y-4">
      <form onSubmit={run} className="flex gap-2 max-w-md">
        <input value={boxId} onChange={e => setBoxId(e.target.value)} placeholder={t("wms_audit_box_placeholder")}
          className="flex-1 px-3 py-2.5 bg-card border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring font-mono" autoFocus />
        <button disabled={loading} className="px-4 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-colors disabled:opacity-50 inline-flex items-center justify-center">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
        </button>
      </form>
      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card title="Status" value={b ? b.status : t("wms_audit_absent")} tone={b ? "default" : "bad"}
              sub={!b && data.receiving ? t("wms_audit_in_receipt_not_boxes") : ""} />
            <Card title={t("location")} value={b?.location || "-"} />
            <Card title={t("wms_label_units")} value={b?.units ?? "-"} sub={b ? `${b.sku || b.style || ""} ${b.size || ""}` : ""} />
            <Card title={t("wms_audit_tab_movements")} value={data.movement_count} tone={data.movement_count === 0 ? "bad" : "default"}
              sub={data.movement_count === 0 ? t("wms_audit_no_trace_sweeps") : ""} />
          </div>
          <div className="grid md:grid-cols-2 gap-3 text-xs">
            {data.receiving && (
              <div className="p-3 border border-border rounded-lg space-y-1">
                <div className="text-xs font-medium text-muted-foreground">{t("wms_audit_receipt")}</div>
                <div className="font-mono">{data.receiving.receiving_id}</div>
                <div>{fmtDate(data.receiving.created_at)} — {data.receiving.received_by_name || "?"} → <b>{data.receiving.inv_location}</b></div>
                <div>{data.receiving.style} {data.receiving.color} {data.receiving.size} · {t("wms_audit_receipt_total_units", { n: data.receiving.total_units })}</div>
              </div>
            )}
            {data.pick_ticket && (
              <div className="p-3 border border-border rounded-lg space-y-1">
                <div className="text-xs font-medium text-muted-foreground">{t("wms_audit_last_pick")}</div>
                <div className="font-mono">{data.pick_ticket.ticket_id}</div>
                <div>{t("order")} {data.pick_ticket.order_number} · {data.pick_ticket.status}</div>
                <div>{data.pick_ticket.assigned_to_name || ""} {data.pick_ticket.completed_at ? `· ${fmtDate(data.pick_ticket.completed_at)}` : ""}</div>
              </div>
            )}
          </div>
          <div className="border border-border rounded-lg overflow-hidden">
            <div className="px-3 py-2 bg-muted/50 border-b border-border text-xs font-semibold text-muted-foreground">{t("wms_audit_timeline", { n: data.movement_count })}</div>
            <div className="max-h-96 overflow-y-auto divide-y divide-border/60">
              {data.movements.map((m, i) => (
                <div key={i} className="px-3 py-2 text-xs flex items-start gap-3">
                  <span className="text-muted-foreground whitespace-nowrap font-mono">{fmtDate(m.created_at)}</span>
                  <span className="font-medium whitespace-nowrap">{m.type}</span>
                  <span className="text-muted-foreground">{m.user_name}</span>
                  <span className="truncate text-muted-foreground">{JSON.stringify(m.details || {}).slice(0, 160)}</span>
                </div>
              ))}
              {data.movement_count === 0 && <div className="p-3 text-xs text-muted-foreground">{t("wms_audit_no_movements_box")}</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

// ─── Tab 3: SKU ──────────────────────────────────────────────────────────────
const SKU_FIELDS = [
  ["style", "wms_audit_ph_style"], ["color", "wms_audit_ph_color"], ["size", "wms_audit_ph_size"],
];

const SkuTab = () => {
  const { t } = useLang();
  const [form, setForm] = useState({ style: "", color: "", size: "" });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const run = async (e) => {
    e?.preventDefault();
    if (!form.style.trim()) { toast.error(t("wms_style_req")); return; }
    setLoading(true); setData(null);
    try {
      const p = new URLSearchParams({ style: form.style.trim(), color: form.color.trim(), size: form.size.trim() });
      setData(await fetcher(`/audit/sku?${p}`));
    } catch { toast.error(t("wms_audit_sku_err")); }
    finally { setLoading(false); }
  };

  const bal = data?.balance;
  const cd = data?.cajas_desglose;
  const ok = bal && Math.abs(bal.diferencia) <= 5;

  // Export a Excel: hoja "Cajas" (los números de caja recibidos) + hoja
  // "Resumen" (balance, desglose de cajas y diagnóstico). Cliente-side con
  // SheetJS, mismo patrón que Analytics/Art.
  const exportExcel = () => {
    if (!data) return;
    const wb = XLSX.utils.book_new();

    const cajas = (data.cajas_lista || []).map((b) => ({
      "Caja": b.box_id || b.barcode || "",
      "Talla": b.size || "",
      "Estatus": b.status || "",
      "Consumida": b.consumida ? "SI" : "NO",
      "Unidades": b.units ?? 0,
      "Ubicación": b.location || "",
      "Recibida": b.created_at || "",
      "Recibo": b.receiving_id || "",
    }));
    const wsCajas = XLSX.utils.json_to_sheet(cajas.length ? cajas : [{ "Caja": "(sin cajas)" }]);
    XLSX.utils.book_append_sheet(wb, wsCajas, "Cajas");

    const b = data.balance || {}, c = data.cajas_desglose || {}, dg = data.diagnostico || {};
    const resumen = [
      { Campo: "Style", Valor: data.style }, { Campo: "Color", Valor: data.color }, { Campo: "Talla", Valor: data.size },
      { Campo: "", Valor: "" },
      { Campo: "Recibido (u)", Valor: b.recibido }, { Campo: "Pickeado (u)", Valor: b.pickeado },
      { Campo: "Esperado R−P (u)", Valor: b.esperado }, { Campo: "En mano (u)", Valor: b.en_mano },
      { Campo: "Diferencia (u)", Valor: b.diferencia },
      { Campo: "", Valor: "" },
      { Campo: "Cajas recibidas", Valor: c.recibidas }, { Campo: "Cajas consumidas", Valor: c.consumidas },
      { Campo: "Cajas deberían quedar", Valor: c.deberian }, { Campo: "Cajas en existencia", Valor: c.vivas },
      { Campo: "Diferencia cajas", Valor: c.diferencia },
      { Campo: "", Valor: "" },
      { Campo: "Diagnóstico", Valor: dg.mensaje || "" },
      ...(dg.causas || []).map((x, i) => ({ Campo: `Causa ${i + 1}`, Valor: x })),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resumen), "Resumen");

    const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const tag = [data.style, data.color, data.size].filter(Boolean).join("_").replace(/[^\w-]+/g, "");
    saveAs(new Blob([buf], { type: "application/octet-stream" }),
      `Balance_SKU_${tag || "export"}_${new Date().toISOString().split("T")[0]}.xlsx`);
    toast.success(t("wms_excel_exported"));
  };
  return (
    <div className="space-y-4">
      <form onSubmit={run} className="flex flex-wrap gap-2 max-w-2xl">
        {SKU_FIELDS.map(([f, phKey]) => (
          <input key={f} value={form[f]} onChange={e => setForm({ ...form, [f]: e.target.value })}
            placeholder={t(phKey)}
            className="flex-1 min-w-[130px] px-3 py-2.5 bg-card border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring" />
        ))}
        <button disabled={loading} className="px-5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-colors disabled:opacity-50">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : t("wms_audit_audit_btn")}
        </button>
      </form>
      {data && (
        <>
          <div className="flex justify-end">
            <Btn onClick={exportExcel} disabled={loading}>
              <Download className="w-4 h-4" /> {t("export_excel")}
            </Btn>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Card title={t("wms_received")} value={bal.recibido.toLocaleString()} sub={t("wms_audit_receipts_count", { n: data.recibos.length })} />
            <Card title={t("wms_picked")} value={bal.pickeado.toLocaleString()} sub={t("wms_audit_tickets_count", { n: data.tickets.length })} />
            <Card title={t("wms_audit_expected_rp")} value={bal.esperado.toLocaleString()} />
            <Card title={t("wms_audit_on_hand_system")} value={bal.en_mano.toLocaleString()} />
            <Card title={t("wms_difference")} value={`${bal.diferencia > 0 ? "+" : ""}${bal.diferencia.toLocaleString()}`}
              tone={ok ? "good" : "bad"} sub={ok ? t("wms_audit_balances") : t("wms_audit_review_phantom")} />
          </div>
          {data.diagnostico && (
            <div className={`rounded-lg border p-4 ${data.diagnostico.cuadra
              ? "border-emerald-200 bg-emerald-50 dark:border-emerald-500/25 dark:bg-emerald-500/10"
              : "border-amber-200 bg-amber-50 dark:border-amber-500/25 dark:bg-amber-500/10"}`}>
              <div className="flex items-start gap-2">
                {data.diagnostico.cuadra
                  ? <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                  : <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />}
                <div className="min-w-0 space-y-1">
                  <div className="text-sm font-semibold text-foreground">{t("wms_audit_diagnosis_label")} {data.diagnostico.mensaje}</div>
                  {data.diagnostico.causas?.length > 0 && (
                    <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-0.5">
                      {data.diagnostico.causas.map((c, i) => <li key={i}>{c}</li>)}
                    </ul>
                  )}
                  <div className="flex flex-wrap gap-2 pt-1 text-[11px]">
                    <Chip>{t("wms_audit_manual_adjustments")} {data.diagnostico.ajustes_manuales_neto > 0 ? "+" : ""}{(data.diagnostico.ajustes_manuales_neto || 0).toLocaleString()} u</Chip>
                    <Chip>{t("wms_audit_boxes_no_receipt")} {data.diagnostico.cajas_sin_recibo || 0}</Chip>
                    {!data.diagnostico.cuadra && (
                      <Chip>{t("wms_audit_unexplained")} {data.diagnostico.residual_sin_explicar > 0 ? "+" : ""}{(data.diagnostico.residual_sin_explicar || 0).toLocaleString()} u</Chip>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
          {cd && (
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-muted/50 border-b border-border text-xs font-semibold text-muted-foreground flex items-center gap-2">
                <Layers className="w-4 h-4" /> {t("wms_audit_box_breakdown")}
              </div>
              <div className="p-4 flex flex-wrap items-center gap-2 md:gap-3">
                <BoxStat label={t("wms_audit_bs_received")} value={cd.recibidas.toLocaleString()} />
                <span className="text-muted-foreground font-semibold">−</span>
                <BoxStat label={t("wms_audit_bs_consumed")} value={cd.consumidas.toLocaleString()} sub={t("wms_audit_bs_consumed_sub")} />
                <span className="text-muted-foreground font-semibold">=</span>
                <BoxStat label={t("wms_audit_bs_should_remain")} value={cd.deberian.toLocaleString()} tone="accent" />
                <span className="text-muted-foreground mx-1">·</span>
                <BoxStat label={t("wms_audit_bs_in_stock")} value={cd.vivas.toLocaleString()} />
                <BoxStat label={t("wms_difference")} value={`${cd.diferencia > 0 ? "+" : ""}${cd.diferencia.toLocaleString()}`}
                  tone={cd.diferencia === 0 ? "good" : "bad"} />
              </div>
              {cd.diferencia !== 0 && (
                <div className="px-4 pb-3 -mt-1 text-xs text-red-600 dark:text-red-400">
                  {cd.diferencia < 0
                    ? t("wms_audit_limbo_boxes", { n: Math.abs(cd.diferencia) })
                    : t("wms_audit_extra_boxes", { n: cd.diferencia })}
                </div>
              )}
            </div>
          )}
          {Array.isArray(data.cajas_lista) && data.cajas_lista.length > 0 && (
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-muted/50 border-b border-border text-xs font-semibold text-muted-foreground flex items-center gap-2">
                <PackageSearch className="w-4 h-4" /> {t("wms_audit_received_box_numbers", { n: data.cajas_lista.length })}
              </div>
              <div className="overflow-x-auto max-h-80 overflow-y-auto">
                <table className="w-full">
                  <thead className={tableCls.thead}><tr>
                    <Th>{t("wms_box")}</Th><Th>{t("wms_label_size")}</Th><Th>{t("status")}</Th><Th right>{t("wms_label_units")}</Th><Th>{t("location")}</Th><Th>{t("wms_audit_received_at")}</Th>
                  </tr></thead>
                  <tbody>
                    {data.cajas_lista.map((b, i) => (
                      <tr key={i} className="border-t border-border/60 hover:bg-muted/40 transition-colors">
                        <Td mono>{b.box_id || b.barcode || "-"}</Td>
                        <Td>{b.size || "-"}</Td>
                        <Td>
                          <span className={b.consumida ? "text-muted-foreground" : "text-emerald-600 dark:text-emerald-400 font-medium"}>
                            {b.status || "-"}{b.consumida ? ` · ${t("wms_audit_consumed_lc")}` : ""}
                          </span>
                        </Td>
                        <Td right>{(b.units ?? 0).toLocaleString()}</Td>
                        <Td mono>{b.location || "-"}</Td>
                        <Td>{fmtDate(b.created_at)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <div className="grid md:grid-cols-2 gap-3">
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-muted/50 border-b border-border text-xs font-semibold text-muted-foreground">{t("wms_audit_inventory_by_location")}</div>
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full">
                  <thead><tr><Th>{t("location")}</Th><Th>{t("wms_label_size")}</Th><Th right>{t("wms_audit_on_hand")}</Th><Th right>{t("wms_boxes")}</Th></tr></thead>
                  <tbody>{data.inventario.map((r, i) => (
                    <tr key={i} className="border-t border-border/60 hover:bg-muted/40 transition-colors">
                      <Td mono>{r.location}</Td><Td>{r.size}</Td>
                      <Td right>{(r.units_on_hand || 0).toLocaleString()}</Td><Td right>{r.total_boxes || 0}</Td>
                    </tr>))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="space-y-3">
              <div className="border border-border rounded-lg p-3">
                <div className="text-xs font-medium text-muted-foreground mb-2">{t("wms_audit_boxes_by_status")}</div>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(data.cajas_por_status).map(([st, v]) => (
                    <Chip key={st}>
                      <b>{st}</b>: {t("wms_boxes_count", { n: v.cajas })} / {(v.unidades || 0).toLocaleString()} u
                    </Chip>
                  ))}
                </div>
              </div>
              <div className="border border-border rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-muted/50 border-b border-border text-xs font-semibold text-muted-foreground">{t("wms_audit_tickets_that_picked")}</div>
                <div className="max-h-40 overflow-y-auto">
                  <table className="w-full">
                    <thead><tr><Th>{t("order")}</Th><Th>Status</Th><Th right>{t("wms_picked")}</Th><Th>{t("date")}</Th></tr></thead>
                    <tbody>{data.tickets.map((tk, i) => (
                      <tr key={i} className="border-t border-border/60 hover:bg-muted/40 transition-colors">
                        <Td>{tk.order}</Td><Td>{tk.status}</Td><Td right>{tk.picked.toLocaleString()}</Td><Td>{fmtDate(tk.created_at)}</Td>
                      </tr>))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

// ─── Tab 4: Movimientos ──────────────────────────────────────────────────────
const MovementsTab = () => {
  const { t } = useLang();
  const [filters, setFilters] = useState({ q: "", movement_type: "", user: "", since: "", until: "" });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const run = async (e) => {
    e?.preventDefault();
    setLoading(true);
    try {
      const p = new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([, v]) => v)));
      setData(await fetcher(`/audit/movements?${p}`));
    } catch { toast.error(t("wms_audit_movements_err")); }
    finally { setLoading(false); }
  };

  const exportExcel = () => {
    if (!data) return;
    const rows = (data.movements || []).map(m => ({
      "Fecha": m.created_at || "",
      "Tipo": m.type || "",
      "Usuario": m.user_name || "",
      "Detalles": JSON.stringify(m.details || {}),
    }));
    downloadXlsx([{ name: "Movimientos", rows }], `Movimientos_${today()}.xlsx`);
    toast.success(t("wms_excel_exported"));
  };

  return (
    <div className="space-y-4">
      <form onSubmit={run} className="flex flex-wrap gap-2 items-end">
        <input value={filters.q} onChange={e => setFilters({ ...filters, q: e.target.value })}
          placeholder={t("wms_audit_mv_placeholder")}
          className="flex-1 min-w-[220px] px-3 py-2.5 bg-card border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring" />
        <input value={filters.movement_type} onChange={e => setFilters({ ...filters, movement_type: e.target.value })}
          placeholder={t("wms_audit_mv_type_placeholder")} className="w-48 px-3 py-2.5 bg-card border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring" />
        <input value={filters.user} onChange={e => setFilters({ ...filters, user: e.target.value })}
          placeholder={t("user")} className="w-36 px-3 py-2.5 bg-card border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring" />
        <input type="date" value={filters.since} onChange={e => setFilters({ ...filters, since: e.target.value })}
          className="px-3 py-2.5 bg-card border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring" />
        <input type="date" value={filters.until} onChange={e => setFilters({ ...filters, until: e.target.value })}
          className="px-3 py-2.5 bg-card border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring" />
        <button disabled={loading} className="px-5 py-2.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-colors disabled:opacity-50">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : t("search")}
        </button>
      </form>
      {data && (
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="px-3 py-2 bg-muted/50 border-b border-border text-xs font-semibold text-muted-foreground flex items-center justify-between gap-2">
            <span>{t("wms_audit_mv_count", { count: data.count, total: data.total.toLocaleString() })}</span>
            {data.movements?.length > 0 && (
              <Btn onClick={exportExcel}><Download className="w-3.5 h-3.5" /> {t("export_excel")}</Btn>
            )}
          </div>
          <div className="max-h-[32rem] overflow-y-auto divide-y divide-border/60">
            {data.movements.map((m, i) => (
              <div key={i} className="px-3 py-2 text-xs flex items-start gap-3">
                <span className="text-muted-foreground whitespace-nowrap font-mono">{fmtDate(m.created_at)}</span>
                <span className="font-medium whitespace-nowrap">{m.type}</span>
                <span className="text-muted-foreground whitespace-nowrap">{m.user_name}</span>
                <span className="truncate text-muted-foreground">{JSON.stringify(m.details || {}).slice(0, 180)}</span>
              </div>
            ))}
            {data.count === 0 && <div className="p-3 text-xs text-muted-foreground">{t("wms_audit_no_results_filters")}</div>}
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Tab: Renglones fantasma ─────────────────────────────────────────────────
// Filas del libro (wms_inventory) que mantienen algún contador vivo pero sin
// NINGUNA caja viva que las respalde. Son las que hacen que el export de
// inventario muestre SKUs en ubicaciones donde "Cajas - LPNs" no tiene nada
// (típico de la carga inicial por Excel). La limpieza es por conteo cíclico de
// la ubicación o por Conciliación; aquí se cazan todas de una vez.
const FantasmasTab = () => {
  const { t } = useLang();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    try {
      setData(await fetcher("/audit/fantasmas"));
    } catch { toast.error(t("wms_audit_phantom_err")); }
    finally { setLoading(false); }
  };

  const exportExcel = () => {
    if (!data) return;
    const rows = (data.fantasmas || []).map(f => ({
      "Ubicación": f.location, "Customer": f.customer, "Style": f.style,
      "SKU": f.sku, "UPC": f.upc, "Color": f.color, "Talla": f.size,
      "En mano": f.units_on_hand, "Apartadas": f.units_allocated,
      "Contador de cajas": f.total_boxes,
      "Creado": f.created_at, "Actualizado": f.updated_at,
      "Inventory ID": f.inventory_id,
    }));
    downloadXlsx([{ name: "Renglones fantasma", rows }], `Renglones_Fantasma_${today()}.xlsx`);
    toast.success(t("wms_excel_exported"));
  };

  const top = (data?.fantasmas || []).slice(0, 200);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Btn variant="primary" onClick={run} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          {t("wms_audit_find_phantom_rows")}
        </Btn>
        {data && <Btn onClick={exportExcel}><Download className="w-4 h-4" /> {t("wms_audit_export_excel_n", { n: data.renglones })}</Btn>}
        {data && <span className="text-xs text-muted-foreground">{t("wms_audit_generated_at", { date: fmtDate(data.generated_at) })}</span>}
      </div>
      {!data && !loading && (
        <p className="text-sm text-muted-foreground">{t("wms_audit_phantom_intro")}</p>
      )}
      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Card title={t("wms_audit_tab_phantom_rows")} value={data.renglones.toLocaleString()}
              tone={data.renglones > 0 ? "bad" : "good"} />
            <Card title={t("wms_audit_phantom_units")} value={data.unidades.toLocaleString()}
              tone={data.unidades > 0 ? "bad" : "good"} sub={t("wms_audit_phantom_units_sub")} />
          </div>
          {data.renglones > 0 && (
            <div className="border border-border rounded-lg overflow-x-auto">
              <table className={tableCls}>
                <thead>
                  <tr>
                    <Th>{t("location")}</Th><Th>{t("wms_label_customer")}</Th><Th>Style</Th><Th>SKU</Th>
                    <Th>Color</Th><Th>{t("wms_label_size")}</Th><Th right>{t("wms_audit_on_hand")}</Th>
                    <Th right>{t("wms_audit_allocated_h")}</Th><Th right>{t("wms_audit_box_counter")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {top.map((f, i) => (
                    <tr key={f.inventory_id || i} className="border-t border-border/60">
                      <Td mono>{f.location || "—"}</Td>
                      <Td>{f.customer || "—"}</Td>
                      <Td>{f.style || "—"}</Td>
                      <Td mono>{f.sku || "—"}</Td>
                      <Td>{f.color || "—"}</Td>
                      <Td>{f.size || "—"}</Td>
                      <Td right>{f.units_on_hand}</Td>
                      <Td right>{f.units_allocated}</Td>
                      <Td right>{f.total_boxes}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.renglones > top.length && (
                <div className="p-2 text-[11px] text-muted-foreground border-t border-border/60">
                  {t("wms_audit_showing_all_excel", { shown: top.length, total: data.renglones })}
                </div>
              )}
            </div>
          )}
          {data.renglones === 0 && (
            <p className="text-sm text-emerald-600 dark:text-emerald-400 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" /> {t("wms_audit_ledger_clean")}
            </p>
          )}
        </>
      )}
    </div>
  );
};

// ─── Tab: SKU vs catálogo UPC ────────────────────────────────────────────────
// Cajas vivas con UPC cuyo estilo/color/talla/SKU difiere de lo que el
// catálogo dice para ese código (entraron ANTES del candado del recibo, que
// hoy rechaza esa divergencia). Vista previa siempre; aplicar reescribe las
// cajas con la identidad del catálogo y reproyecta el libro (solo supersu).
const SkuCatalogoTab = () => {
  const { t } = useLang();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [aplicando, setAplicando] = useState(false);

  const run = async () => {
    setLoading(true);
    try {
      setData(await fetcher("/audit/sku-catalogo"));
    } catch { toast.error(t("wms_audit_skucat_err")); }
    finally { setLoading(false); }
  };

  const aplicar = async () => {
    if (!data?.cajas) return;
    if (!window.confirm(t("wms_audit_skucat_confirm", { n: data.cajas }))) return;
    setAplicando(true);
    try {
      const res = await poster("/audit/sku-catalogo/aplicar", {});
      const r = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(r.detail || t("wms_audit_skucat_apply_err")); return; }
      toast.success(t("wms_audit_skucat_applied", { boxes: r.cajas, cells: r.celdas_reproyectadas }));
      run();
    } catch { toast.error(t("wms_server_unreachable")); }
    finally { setAplicando(false); }
  };

  const fmtCambios = (c) => Object.entries(c || {})
    .map(([k, v]) => `${k}: ${v.de || "—"} → ${v.a}`).join(" · ");

  const exportExcel = () => {
    if (!data) return;
    const rows = (data.detalle || []).map(d => ({
      "Caja": d.box_id, "Ubicación": d.location, "Customer": d.customer,
      "UPC": d.upc, "Piezas": d.units, "Cambios": fmtCambios(d.cambios),
    }));
    downloadXlsx([{ name: "SKU vs catalogo", rows }], `SKU_vs_Catalogo_${today()}.xlsx`);
    toast.success(t("wms_excel_exported"));
  };

  const top = (data?.detalle || []).slice(0, 200);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Btn variant="primary" onClick={run} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          {t("wms_audit_preview")}
        </Btn>
        {data?.cajas > 0 && (
          <Btn onClick={aplicar} disabled={aplicando} className="!bg-red-600 !text-white hover:!bg-red-700">
            {aplicando ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            {t("wms_audit_apply_to_boxes", { n: data.cajas })}
          </Btn>
        )}
        {data && <Btn onClick={exportExcel}><Download className="w-4 h-4" /> {t("export_excel")}</Btn>}
        {data && <span className="text-xs text-muted-foreground">{t("wms_audit_generated_at", { date: fmtDate(data.generated_at) })}</span>}
      </div>
      {!data && !loading && (
        <p className="text-sm text-muted-foreground">{t("wms_audit_skucat_intro")}</p>
      )}
      {data && (
        <>
          <Card title={t("wms_audit_skucat_divergent")} value={data.cajas.toLocaleString()}
            tone={data.cajas > 0 ? "bad" : "good"} />
          {data.cajas > 0 && (
            <div className="border border-border rounded-lg overflow-x-auto">
              <table className={tableCls}>
                <thead>
                  <tr>
                    <Th>{t("wms_box")}</Th><Th>{t("location")}</Th><Th>{t("wms_label_customer")}</Th><Th>UPC</Th>
                    <Th right>{t("wms_label_pieces")}</Th><Th>{t("wms_audit_changes_from_to")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {top.map((d) => (
                    <tr key={d.box_id} className="border-t border-border/60">
                      <Td mono>{d.box_id}</Td>
                      <Td mono>{d.location || "—"}</Td>
                      <Td>{d.customer || "—"}</Td>
                      <Td mono>{d.upc}</Td>
                      <Td right>{d.units}</Td>
                      <Td>{fmtCambios(d.cambios)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.cajas > top.length && (
                <div className="p-2 text-[11px] text-muted-foreground border-t border-border/60">
                  {t("wms_audit_showing_all_excel", { shown: top.length, total: data.cajas })}
                </div>
              )}
            </div>
          )}
          {data.cajas === 0 && (
            <p className="text-sm text-emerald-600 dark:text-emerald-400 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" /> {t("wms_audit_skucat_all_match")}
            </p>
          )}
        </>
      )}
    </div>
  );
};

// ─── Módulo ──────────────────────────────────────────────────────────────────
export const AuditModule = () => {
  const { t } = useLang();
  const [tab, setTab] = useState("health");
  return (
    <div className="space-y-5">
      <div className="flex gap-1 border-b border-border overflow-x-auto">
        {TABS.map(tb => {
          const Icon = tb.icon;
          return (
            <button key={tb.id} onClick={() => setTab(tb.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors
                ${tab === tb.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
              <Icon className="w-4 h-4" /> {t(tb.labelKey)}
            </button>
          );
        })}
      </div>
      {tab === "health" && <HealthTab />}
      {tab === "fantasmas" && <FantasmasTab />}
      {tab === "skucat" && <SkuCatalogoTab />}
      {tab === "selftest" && <SelfTestTab />}
      {tab === "box" && <BoxTab />}
      {tab === "sku" && <SkuTab />}
      {tab === "movements" && <MovementsTab />}
    </div>
  );
};
