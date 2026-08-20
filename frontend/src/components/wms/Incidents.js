import { useState, useEffect, useCallback, useMemo } from "react";
import { toast } from "sonner";
import {
  ShieldAlert, RefreshCw, CheckCircle2, Filter, Loader2, PackageX,
  Scale, Copy, ShieldCheck, ChevronDown, ChevronRight, SearchX, ScanBarcode,
} from "lucide-react";
import { fetcher, poster, logLoadError } from "./lib";
import { SoftAlert, Btn, Chip, ModuleToolbar } from "./ui";

// Módulo de Incidencias de inventario · SOLO supersu.
//
// `wms_incidents` se llenaba desde 2026-07 pero nadie la leía: ni endpoint, ni
// pantalla, ni reporte. Un registro que nadie abre no sirve de nada. Esta
// pantalla lo hace visible para que un descuadre se sepa el mismo día y no por
// casualidad, semanas después, en la pantalla de ubicaciones.

const TIPOS = {
  inventory_conservation_violation: {
    label: "Descuadre de inventario",
    detalle: "Un movimiento dejó el inventario descuadrado. Es lo más grave que puede aparecer aquí.",
    icon: Scale, tono: "text-red-700 bg-red-50 border-red-200 dark:text-red-300 dark:bg-red-500/10 dark:border-red-500/25", gravedad: 0,
  },
  material_no_encontrado: {
    label: "Material no encontrado",
    detalle: "El sistema no encontró el inventario del material en esa ubicación y DETUVO la operación. "
      + "Antes habría seguido de largo e inventado inventario en el destino. Hay que revisar la ubicación.",
    icon: SearchX, tono: "text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-500/10 dark:border-amber-500/25", gravedad: 0,
  },
  material_duplicado: {
    label: "Material duplicado en la ubicación",
    detalle: "Hay más de una fila de inventario para el mismo material y lote. El movimiento se bloqueó "
      + "para no propagar el duplicado. Requiere reconciliación.",
    icon: Copy, tono: "text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-500/10 dark:border-amber-500/25", gravedad: 1,
  },
  picking_sin_fila_inventario: {
    label: "Picking sin renglón de resumen",
    detalle: "El material SÍ existe: el picker surtió una caja real y la caja se descontó bien. Lo que no "
      + "existe es el RENGLÓN de resumen de ese material y lote en esa ubicación (suele estar mal "
      + "etiquetado de país), así que el saldo quedó sin actualizar y la ubicación queda descuadrada. "
      + "Se repara reproyectando la ubicación desde sus cajas.",
    icon: SearchX, tono: "text-red-700 bg-red-50 border-red-200 dark:text-red-300 dark:bg-red-500/10 dark:border-red-500/25", gravedad: 0,
  },
  picking_sin_caja_de_respaldo: {
    label: "Picking sin caja de respaldo",
    detalle: "Se descontó saldo directo de la fila de inventario, sin ninguna caja detrás (saldo heredado "
      + "de Excel). La ubicación queda con menos inventario del que sus cajas justifican.",
    icon: PackageX, tono: "text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-500/10 dark:border-amber-500/25", gravedad: 1,
  },
  recepcion_upc_no_coincide: {
    label: "Recepción · UPC no coincide",
    detalle: "El UPC escaneado pertenece a otro estilo, color o talla. Se bloqueó la recepción: "
      + "recibirlo habría metido el material con la identidad equivocada.",
    icon: ScanBarcode, tono: "text-red-700 bg-red-50 border-red-200 dark:text-red-300 dark:bg-red-500/10 dark:border-red-500/25", gravedad: 1,
  },
  recepcion_asn_cerrado: {
    label: "Recepción · ASN cerrado",
    detalle: "Se intentó recibir contra un ASN que ya cerró su recibo.",
    icon: PackageX, tono: "text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-500/10 dark:border-amber-500/25", gravedad: 2,
  },
  recon_pending_written_off: {
    label: "Faltantes dados de baja",
    detalle: "Cajas no encontradas en el conteo, dadas de baja tras confirmación del segundo conteo.",
    icon: PackageX, tono: "text-blue-700 bg-blue-50 border-blue-200 dark:text-blue-300 dark:bg-blue-500/10 dark:border-blue-500/25", gravedad: 3,
  },
  inventory_reprojected: {
    label: "Inventario reproyectado",
    detalle: "Las filas de la ubicación se recalcularon desde las cajas físicas.",
    icon: RefreshCw, tono: "text-blue-700 bg-blue-50 border-blue-200 dark:text-blue-300 dark:bg-blue-500/10 dark:border-blue-500/25", gravedad: 3,
  },
  duplicate_blocked_by_index: {
    label: "Duplicado bloqueado",
    detalle: "La base de datos impidió crear un inventario duplicado. El dato quedó sano; falta migrar ese punto del sistema.",
    icon: ShieldCheck, tono: "text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-500/10 dark:border-amber-500/25", gravedad: 1,
  },
  duplicate_rows_merged: {
    label: "Filas duplicadas fusionadas",
    detalle: "Se consolidaron filas duplicadas del mismo material y lote.",
    icon: Copy, tono: "text-blue-700 bg-blue-50 border-blue-200 dark:text-blue-300 dark:bg-blue-500/10 dark:border-blue-500/25", gravedad: 2,
  },
  orphan_boxes_reconciled: {
    label: "Cajas huérfanas reconciliadas",
    detalle: "Había cajas físicas sin fila de inventario; se reconstruyó desde las cajas.",
    icon: PackageX, tono: "text-blue-700 bg-blue-50 border-blue-200 dark:text-blue-300 dark:bg-blue-500/10 dark:border-blue-500/25", gravedad: 3,
  },
};
const META = (k) => TIPOS[k] || {
  label: k, detalle: "", icon: ShieldAlert,
  tono: "text-foreground/70 bg-muted border-border", gravedad: 9,
};

