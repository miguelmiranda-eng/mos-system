import { useState, useEffect, useCallback, useMemo } from "react";
import { Loader2, RefreshCw, Download, Trash2, Camera, Save, AlertTriangle } from "lucide-react";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import { fetcher, poster, useWmsCatalogs, mergeUnique } from "./lib";
import { Card, StatCard, SoftAlert, Btn, Chip, Th, EmptyState, TableShell, tableCls, cls } from "./ui";

// Inventario por foto — panel PC. El piso captura cartones en /pda-foto (foto de
// la etiqueta -> barcodes -> cantidad). Aquí se completa el material de cada SKU
// (país y contenido, que NO viajan en barcode y hacen falta para sacar el
// material) y se exporta el Excel.

const CAMPOS = [
  { k: "style", label: "Style" },
  { k: "color", label: "Color" },
  { k: "size", label: "Talla" },
  { k: "description", label: "Descripción" },
  { k: "country_of_origin", label: "País de origen", req: true, cat: "countries" },
  { k: "fabric_content", label: "Contenido", req: true, cat: "fabrics" },
  { k: "customer", label: "Cliente", cat: "customers" },
  { k: "manufacturer", label: "Fabricante", cat: "manufacturers" },
];

const fmt = (iso) => {
  if (!iso) return "-";
  const d = new Date(iso);
  return isNaN(d) ? String(iso).slice(0, 16) : d.toLocaleString("es-MX", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
};

export const PhotoInventoryTab = () => {
  const [lote, setLote] = useState("");
  const [data, setData] = useState(null);
  const [skus, setSkus] = useState([]);
  const [draft, setDraft] = useState({});      // sku -> campos editados sin guardar
  const [editing, setEditing] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const catalogs = useWmsCatalogs();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, s] = await Promise.all([
        fetcher(`/recon/photo/lines${lote ? `?lote=${encodeURIComponent(lote)}` : ""}`),
        fetcher("/recon/photo/skus"),
      ]);
      setData(d); setSkus(s.skus || []);
    } catch { toast.error("No se pudo cargar el inventario por foto"); }
    finally { setLoading(false); }
  }, [lote]);

  useEffect(() => { load(); }, [load]);

  const resumen = data?.resumen || { cartones: 0, unidades: 0, skus: 0, skus_sin_catalogar: [] };
  const pendientes = resumen.skus_sin_catalogar || [];
  const catBySku = useMemo(() => Object.fromEntries(skus.map(s => [s.sku, s])), [skus]);

  // Todo SKU visto en los renglones, esté o no catalogado: los pendientes son
  // justo los que hay que llenar, así que tienen que aparecer en la lista.
  const skusEnLista = useMemo(() => {
    const vistos = [...new Set((data?.lines || []).map(l => l.sku).filter(Boolean))].sort();
    return vistos.map(sku => catBySku[sku] || { sku, completo: false });
  }, [data, catBySku]);

  const opciones = (campo) => {
    if (campo.cat === "countries") return mergeUnique(catalogs.countries);
    if (campo.cat === "fabrics") return mergeUnique(catalogs.fabrics);
    if (campo.cat === "customers") return mergeUnique(catalogs.customers);
    if (campo.cat === "manufacturers") return mergeUnique(catalogs.manufacturers);
    return [];
  };

  const saveSku = async (sku) => {
    const d = { ...(catBySku[sku] || {}), ...(draft[sku] || {}), sku };
    setSaving(true);
    try {
      const res = await poster("/recon/photo/sku", d);
      if (res.ok) {
        toast.success(`SKU ${sku} guardado`);
        setDraft(p => { const n = { ...p }; delete n[sku]; return n; });
        setEditing(null); load();
      } else {
        const e = await res.json().catch(() => ({}));
        toast.error(e.detail || "No se pudo guardar");
      }
    } catch { toast.error("Error de conexión"); }
    finally { setSaving(false); }
  };

  const delLine = async (line) => {
    if (!window.confirm(`¿Borrar el cartón ${line.carton} (${line.units} u)?`)) return;
    try {
      const res = await fetch(`${process.env.REACT_APP_BACKEND_URL}/api/wms/recon/photo/line/${line.line_id}`,
        { method: "DELETE", credentials: "include" });
      if (res.ok) { toast.success("Renglón borrado"); load(); }
      else { const e = await res.json().catch(() => ({})); toast.error(e.detail || "No se pudo borrar"); }
    } catch { toast.error("Error de conexión"); }
  };

  const exportar = () => {
    const lines = data?.lines || [];
    if (!lines.length) { toast.error("No hay cartones capturados"); return; }
    if (pendientes.length && !window.confirm(
      `${pendientes.length} SKU sin país de origen / contenido:\n${pendientes.join(", ")}\n\n` +
      `Esas columnas saldrán vacías en el Excel. ¿Exportar de todos modos?`)) return;

    const wb = XLSX.utils.book_new();
    const cartones = lines.map(l => {
      const m = catBySku[l.sku] || l.sku_info || {};
      return {
        Lote: l.lote, Carton: l.carton, SKU: l.sku,
        Style: m.style || "", Color: m.color || "", Talla: m.size || "",
        Descripcion: m.description || "",
        "Pais de origen": m.country_of_origin || "", Contenido: m.fabric_content || "",
        Cliente: m.customer || "", Fabricante: m.manufacturer || "",
        Unidades: l.units,
        "Capturado por": l.capturado_por || "", Fecha: fmt(l.created_at),
      };
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cartones), "Cartones");

    // Agrupado por SKU: es la vista que pide el papeleo de salida.
    const porSku = {};
    for (const l of lines) {
      const m = catBySku[l.sku] || l.sku_info || {};
      const g = porSku[l.sku] || (porSku[l.sku] = {
        SKU: l.sku, Style: m.style || "", Color: m.color || "", Talla: m.size || "",
        "Pais de origen": m.country_of_origin || "", Contenido: m.fabric_content || "",
        Cartones: 0, Unidades: 0,
      });
      g.Cartones += 1; g.Unidades += Number(l.units) || 0;
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(Object.values(porSku)), "Resumen por SKU");

    const stamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `inventario_foto_${(lote || "todos").toLowerCase()}_${stamp}.xlsx`);
    toast.success(`${cartones.length} cartones exportados`);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <select value={lote} onChange={e => setLote(e.target.value)} className={`${cls.input} w-auto`}>
          <option value="">Todos los lotes</option>
          {(data?.lotes || []).map(l => <option key={l} value={l}>{l}</option>)}
        </select>
        <Btn onClick={load} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Actualizar
        </Btn>
        <Btn variant="primary" onClick={exportar} className="ml-auto">
          <Download className="w-4 h-4" /> Exportar Excel
        </Btn>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Cartones" value={resumen.cartones} />
        <StatCard label="Unidades" value={resumen.unidades.toLocaleString()} />
        <StatCard label="SKU distintos" value={resumen.skus} />
        <StatCard label="SKU sin catalogar" value={pendientes.length}
          sub={pendientes.length ? "faltan país y contenido" : "listo para exportar"} />
      </div>

      {pendientes.length > 0 && (
        <SoftAlert tone="warning" title={`${pendientes.length} SKU sin país de origen o contenido`}>
          Sin esos datos el Excel sale incompleto para sacar el material. Llénalos abajo:
          se capturan una sola vez por SKU y aplican a todos sus cartones.
        </SoftAlert>
      )}

      {/* ── Catálogo de material por SKU ── */}
      <Card className="overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <Camera className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Material por SKU</span>
          <span className="text-xs text-muted-foreground">— se captura una vez y aplica a todos los cartones de ese SKU</span>
        </div>
        {skusEnLista.length === 0 ? (
          <EmptyState title="Todavía no hay SKU capturados" hint="Aparecen conforme el piso fotografía cartones." />
        ) : (
          <div className="divide-y divide-border/60">
            {skusEnLista.map(s => {
              const abierto = editing === s.sku;
              const d = { ...s, ...(draft[s.sku] || {}) };
              return (
                <div key={s.sku} className="px-4 py-3">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="font-mono text-sm font-semibold">{s.sku}</span>
                    {s.completo
                      ? <Chip tone="success">Completo</Chip>
                      : <Chip tone="warning"><AlertTriangle className="w-3 h-3" /> Falta país / contenido</Chip>}
                    <span className="text-xs text-muted-foreground truncate">
                      {[s.style, s.color, s.size].filter(Boolean).join(" · ")}
                      {s.country_of_origin ? ` — ${s.country_of_origin}` : ""}
                    </span>
                    <Btn className="ml-auto" onClick={() => setEditing(abierto ? null : s.sku)}>
                      {abierto ? "Cerrar" : "Editar"}
                    </Btn>
                  </div>
                  {abierto && (
                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                      {CAMPOS.map(campo => {
                        const opts = opciones(campo);
                        return (
                          <div key={campo.k}>
                            <label className="block text-xs font-medium text-muted-foreground mb-1">
                              {campo.label}{campo.req && <span className="text-red-500"> *</span>}
                            </label>
                            <input list={opts.length ? `pi-${campo.k}` : undefined}
                              className={cls.input} value={d[campo.k] || ""}
                              onChange={e => setDraft(p => ({ ...p, [s.sku]: { ...(p[s.sku] || {}), [campo.k]: e.target.value } }))} />
                            {opts.length > 0 && (
                              <datalist id={`pi-${campo.k}`}>
                                {opts.map(o => <option key={o} value={o} />)}
                              </datalist>
                            )}
                          </div>
                        );
                      })}
                      <div className="sm:col-span-2 lg:col-span-4">
                        <Btn variant="primary" onClick={() => saveSku(s.sku)} disabled={saving}>
                          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Guardar SKU
                        </Btn>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* ── Cartones capturados ── */}
      <Card className="overflow-hidden">
        <div className="px-4 py-3 border-b border-border text-sm font-semibold">
          Cartones capturados {data?.lines?.length ? `(${data.lines.length})` : ""}
        </div>
        {!data?.lines?.length ? (
          <EmptyState title="Sin cartones" hint="El piso los captura desde Inventario por foto en la PDA." />
        ) : (
          <TableShell maxH="max-h-[60vh]">
            <thead className={tableCls.thead}>
              <tr>
                <Th>Cartón</Th><Th>SKU</Th><Th>Material</Th><Th>País / contenido</Th>
                <Th right>Unidades</Th><Th>Lote</Th><Th>Capturado por</Th><Th>Fecha</Th><Th></Th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map(l => {
                const m = catBySku[l.sku] || l.sku_info || {};
                return (
                  <tr key={l.line_id} className={tableCls.row}>
                    <td className={`${cls.td} font-mono`}>{l.carton}</td>
                    <td className={`${cls.td} font-mono`}>{l.sku}</td>
                    <td className={cls.td}>{[m.style, m.color, m.size].filter(Boolean).join(" · ") || <span className="text-muted-foreground">—</span>}</td>
                    <td className={cls.td}>
                      {m.country_of_origin
                        ? <span className="text-xs">{m.country_of_origin}<br /><span className="text-muted-foreground">{m.fabric_content}</span></span>
                        : <Chip tone="warning">Falta</Chip>}
                    </td>
                    <td className={`${cls.td} text-right tabular-nums font-semibold`}>{l.units}</td>
                    <td className={cls.td}>{l.lote}</td>
                    <td className={cls.td}>{l.capturado_por}</td>
                    <td className={`${cls.td} text-xs text-muted-foreground`}>{fmt(l.created_at)}</td>
                    <td className={cls.td}>
                      <Btn variant="danger" onClick={() => delLine(l)}><Trash2 className="w-4 h-4" /></Btn>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableShell>
        )}
      </Card>
    </div>
  );
};

export default PhotoInventoryTab;
