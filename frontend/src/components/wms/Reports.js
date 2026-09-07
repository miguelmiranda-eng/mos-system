import { useState, useEffect, useCallback, useRef } from "react";
import {
  Loader2, RefreshCw, Download, AlertTriangle, Clock, Users, History, PackageX,
} from "lucide-react";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher } from "./lib";
import { Card, StatCard, SoftAlert, Btn, Chip, Th, EmptyState, TableShell, tableCls, cls } from "./ui";

// Reportes del WMS: recibos, putaway y pick tickets. Cuatro vistas, cada una
// respondiendo a una pregunta distinta — pendiente hoy, productividad,
// historial y excepciones. Todo se puede bajar a Excel.

// Etiquetas por labelKey: se traducen en el render (constante de módulo, sin hooks).
const TABS = [
  { id: "pendientes", labelKey: "wms_rep_tab_pending", icon: Clock },
  { id: "productividad", labelKey: "wms_rep_tab_productivity", icon: Users },
  { id: "historial", labelKey: "wms_rep_tab_history", icon: History },
  { id: "excepciones", labelKey: "wms_rep_tab_exceptions", icon: AlertTriangle },
];

const hoy = () => new Date().toISOString().slice(0, 10);
const haceDias = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const fmt = (iso) => {
  if (!iso) return "-";
  const d = new Date(iso);
  return isNaN(d) ? String(iso).slice(0, 16)
    : d.toLocaleString("es-MX", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
};
const fmtDia = (iso) => (iso || "").slice(0, 10);
const num = (n) => Number(n || 0).toLocaleString();

// Días transcurridos desde una fecha — para ver de un vistazo qué tan añeja
// está una caja sin guardar.
const diasDesde = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d) ? null : Math.floor((Date.now() - d.getTime()) / 86400000);
};

// `tr` = traductor (se recibe como argumento: esta función vive fuera del componente).
const bajar = (hojas, nombre, tr) => {
  const wb = XLSX.utils.book_new();
  let algo = false;
  for (const [titulo, filas] of hojas) {
    if (!filas?.length) continue;
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(filas), titulo.slice(0, 31));
    algo = true;
  }
  if (!algo) { toast.error(tr("wms_rep_no_export_data")); return; }
  XLSX.writeFile(wb, `${nombre}_${hoy()}.xlsx`);
  toast.success(tr("wms_rep_exported"));
};