const fecha = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString("es-MX", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
};

function Detalle({ inc }) {
  // Los campos varían por tipo; se muestran los relevantes y el resto en crudo.
  // Los OBJETOS se aplanan un nivel (context.to, context.sources…): el descuadre
  // de conservación guardaba ubicación/cajas dentro de `context` y la pantalla
  // los ocultaba — "esta falta de información", reclamo literal del usuario.
  const omitir = new Set(["incident_id", "kind", "created_at", "user_id", "user_name",
    "resolved_at", "resolved_by", "resolution_note"]);
  const campos = Object.entries(inc).flatMap(([k, v]) => {
    if (omitir.has(k) || v === null || v === undefined || v === "") return [];
    if (Array.isArray(v)) return [[k, v.join(", ")]];
    if (typeof v === "object") {
      return Object.entries(v)
        .filter(([, vv]) => vv !== null && vv !== undefined && vv !== "")
        .map(([kk, vv]) => [`${k}.${kk}`,
          Array.isArray(vv) ? vv.join(", ") : (typeof vv === "object" ? JSON.stringify(vv) : vv)]);
    }
    return [[k, v]];
  });
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 px-4 pb-4 pt-1">
      {campos.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <div className="text-xs font-medium text-muted-foreground">{k}</div>
          <div className="text-sm font-mono break-words">{String(v)}</div>
        </div>
      ))}
    </div>
  );
}

