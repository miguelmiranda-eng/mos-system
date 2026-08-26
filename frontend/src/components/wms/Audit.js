import { useState } from "react";
import {
  Activity, PackageSearch, Layers, History, Search, Loader2,
  AlertTriangle, CheckCircle2, RefreshCw, FlaskConical, XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { fetcher, poster } from "./lib";
import { Btn, Th, Chip, tableCls } from "./ui";

// Módulo de Auditoría — admin nivel 5 y supersu (el backend valida con
// require_admin_level(5) y rechaza al resto con 403). Cuatro vistas: salud del
// sistema, trazabilidad por caja, balance por SKU y búsqueda de movimientos.

const TABS = [
  { id: "health", label: "Salud del sistema", icon: Activity },
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

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Btn variant="primary" onClick={run} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Ejecutar chequeo completo
        </Btn>
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
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Card title="Recibido" value={bal.recibido.toLocaleString()} sub={`${data.recibos.length} recibos`} />
            <Card title="Pickeado" value={bal.pickeado.toLocaleString()} sub={`${data.tickets.length} tickets`} />
            <Card title="Esperado (R−P)" value={bal.esperado.toLocaleString()} />
            <Card title="En mano (sistema)" value={bal.en_mano.toLocaleString()} />
            <Card title="Diferencia" value={`${bal.diferencia > 0 ? "+" : ""}${bal.diferencia.toLocaleString()}`}
              tone={ok ? "good" : "bad"} sub={ok ? "cuadra" : "revisar: fantasma o entradas sin rastrear"} />
          </div>
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
          <div className="px-3 py-2 bg-muted/50 border-b border-border text-xs font-semibold text-muted-foreground">
            {data.count} de {data.total.toLocaleString()} movimientos
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
      {tab === "selftest" && <SelfTestTab />}
      {tab === "box" && <BoxTab />}
      {tab === "sku" && <SkuTab />}
      {tab === "movements" && <MovementsTab />}
    </div>
  );
};