export const ReportsModule = () => {
  const { t } = useLang();
  // La carga no debe re-correr al cambiar idioma: el traductor va por ref.
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);
  const [tab, setTab] = useState("pendientes");
  const [desde, setDesde] = useState(haceDias(30));
  const [hasta, setHasta] = useState(hoy());
  const [customer, setCustomer] = useState("");
  const [orden, setOrden] = useState("");
  const [operador, setOperador] = useState("");
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (tab !== "pendientes") { p.set("desde", desde); p.set("hasta", hasta); }
      if (tab === "productividad" && operador) p.set("operador", operador);
      if (tab === "historial") {
        if (customer) p.set("customer", customer);
        if (orden) p.set("orden", orden);
      }
      const q = p.toString();
      const datos = await fetcher(`/reports/${tab}${q ? `?${q}` : ""}`);
      setData(prev => ({ ...prev, [tab]: datos }));
    } catch (res) {
      const e = await res?.json?.().catch(() => ({})) || {};
      toast.error(e.detail || tRef.current("wms_rep_load_err"));
    } finally { setLoading(false); }
  }, [tab, desde, hasta, customer, orden, operador]);

  useEffect(() => { load(); }, [load]);

  const d = data[tab] || null;

  const exportar = () => {
    if (!d) return;
    if (tab === "pendientes") {
      bajar([["Por antiguedad", d.putaway?.por_antiguedad],
             ["Cajas mas viejas", (d.putaway?.mas_viejas || []).map(b => ({
               Caja: b.box_id, Dias: diasDesde(b.created_at), Cliente: b.customer || "",
               Style: b.style || "", Color: b.color || "", Talla: b.size || "",
               Unidades: b.units, Ubicacion: b.location || "", Recibida: fmt(b.created_at),
             }))],
             ["Tickets abiertos", (d.picking?.tickets || []).map(tk => ({
               Ticket: tk.ticket_id, Orden: tk.order_number || "", Cliente: tk.customer || "",
               Style: tk.style || "", Cantidad: tk.total_pick_qty || 0, Estado: tk.status || "",
               Asignado: tk.assigned_to_name || "(sin asignar)", Creado: fmt(tk.created_at),
               "Vence": fmt(tk.sla_deadline),
             }))]], "wms_pendiente", t);
    } else if (tab === "productividad") {
      bajar([["Por operador", (d.operadores || []).map(o => ({
               Operador: o.operador, Recibos: o.recibos, "Unidades recibidas": o.unidades_recibidas,
               "Putaway (eventos)": o.putaway_eventos, "Putaway (cajas)": o.putaway_cajas,
               "Tickets surtidos": o.tickets, "Unidades surtidas": o.unidades_surtidas,
             }))],
             ["Por dia", d.por_dia]], "wms_productividad", t);
    } else if (tab === "historial") {
      bajar([["Recibos", (d.recibos || []).map(r => ({
               Fecha: fmt(r.created_at), Recibo: r.receiving_id, Cliente: r.customer || "",
               Fabricante: r.manufacturer || "", Style: r.style || "", Color: r.color || "",
               Talla: r.size || "", Unidades: r.total_units || 0, Lote: r.lot_number || "",
               ASN: r.asn_reference || "", Pais: r.country_of_origin || "",
               Ubicacion: r.inv_location || "", "Recibido por": r.received_by_name || "",
             }))],
             ["Tickets", (d.tickets || []).map(tk => ({
               Creado: fmt(tk.created_at), Ticket: tk.ticket_id, Orden: tk.order_number || "",
               Cliente: tk.customer || "", Style: tk.style || "", Color: tk.color || "",
               Cantidad: tk.total_pick_qty || 0, Estado: tk.status || "",
               Destino: tk.destination || "", Picker: tk.assigned_to_name || "",
               Completado: tk.completed_at ? fmt(tk.completed_at) : "",
             }))]], "wms_historial", t);
    } else {
      bajar([["Recibos forzados", (d.recibos_forzados || []).map(r => ({
               Fecha: fmt(r.created_at), Recibo: r.receiving_id, Excepcion: r.excepcion || "",
               Cliente: r.customer || "", Style: r.style || "", Unidades: r.total_units || 0,
               ASN: r.asn_reference || "", "Recibido por": r.received_by_name || "",
             }))],
             ["Tickets fuera de SLA", (d.tickets_fuera_sla || []).map(tk => ({
               Ticket: tk.ticket_id, Situacion: tk.situacion || "", Orden: tk.order_number || "",
               Cliente: tk.customer || "", Cantidad: tk.total_pick_qty || 0,
               Picker: tk.assigned_to_name || "(sin asignar)", Creado: fmt(tk.created_at),
               Vencia: fmt(tk.sla_deadline), Completado: tk.completed_at ? fmt(tk.completed_at) : "",
             }))],
             ["Por persona", d.por_persona]], "wms_excepciones", t);
    }
  };

  const filtrosFecha = tab !== "pendientes";

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{t("wms_rep_title")}</h2>
          <p className="text-sm text-muted-foreground mt-0.5">{t("wms_rep_subtitle")}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {filtrosFecha && (
            <>
              <input type="date" value={desde} onChange={e => setDesde(e.target.value)}
                className={`${cls.input} w-auto`} aria-label={t("wms_from")} />
              <span className="text-sm text-muted-foreground">{t("wms_rep_date_sep")}</span>
              <input type="date" value={hasta} onChange={e => setHasta(e.target.value)}
                className={`${cls.input} w-auto`} aria-label={t("wms_to")} />
            </>
          )}
          {tab === "historial" && (
            <>
              <input placeholder={t("wms_rep_customer_ph")} value={customer} onChange={e => setCustomer(e.target.value)}
                className={`${cls.input} w-32`} />
              <input placeholder={t("wms_rep_order_ph")} value={orden} onChange={e => setOrden(e.target.value)}
                className={`${cls.input} w-32`} />
            </>
          )}
          {tab === "productividad" && (
            <input placeholder={t("wms_rep_operator_ph")} value={operador} onChange={e => setOperador(e.target.value)}
              className={`${cls.input} w-36`} />
          )}
          <Btn onClick={load} disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} {t("wms_refresh")}
          </Btn>
          <Btn variant="primary" onClick={exportar} disabled={!d}>
            <Download className="w-4 h-4" /> {t("export_excel")}
          </Btn>
        </div>
      </div>

      <div className="flex gap-1 border-b border-border">
        {TABS.map(tb => {
          const Icon = tb.icon;
          return (
            <button key={tb.id} onClick={() => setTab(tb.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === tb.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
              <Icon className="w-4 h-4" /> {t(tb.labelKey)}
            </button>
          );
        })}
      </div>

      {loading && !d && <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>}

      {/* ── Pendiente hoy ── */}
      {tab === "pendientes" && d && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard label={t("wms_rep_boxes_to_putaway")} value={num(d.putaway?.cajas)}
              sub={t("wms_rep_units_n", { n: num(d.putaway?.unidades) })} />
            <StatCard label={t("wms_rep_open_tickets")} value={num(d.picking?.abiertos)} />
            <StatCard label={t("wms_rep_overdue_tickets")} value={num(d.picking?.vencidos)}
              sub={d.picking?.vencidos ? t("wms_rep_overdue_sub") : t("wms_rep_none_sub")} />
            <StatCard label={t("wms_rep_received_today")} value={num(d.recibos_hoy?.unidades)}
              sub={t("wms_rep_receipts_n", { n: num(d.recibos_hoy?.recibos) })} />
          </div>

          {d.picking?.vencidos > 0 && (
            <SoftAlert tone="danger" title={t("wms_rep_overdue_alert_title", { n: d.picking.vencidos })}>
              {t("wms_rep_overdue_alert_body")}
            </SoftAlert>
          )}

          <Card className="overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center gap-2">
              <PackageX className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-semibold">{t("wms_rep_putaway_by_age")}</span>
              <span className="text-xs text-muted-foreground">{t("wms_rep_putaway_by_age_hint")}</span>
            </div>
            <TableShell>
              <thead className={tableCls.thead}>
                <tr><Th>{t("wms_rep_age")}</Th><Th right>{t("wms_boxes")}</Th><Th right>{t("wms_label_units")}</Th></tr>
              </thead>
              <tbody>
                {(d.putaway?.por_antiguedad || []).map(tm => (
                  <tr key={tm.tramo} className={tableCls.row}>
                    <td className={cls.td}>
                      {tm.tramo}
                      {tm.tramo === "más de 7 días" && tm.cajas > 0 && <Chip tone="danger" className="ml-2">{t("wms_rep_attention")}</Chip>}
                    </td>
                    <td className={`${cls.td} text-right tabular-nums font-semibold`}>{num(tm.cajas)}</td>
                    <td className={`${cls.td} text-right tabular-nums`}>{num(tm.unidades)}</td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </Card>

          <Card className="overflow-hidden">
            <div className="px-4 py-3 border-b border-border text-sm font-semibold">{t("wms_rep_oldest_unstored")}</div>
            {!d.putaway?.mas_viejas?.length ? (
              <EmptyState art="done" title={t("wms_rep_nothing_pending")} hint={t("wms_rep_all_stored")} />
            ) : (
              <TableShell maxH="max-h-[40vh]">
                <thead className={tableCls.thead}>
                  <tr><Th>{t("wms_box")}</Th><Th right>{t("wms_rep_days")}</Th><Th>{t("client")}</Th><Th>{t("wms_rep_material")}</Th><Th right>{t("wms_label_units")}</Th><Th>{t("wms_rep_received")}</Th></tr>
                </thead>
                <tbody>
                  {d.putaway.mas_viejas.map(b => {
                    const dias = diasDesde(b.created_at);
                    return (
                      <tr key={b.box_id} className={tableCls.row}>
                        <td className={`${cls.td} font-mono`}>{b.box_id}</td>
                        <td className={`${cls.td} text-right tabular-nums`}>
                          {dias >= 7 ? <Chip tone="danger">{dias}</Chip> : dias >= 3 ? <Chip tone="warning">{dias}</Chip> : dias}
                        </td>
                        <td className={cls.td}>{b.customer || "—"}</td>
                        <td className={cls.td}>{[b.style, b.color, b.size].filter(Boolean).join(" · ") || "—"}</td>
                        <td className={`${cls.td} text-right tabular-nums`}>{num(b.units)}</td>
                        <td className={`${cls.td} text-xs text-muted-foreground`}>{fmt(b.created_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </TableShell>
            )}
          </Card>

          <Card className="overflow-hidden">
            <div className="px-4 py-3 border-b border-border text-sm font-semibold">
              {t("wms_rep_open_tickets")} {d.picking?.sin_asignar ? t("wms_rep_unassigned_n", { n: d.picking.sin_asignar }) : ""}
            </div>
            {!d.picking?.tickets?.length ? (
              <EmptyState art="done" title={t("wms_rep_no_open_tickets")} hint={t("wms_rep_all_picked")} />
            ) : (
              <TableShell maxH="max-h-[45vh]">
                <thead className={tableCls.thead}>
                  <tr><Th>{t("wms_rep_ticket")}</Th><Th>{t("order")}</Th><Th>{t("client")}</Th><Th right>{t("quantity")}</Th><Th>{t("wms_rep_picker")}</Th><Th>{t("wms_rep_due")}</Th></tr>
                </thead>
                <tbody>
                  {d.picking.tickets.map(tk => {
                    const vencido = tk.sla_deadline && tk.sla_deadline < (d.generado || "");
                    return (
                      <tr key={tk.ticket_id} className={tableCls.row}>
                        <td className={`${cls.td} font-mono`}>{tk.ticket_id}</td>
                        <td className={cls.td}>{tk.order_number || "—"}</td>
                        <td className={cls.td}>{tk.customer || "—"}</td>
                        <td className={`${cls.td} text-right tabular-nums`}>{num(tk.total_pick_qty)}</td>
                        <td className={cls.td}>
                          {tk.assigned_to_name || <Chip tone="warning">{t("wms_rep_unassigned_chip")}</Chip>}
                        </td>
                        <td className={cls.td}>
                          {vencido ? <Chip tone="danger">{t("wms_rep_overdue_on", { date: fmtDia(tk.sla_deadline) })}</Chip>
                                   : <span className="text-xs text-muted-foreground">{fmt(tk.sla_deadline)}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </TableShell>
            )}
          </Card>
        </div>
      )}

      {/* ── Productividad ── */}
      {tab === "productividad" && d && (
        <div className="space-y-4">
          <Card className="overflow-hidden">
            <div className="px-4 py-3 border-b border-border text-sm font-semibold">{t("wms_rep_by_operator")}</div>
            {!d.operadores?.length ? (
              <EmptyState art="clipboard" title={t("wms_rep_no_activity")} hint={t("wms_rep_try_other_range")} />
            ) : (
              <TableShell maxH="max-h-[55vh]">
                <thead className={tableCls.thead}>
                  <tr>
                    <Th>{t("wms_rep_operator")}</Th>
                    <Th right>{t("wms_rep_receipts")}</Th><Th right>{t("wms_rep_units_received_short")}</Th>
                    <Th right>{t("wms_rep_putaway_boxes")}</Th>
                    <Th right>{t("wms_rep_tickets")}</Th><Th right>{t("wms_rep_units_picked_short")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {d.operadores.map(o => (
                    <tr key={o.operador} className={tableCls.row}>
                      <td className={`${cls.td} font-medium`}>{o.operador}</td>
                      <td className={`${cls.td} text-right tabular-nums`}>{num(o.recibos)}</td>
                      <td className={`${cls.td} text-right tabular-nums`}>{num(o.unidades_recibidas)}</td>
                      <td className={`${cls.td} text-right tabular-nums`}>{num(o.putaway_cajas)}</td>
                      <td className={`${cls.td} text-right tabular-nums`}>{num(o.tickets)}</td>
                      <td className={`${cls.td} text-right tabular-nums`}>{num(o.unidades_surtidas)}</td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            )}
          </Card>

          {d.por_dia?.length > 0 && (
            <Card className="overflow-hidden">
              <div className="px-4 py-3 border-b border-border text-sm font-semibold">{t("wms_rep_by_day")}</div>
              <TableShell maxH="max-h-[40vh]">
                <thead className={tableCls.thead}>
                  <tr><Th>{t("wms_rep_day")}</Th><Th right>{t("wms_rep_receipts")}</Th><Th right>{t("wms_rep_tickets_completed")}</Th></tr>
                </thead>
                <tbody>
                  {d.por_dia.map(x => (
                    <tr key={x.dia} className={tableCls.row}>
                      <td className={cls.td}>{x.dia}</td>
                      <td className={`${cls.td} text-right tabular-nums`}>{num(x.recibos)}</td>
                      <td className={`${cls.td} text-right tabular-nums`}>{num(x.tickets)}</td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            </Card>
          )}
        </div>
      )}

      {/* ── Historial ── */}
      {tab === "historial" && d && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard label={t("wms_rep_receipts")} value={num(d.totales?.recibos)} />
            <StatCard label={t("wms_rep_units_received")} value={num(d.totales?.unidades_recibidas)} />
            <StatCard label={t("wms_rep_tickets")} value={num(d.totales?.tickets)} />
            <StatCard label={t("wms_rep_units_picked")} value={num(d.totales?.unidades_surtidas)} sub={t("wms_rep_only_completed")} />
          </div>

          <Card className="overflow-hidden">
            <div className="px-4 py-3 border-b border-border text-sm font-semibold">
              {t("wms_rep_inbound_receipts")} {d.recibos?.length ? `(${d.recibos.length})` : ""}
            </div>
            {!d.recibos?.length ? <EmptyState art={false} title={t("wms_rep_no_receipts_period")} /> : (
              <TableShell maxH="max-h-[45vh]">
                <thead className={tableCls.thead}>
                  <tr><Th>{t("date")}</Th><Th>{t("client")}</Th><Th>{t("wms_rep_material")}</Th><Th right>{t("wms_label_units")}</Th><Th>ASN</Th><Th>{t("wms_rep_received_by")}</Th></tr>
                </thead>
                <tbody>
                  {d.recibos.map(r => (
                    <tr key={r.receiving_id} className={tableCls.row}>
                      <td className={`${cls.td} text-xs text-muted-foreground`}>{fmt(r.created_at)}</td>
                      <td className={cls.td}>{r.customer || "—"}</td>
                      <td className={cls.td}>{[r.style, r.color, r.size].filter(Boolean).join(" · ") || "—"}</td>
                      <td className={`${cls.td} text-right tabular-nums font-semibold`}>{num(r.total_units)}</td>
                      <td className={cls.td}>{r.asn_reference || "—"}</td>
                      <td className={cls.td}>{r.received_by_name || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            )}
          </Card>

          <Card className="overflow-hidden">
            <div className="px-4 py-3 border-b border-border text-sm font-semibold">
              {t("wms_rep_outbound_tickets")} {d.tickets?.length ? `(${d.tickets.length})` : ""}
            </div>
            {!d.tickets?.length ? <EmptyState art={false} title={t("wms_rep_no_tickets_period")} /> : (
              <TableShell maxH="max-h-[45vh]">
                <thead className={tableCls.thead}>
                  <tr><Th>{t("wms_rep_created")}</Th><Th>{t("wms_rep_ticket")}</Th><Th>{t("order")}</Th><Th>{t("client")}</Th><Th right>{t("quantity")}</Th><Th>{t("status")}</Th><Th>{t("wms_rep_picker")}</Th></tr>
                </thead>
                <tbody>
                  {d.tickets.map(tk => (
                    <tr key={tk.ticket_id} className={tableCls.row}>
                      <td className={`${cls.td} text-xs text-muted-foreground`}>{fmt(tk.created_at)}</td>
                      <td className={`${cls.td} font-mono`}>{tk.ticket_id}</td>
                      <td className={cls.td}>{tk.order_number || "—"}</td>
                      <td className={cls.td}>{tk.customer || "—"}</td>
                      <td className={`${cls.td} text-right tabular-nums`}>{num(tk.total_pick_qty)}</td>
                      <td className={cls.td}>
                        {tk.status === "completed" ? <Chip tone="success">{t("wms_rep_completed_chip")}</Chip> : <Chip>{tk.status || "—"}</Chip>}
                      </td>
                      <td className={cls.td}>{tk.assigned_to_name || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            )}
          </Card>
        </div>
      )}

      {/* ── Excepciones ── */}
      {tab === "excepciones" && d && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <StatCard label={t("wms_rep_forced_receipts")} value={num(d.totales?.recibos_forzados)}
              sub={t("wms_rep_forced_sub")} />
            <StatCard label={t("wms_rep_tickets_past_due")} value={num(d.totales?.tickets_fuera_sla)} />
          </div>

          {(d.totales?.recibos_forzados > 0 || d.totales?.tickets_fuera_sla > 0) && (
            <SoftAlert tone="warning" title={t("wms_rep_exc_alert_title")}>
              {t("wms_rep_exc_alert_body")}
            </SoftAlert>
          )}

          <Card className="overflow-hidden">
            <div className="px-4 py-3 border-b border-border text-sm font-semibold">{t("wms_rep_forced_receipts")}</div>
            {!d.recibos_forzados?.length ? <EmptyState art={false} title={t("wms_rep_none_in_period")} /> : (
              <TableShell maxH="max-h-[40vh]">
                <thead className={tableCls.thead}>
                  <tr><Th>{t("date")}</Th><Th>{t("wms_rep_exception")}</Th><Th>{t("client")}</Th><Th>{t("wms_rep_material")}</Th><Th right>{t("wms_label_units")}</Th><Th>{t("wms_rep_received_by")}</Th></tr>
                </thead>
                <tbody>
                  {d.recibos_forzados.map(r => (
                    <tr key={r.receiving_id} className={tableCls.row}>
                      <td className={`${cls.td} text-xs text-muted-foreground`}>{fmt(r.created_at)}</td>
                      <td className={cls.td}><Chip tone="warning">{r.excepcion}</Chip></td>
                      <td className={cls.td}>{r.customer || "—"}</td>
                      <td className={cls.td}>{[r.style, r.color, r.size].filter(Boolean).join(" · ") || "—"}</td>
                      <td className={`${cls.td} text-right tabular-nums`}>{num(r.total_units)}</td>
                      <td className={cls.td}>{r.received_by_name || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            )}
          </Card>

          <Card className="overflow-hidden">
            <div className="px-4 py-3 border-b border-border text-sm font-semibold">{t("wms_rep_tickets_past_due")}</div>
            {!d.tickets_fuera_sla?.length ? <EmptyState art={false} title={t("wms_rep_none_in_period")} /> : (
              <TableShell maxH="max-h-[40vh]">
                <thead className={tableCls.thead}>
                  <tr><Th>{t("wms_rep_ticket")}</Th><Th>{t("wms_rep_situation")}</Th><Th>{t("order")}</Th><Th>{t("client")}</Th><Th right>{t("quantity")}</Th><Th>{t("wms_rep_picker")}</Th><Th>{t("wms_rep_was_due")}</Th></tr>
                </thead>
                <tbody>
                  {d.tickets_fuera_sla.map(tk => (
                    <tr key={tk.ticket_id} className={tableCls.row}>
                      <td className={`${cls.td} font-mono`}>{tk.ticket_id}</td>
                      <td className={cls.td}>
                        <Chip tone={tk.situacion === "completado tarde" ? "warning" : "danger"}>{tk.situacion}</Chip>
                      </td>
                      <td className={cls.td}>{tk.order_number || "—"}</td>
                      <td className={cls.td}>{tk.customer || "—"}</td>
                      <td className={`${cls.td} text-right tabular-nums`}>{num(tk.total_pick_qty)}</td>
                      <td className={cls.td}>{tk.assigned_to_name || `(${t("wms_rep_unassigned_chip")})`}</td>
                      <td className={`${cls.td} text-xs text-muted-foreground`}>{fmt(tk.sla_deadline)}</td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            )}
          </Card>

          {d.por_persona?.length > 0 && (
            <Card className="overflow-hidden">
              <div className="px-4 py-3 border-b border-border text-sm font-semibold">{t("wms_rep_by_person")}</div>
              <TableShell maxH="max-h-[35vh]">
                <thead className={tableCls.thead}>
                  <tr><Th>{t("wms_rep_person")}</Th><Th right>{t("wms_rep_forced_receipts")}</Th><Th right>{t("wms_rep_late_tickets")}</Th></tr>
                </thead>
                <tbody>
                  {d.por_persona.map(p => (
                    <tr key={p.persona} className={tableCls.row}>
                      <td className={`${cls.td} font-medium`}>{p.persona}</td>
                      <td className={`${cls.td} text-right tabular-nums`}>{num(p.recibos_forzados)}</td>
                      <td className={`${cls.td} text-right tabular-nums`}>{num(p.tickets_tarde)}</td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            </Card>
          )}
        </div>
      )}
    </div>
  );
};

export default ReportsModule;