export default function Incidents() {
  const [data, setData] = useState({ items: [], summary: [] });
  const [cargando, setCargando] = useState(true);
  const [dias, setDias] = useState(30);
  const [tipo, setTipo] = useState("");
  const [soloPendientes, setSoloPendientes] = useState(false);
  const [abierta, setAbierta] = useState(null);
  const [resolviendo, setResolviendo] = useState(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const qs = new URLSearchParams({ days: String(dias), limit: "300" });
      if (tipo) qs.set("kind", tipo);
      if (soloPendientes) qs.set("unresolved_only", "true");
      setData(await fetcher(`/incidents?${qs.toString()}`));
    } catch (e) {
      logLoadError("incidencias")(e);
      toast.error("No se pudieron cargar las incidencias");
    } finally {
      setCargando(false);
    }
  }, [dias, tipo, soloPendientes]);

  useEffect(() => { cargar(); }, [cargar]);

  const marcarAtendida = async (id) => {
    setResolviendo(id);
    try {
      const res = await poster(`/incidents/${encodeURIComponent(id)}/resolve`, {});
      if (res.ok) { toast.success("Incidencia marcada como atendida"); cargar(); }
      else toast.error("No se pudo marcar");
    } catch { toast.error("Error de conexión"); }
    finally { setResolviendo(null); }
  };

  const resumen = useMemo(
    () => [...(data.summary || [])].sort((a, b) => META(a.kind).gravedad - META(b.kind).gravedad),
    [data.summary]
  );
  const criticas = resumen.find(r => r.kind === "inventory_conservation_violation");

  return (
    <div className="h-full overflow-y-auto bg-background text-foreground">
      <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-5">
        <ModuleToolbar
        right={
            <Btn onClick={cargar} disabled={cargando}>
              {cargando ? <Loader2 className="w-4 h-4 animate-spin"
      /> : <RefreshCw className="w-4 h-4" />}
              Actualizar
            </Btn>
          }
        />

        {/* Estado general: lo importante es poder confiar en el "todo bien" */}
        {!cargando && !criticas && (
          <SoftAlert tone="success">
            <span className="font-semibold text-emerald-700 dark:text-emerald-300">Sin descuadres de inventario</span>
            <span className="text-muted-foreground"> en los últimos {dias} días.</span>
          </SoftAlert>
        )}
        {criticas && (
          <SoftAlert tone="danger">
            <span className="font-semibold text-red-700 dark:text-red-300">{criticas.total} descuadre(s) de inventario</span>
            <span className="text-muted-foreground"> — un movimiento creó o destruyó unidades. Revisa de inmediato.</span>
          </SoftAlert>
        )}

        {/* Resumen por tipo */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {resumen.map(r => {
            const m = META(r.kind); const Icon = m.icon;
            const activo = tipo === r.kind;
            return (
              <button key={r.kind} onClick={() => setTipo(activo ? "" : r.kind)}
                className={`text-left p-3 rounded-lg border transition-colors ${m.tono} ${activo ? "ring-2 ring-primary" : ""}`}>
                <div className="flex items-center gap-2 mb-1"><Icon className="w-4 h-4" />
                  <span className="text-xs font-medium truncate">{m.label}</span>
                </div>
                <div className="text-2xl font-semibold tracking-tight tabular-nums">{r.total}</div>
                <div className="text-xs text-muted-foreground">
                  {r.sin_resolver} sin atender · {fecha(r.ultimo)}
                </div>
              </button>
            );
          })}
        </div>

        {/* Filtros */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Filter className="w-4 h-4 text-muted-foreground" />
          {[7, 30, 90].map(d => (
            <button key={d} onClick={() => setDias(d)}
              className={`px-3 py-1.5 rounded-md border font-medium transition-colors ${dias === d ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:text-foreground hover:bg-muted"}`}>
              {d} días
            </button>
          ))}
          <button onClick={() => setSoloPendientes(v => !v)}
            className={`px-3 py-1.5 rounded-md border font-medium transition-colors ${soloPendientes ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:text-foreground hover:bg-muted"}`}>
            Sólo sin atender
          </button>
          {tipo && (
            <button onClick={() => setTipo("")}
              className="px-3 py-1.5 rounded-md border border-border text-muted-foreground font-medium hover:text-foreground hover:bg-muted transition-colors">
              Quitar filtro: {META(tipo).label}
            </button>
          )}
        </div>

        {/* Lista */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          {cargando ? (
            <div className="p-10 text-center text-muted-foreground">
              <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />Cargando…
            </div>
          ) : !data.items.length ? (
            <div className="p-10 text-center text-muted-foreground text-sm">
              No hay incidencias con estos filtros.
            </div>
          ) : data.items.map(inc => {
            const m = META(inc.kind); const Icon = m.icon;
            const abierto = abierta === inc.incident_id;
            const atendida = !!inc.resolved_at;
            return (
              <div key={inc.incident_id} className="border-b border-border/60 last:border-0">
                <div className="flex items-center gap-3 px-4 py-3">
                  <button onClick={() => setAbierta(abierto ? null : inc.incident_id)}
                    className="p-1 text-muted-foreground hover:text-foreground">
                    {abierto ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  </button>
                  <div className={`p-1.5 rounded-md border ${m.tono}`}><Icon className="w-4 h-4" /></div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm truncate">
                      {m.label}
                      {inc.material && <span className="text-muted-foreground font-mono font-normal"> · {inc.material}</span>}
                      {!inc.material && inc.location && <span className="text-muted-foreground font-mono font-normal"> · {inc.location}</span>}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {fecha(inc.created_at)}
                      {inc.user_name ? ` · ${inc.user_name}` : ""}
                      {typeof inc.delta === "number" ? ` · ${inc.delta > 0 ? "+" : ""}${inc.delta} u` : ""}
                    </div>
                  </div>
                  {atendida ? (
                    <Chip tone="success">
                      <CheckCircle2 className="w-3.5 h-3.5" />Atendida
                    </Chip>
                  ) : (
                    <Btn onClick={() => marcarAtendida(inc.incident_id)}
                      disabled={resolviendo === inc.incident_id}>
                      {resolviendo === inc.incident_id ? "…" : "Marcar atendida"}
                    </Btn>
                  )}
                </div>
                {abierto && (
                  <div className="bg-muted/30 border-t border-border/60">
                    <p className="px-4 pt-3 text-xs text-muted-foreground">{m.detalle}</p>
                    <Detalle inc={inc} />
                    {inc.resolution_note && (
                      <p className="px-4 pb-3 text-xs">
                        <span className="text-muted-foreground">Nota: </span>{inc.resolution_note}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground text-center pb-4">
          {data.total} incidencia(s) · últimos {dias} días
        </p>
      </div>
    </div>
  );
}
