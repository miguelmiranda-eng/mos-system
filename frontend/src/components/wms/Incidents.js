import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import {
  ShieldAlert, RefreshCw, CheckCircle2, Filter, Loader2, PackageX,
  Scale, Copy, ShieldCheck, ChevronDown, ChevronRight, SearchX, ScanBarcode,
} from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, poster, logLoadError } from "./lib";
import { SoftAlert, Btn, Chip, ModuleToolbar } from "./ui";

// Módulo de Incidencias de inventario · SOLO supersu.
//
// `wms_incidents` se llenaba desde 2026-07 pero nadie la leía: ni endpoint, ni
// pantalla, ni reporte. Un registro que nadie abre no sirve de nada. Esta
// pantalla lo hace visible para que un descuadre se sepa el mismo día y no por
// casualidad, semanas después, en la pantalla de ubicaciones.
//
// La llave (kind) es valor de dominio y se compara/guarda tal cual; solo la
// etiqueta y el detalle se traducen (labelKey / detalleKey → t()).

const TIPOS = {
  inventory_conservation_violation: {
    labelKey: "wms_inc_t_conservation", detalleKey: "wms_inc_d_conservation",
    icon: Scale, tono: "text-red-700 bg-red-50 border-red-200 dark:text-red-300 dark:bg-red-500/10 dark:border-red-500/25", gravedad: 0,
  },
  material_no_encontrado: {
    labelKey: "wms_inc_t_material_not_found", detalleKey: "wms_inc_d_material_not_found",
    icon: SearchX, tono: "text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-500/10 dark:border-amber-500/25", gravedad: 0,
  },
  material_duplicado: {
    labelKey: "wms_inc_t_material_dup", detalleKey: "wms_inc_d_material_dup",
    icon: Copy, tono: "text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-500/10 dark:border-amber-500/25", gravedad: 1,
  },
  picking_sin_fila_inventario: {
    labelKey: "wms_inc_t_pick_no_row", detalleKey: "wms_inc_d_pick_no_row",
    icon: SearchX, tono: "text-red-700 bg-red-50 border-red-200 dark:text-red-300 dark:bg-red-500/10 dark:border-red-500/25", gravedad: 0,
  },
  picking_sin_caja_de_respaldo: {
    labelKey: "wms_inc_t_pick_no_box", detalleKey: "wms_inc_d_pick_no_box",
    icon: PackageX, tono: "text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-500/10 dark:border-amber-500/25", gravedad: 1,
  },
  recepcion_upc_no_coincide: {
    labelKey: "wms_inc_t_rcv_upc_mismatch", detalleKey: "wms_inc_d_rcv_upc_mismatch",
    icon: ScanBarcode, tono: "text-red-700 bg-red-50 border-red-200 dark:text-red-300 dark:bg-red-500/10 dark:border-red-500/25", gravedad: 1,
  },
  recepcion_asn_cerrado: {
    labelKey: "wms_inc_t_rcv_asn_closed", detalleKey: "wms_inc_d_rcv_asn_closed",
    icon: PackageX, tono: "text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-500/10 dark:border-amber-500/25", gravedad: 2,
  },
  recon_pending_written_off: {
    labelKey: "wms_inc_t_written_off", detalleKey: "wms_inc_d_written_off",
    icon: PackageX, tono: "text-blue-700 bg-blue-50 border-blue-200 dark:text-blue-300 dark:bg-blue-500/10 dark:border-blue-500/25", gravedad: 3,
  },
  inventory_reprojected: {
    labelKey: "wms_inc_t_reprojected", detalleKey: "wms_inc_d_reprojected",
    icon: RefreshCw, tono: "text-blue-700 bg-blue-50 border-blue-200 dark:text-blue-300 dark:bg-blue-500/10 dark:border-blue-500/25", gravedad: 3,
  },
  duplicate_blocked_by_index: {
    labelKey: "wms_inc_t_dup_blocked", detalleKey: "wms_inc_d_dup_blocked",
    icon: ShieldCheck, tono: "text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-500/10 dark:border-amber-500/25", gravedad: 1,
  },
  duplicate_rows_merged: {
    labelKey: "wms_inc_t_dup_merged", detalleKey: "wms_inc_d_dup_merged",
    icon: Copy, tono: "text-blue-700 bg-blue-50 border-blue-200 dark:text-blue-300 dark:bg-blue-500/10 dark:border-blue-500/25", gravedad: 2,
  },
  orphan_boxes_reconciled: {
    labelKey: "wms_inc_t_orphan_reconciled", detalleKey: "wms_inc_d_orphan_reconciled",
    icon: PackageX, tono: "text-blue-700 bg-blue-50 border-blue-200 dark:text-blue-300 dark:bg-blue-500/10 dark:border-blue-500/25", gravedad: 3,
  },
};
// Tipo desconocido: se muestra la llave cruda (sin labelKey) y sin detalle.
const META = (k) => TIPOS[k] || {
  rawLabel: k, icon: ShieldAlert,
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
  const { t } = useLang();
  // `cargar` va en las deps del useEffect de carga: se usa un ref para que un
  // cambio de idioma no dispare otro fetch.
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);
  const [data, setData] = useState({ items: [], summary: [] });
  const [cargando, setCargando] = useState(true);
  const [dias, setDias] = useState(30);
  const [tipo, setTipo] = useState("");
  const [soloPendientes, setSoloPendientes] = useState(false);
  const [abierta, setAbierta] = useState(null);
  const [resolviendo, setResolviendo] = useState(null);

  const label = (m) => (m.labelKey ? t(m.labelKey) : m.rawLabel);
  const detalle = (m) => (m.detalleKey ? t(m.detalleKey) : "");

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const qs = new URLSearchParams({ days: String(dias), limit: "300" });
      if (tipo) qs.set("kind", tipo);
      if (soloPendientes) qs.set("unresolved_only", "true");
      setData(await fetcher(`/incidents?${qs.toString()}`));
    } catch (e) {
      logLoadError("incidencias")(e);
      toast.error(tRef.current("wms_inc_load_err"));
    } finally {
      setCargando(false);
    }
  }, [dias, tipo, soloPendientes]);

  useEffect(() => { cargar(); }, [cargar]);

  const marcarAtendida = async (id) => {
    setResolviendo(id);
    try {
      const res = await poster(`/incidents/${encodeURIComponent(id)}/resolve`, {});
      if (res.ok) { toast.success(t("wms_inc_marked")); cargar(); }
      else toast.error(t("wms_inc_mark_err"));
    } catch { toast.error(t("wms_conn_error")); }
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
              {t("wms_refresh")}
            </Btn>
          }
        />

        {/* Estado general: lo importante es poder confiar en el "todo bien" */}
        {!cargando && !criticas && (
          <SoftAlert tone="success">
            <span className="font-semibold text-emerald-700 dark:text-emerald-300">{t("wms_inc_no_mismatch")}</span>
            <span className="text-muted-foreground"> {t("wms_inc_in_last_days", { n: dias })}</span>
          </SoftAlert>
        )}
        {criticas && (
          <SoftAlert tone="danger">
            <span className="font-semibold text-red-700 dark:text-red-300">{t("wms_inc_mismatch_count", { n: criticas.total })}</span>
            <span className="text-muted-foreground"> {t("wms_inc_mismatch_detail")}</span>
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
                  <span className="text-xs font-medium truncate">{label(m)}</span>
                </div>
                <div className="text-2xl font-semibold tracking-tight tabular-nums">{r.total}</div>
                <div className="text-xs text-muted-foreground">
                  {t("wms_inc_unattended_n", { n: r.sin_resolver })} · {fecha(r.ultimo)}
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
              {t("wms_inc_days_n", { n: d })}
            </button>
          ))}
          <button onClick={() => setSoloPendientes(v => !v)}
            className={`px-3 py-1.5 rounded-md border font-medium transition-colors ${soloPendientes ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:text-foreground hover:bg-muted"}`}>
            {t("wms_inc_only_unattended")}
          </button>
          {tipo && (
            <button onClick={() => setTipo("")}
              className="px-3 py-1.5 rounded-md border border-border text-muted-foreground font-medium hover:text-foreground hover:bg-muted transition-colors">
              {t("wms_inc_remove_filter", { label: label(META(tipo)) })}
            </button>
          )}
        </div>

        {/* Lista */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          {cargando ? (
            <div className="p-10 text-center text-muted-foreground">
              <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />{t("loading")}
            </div>
          ) : !data.items.length ? (
            <div className="p-10 text-center text-muted-foreground text-sm">
              {t("wms_inc_none_filters")}
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
                      {label(m)}
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
                      <CheckCircle2 className="w-3.5 h-3.5" />{t("wms_inc_attended")}
                    </Chip>
                  ) : (
                    <Btn onClick={() => marcarAtendida(inc.incident_id)}
                      disabled={resolviendo === inc.incident_id}>
                      {resolviendo === inc.incident_id ? "…" : t("wms_inc_mark_attended")}
                    </Btn>
                  )}
                </div>
                {abierto && (
                  <div className="bg-muted/30 border-t border-border/60">
                    <p className="px-4 pt-3 text-xs text-muted-foreground">{detalle(m)}</p>
                    <Detalle inc={inc} />
                    {inc.resolution_note && (
                      <p className="px-4 pb-3 text-xs">
                        <span className="text-muted-foreground">{t("wms_inc_note")} </span>{inc.resolution_note}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground text-center pb-4">
          {t("wms_inc_footer", { n: data.total, days: dias })}
        </p>
      </div>
    </div>
  );
}
