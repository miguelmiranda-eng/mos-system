import { useState, useEffect, useMemo, useCallback } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Search, Edit2, Trash2, X, Barcode, CheckCircle2, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import SearchableSelect from "../SearchableSelect";
import { fetcher, poster, putter, deleter, useWmsSizes, useWmsCatalogs, mergeUnique } from "./lib";

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

const EMPTY = {
  upc: "", customer: "", manufacturer: "", style: "", color: "", size: "",
  description: "", country_of_origin: "", fabric_content: "", brand: "",
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

  // Listas curadas para los dropdowns (igual que Receiving).
  const wmsCat = useWmsCatalogs();
  const { all: sizeOptions } = useWmsSizes();
  const [globalOpts, setGlobalOpts] = useState({ customers: [], styles: [], colors: [], manufacturers: [] });
  const [fieldOpts, setFieldOpts] = useState({ descriptions: [], countries: [], fabrics: [] });
  const [custStyles, setCustStyles] = useState([]);
  const [custColors, setCustColors] = useState([]);

  useEffect(() => {
    fetcher("/inventory/options?").then(d => setGlobalOpts({
      customers: d?.customers || [], styles: d?.styles || [],
      colors: d?.colors || [], manufacturers: d?.manufacturers || [],
    })).catch(() => {});
    fetcher("/inventory/field-options").then(d => setFieldOpts({
      descriptions: d?.descriptions || [], countries: d?.countries || [], fabrics: d?.fabrics || [],
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
  const descOptions = useMemo(() => mergeUnique(wmsCat.descriptions, fieldOpts.descriptions), [wmsCat.descriptions, fieldOpts.descriptions]);
  const countryOptions = useMemo(() => mergeUnique(wmsCat.countries, fieldOpts.countries), [wmsCat.countries, fieldOpts.countries]);
  const fabricOptions = useMemo(() => mergeUnique(wmsCat.fabrics, fieldOpts.fabrics), [wmsCat.fabrics, fieldOpts.fabrics]);

  const doSearch = useCallback(async (q) => {
    setLoading(true);
    try {
      const qs = q?.trim() ? `?search=${encodeURIComponent(q.trim())}&limit=200` : "?limit=200";
      const data = await fetcher(`/upc${qs}`);
      setRows(Array.isArray(data) ? data : []);
    } catch { toast.error("No se pudo cargar el catálogo de UPC"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { const h = setTimeout(() => doSearch(search), 300); return () => clearTimeout(h); }, [search, doSearch]);

  // Datos descriptivos (fabricante/descripcion/pais/tela) colapsados por
  // defecto: NO son parte de la identidad del UPC (el SKU es estilo+color+talla),
  // asi que el modal muestra solo lo requerido. En edicion se abre si ya traen
  // algo, para no esconder datos existentes.
  const [showOptional, setShowOptional] = useState(false);
  const openCreate = () => { setDraft(EMPTY); setEditMode(false); setShowOptional(false); setFormOpen(true); };
  const openEdit = (r) => {
    setDraft({ ...EMPTY, ...r, upc: r.upc || "" });
    setEditMode(true);
    setShowOptional(!!(r.manufacturer || r.description || r.country_of_origin || r.fabric_content));
    setFormOpen(true);
  };

  const codeValid = validGtin(draft.upc);

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
    if (!editMode && !codeValid) {
      toast.error("El UPC no es un código de barras válido (dígitos + verificador). Escanéalo, no lo teclees.");
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
      const payload = editMode ? { ...draft, upc: code, propagate_to_boxes: true } : { ...draft, upc: code };
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
        customer: draft.customer, style: draft.style, color: draft.color,
        size: draft.size, description: draft.description,
        country_of_origin: draft.country_of_origin,
        fabric_content: draft.fabric_content, manufacturer: draft.manufacturer,
        brand: draft.brand,
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
    <div className="bg-card/40 border border-indigo-500/20 rounded-2xl overflow-hidden" data-testid="upc-catalog">
      <div className="p-5 bg-indigo-500/5 border-b border-indigo-500/20 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
            <Barcode className="w-5 h-5 text-indigo-400" />
          </div>
          <div>
            <h2 className="text-sm font-black uppercase tracking-widest text-foreground">Catálogo de UPC</h2>
            <p className="text-xs text-muted-foreground">Los UPC que el operador escanea en Receiving. Aquí los da de alta el supervisor.</p>
          </div>
        </div>
        {isManager && (
          <button onClick={openCreate} className="px-4 py-2 bg-indigo-500 hover:bg-indigo-400 text-white rounded-xl font-black uppercase tracking-wider text-xs flex items-center gap-2 transition-all" data-testid="upc-cat-new">
            <Plus className="w-4 h-4" /> Nuevo UPC
          </button>
        )}
      </div>

      <div className="p-4">
        <div className="relative mb-3">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar por UPC, estilo, color, cliente…"
            className="w-full pl-10 pr-3 py-2.5 bg-background border border-border rounded-xl text-sm"
            data-testid="upc-cat-search"
          />
          {loading && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground" />}
        </div>

        {rows.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground italic">
            {search.trim() ? "Sin resultados." : "Escribe para buscar UPC en el catálogo."}
          </div>
        ) : (
          <div className="overflow-x-auto custom-scrollbar max-h-[420px] overflow-y-auto rounded-xl border border-border/30">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-secondary/60 backdrop-blur">
                <tr className="text-left">
                  {["UPC", "Cliente", "Estilo", "Color", "Talla", "Descripción", "País", ""].map(h => (
                    <th key={h} className="px-2.5 py-2 font-black uppercase tracking-wider text-muted-foreground whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/10">
                {rows.map(r => {
                  const ok = validGtin(r.upc);
                  return (
                    <tr key={r.upc} className="hover:bg-secondary/20">
                      <td className="px-2.5 py-1.5 font-mono font-bold whitespace-nowrap">
                        <span className="inline-flex items-center gap-1">
                          {ok ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : <AlertTriangle className="w-3 h-3 text-amber-500" title="No pasa el dígito verificador" />}
                          {r.upc}
                        </span>
                      </td>
                      <td className="px-2.5 py-1.5">{r.customer}</td>
                      <td className="px-2.5 py-1.5 font-bold">{r.style}</td>
                      <td className="px-2.5 py-1.5">{r.color}</td>
                      <td className="px-2.5 py-1.5 font-mono">{r.size}</td>
                      <td className="px-2.5 py-1.5 text-muted-foreground truncate max-w-[180px]" title={r.description}>{r.description}</td>
                      <td className="px-2.5 py-1.5 text-muted-foreground">{r.country_of_origin}</td>
                      <td className="px-2.5 py-1.5 whitespace-nowrap">
                        {isManager && (
                          <div className="flex items-center gap-1 justify-end">
                            <button onClick={() => openEdit(r)} className="p-1 text-muted-foreground hover:text-indigo-400" title="Editar" data-testid={`upc-cat-edit-${r.upc}`}><Edit2 className="w-3.5 h-3.5" /></button>
                            <button onClick={() => remove(r)} className="p-1 text-muted-foreground hover:text-red-400" title="Eliminar" data-testid={`upc-cat-del-${r.upc}`}><Trash2 className="w-3.5 h-3.5" /></button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Alta / edición — supervisor. Identidad 100% desde catálogos curados. */}
      {formOpen && (
        <div className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" data-testid="upc-cat-form">
          <div className="w-full max-w-2xl bg-card border border-border rounded-2xl shadow-2xl overflow-hidden">
            <div className="px-5 py-3 bg-indigo-500/10 border-b border-border/40 flex items-center justify-between">
              <span className="font-black uppercase tracking-wider text-sm flex items-center gap-2">
                <Barcode className="w-4 h-4 text-indigo-400" /> {editMode ? "Editar UPC" : "Nuevo UPC"}
              </span>
              <button onClick={() => setFormOpen(false)} className="p-1 text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 grid grid-cols-2 gap-3 max-h-[65vh] overflow-y-auto custom-scrollbar">
              <div className="col-span-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">UPC (código de barras) *</label>
                <div className="flex gap-2">
                  <input
                    value={draft.upc}
                    onChange={e => setD("upc", e.target.value.replace(/\s+/g, "").toUpperCase())}
                    disabled={editMode}
                    placeholder="Escanea el código físico"
                    className={`flex-1 px-3 py-2 bg-background border rounded text-sm font-mono font-bold disabled:opacity-60 ${
                      draft.upc ? (codeValid ? "border-emerald-500/50" : "border-amber-500/50") : "border-border"
                    }`}
                    data-testid="upc-cat-draft-upc"
                    autoFocus={!editMode}
                  />
                  {!editMode && (
                    <button
                      type="button"
                      onClick={generateUpc}
                      disabled={generating}
                      title="Para material sin código de fábrica: genera un UPC-A interno válido (estilo+color+talla)"
                      className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-xs font-black uppercase tracking-wider flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50"
                      data-testid="upc-cat-generate"
                    >
                      {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Barcode className="w-3.5 h-3.5" />}
                      Generar interno
                    </button>
                  )}
                </div>
                {draft.upc && !codeValid && !editMode && (
                  <p className="text-[10px] text-amber-500 mt-1 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" /> No pasa el dígito verificador — no es un código de barras real. Escanéalo, no lo teclees.
                  </p>
                )}
                <p className="text-[10px] text-muted-foreground mt-1">
                  El UPC identifica una variante única: <b>estilo + color + talla</b> (el SKU). Los tres son obligatorios.
                  Si el material <b>no trae código de fábrica</b> (blank de importación), usa <b>Generar interno</b>.
                </p>
                {dupUpc && (
                  <p className="text-[10px] text-amber-500 mt-1 flex items-start gap-1" data-testid="upc-cat-dup-warn">
                    <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                    <span>Ya existe el UPC <span className="font-mono font-bold">{dupUpc}</span> para {draft.style}/{draft.color}/{draft.size}. Un SKU normalmente lleva un solo UPC.</span>
                  </p>
                )}
              </div>
              <div className="col-span-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Cliente *</label>
                <SearchableSelect options={customerOptions} value={draft.customer} onChange={v => setDraft(p => ({ ...p, customer: v, style: "", color: "" }))} placeholder="Cliente…" testId="upc-cat-draft-customer" allowCreate={false} />
              </div>
              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Estilo *</label>
                <SearchableSelect options={styleOptions} value={draft.style} onChange={v => setD("style", v)} placeholder={draft.customer ? "Estilo…" : "Elige cliente primero"} testId="upc-cat-draft-style" allowCreate={false} />
              </div>
              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Color *</label>
                <SearchableSelect options={colorOptions} value={draft.color} onChange={v => setD("color", v)} placeholder="Color…" testId="upc-cat-draft-color" allowCreate={false} />
              </div>
              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Talla *</label>
                <select value={draft.size} onChange={e => setD("size", e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded text-sm font-mono" data-testid="upc-cat-draft-size">
                  <option value="">—</option>
                  {sizeOptions.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              {/* Datos descriptivos — NO son identidad del UPC. Ocultos por
                  defecto; el país sobre todo cambia por embarque, no por UPC.
                  Si se llenan, Receiving los autocompleta al escanear. */}
              <div className="col-span-2">
                <button
                  type="button"
                  onClick={() => setShowOptional(o => !o)}
                  className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-secondary/40 hover:bg-secondary/60 text-[11px] font-black uppercase tracking-widest text-muted-foreground transition-colors"
                  data-testid="upc-cat-optional-toggle"
                >
                  <span>Datos descriptivos (opcional): descripción, país, tela, fabricante</span>
                  {showOptional ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </button>
              </div>
              {showOptional && (
                <>
                  <div>
                    <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Fabricante</label>
                    <input value={draft.manufacturer} onChange={e => setD("manufacturer", e.target.value.toUpperCase())} className="w-full px-3 py-2 bg-background border border-border rounded text-sm" placeholder="(opcional)" />
                  </div>
                  <div className="col-span-2">
                    <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Descripción</label>
                    <SearchableSelect options={descOptions} value={draft.description} onChange={v => setD("description", v)} placeholder="Descripción…" testId="upc-cat-draft-desc" allowCreate={false} />
                  </div>
                  <div>
                    <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">País de origen</label>
                    <SearchableSelect options={countryOptions} value={draft.country_of_origin} onChange={v => setD("country_of_origin", v)} placeholder="País…" testId="upc-cat-draft-country" allowCreate={false} />
                  </div>
                  <div>
                    <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground block mb-1">Contenido / tela</label>
                    <SearchableSelect options={fabricOptions} value={draft.fabric_content} onChange={v => setD("fabric_content", v)} placeholder="Tela…" testId="upc-cat-draft-fabric" allowCreate={false} />
                  </div>
                </>
              )}
            </div>
            <div className="px-5 py-3 bg-secondary/30 border-t border-border/40 flex justify-end gap-2">
              <button onClick={() => setFormOpen(false)} className="px-4 py-2 bg-secondary text-foreground rounded-lg text-sm font-bold">Cancelar</button>
              <button onClick={save} disabled={saving} className="px-5 py-2 bg-indigo-500 text-white rounded-lg text-sm font-black uppercase tracking-wider flex items-center gap-2 disabled:opacity-50" data-testid="upc-cat-save">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                {editMode ? "Guardar" : "Crear UPC"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
