import { useState, useEffect, useMemo, useCallback } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Search, Edit2, Trash2, X, Barcode, CheckCircle2, AlertTriangle } from "lucide-react";
import SearchableSelect from "../SearchableSelect";
import { fetcher, poster, putter, deleter, useWmsSizes, useWmsCatalogs, mergeUnique } from "./lib";
import { Btn, cls, EmptyState } from "./ui";

// Validacion GTIN del lado del cliente — mismo criterio que _valid_gtin del
// backend (POST /upc). Adelanta el feedback: el supervisor ve al instante si el
// codigo es un codigo de barras real (digitos, longitud 8/12/13/14 y digito
// verificador que cuadra) antes de mandar. El backend revalida de todos modos.
function validGtin(code) {
  const c = String(code || "").trim();
  if (!/^\d+$/.test(c) || ![8, 12, 13, 14].includes(c.length)) return false;
  const d = c.split("").map(Number);
  const body = d.slice(0, -1).reverse();
  const sum = body.reduce((s, x, i) => s + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === d[d.length - 1];
}

// El UPC es SOLO el SKU: cliente + estilo + color + talla.
const EMPTY = {
  upc: "", customer: "", style: "", color: "", size: "",
};

// Catálogo de UPC para el módulo de Configuración. El supervisor da de alta aquí
// los UPC que el operador escaneará en Receiving; Receiving ya NO deja crearlos.
// Toda la identidad sale de los catálogos curados (dropdowns select-only), igual
// que Receiving — nada de texto libre en los campos de identidad.
export const UpcCatalog = ({ isManager }) => {
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  // Override: el codigo VIENE IMPRESO en la caja pero no pasa el verificador GS1
  // (algunas etiquetas de fabrica, p.ej. Gildan, traen GTIN mal formado).
  const [allowNonCompliant, setAllowNonCompliant] = useState(false);
  // Filtros por columna (client-side, sobre las filas ya cargadas). Refinan lo
  // que trajo el buscador global. "contiene", sin distinguir mayus/minus.
  const [colFilters, setColFilters] = useState({
    customer: "", style: "", color: "", size: "",
  });
  const setF = (k, v) => setColFilters(p => ({ ...p, [k]: v }));
  const clearFilters = () => setColFilters({
    customer: "", style: "", color: "", size: "",
  });

  // Listas curadas para los dropdowns (igual que Receiving).
  const wmsCat = useWmsCatalogs();
  const { all: sizeOptions } = useWmsSizes();
  const [globalOpts, setGlobalOpts] = useState({ customers: [], styles: [], colors: [] });
  const [custStyles, setCustStyles] = useState([]);
  const [custColors, setCustColors] = useState([]);

  useEffect(() => {
    fetcher("/inventory/options?").then(d => setGlobalOpts({
      customers: d?.customers || [], styles: d?.styles || [], colors: d?.colors || [],
    })).catch(() => {});
  }, []);

  // Estilos/colores scopeados al cliente del draft (cliente + globales), igual
  // que Receiving: nunca se ofrece un estilo de OTRO cliente.
  useEffect(() => {
    const c = draft.customer;
    if (!c) { setCustStyles([]); setCustColors([]); return; }
    fetcher(`/catalogs/styles?customer=${encodeURIComponent(c)}`).then(d => setCustStyles(d?.styles || [])).catch(() => setCustStyles([]));
    fetcher(`/catalogs/colors/for-customer?customer=${encodeURIComponent(c)}`).then(d => setCustColors(d?.values || [])).catch(() => setCustColors([]));
  }, [draft.customer]);

  const customerOptions = useMemo(() => mergeUnique(wmsCat.customers, globalOpts.customers), [wmsCat.customers, globalOpts.customers]);
  const styleOptions = useMemo(() => mergeUnique(custStyles, globalOpts.styles), [custStyles, globalOpts.styles]);
  const colorOptions = useMemo(() => mergeUnique(custColors, globalOpts.colors), [custColors, globalOpts.colors]);

  // Aplica los filtros de columna sobre las filas cargadas. "contiene", ci.
  const filteredRows = useMemo(() => {
    const active = Object.entries(colFilters).filter(([, v]) => v.trim());
    if (!active.length) return rows;
    return rows.filter(r => active.every(([k, v]) =>
      String(r[k] ?? "").toLowerCase().includes(v.trim().toLowerCase())));
  }, [rows, colFilters]);
  const filtersActive = Object.values(colFilters).some(v => v.trim());

  const doSearch = useCallback(async (q) => {
    setLoading(true);
    try {
      const qs = q?.trim() ? `?search=${encodeURIComponent(q.trim())}&limit=1000` : "?limit=1000";
      const data = await fetcher(`/upc${qs}`);
      setRows(Array.isArray(data) ? data : []);
    } catch { toast.error("No se pudo cargar el catálogo de UPC"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { const h = setTimeout(() => doSearch(search), 300); return () => clearTimeout(h); }, [search, doSearch]);

  const openCreate = () => { setDraft(EMPTY); setEditMode(false); setAllowNonCompliant(false); setFormOpen(true); };
  const openEdit = (r) => {
    // Solo el SKU es editable; los campos descriptivos viejos no se cargan.
    setDraft({ upc: r.upc || "", customer: r.customer || "", style: r.style || "", color: r.color || "", size: r.size || "" });
    setEditMode(true);
    setAllowNonCompliant(false);
    setFormOpen(true);
  };

  const codeValid = validGtin(draft.upc);
  // Codigo que PARECE de caja: numerico y de longitud GS1 (12-14). Solo estos
  // pueden registrarse con el override si no pasan el verificador — nunca texto.
  const looksLikeBoxCode = /^\d{12,14}$/.test(String(draft.upc || ""));

  // Aviso de duplicado de VARIANTE: un UPC identifica UN estilo+color+talla
  // (el SKU). Si ese trio ya tiene un UPC en el catalogo, crear otro es un
  // duplicado — la causa exacta de los 416 SKUs con multiples UPC que se
  // investigaron. Se avisa (no bloquea: a veces el cliente reasigna codigo),
  // pero el operador ve que ya existe uno.
  const [dupUpc, setDupUpc] = useState(null);
  useEffect(() => {
    const { customer, style, color, size } = draft;
    if (editMode || !style?.trim() || !color?.trim() || !size?.trim()) { setDupUpc(null); return; }
    let alive = true;
    fetcher(`/upc?search=${encodeURIComponent(style.trim())}&limit=200`)
      .then(rows => {
        if (!alive) return;
        const eq = (a, b) => String(a || "").trim().toUpperCase() === String(b || "").trim().toUpperCase();
        const hit = (Array.isArray(rows) ? rows : []).find(r =>
          eq(r.style, style) && eq(r.color, color) && eq(r.size, size) &&
          (!customer || eq(r.customer, customer)) && !eq(r.upc, draft.upc));
        setDupUpc(hit ? hit.upc : null);
      })
      .catch(() => { if (alive) setDupUpc(null); });
    return () => { alive = false; };
  }, [draft.customer, draft.style, draft.color, draft.size, draft.upc, editMode]);

  const save = async () => {
    const code = String(draft.upc || "").trim().toUpperCase();
    if (!code) { toast.error("Captura el UPC"); return; }
    // Override: código impreso en la caja (numérico 12-14) que no pasa el
    // verificador GS1, aceptado solo si el operador marca la casilla.
    const boxOverride = allowNonCompliant && looksLikeBoxCode;
    if (!editMode && !codeValid && !boxOverride) {
      if (looksLikeBoxCode) {
        toast.error("Ese código no pasa el verificador GS1. Si viene impreso en la caja, marca la casilla para registrarlo tal cual.");
      } else {
        toast.error("El UPC no es un código de barras válido (dígitos + verificador). Escanéalo, no lo teclees.");
      }
      return;
    }
    // Identidad del UPC = SKU = estilo + color + talla. Los tres son
    // obligatorios: un UPC sin color o sin talla no identifica una prenda real.
    if (!draft.customer?.trim()) { toast.error("Cliente es obligatorio"); return; }
    if (!draft.style?.trim()) { toast.error("Estilo es obligatorio"); return; }
    if (!draft.color?.trim()) { toast.error("Color es obligatorio (es parte del SKU)"); return; }
    if (!draft.size?.trim()) { toast.error("Talla es obligatoria (es parte del SKU)"); return; }
    if (dupUpc && !window.confirm(
      `Ya existe el UPC ${dupUpc} para ${draft.style}/${draft.color}/${draft.size}. ` +
      `Un SKU normalmente lleva UN solo UPC. ¿Crear otro de todas formas?`)) return;
    setSaving(true);
    try {
      const payload = editMode
        ? { ...draft, upc: code, propagate_to_boxes: true }
        : { ...draft, upc: code, ...(boxOverride ? { allow_noncompliant: true } : {}) };
      const res = editMode
        ? await putter(`/upc/${encodeURIComponent(code)}`, payload)
        : await poster("/upc", payload);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || (editMode ? "No se pudo actualizar" : "No se pudo crear"));
        return;
      }
      toast.success(`UPC ${code} ${editMode ? "actualizado" : "creado"} en el catálogo`);
      setFormOpen(false);
      doSearch(search);
    } catch { toast.error("Error de conexión"); }
    finally { setSaving(false); }
  };

  // Genera un UPC-A interno VALIDO para material sin codigo de fabrica (blanks
  // de importacion, etc.). No teclea texto: el backend arma un GTIN real con
  // prefijo interno (2) + secuencial + verificador, escaneable e imprimible en
  // la etiqueta de caja. Idempotente: si el SKU ya tiene UPC, lo reusa.
  const generateUpc = async () => {
    if (editMode) return;
    if (!draft.customer?.trim()) { toast.error("Elige el cliente primero"); return; }
    if (!draft.style?.trim() || !draft.color?.trim() || !draft.size?.trim()) {
      toast.error("Elige estilo, color y talla primero — son el SKU del UPC");
      return;
    }
    setGenerating(true);
    try {
      const res = await poster("/upc/generate-internal", {
        customer: draft.customer, style: draft.style, color: draft.color, size: draft.size,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || "No se pudo generar el UPC interno");
        return;
      }
      const doc = await res.json();
      setD("upc", doc.upc);
      toast.success(doc.reused
        ? `Ese SKU ya tenía UPC: ${doc.upc} (reusado)`
        : `UPC interno generado: ${doc.upc}`);
    } catch { toast.error("Error de conexión"); }
    finally { setGenerating(false); }
  };

  const remove = async (r) => {
    if (!window.confirm(`¿Eliminar el UPC ${r.upc} del catálogo? Los recibos ya hechos NO se afectan.`)) return;
    try {
      await deleter(`/upc/${encodeURIComponent(r.upc)}`);
      toast.success(`UPC ${r.upc} eliminado`);
      doSearch(search);
    } catch { toast.error("No se pudo eliminar (¿permisos de admin?)"); }
  };

  const setD = (k, v) => setDraft(p => ({ ...p, [k]: v }));

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden" data-testid="upc-catalog">
      <div className="p-5 border-b border-border flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Catálogo de UPC</h2>
          <p className="text-xs text-muted-foreground">Los UPC que el operador escanea en Receiving. Aquí los da de alta el supervisor.</p>
        </div>
        {isManager && (
          <Btn variant="primary" onClick={openCreate} data-testid="upc-cat-new">
            <Plus className="w-4 h-4" /> Nuevo UPC
          </Btn>
        )}
      </div>

      <div className="p-4">
        <div className="relative mb-3">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar por UPC, estilo, color, cliente…"
            className={`${cls.input} pl-10`}
            data-testid="upc-cat-search"
          />
          {loading && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground" />}
        </div>

        {rows.length === 0 ? (
          <EmptyState
            art={search.trim() ? "boxes" : "scan"}
            title={search.trim() ? "Sin resultados" : "Busca un UPC"}
            hint={search.trim()
              ? "Ningún UPC coincide con lo que escribiste."
              : "Escribe el UPC, el estilo, el color o el cliente."}
          />
        ) : (
          <>
          {filtersActive && (
            <div className="flex items-center justify-between mb-2 text-xs text-muted-foreground">
              <span>Mostrando <b>{filteredRows.length}</b> de {rows.length} con filtros de columna</span>
              <button onClick={clearFilters} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground font-medium" data-testid="upc-cat-clear-filters">
                <X className="w-3 h-3" /> Limpiar filtros
              </button>
            </div>
          )}
          <div className="overflow-x-auto custom-scrollbar max-h-[420px] overflow-y-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted/50 border-b border-border z-10">
                <tr className="text-left">
                  {["UPC", "Cliente", "Estilo", "Color", "Talla", ""].map(h => (
                    <th key={h} className="px-2.5 pt-2 pb-1 text-xs font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
                  ))}
                </tr>
                {/* Fila de filtros por columna: contiene, sin distinguir mayúsculas. */}
                <tr>
                  <th className="px-2.5 pb-2"></th>
                  {["customer", "style", "color", "size"].map(k => (
                    <th key={k} className="px-2.5 pb-2">
                      <input
                        value={colFilters[k]}
                        onChange={e => setF(k, e.target.value)}
                        placeholder="Filtrar…"
                        className="w-full min-w-[64px] px-1.5 py-1 bg-card border border-input rounded text-xs font-normal"
                        data-testid={`upc-cat-filter-${k}`}
                      />
                    </th>
                  ))}
                  <th className="px-2.5 pb-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {filteredRows.length === 0 && (
                  <tr><td colSpan={6} className="px-2.5 py-6 text-center text-muted-foreground">Ningún UPC coincide con los filtros.</td></tr>
                )}
                {filteredRows.map(r => {
                  const ok = validGtin(r.upc);
                  return (
                    <tr key={r.upc} className="hover:bg-muted/40 transition-colors">
                      <td className="px-2.5 py-1.5 font-mono font-medium whitespace-nowrap">
                        <span className="inline-flex items-center gap-1">
                          {ok ? <CheckCircle2 className="w-3 h-3 text-emerald-600 dark:text-emerald-400" /> : <AlertTriangle className="w-3 h-3 text-amber-600 dark:text-amber-400" title="No pasa el dígito verificador" />}
                          {r.upc}
                        </span>
                      </td>
                      <td className="px-2.5 py-1.5">{r.customer}</td>
                      <td className="px-2.5 py-1.5 font-medium">{r.style}</td>
                      <td className="px-2.5 py-1.5">{r.color}</td>
                      <td className="px-2.5 py-1.5 font-mono">{r.size}</td>
                      <td className="px-2.5 py-1.5 whitespace-nowrap">
                        {isManager && (
                          <div className="flex items-center gap-1 justify-end">
                            <button onClick={() => openEdit(r)} className="p-1 text-muted-foreground hover:text-primary" title="Editar" data-testid={`upc-cat-edit-${r.upc}`}><Edit2 className="w-3.5 h-3.5" /></button>
                            <button onClick={() => remove(r)} className="p-1 text-muted-foreground hover:text-red-600 dark:hover:text-red-400" title="Eliminar" data-testid={`upc-cat-del-${r.upc}`}><Trash2 className="w-3.5 h-3.5" /></button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
      </div>

      {/* Alta / edición — supervisor. Identidad 100% desde catálogos curados. */}
      {formOpen && (
        <div className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" data-testid="upc-cat-form">
          <div className="w-full max-w-2xl bg-card border border-border rounded-lg shadow-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-border flex items-center justify-between">
              <span className="font-semibold text-sm flex items-center gap-2">
                <Barcode className="w-4 h-4 text-muted-foreground" /> {editMode ? "Editar UPC" : "Nuevo UPC"}
              </span>
              <button onClick={() => setFormOpen(false)} className="p-1 text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 grid grid-cols-2 gap-3 max-h-[65vh] overflow-y-auto custom-scrollbar">
              <div className="col-span-2">
                <label className="text-xs font-medium text-muted-foreground block mb-1">UPC (código de barras) *</label>
                <div className="flex gap-2">
                  <input
                    value={draft.upc}
                    onChange={e => setD("upc", e.target.value.replace(/\s+/g, "").toUpperCase())}
                    disabled={editMode}
                    placeholder="Escanea el código físico"
                    className={`flex-1 px-3 py-2 text-sm bg-card border rounded-md font-mono placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring/25 transition-colors disabled:opacity-60 ${
                      draft.upc ? (codeValid ? "border-emerald-500/50" : "border-amber-500/50") : "border-input"
                    }`}
                    data-testid="upc-cat-draft-upc"
                    autoFocus={!editMode}
                  />
                  {!editMode && (
                    <Btn
                      type="button"
                      onClick={generateUpc}
                      disabled={generating}
                      title="Para material sin código de fábrica: genera un UPC-A interno válido (estilo+color+talla)"
                      className="whitespace-nowrap"
                      data-testid="upc-cat-generate"
                    >
                      {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Barcode className="w-3.5 h-3.5" />}
                      Generar interno
                    </Btn>
                  )}
                </div>
                {draft.upc && !codeValid && !editMode && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" /> No pasa el dígito verificador — {looksLikeBoxCode ? "no es un GTIN válido." : "no es un código de barras real. Escanéalo, no lo teclees."}
                  </p>
                )}
                {/* Override: solo para códigos numéricos 12-14 que vienen impresos
                    en la caja pero no cumplen el checksum (GTIN de fábrica mal
                    formado). El texto libre (ICEBLUE2X) nunca llega aquí. */}
                {draft.upc && !codeValid && looksLikeBoxCode && !editMode && (
                  <label className="mt-2 flex items-start gap-2 p-2 rounded-lg border bg-amber-50 border-amber-200/70 dark:bg-amber-500/10 dark:border-amber-500/25 cursor-pointer" data-testid="upc-cat-noncompliant">
                    <input
                      type="checkbox"
                      checked={allowNonCompliant}
                      onChange={e => setAllowNonCompliant(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span className="text-xs text-amber-700 dark:text-amber-300 leading-snug">
                      <b>Este código viene impreso en la caja</b> aunque no pase el verificador
                      (algunas etiquetas de fábrica traen el GTIN mal formado). Regístralo tal
                      cual para poder escanear la caja como viene.
                    </span>
                  </label>
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  El UPC identifica una variante única: <b>estilo + color + talla</b> (el SKU). Los tres son obligatorios.
                  Si el material <b>no trae código de fábrica</b> (blank de importación), usa <b>Generar interno</b>.
                </p>
                {dupUpc && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1 flex items-start gap-1" data-testid="upc-cat-dup-warn">
                    <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                    <span>Ya existe el UPC <span className="font-mono font-medium">{dupUpc}</span> para {draft.style}/{draft.color}/{draft.size}. Un SKU normalmente lleva un solo UPC.</span>
                  </p>
                )}
              </div>
              <div className="col-span-2">
                <label className="text-xs font-medium text-muted-foreground block mb-1">Cliente *</label>
                <SearchableSelect options={customerOptions} value={draft.customer} onChange={v => setDraft(p => ({ ...p, customer: v, style: "", color: "" }))} placeholder="Cliente…" testId="upc-cat-draft-customer" allowCreate={false} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Estilo *</label>
                <SearchableSelect options={styleOptions} value={draft.style} onChange={v => setD("style", v)} placeholder={draft.customer ? "Estilo…" : "Elige cliente primero"} testId="upc-cat-draft-style" allowCreate={false} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Color *</label>
                <SearchableSelect options={colorOptions} value={draft.color} onChange={v => setD("color", v)} placeholder="Color…" testId="upc-cat-draft-color" allowCreate={false} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">Talla *</label>
                <select value={draft.size} onChange={e => setD("size", e.target.value)} className="w-full px-3 py-2 bg-card border border-input rounded-md text-sm font-mono" data-testid="upc-cat-draft-size">
                  <option value="">—</option>
                  {sizeOptions.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              {/* El UPC es SOLO el SKU: cliente + estilo + color + talla. País,
                  descripción, tela y fabricante NO son parte del UPC — son
                  metadata del embarque y las provee el ASN en Receiving. */}
            </div>
            <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
              <Btn onClick={() => setFormOpen(false)}>Cancelar</Btn>
              <Btn variant="primary" onClick={save} disabled={saving} data-testid="upc-cat-save">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                {editMode ? "Guardar" : "Crear UPC"}
              </Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
