import { useState, useEffect, useCallback } from "react";
import {
  Loader2, RefreshCw, Download, AlertTriangle, Clock, Users, History, PackageX,
} from "lucide-react";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import { fetcher } from "./lib";
import { Card, StatCard, SoftAlert, Btn, Chip, Th, EmptyState, TableShell, tableCls, cls } from "./ui";

// Reportes del WMS: recibos, putaway y pick tickets. Cuatro vistas, cada una
// respondiendo a una pregunta distinta — pendiente hoy, productividad,
// historial y excepciones. Todo se puede bajar a Excel.

const TABS = [
  { id: "pendientes", label: "Pendiente hoy", icon: Clock },
  { id: "productividad", label: "Productividad", icon: Users },
  { id: "historial", label: "Historial", icon: History },
  { id: "excepciones", label: "Excepciones", icon: AlertTriangle },
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

const bajar = (hojas, nombre) => {
  const wb = XLSX.utils.book_new();
  let algo = false;
  for (const [titulo, filas] of hojas) {
    if (!filas?.length) continue;
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(filas), titulo.slice(0, 31));
    algo = true;
  }
  if (!algo) { toast.error("No hay datos para exportar"); return; }
  XLSX.writeFile(wb, `${nombre}_${hoy()}.xlsx`);
  toast.success("Exportado a Excel");
};

