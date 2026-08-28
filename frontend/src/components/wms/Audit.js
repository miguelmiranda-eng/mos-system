import { useState } from "react";
import {
  Activity, PackageSearch, Layers, History, Search, Loader2,
  AlertTriangle, CheckCircle2, RefreshCw, FlaskConical, XCircle, Download, Ghost,
} from "lucide-react";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { saveAs } from "file-saver";
import { fetcher, poster } from "./lib";
import { Btn, Th, Chip, tableCls } from "./ui";

// Módulo de Auditoría — admin nivel 5 y supersu (el backend valida con
// require_admin_level(5) y rechaza al resto con 403). Cuatro vistas: salud del
// sistema, trazabilidad por caja, balance por SKU y búsqueda de movimientos.

const TABS = [
  { id: "health", label: "Salud del sistema", icon: Activity },
  { id: "fantasmas", label: "Renglones fantasma", icon: Ghost },
  { id: "selftest", label: "Simulación", icon: FlaskConical },
  { id: "box", label: "Rastrear caja", icon: PackageSearch },
  { id: "sku", label: "Balance por SKU", icon: Layers },
  { id: "movements", label: "Movimientos", icon: History },
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
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    try {
      setData(await fetcher("/audit/health"));
    } catch { toast.error("Error al ejecutar el chequeo (¿rol super admin?)"); }
    finally { setLoading(false); }
  };

  const exportExcel = () => {
    if (!data) return;
    const t = data.totales || {};
    const resumen = [
      { Métrica: "Unidades (inventario)", Valor: t.inventario_unidades, Extra: `${t.inventario_filas} filas` },
      { Métrica: "Unidades (cajas vivas)", Valor: t.cajas_unidades, Extra: `${t.cajas_vivas} cajas` },
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
    toast.success("Excel exportado");
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Btn variant="primary" onClick={run} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Ejecutar chequeo completo
        </Btn>
        {data && <Btn onClick={exportExcel}><Download className="w-4 h-4" /> Exportar Excel</Btn>}
        {data && <span className="text-xs text-muted-foreground">Generado: {fmtDate(data.generated_at)}</span>}
      </div>
      {!data && !loading && (
        <p className="text-sm text-muted-foreground">Compara inventario contra cajas celda por celda, detecta picks sin descontar, negativos y cajas estancadas. Tarda unos segundos.</p>
      )}
      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card title="Unidades (inventario)" value={data.totales.inventario_unidades.toLocaleString()} sub={`${data.totales.inventario_filas.toLocaleString()} filas`} />
            <Card title="Unidades (cajas vivas)" value={data.totales.cajas_unidades.toLocaleString()} sub={`${data.totales.cajas_vivas.toLocaleString()} cajas`} />
            <Card title="Drift inventario↔cajas" value={`${data.drift.celdas.toLocaleString()} celdas`}
              tone={data.drift.celdas > 0 ? "bad" : "good"} sub={`${data.drift.unidades_abs.toLocaleString()} unidades de diferencia`} />
            <Card title="Picks sin descontar" value={data.sin_descontar.tickets} tone={data.sin_descontar.tickets > 0 ? "bad" : "good"} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Card title="Asignado > en mano" value={data.negativos_allocated} tone={data.negativos_allocated > 0 ? "bad" : "good"} />
            <Card title="Filas en 0 con cajas" value={data.ceros_con_cajas} tone={data.ceros_con_cajas > 0 ? "bad" : "good"} />
            <Card title="Cajas pendientes +14 días" value={data.cajas_pendientes_14d} tone={data.cajas_pendientes_14d > 0 ? "bad" : "good"} />
          </div>

          {data.drift.top.length > 0 && (
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-muted/50 border-b border-border text-xs font-semibold text-muted-foreground flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400" /> Peores celdas con drift (top {data.drift.top.length})
              </div>
              <div className="overflow-x-auto max-h-80 overflow-y-auto">
                <table className="w-full">
                  <thead className={tableCls.thead}><tr>
                    <Th>Ubicación</Th><Th>Style</Th><Th>Color</Th><Th>Talla</Th>
                    <Th right>Inventario</Th><Th right>Cajas</Th><Th right>Diferencia</Th>
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
                <AlertTriangle className="w-4 h-4" /> Tickets con picks sin descontar
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead><tr><Th>Ticket</Th><Th>Orden</Th><Th>Style</Th><Th>Color</Th><Th>Status</Th><Th right>Pickeado</Th><Th>Creado</Th></tr></thead>
                  <tbody>
                    {data.sin_descontar.top.map((t, i) => (
                      <tr key={i} className="border-t border-border/60 hover:bg-muted/40 transition-colors">
                        <Td mono>{t.ticket_id}</Td><Td>{t.order}</Td><Td>{t.style}</Td><Td>{t.color}</Td>
                        <Td>{t.status}</Td><Td right>{t.picked.toLocaleString()}</Td><Td>{fmtDate(t.created_at)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {data.drift.celdas === 0 && data.sin_descontar.tickets === 0 && (
            <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 text-sm font-medium">
              <CheckCircle2 className="w-5 h-5" /> Sistema consistente: sin drift ni picks pendientes de descuento.
            </div>
          )}
        </>
      )}
    </div>
  );
};

// ─── Tab: Simulación (self-test) ─────────────────────────────────────────────
const SelfTestTab = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [params, setParams] = useState({ boxes: 3, units_per_box: 10, pick_units: 20 });

  const run = async () => {
    setLoading(true); setData(null);
    try {
      const res = await poster("/audit/self-test", params);
      if (res.ok) setData(await res.json());
      else { const e = await res.json().catch(() => ({})); toast.error(e.detail || "Error en la simulación"); }
    } catch { toast.error("Error de conexión"); }
    finally { setLoading(false); }
  };

  return (
    <div className="space-y-4">
      <div className="p-4 rounded-lg border border-border bg-card text-sm text-muted-foreground">
        Ejecuta el ciclo completo — <b className="text-foreground">Recibo → Putaway → Pick Ticket → Surtido</b> — usando
        las mismas funciones internas del sistema real, con material de prueba marcado. Verifica el inventario en cada
        paso y <b className="text-foreground">borra todo automáticamente</b> al terminar. No toca inventario real.
      </div>
      <div className="flex flex-wrap items-end gap-3">
        {[["boxes", "Cajas"], ["units_per_box", "Unidades/caja"], ["pick_units", "Unidades a surtir"]].map(([k, lbl]) => (
          <div key={k}>
            <div className="text-xs font-medium text-muted-foreground mb-1">{lbl}</div>
            <input type="number" min="1" value={params[k]}
              onChange={e => setParams({ ...params, [k]: parseInt(e.target.value) || 1 })}
              className="w-28 px-3 py-2 bg-card border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring" />
          </div>
        ))}
        <Btn variant="primary" onClick={run} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FlaskConical className="w-4 h-4" />}
          Ejecutar simulación
        </Btn>
      </div>

      {data && (
        <>
          <div className={`flex items-center gap-2 text-lg font-semibold ${data.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
            {data.ok ? <CheckCircle2 className="w-6 h-6" /> : <XCircle className="w-6 h-6" />}
            {data.ok ? `Todos los módulos funcionan (${data.passed}/${data.total})` : `Falló (${data.passed}/${data.total})`}
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
                    <span className="text-muted-foreground">obtenido:</span> {s.got}
                    {s.status === "FAIL" && <span className="text-red-600 dark:text-red-400"> · esperado: {s.expected}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="text-xs text-muted-foreground flex items-center gap-2">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
            Limpieza automática: {Object.entries(data.cleanup).map(([k, v]) => `${v} ${k}`).join(", ")} eliminados. Sin residuo.
          </div>
        </>
      )}
    </div>
  );
};

// ─── Tab 2: Caja ─────────────────────────────────────────────────────────────
const BoxTab = () => {
  const [boxId, setBoxId] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const run = async (e) => {
    e?.preventDefault();
    if (!boxId.trim()) return;
    setLoading(true); setData(null);
    try {
      setData(await fetcher(`/audit/box/${encodeURIComponent(boxId.trim())}`));
    } catch { toast.error("Sin rastro de esa caja (cajas, recibos y movimientos)"); }
    finally { setLoading(false); }
  };

  const b = data?.box;
  return (
    <div className="space-y-4">
      <form onSubmit={run} className="flex gap-2 max-w-md">
        <input value={boxId} onChange={e => setBoxId(e.target.value)} placeholder="BOX-012345 (escanea o teclea)"
          className="flex-1 px-3 py-2.5 bg-card border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring font-mono" autoFocus />
        <button disabled={loading} className="px-4 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-colors disabled:opacity-50 inline-flex items-center justify-center">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
        </button>
      </form>
      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card title="Status" value={b ? b.status : "AUSENTE"} tone={b ? "default" : "bad"}
              sub={!b && data.receiving ? "existe en el recibo pero no en cajas" : ""} />
            <Card title="Ubicación" value={b?.location || "-"} />
            <Card title="Unidades" value={b?.units ?? "-"} sub={b ? `${b.sku || b.style || ""} ${b.size || ""}` : ""} />
            <Card title="Movimientos" value={data.movement_count} tone={data.movement_count === 0 ? "bad" : "default"}
              sub={data.movement_count === 0 ? "sin rastro — cuidado en barridos" : ""} />
          </div>
          <div className="grid md:grid-cols-2 gap-3 text-xs">
            {data.receiving && (
              <div className="p-3 border border-border rounded-lg space-y-1">
                <div className="text-xs font-medium text-muted-foreground">Recibo</div>
                <div className="font-mono">{data.receiving.receiving_id}</div>
                <div>{fmtDate(data.receiving.created_at)} — {data.receiving.received_by_name || "?"} → <b>{data.receiving.inv_location}</b></div>
                <div>{data.receiving.style} {data.receiving.color} {data.receiving.size} · {data.receiving.total_units} u totales del recibo</div>
              </div>
            )}
            {data.pick_ticket && (
              <div className="p-3 border border-border rounded-lg space-y-1">
                <div className="text-xs font-medium text-muted-foreground">Último pick</div>
                <div className="font-mono">{data.pick_ticket.ticket_id}</div>
                <div>Orden {data.pick_ticket.order_number} · {data.pick_ticket.status}</div>
                <div>{data.pick_ticket.assigned_to_name || ""} {data.pick_ticket.completed_at ? `· ${fmtDate(data.pick_ticket.completed_at)}` : ""}</div>
              </div>
            )}
          </div>
          <div className="border border-border rounded-lg overflow-hidden">
            <div className="px-3 py-2 bg-muted/50 border-b border-border text-xs font-semibold text-muted-foreground">Línea de tiempo ({data.movement_count})</div>
            <div className="max-h-96 overflow-y-auto divide-y divide-border/60">
              {data.movements.map((m, i) => (
                <div key={i} className="px-3 py-2 text-xs flex items-start gap-3">
                  <span className="text-muted-foreground whitespace-nowrap font-mono">{fmtDate(m.created_at)}</span>
                  <span className="font-medium whitespace-nowrap">{m.type}</span>
                  <span className="text-muted-foreground">{m.user_name}</span>
                  <span className="truncate text-muted-foreground">{JSON.stringify(m.details || {}).slice(0, 160)}</span>
                </div>
              ))}
              {data.movement_count === 0 && <div className="p-3 text-xs text-muted-foreground">Sin movimientos registrados para esta caja.</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

// ─── Tab 3: SKU ──────────────────────────────────────────────────────────────
const SkuTab = () => {
  const [form, setForm] = useState({ style: "", color: "", size: "" });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const run = async (e) => {
    e?.preventDefault();
    if (!form.style.trim()) { toast.error("Style requerido"); return; }
    setLoading(true); setData(null);
    try {
      const p = new URLSearchParams({ style: form.style.trim(), color: form.color.trim(), size: form.size.trim() });
      setData(await fetcher(`/audit/sku?${p}`));
    } catch { toast.error("Error al consultar el SKU"); }
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
    toast.success("Excel exportado");
  };
  return (
    <div className="space-y-4">
      <form onSubmit={run} className="flex flex-wrap gap-2 max-w-2xl">
        {["style", "color", "size"].map(f => (
          <input key={f} value={form[f]} onChange={e => setForm({ ...form, [f]: e.target.value })}
            placeholder={f === "style" ? "Style (ej. 64000)" : f === "color" ? "Color (opcional)" : "Talla (opcional)"}
            className="flex-1 min-w-[130px] px-3 py-2.5 bg-card border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring" />
        ))}
        <button disabled={loading} className="px-5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-colors disabled:opacity-50">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Auditar"}
        </button>
      </form>
      {data && (
        <>
          <div className="flex justify-end">
            <Btn onClick={exportExcel} disabled={loading}>
              <Download className="w-4 h-4" /> Exportar Excel
            </Btn>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Card title="Recibido" value={bal.recibido.toLocaleString()} sub={`${data.recibos.length} recibos`} />
            <Card title="Pickeado" value={bal.pickeado.toLocaleString()} sub={`${data.tickets.length} tickets`} />
            <Card title="Esperado (R−P)" value={bal.esperado.toLocaleString()} />
            <Card title="En mano (sistema)" value={bal.en_mano.toLocaleString()} />
            <Card title="Diferencia" value={`${bal.diferencia > 0 ? "+" : ""}${bal.diferencia.toLocaleString()}`}
              tone={ok ? "good" : "bad"} sub={ok ? "cuadra" : "revisar: fantasma o entradas sin rastrear"} />
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
                  <div className="text-sm font-semibold text-foreground">Diagnóstico: {data.diagnostico.mensaje}</div>
                  {data.diagnostico.causas?.length > 0 && (
                    <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-0.5">
                      {data.diagnostico.causas.map((c, i) => <li key={i}>{c}</li>)}
                    </ul>
                  )}
                  <div className="flex flex-wrap gap-2 pt-1 text-[11px]">
                    <Chip>Ajustes manuales: {data.diagnostico.ajustes_manuales_neto > 0 ? "+" : ""}{(data.diagnostico.ajustes_manuales_neto || 0).toLocaleString()} u</Chip>
                    <Chip>Cajas sin recibo: {data.diagnostico.cajas_sin_recibo || 0}</Chip>
                    {!data.diagnostico.cuadra && (
                      <Chip>Sin explicar: {data.diagnostico.residual_sin_explicar > 0 ? "+" : ""}{(data.diagnostico.residual_sin_explicar || 0).toLocaleString()} u</Chip>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
          {cd && (
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-muted/50 border-b border-border text-xs font-semibold text-muted-foreground flex items-center gap-2">
                <Layers className="w-4 h-4" /> Desglose de cajas — recibidas, consumidas y las que deberían quedar
              </div>
              <div className="p-4 flex flex-wrap items-center gap-2 md:gap-3">
                <BoxStat label="Recibidas" value={cd.recibidas.toLocaleString()} />
                <span className="text-muted-foreground font-semibold">−</span>
                <BoxStat label="Consumidas" value={cd.consumidas.toLocaleString()} sub="depleted / embarcadas" />
                <span className="text-muted-foreground font-semibold">=</span>
                <BoxStat label="Deberían quedar" value={cd.deberian.toLocaleString()} tone="accent" />
                <span className="text-muted-foreground mx-1">·</span>
                <BoxStat label="En existencia" value={cd.vivas.toLocaleString()} />
                <BoxStat label="Diferencia" value={`${cd.diferencia > 0 ? "+" : ""}${cd.diferencia.toLocaleString()}`}
                  tone={cd.diferencia === 0 ? "good" : "bad"} />
              </div>
              {cd.diferencia !== 0 && (
                <div className="px-4 pb-3 -mt-1 text-xs text-red-600 dark:text-red-400">
                  {cd.diferencia < 0
                    ? `${Math.abs(cd.diferencia)} caja(s) en limbo: estatus vivo pero 0 unidades — nadie las marcó como consumidas.`
                    : `${cd.diferencia} caja(s) de más sobre lo esperado: revisar entradas sin rastrear.`}
                </div>
              )}
            </div>
          )}
          {Array.isArray(data.cajas_lista) && data.cajas_lista.length > 0 && (
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-muted/50 border-b border-border text-xs font-semibold text-muted-foreground flex items-center gap-2">
                <PackageSearch className="w-4 h-4" /> Números de caja recibidos ({data.cajas_lista.length})
              </div>
              <div className="overflow-x-auto max-h-80 overflow-y-auto">
                <table className="w-full">
                  <thead className={tableCls.thead}><tr>
                    <Th>Caja</Th><Th>Talla</Th><Th>Estatus</Th><Th right>Unidades</Th><Th>Ubicación</Th><Th>Recibida</Th>
                  </tr></thead>
                  <tbody>
                    {data.cajas_lista.map((b, i) => (
                      <tr key={i} className="border-t border-border/60 hover:bg-muted/40 transition-colors">
                        <Td mono>{b.box_id || b.barcode || "-"}</Td>
                        <Td>{b.size || "-"}</Td>
                        <Td>
                          <span className={b.consumida ? "text-muted-foreground" : "text-emerald-600 dark:text-emerald-400 font-medium"}>
                            {b.status || "-"}{b.consumida ? " · consumida" : ""}
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
              <div className="px-3 py-2 bg-muted/50 border-b border-border text-xs font-semibold text-muted-foreground">Inventario por ubicación</div>
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full">
                  <thead><tr><Th>Ubicación</Th><Th>Talla</Th><Th right>En mano</Th><Th right>Cajas</Th></tr></thead>
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
                <div className="text-xs font-medium text-muted-foreground mb-2">Cajas por status</div>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(data.cajas_por_status).map(([st, v]) => (
                    <Chip key={st}>
                      <b>{st}</b>: {v.cajas} cajas / {(v.unidades || 0).toLocaleString()} u
                    </Chip>
                  ))}
                </div>
              </div>
              <div className="border border-border rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-muted/50 border-b border-border text-xs font-semibold text-muted-foreground">Tickets que lo surtieron</div>
                <div className="max-h-40 overflow-y-auto">
                  <table className="w-full">
                    <thead><tr><Th>Orden</Th><Th>Status</Th><Th right>Pickeado</Th><Th>Fecha</Th></tr></thead>
                    <tbody>{data.tickets.map((t, i) => (
                      <tr key={i} className="border-t border-border/60 hover:bg-muted/40 transition-colors">
                        <Td>{t.order}</Td><Td>{t.status}</Td><Td right>{t.picked.toLocaleString()}</Td><Td>{fmtDate(t.created_at)}</Td>
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
  const [filters, setFilters] = useState({ q: "", movement_type: "", user: "", since: "", until: "" });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const run = async (e) => {
    e?.preventDefault();
    setLoading(true);
    try {
      const p = new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([, v]) => v)));
      setData(await fetcher(`/audit/movements?${p}`));
    } catch { toast.error("Error al buscar movimientos"); }
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
    toast.success("Excel exportado");
  };

  return (
    <div className="space-y-4">
      <form onSubmit={run} className="flex flex-wrap gap-2 items-end">
        <input value={filters.q} onChange={e => setFilters({ ...filters, q: e.target.value })}
          placeholder="Caja / SKU / orden / ubicación / ticket…"
          className="flex-1 min-w-[220px] px-3 py-2.5 bg-card border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring" />
        <input value={filters.movement_type} onChange={e => setFilters({ ...filters, movement_type: e.target.value })}
          placeholder="Tipo (ej. pick_deduction)" className="w-48 px-3 py-2.5 bg-card border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring" />
        <input value={filters.user} onChange={e => setFilters({ ...filters, user: e.target.value })}
          placeholder="Usuario" className="w-36 px-3 py-2.5 bg-card border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring" />
        <input type="date" value={filters.since} onChange={e => setFilters({ ...filters, since: e.target.value })}
          className="px-3 py-2.5 bg-card border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring" />
        <input type="date" value={filters.until} onChange={e => setFilters({ ...filters, until: e.target.value })}
          className="px-3 py-2.5 bg-card border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring/25 focus:border-ring" />
        <button disabled={loading} className="px-5 py-2.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-colors disabled:opacity-50">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Buscar"}
        </button>
      </form>
      {data && (
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="px-3 py-2 bg-muted/50 border-b border-border text-xs font-semibold text-muted-foreground flex items-center justify-between gap-2">
            <span>{data.count} de {data.total.toLocaleString()} movimientos</span>
            {data.movements?.length > 0 && (
              <Btn onClick={exportExcel}><Download className="w-3.5 h-3.5" /> Exportar Excel</Btn>
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
            {data.count === 0 && <div className="p-3 text-xs text-muted-foreground">Sin resultados con esos filtros.</div>}
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
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    try {
      setData(await fetcher("/audit/fantasmas"));
    } catch { toast.error("Error al buscar renglones fantasma (¿rol super admin?)"); }
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
    toast.success("Excel exportado");
  };

  const top = (data?.fantasmas || []).slice(0, 200);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Btn variant="primary" onClick={run} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Buscar renglones fantasma
        </Btn>
        {data && <Btn onClick={exportExcel}><Download className="w-4 h-4" /> Exportar Excel ({data.renglones})</Btn>}
        {data && <span className="text-xs text-muted-foreground">Generado: {fmtDate(data.generated_at)}</span>}
      </div>
      {!data && !loading && (
        <p className="text-sm text-muted-foreground">
          Encuentra las filas del inventario que no tienen ninguna caja viva que las respalde
          (ni ligada al renglón ni parada en su misma ubicación con el mismo SKU). Son las que
          aparecen en el export de inventario pero no en "Cajas - LPNs". Se limpian con conteo
          cíclico de la ubicación o con Conciliación.
        </p>
      )}
      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Card title="Renglones fantasma" value={data.renglones.toLocaleString()}
              tone={data.renglones > 0 ? "bad" : "good"} />
            <Card title="Unidades fantasma (en mano)" value={data.unidades.toLocaleString()}
              tone={data.unidades > 0 ? "bad" : "good"} sub="piezas que el libro dice tener y ninguna caja respalda" />
          </div>
          {data.renglones > 0 && (
            <div className="border border-border rounded-lg overflow-x-auto">
              <table className={tableCls}>
                <thead>
                  <tr>
                    <Th>Ubicación</Th><Th>Customer</Th><Th>Style</Th><Th>SKU</Th>
                    <Th>Color</Th><Th>Talla</Th><Th right>En mano</Th>
                    <Th right>Apartadas</Th><Th right>Cont. cajas</Th>
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
                  Mostrando {top.length} de {data.renglones} — el Excel trae todos.
                </div>
              )}
            </div>
          )}
          {data.renglones === 0 && (
            <p className="text-sm text-emerald-600 dark:text-emerald-400 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" /> El libro está limpio: cada renglón vivo tiene cajas que lo respaldan.
            </p>
          )}
        </>
      )}
    </div>
  );
};

// ─── Módulo ──────────────────────────────────────────────────────────────────
export const AuditModule = () => {
  const [tab, setTab] = useState("health");
  return (
    <div className="space-y-5">
      <div className="flex gap-1 border-b border-border overflow-x-auto">
        {TABS.map(t => {
          const Icon = t.icon;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors
                ${tab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
              <Icon className="w-4 h-4" /> {t.label}
            </button>
          );
        })}
      </div>
      {tab === "health" && <HealthTab />}
      {tab === "fantasmas" && <FantasmasTab />}
      {tab === "selftest" && <SelfTestTab />}
      {tab === "box" && <BoxTab />}
      {tab === "sku" && <SkuTab />}
      {tab === "movements" && <MovementsTab />}
    </div>
  );
};
