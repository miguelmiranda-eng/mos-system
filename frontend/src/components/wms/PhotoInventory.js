import { Fragment, useState, useEffect, useCallback, useMemo } from "react";
import { Loader2, RefreshCw, Download, Trash2, Camera, Save, AlertTriangle, X } from "lucide-react";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import { fetcher } from "./lib";
import { Card, StatCard, SoftAlert, Btn, Chip, Th, EmptyState, TableShell, tableCls, cls } from "./ui";

// Inventario por foto — panel PC. El piso captura cartones en /pda-foto (foto de
// la etiqueta → modal editable → renglón). Aquí se revisa, se corrige lo que
// haya quedado mal y se exporta el Excel para sacar el material.

const CAMPOS = [
  { k: "sku", label: "SKU" },
  { k: "style", label: "Style" },
  { k: "color", label: "Color" },
  { k: "size", label: "Talla" },
  { k: "description", label: "Descripción" },
  { k: "country_of_origin", label: "País de origen", aduana: true },
  { k: "fabric_content", label: "Contenido", aduana: true },
  { k: "customer", label: "Cliente" },
  { k: "manufacturer", label: "Fabricante" },
  { k: "dozens", label: "Docenas" },
  { k: "pieces", label: "Piezas" },
];

const fmt = (iso) => {
  if (!iso) return "-";
  const d = new Date(iso);
  return isNaN(d) ? String(iso).slice(0, 16) : d.toLocaleString("es-MX", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
};

// La foto se sirve en /api/uploads (fuera de /api/wms); el backend guarda la URL
// relativa y aquí la volvemos absoluta contra el backend.
const IMG = (u) => (u ? `${process.env.REACT_APP_BACKEND_URL}${u}` : "");

export const PhotoInventoryTab = () => {
  const [container, setContainer] = useState("");
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null);   // line_id abierto
  const [draft, setDraft] = useState({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetcher(`/recon/photo/lines${container ? `?container=${encodeURIComponent(container)}` : ""}`));
    } catch { toast.error("No se pudo cargar el inventario por foto"); }
    finally { setLoading(false); }
  }, [container]);

  useEffect(() => { load(); }, [load]);

  const resumen = data?.resumen || { cartones: 0, unidades: 0, sin_aduana: 0 };
  const lines = useMemo(() => data?.lines || [], [data]);

  const saveLine = async (line) => {
    const d = draft[line.line_id] || {};
    if (!Object.keys(d).length) { setEditing(null); return; }
    setSaving(true);
    try {
      const res = await fetch(`${process.env.REACT_APP_BACKEND_URL}/api/wms/recon/photo/line/${line.line_id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify(d),
      });
      if (res.ok) {
        toast.success(`${line.carton} actualizado`);
        setDraft(p => { const n = { ...p }; delete n[line.line_id]; return n; });
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
    if (!lines.length) { toast.error("No hay cartones capturados"); return; }
    if (resumen.sin_aduana && !window.confirm(
      `${resumen.sin_aduana} cartón(es) sin país de origen o contenido.\n\n` +
      `Esas columnas saldrán vacías en el Excel de salida. ¿Exportar de todos modos?`)) return;

    const wb = XLSX.utils.book_new();
    const cartones = lines.map(l => ({
      Contenedor: l.container, Carton: l.carton, SKU: l.sku || "",
      Style: l.style || "", Color: l.color || "", Talla: l.size || "",
      Descripcion: l.description || "",
      "Pais de origen": l.country_of_origin || "", Contenido: l.fabric_content || "",
      Cliente: l.customer || "", Fabricante: l.manufacturer || "",
      Docenas: l.dozens || "", Piezas: l.pieces || "", Unidades: l.units,
      "Capturado por": l.capturado_por || "", Fecha: fmt(l.created_at),
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cartones), "Cartones");

    // Agrupado por material: la vista que pide el papeleo de salida.
    const grupos = {};
    for (const l of lines) {
      const key = [l.sku, l.style, l.color, l.size, l.country_of_origin].join("|");
      const g = grupos[key] || (grupos[key] = {
        SKU: l.sku || "", Style: l.style || "", Color: l.color || "", Talla: l.size || "",
        "Pais de origen": l.country_of_origin || "", Contenido: l.fabric_content || "",
        Cartones: 0, Unidades: 0,
      });
      g.Cartones += 1; g.Unidades += Number(l.units) || 0;
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(Object.values(grupos)), "Resumen por material");

    const stamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `inventario_foto_${(container || "todos").toLowerCase().replace(/\s+/g, "_")}_${stamp}.xlsx`);
    toast.success(`${cartones.length} cartones exportados`);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <select value={container} onChange={e => setContainer(e.target.value)} className={`${cls.input} w-auto`}>
          <option value="">Todos los contenedores</option>
          {(data?.containers || []).map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <Btn onClick={load} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Actualizar
        </Btn>
        <Btn variant="primary" onClick={exportar} className="ml-auto">
          <Download className="w-4 h-4" /> Exportar Excel
        </Btn>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Cartones" value={resumen.cartones} />
        <StatCard label="Unidades" value={resumen.unidades.toLocaleString()} />
        <StatCard label="Sin datos de salida" value={resumen.sin_aduana}
          sub={resumen.sin_aduana ? "falta país o contenido" : "listo para exportar"} />
      </div>

      {resumen.sin_aduana > 0 && (
        <SoftAlert tone="warning" title={`${resumen.sin_aduana} cartón(es) sin país de origen o contenido`}>
          Son datos de la etiqueta que hacen falta para sacar el material. Ábrelos abajo y complétalos
          antes de exportar.
        </SoftAlert>
      )}

      <Card className="overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <Camera className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Cartones capturados {lines.length ? `(${lines.length})` : ""}</span>
        </div>
        {!lines.length ? (
          <EmptyState title="Sin cartones" hint="El piso los captura desde Inventario por foto en la PDA." />
        ) : (
          <TableShell maxH="max-h-[65vh]">
            <thead className={tableCls.thead}>
              <tr>
                <Th>Foto</Th><Th>Cartón</Th><Th>SKU</Th><Th>Material</Th><Th>País / contenido</Th>
                <Th right>Unidades</Th><Th>Contenedor</Th><Th>Capturado por</Th><Th>Fecha</Th><Th></Th>
              </tr>
            </thead>
            <tbody>
              {lines.map(l => {
                const abierto = editing === l.line_id;
                const d = { ...l, ...(draft[l.line_id] || {}) };
                return (
                  <Fragment key={l.line_id}>
                    <tr className={tableCls.row}>
                      <td className={cls.td}>
                        {l.photo_url ? (
                          <a href={IMG(l.photo_url)} target="_blank" rel="noreferrer" title="Ver foto">
                            <img src={IMG(l.photo_url)} alt="" loading="lazy"
                              className="w-10 h-10 rounded object-cover border border-border" />
                          </a>
                        ) : <span className="text-muted-foreground text-xs">—</span>}
                      </td>
                      <td className={`${cls.td} font-mono`}>{l.carton}</td>
                      <td className={`${cls.td} font-mono`}>{l.sku || <span className="text-muted-foreground">—</span>}</td>
                      <td className={cls.td}>{[l.style, l.color, l.size].filter(Boolean).join(" · ") || <span className="text-muted-foreground">—</span>}</td>
                      <td className={cls.td}>
                        {l.country_of_origin
                          ? <span className="text-xs">{l.country_of_origin}<br /><span className="text-muted-foreground">{l.fabric_content}</span></span>
                          : <Chip tone="warning"><AlertTriangle className="w-3 h-3" /> Falta</Chip>}
                      </td>
                      <td className={`${cls.td} text-right tabular-nums font-semibold`}>{l.units}</td>
                      <td className={cls.td}>{l.container}</td>
                      <td className={cls.td}>{l.capturado_por}</td>
                      <td className={`${cls.td} text-xs text-muted-foreground`}>{fmt(l.created_at)}</td>
                      <td className={`${cls.td} whitespace-nowrap`}>
                        <Btn onClick={() => setEditing(abierto ? null : l.line_id)}>
                          {abierto ? <X className="w-4 h-4" /> : "Editar"}
                        </Btn>
                        <Btn variant="danger" className="ml-1" onClick={() => delLine(l)}><Trash2 className="w-4 h-4" /></Btn>
                      </td>
                    </tr>
                    {abierto && (
                      <tr className="border-b border-border/60 bg-muted/30">
                        <td colSpan={10} className="px-4 py-3">
                          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                            <div>
                              <label className="block text-xs font-medium text-muted-foreground mb-1">Unidades</label>
                              <input type="number" min="1" className={cls.input} value={d.units ?? ""}
                                onChange={e => setDraft(p => ({ ...p, [l.line_id]: { ...(p[l.line_id] || {}), units: e.target.value } }))} />
                            </div>
                            {CAMPOS.map(campo => (
                              <div key={campo.k}>
                                <label className="block text-xs font-medium text-muted-foreground mb-1">
                                  {campo.label}{campo.aduana && <span className="text-amber-600 dark:text-amber-400"> *</span>}
                                </label>
                                <input className={cls.input} value={d[campo.k] || ""}
                                  onChange={e => setDraft(p => ({ ...p, [l.line_id]: { ...(p[l.line_id] || {}), [campo.k]: e.target.value } }))} />
                              </div>
                            ))}
                            <div className="col-span-2 sm:col-span-3 lg:col-span-6">
                              <Btn variant="primary" onClick={() => saveLine(l)} disabled={saving}>
                                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Guardar cartón
                              </Btn>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
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