export const ReportsModule = () => {
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
      toast.error(e.detail || "No se pudo cargar el reporte (¿permiso de supervisor?)");
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
             ["Tickets abiertos", (d.picking?.tickets || []).map(t => ({
               Ticket: t.ticket_id, Orden: t.order_number || "", Cliente: t.customer || "",
               Style: t.style || "", Cantidad: t.total_pick_qty || 0, Estado: t.status || "",
               Asignado: t.assigned_to_name || "(sin asignar)", Creado: fmt(t.created_at),
               "Vence": fmt(t.sla_deadline),
             }))]], "wms_pendiente");
    } else if (tab === "productividad") {
      bajar([["Por operador", (d.operadores || []).map(o => ({
               Operador: o.operador, Recibos: o.recibos, "Unidades recibidas": o.unidades_recibidas,
               "Putaway (eventos)": o.putaway_eventos, "Putaway (cajas)": o.putaway_cajas,
               "Tickets surtidos": o.tickets, "Unidades surtidas": o.unidades_surtidas,
             }))],
             ["Por dia", d.por_dia]], "wms_productividad");
    } else if (tab === "historial") {
      bajar([["Recibos", (d.recibos || []).map(r => ({
               Fecha: fmt(r.created_at), Recibo: r.receiving_id, Cliente: r.customer || "",
               Fabricante: r.manufacturer || "", Style: r.style || "", Color: r.color || "",
               Talla: r.size || "", Unidades: r.total_units || 0, Lote: r.lot_number || "",
               ASN: r.asn_reference || "", Pais: r.country_of_origin || "",
               Ubicacion: r.inv_location || "", "Recibido por": r.received_by_name || "",
             }))],
             ["Tickets", (d.tickets || []).map(t => ({
               Creado: fmt(t.created_at), Ticket: t.ticket_id, Orden: t.order_number || "",
               Cliente: t.customer || "", Style: t.style || "", Color: t.color || "",
               Cantidad: t.total_pick_qty || 0, Estado: t.status || "",
               Destino: t.destination || "", Picker: t.assigned_to_name || "",
               Completado: t.completed_at ? fmt(t.completed_at) : "",
             }))]], "wms_historial");
    } else {
      bajar([["Recibos forzados", (d.recibos_forzados || []).map(r => ({
               Fecha: fmt(r.created_at), Recibo: r.receiving_id, Excepcion: r.excepcion || "",
               Cliente: r.customer || "", Style: r.style || "", Unidades: r.total_units || 0,
               ASN: r.asn_reference || "", "Recibido por": r.received_by_name || "",
             }))],
             ["Tickets fuera de SLA", (d.tickets_fuera_sla || []).map(t => ({
               Ticket: t.ticket_id, Situacion: t.situacion || "", Orden: t.order_number || "",
               Cliente: t.customer || "", Cantidad: t.total_pick_qty || 0,
               Picker: t.assigned_to_name || "(sin asignar)", Creado: fmt(t.created_at),
               Vencia: fmt(t.sla_deadline), Completado: t.completed_at ? fmt(t.completed_at) : "",
             }))],
             ["Por persona", d.por_persona]], "wms_excepciones");
    }
  };

  const filtrosFecha = tab !== "pendientes";

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Reportes</h2>
          <p className="text-sm text-muted-foreground mt-0.5">Recibos, putaway y pick tickets</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {filtrosFecha && (
            <>
              <input type="date" value={desde} onChange={e => setDesde(e.target.value)}
                className={`${cls.input} w-auto`} aria-label="Desde" />
              <span className="text-sm text-muted-foreground">a</span>
              <input type="date" value={hasta} onChange={e => setHasta(e.target.value)}
                className={`${cls.input} w-auto`} aria-label="Hasta" />
            </>
          )}
          {tab === "historial" && (
            <>
              <input placeholder="Cliente…" value={customer} onChange={e => setCustomer(e.target.value)}
                className={`${cls.input} w-32`} />
              <input placeholder="Orden…" value={orden} onChange={e => setOrden(e.target.value)}
                className={`${cls.input} w-32`} />
            </>
          )}
          {tab === "productividad" && (
            <input placeholder="Operador…" value={operador} onChange={e => setOperador(e.target.value)}
              className={`${cls.input} w-36`} />
          )}
          <Btn onClick={load} disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Actualizar
          </Btn>
          <Btn variant="primary" onClick={exportar} disabled={!d}>
            <Download className="w-4 h-4" /> Exportar Excel
          </Btn>
        </div>
      </div>

      <div className="flex gap-1 border-b border-border">
        {TABS.map(t => {
          const Icon = t.icon;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
              <Icon className="w-4 h-4" /> {t.label}
            </button>
          );
        })}
      </div>

      {loading && !d && <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>}

      {/* ── Pendiente hoy ── */}
      {tab === "pendientes" && d && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard label="Cajas por guardar" value={num(d.putaway?.cajas)}
              sub={`${num(d.putaway?.unidades)} unidades`} />
            <StatCard label="Tickets abiertos" value={num(d.picking?.abiertos)} />
            <StatCard label="Tickets vencidos" value={num(d.picking?.vencidos)}
              sub={d.picking?.vencidos ? "fuera de plazo" : "ninguno"} />
            <StatCard label="Recibido hoy" value={num(d.recibos_hoy?.unidades)}
              sub={`${num(d.recibos_hoy?.recibos)} recibos`} />
          </div>

          {d.picking?.vencidos > 0 && (
            <SoftAlert tone="danger" title={`${d.picking.vencidos} ticket(s) fuera de plazo`}>
              Ya pasaron su fecha compromiso y siguen sin completarse.
            </SoftAlert>
          )}

          <Card className="overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center gap-2">
              <PackageX className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-semibold">Putaway pendiente por antigüedad</span>
              <span className="text-xs text-muted-foreground">— una caja recibida y no guardada es inventario que el piso no encuentra</span>
            </div>
            <TableShell>
              <thead className={tableCls.thead}>
                <tr><Th>Antigüedad</Th><Th right>Cajas</Th><Th right>Unidades</Th></tr>
              </thead>
              <tbody>
                {(d.putaway?.por_antiguedad || []).map(t => (
                  <tr key={t.tramo} className={tableCls.row}>
                    <td className={cls.td}>
                      {t.tramo}
                      {t.tramo === "más de 7 días" && t.cajas > 0 && <Chip tone="danger" className="ml-2">atención</Chip>}
                    </td>
                    <td className={`${cls.td} text-right tabular-nums font-semibold`}>{num(t.cajas)}</td>
                    <td className={`${cls.td} text-right tabular-nums`}>{num(t.unidades)}</td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </Card>

          <Card className="overflow-hidden">
            <div className="px-4 py-3 border-b border-border text-sm font-semibold">Las más viejas sin guardar</div>
            {!d.putaway?.mas_viejas?.length ? (
              <EmptyState title="Nada pendiente" hint="Todas las cajas recibidas están guardadas." />
            ) : (
              <TableShell maxH="max-h-[40vh]">
                <thead className={tableCls.thead}>
                  <tr><Th>Caja</Th><Th right>Días</Th><Th>Cliente</Th><Th>Material</Th><Th right>Unidades</Th><Th>Recibida</Th></tr>
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
              Tickets abiertos {d.picking?.sin_asignar ? `— ${d.picking.sin_asignar} sin asignar` : ""}
            </div>
            {!d.picking?.tickets?.length ? (
              <EmptyState title="Sin tickets abiertos" hint="Todo lo pedido está surtido." />
            ) : (
              <TableShell maxH="max-h-[45vh]">
                <thead className={tableCls.thead}>
                  <tr><Th>Ticket</Th><Th>Orden</Th><Th>Cliente</Th><Th right>Cantidad</Th><Th>Picker</Th><Th>Vence</Th></tr>
                </thead>
                <tbody>
                  {d.picking.tickets.map(t => {
                    const vencido = t.sla_deadline && t.sla_deadline < (d.generado || "");
                    return (
                      <tr key={t.ticket_id} className={tableCls.row}>
                        <td className={`${cls.td} font-mono`}>{t.ticket_id}</td>
                        <td className={cls.td}>{t.order_number || "—"}</td>
                        <td className={cls.td}>{t.customer || "—"}</td>
                        <td className={`${cls.td} text-right tabular-nums`}>{num(t.total_pick_qty)}</td>
                        <td className={cls.td}>
                          {t.assigned_to_name || <Chip tone="warning">sin asignar</Chip>}
                        </td>
                        <td className={cls.td}>
                          {vencido ? <Chip tone="danger">venció {fmtDia(t.sla_deadline)}</Chip>
                                   : <span className="text-xs text-muted-foreground">{fmt(t.sla_deadline)}</span>}
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
            <div className="px-4 py-3 border-b border-border text-sm font-semibold">Por operador</div>
            {!d.operadores?.length ? (
              <EmptyState title="Sin actividad en el periodo" hint="Prueba con otro rango de fechas." />
            ) : (
              <TableShell maxH="max-h-[55vh]">
                <thead className={tableCls.thead}>
                  <tr>
                    <Th>Operador</Th>
                    <Th right>Recibos</Th><Th right>Unid. recibidas</Th>
                    <Th right>Putaway (cajas)</Th>
                    <Th right>Tickets</Th><Th right>Unid. surtidas</Th>
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
              <div className="px-4 py-3 border-b border-border text-sm font-semibold">Por día</div>
              <TableShell maxH="max-h-[40vh]">
                <thead className={tableCls.thead}>
                  <tr><Th>Día</Th><Th right>Recibos</Th><Th right>Tickets completados</Th></tr>
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
            <StatCard label="Recibos" value={num(d.totales?.recibos)} />
            <StatCard label="Unidades recibidas" value={num(d.totales?.unidades_recibidas)} />
            <StatCard label="Tickets" value={num(d.totales?.tickets)} />
            <StatCard label="Unidades surtidas" value={num(d.totales?.unidades_surtidas)} sub="sólo completados" />
          </div>

          <Card className="overflow-hidden">
            <div className="px-4 py-3 border-b border-border text-sm font-semibold">
              Entradas — recibos {d.recibos?.length ? `(${d.recibos.length})` : ""}
            </div>
            {!d.recibos?.length ? <EmptyState title="Sin recibos en el periodo" /> : (
              <TableShell maxH="max-h-[45vh]">
                <thead className={tableCls.thead}>
                  <tr><Th>Fecha</Th><Th>Cliente</Th><Th>Material</Th><Th right>Unidades</Th><Th>ASN</Th><Th>Recibió</Th></tr>
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
              Salidas — pick tickets {d.tickets?.length ? `(${d.tickets.length})` : ""}
            </div>
            {!d.tickets?.length ? <EmptyState title="Sin tickets en el periodo" /> : (
              <TableShell maxH="max-h-[45vh]">
                <thead className={tableCls.thead}>
                  <tr><Th>Creado</Th><Th>Ticket</Th><Th>Orden</Th><Th>Cliente</Th><Th right>Cantidad</Th><Th>Estado</Th><Th>Picker</Th></tr>
                </thead>
                <tbody>
                  {d.tickets.map(t => (
                    <tr key={t.ticket_id} className={tableCls.row}>
                      <td className={`${cls.td} text-xs text-muted-foreground`}>{fmt(t.created_at)}</td>
                      <td className={`${cls.td} font-mono`}>{t.ticket_id}</td>
                      <td className={cls.td}>{t.order_number || "—"}</td>
                      <td className={cls.td}>{t.customer || "—"}</td>
                      <td className={`${cls.td} text-right tabular-nums`}>{num(t.total_pick_qty)}</td>
                      <td className={cls.td}>
                        {t.status === "completed" ? <Chip tone="success">completado</Chip> : <Chip>{t.status || "—"}</Chip>}
                      </td>
                      <td className={cls.td}>{t.assigned_to_name || "—"}</td>
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
            <StatCard label="Recibos forzados" value={num(d.totales?.recibos_forzados)}
              sub="duplicados, sin UPC o fuera de tolerancia" />
            <StatCard label="Tickets fuera de plazo" value={num(d.totales?.tickets_fuera_sla)} />
          </div>

          {(d.totales?.recibos_forzados > 0 || d.totales?.tickets_fuera_sla > 0) && (
            <SoftAlert tone="warning" title="Cada excepción se autorizó por una razón">
              El punto no es una en particular, sino si se están volviendo costumbre en la misma
              persona, cliente o turno.
            </SoftAlert>
          )}

          <Card className="overflow-hidden">
            <div className="px-4 py-3 border-b border-border text-sm font-semibold">Recibos forzados</div>
            {!d.recibos_forzados?.length ? <EmptyState title="Ninguno en el periodo" /> : (
              <TableShell maxH="max-h-[40vh]">
                <thead className={tableCls.thead}>
                  <tr><Th>Fecha</Th><Th>Excepción</Th><Th>Cliente</Th><Th>Material</Th><Th right>Unidades</Th><Th>Recibió</Th></tr>
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
            <div className="px-4 py-3 border-b border-border text-sm font-semibold">Tickets fuera de plazo</div>
            {!d.tickets_fuera_sla?.length ? <EmptyState title="Ninguno en el periodo" /> : (
              <TableShell maxH="max-h-[40vh]">
                <thead className={tableCls.thead}>
                  <tr><Th>Ticket</Th><Th>Situación</Th><Th>Orden</Th><Th>Cliente</Th><Th right>Cantidad</Th><Th>Picker</Th><Th>Vencía</Th></tr>
                </thead>
                <tbody>
                  {d.tickets_fuera_sla.map(t => (
                    <tr key={t.ticket_id} className={tableCls.row}>
                      <td className={`${cls.td} font-mono`}>{t.ticket_id}</td>
                      <td className={cls.td}>
                        <Chip tone={t.situacion === "completado tarde" ? "warning" : "danger"}>{t.situacion}</Chip>
                      </td>
                      <td className={cls.td}>{t.order_number || "—"}</td>
                      <td className={cls.td}>{t.customer || "—"}</td>
                      <td className={`${cls.td} text-right tabular-nums`}>{num(t.total_pick_qty)}</td>
                      <td className={cls.td}>{t.assigned_to_name || "(sin asignar)"}</td>
                      <td className={`${cls.td} text-xs text-muted-foreground`}>{fmt(t.sla_deadline)}</td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            )}
          </Card>

          {d.por_persona?.length > 0 && (
            <Card className="overflow-hidden">
              <div className="px-4 py-3 border-b border-border text-sm font-semibold">Concentración por persona</div>
              <TableShell maxH="max-h-[35vh]">
                <thead className={tableCls.thead}>
                  <tr><Th>Persona</Th><Th right>Recibos forzados</Th><Th right>Tickets tarde</Th></tr>
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
