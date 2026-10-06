import React, { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { API } from "../lib/constants";
import { useLang } from "../contexts/LanguageContext";
import {
  ArrowLeft, Upload, Loader2, CheckCircle2, AlertTriangle, FileText,
  Plus, Trash2, Save, Power, Crosshair, X, ChevronUp, ChevronDown, Receipt,
} from "lucide-react";
import { toast } from "sonner";

// Los datos que MOS necesita de cualquier PO. La plantilla del cliente se arma
// señalando dónde vive cada uno dentro de SU formato.
const CAMPOS = [
  { k: "po_number", req: true },
  { k: "design_num", req: true },
  { k: "qty", req: true },
  { k: "store_po" },
  { k: "brand" },
  { k: "color" },
  { k: "blank" },
  { k: "description" },
  { k: "unit_price" },
  { k: "ship_date" },
  { k: "cancel_date" },
];

// Mismas tolerancias que el motor (services/po_templates.py): un rótulo y su
// contenido no caen exactamente a la misma altura, y una celda va pegada a su
// encabezado. Si allá cambian, aquí también.
const TOL_RENGLON = 8;
const TOL_ABAJO = 26;

/** Cuál de las apariciones de ese texto es la señalada.
 *  El mismo rótulo se repite en una hoja —"CUST" está en el encabezado del
 *  cliente y otra vez en la columna "CUST PO"—, así que guardar sólo el texto
 *  haría que el motor eligiera la primera, que casi nunca es la buena. Aquí sí
 *  se sabe cuál señaló el usuario, y se guarda. */
function ocurrenciaDe(palabras, w) {
  const igual = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
  return palabras.filter((o) => igual(o.t, w.t) && (o.y < w.y || (o.y === w.y && o.x < w.x))).length;
}

/** Del dato señalado deduce su ancla: el rótulo de su izquierda (mismo renglón)
 *  o el encabezado de arriba. Se guarda el ancla, nunca la coordenada, para que
 *  el mapeo aguante que el cliente mueva el bloque de lugar. */
function deducirAncla(palabras, idx) {
  const w = palabras[idx];
  const izq = palabras
    .filter((o, i) => i !== idx && Math.abs(o.y - w.y) <= TOL_RENGLON && o.x1 <= w.x)
    .sort((a, b) => b.x1 - a.x1)[0];
  const arriba = palabras
    .filter((o, i) => i !== idx && w.y - o.y1 >= 0 && w.y - o.y1 <= TOL_ABAJO
      && o.x < w.x1 && o.x1 > w.x)
    .sort((a, b) => b.y1 - a.y1)[0];
  const opciones = [];
  if (izq) opciones.push({
    modo: "derecha_de", rotulo: izq.t,
    spec: { tipo: "derecha_de", rotulo: izq.t, ocurrencia: ocurrenciaDe(palabras, izq) },
  });
  if (arriba) opciones.push({
    modo: "debajo_de", rotulo: arriba.t,
    spec: { tipo: "debajo_de", rotulo: arriba.t, ocurrencia: ocurrenciaDe(palabras, arriba) },
  });
  opciones.push({ modo: "fijo", rotulo: w.t, spec: { tipo: "fijo", valor: w.t } });
  return opciones;
}

const Campo = ({ label, value, onChange, mono }) => (
  <div>
    <label className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-black block mb-1">{label}</label>
    <input value={value ?? ""} onChange={(e) => onChange(e.target.value)}
      className={`w-full bg-background/60 border border-border/50 rounded px-2 py-1.5 text-sm ${mono ? "font-mono" : ""} focus:ring-1 focus:ring-primary`} />
  </div>
);

export default function PlantillasPO() {
  const navigate = useNavigate();
  const { t } = useLang();

  const [lista, setLista] = useState([]);
  const [sel, setSel] = useState(null);          // plantilla en edición
  const [draft, setDraft] = useState(null);      // { draft_id, filename, paginas }
  const [pagina, setPagina] = useState(0);
  const [campoActivo, setCampoActivo] = useState(null);
  const [menu, setMenu] = useState(null);        // { idx, opciones, x, y }
  const [previa, setPrevia] = useState(null);
  const [cargando, setCargando] = useState(false);
  const lienzoRef = useRef(null);
  const [escala, setEscala] = useState(1);

  const cargarLista = useCallback(async () => {
    try {
      const r = await fetch(`${API}/po-templates`, { credentials: "include" });
      const d = await r.json();
      setLista(d.plantillas || []);
    } catch { /* la lista vacía es un estado válido */ }
  }, []);
  useEffect(() => { cargarLista(); }, [cargarLista]);

  // La página se pinta a la escala que quepa en el contenedor.
  useEffect(() => {
    const ajustar = () => {
      const pg = draft?.paginas?.[pagina];
      if (pg && lienzoRef.current) setEscala(lienzoRef.current.clientWidth / pg.ancho);
    };
    ajustar();
    window.addEventListener("resize", ajustar);
    return () => window.removeEventListener("resize", ajustar);
  }, [draft, pagina]);

  const probar = useCallback(async (plantilla) => {
    if (!draft || !plantilla) return;
    try {
      const r = await fetch(`${API}/po-templates/borrador/${draft.draft_id}/probar`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify(plantilla),
      });
      const d = await r.json();
      setPrevia(r.ok ? d : { error: d.detail });
    } catch (e) { setPrevia({ error: e.message }); }
  }, [draft]);

  useEffect(() => { if (draft && sel) probar(sel); }, [draft, sel, probar]);

  const subirPDF = async (file, paraValidar = false) => {
    if (!file) return;
    setCargando(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (paraValidar) {
        const r = await fetch(`${API}/po-templates/${sel.template_id}/validar`, {
          method: "POST", credentials: "include", body: fd });
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail);
        toast[d.valida ? "success" : "warning"](
          d.valida ? t('ppo_validada', { n: d.estilos }) : t('ppo_no_valida'));
        cargarLista();
        setSel((s) => ({ ...s, validada_con: d.valida ? file.name : null, activa: false }));
      } else {
        const r = await fetch(`${API}/po-templates/borrador`, {
          method: "POST", credentials: "include", body: fd });
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail);
        setDraft(d); setPagina(0); setMenu(null);
      }
    } catch (e) { toast.error(e.message); }
    finally { setCargando(false); }
  };

  const nueva = async () => {
    const nombre = window.prompt(t('ppo_nombre_pregunta'));
    if (!nombre?.trim()) return;
    try {
      const r = await fetch(`${API}/po-templates`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify({ nombre: nombre.trim() }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail);
      setSel(d); setDraft(null); setPrevia(null); cargarLista();
    } catch (e) { toast.error(e.message); }
  };

  const guardar = async () => {
    try {
      const r = await fetch(`${API}/po-templates/${sel.template_id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ nombre: sel.nombre, huella: sel.huella, campos: sel.campos, tallas: sel.tallas, quote: sel.quote }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail);
      setSel(d); cargarLista(); toast.success(t('ppo_guardada'));
    } catch (e) { toast.error(e.message); }
  };

  const activar = async (activa) => {
    try {
      const r = await fetch(`${API}/po-templates/${sel.template_id}/activar`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify({ activa }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail);
      setSel((s) => ({ ...s, activa })); cargarLista();
      toast.success(activa ? t('ppo_activada') : t('ppo_desactivada'));
    } catch (e) { toast.error(e.message); }
  };

  const borrar = async (p) => {
    if (!window.confirm(t('ppo_borrar_confirm', { n: p.nombre }))) return;
    try {
      const r = await fetch(`${API}/po-templates/${p.template_id}`, {
        method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error((await r.json()).detail);
      if (sel?.template_id === p.template_id) setSel(null);
      cargarLista();
    } catch (e) { toast.error(e.message); }
  };

  const clicPalabra = (idx, ev) => {
    if (!campoActivo) { toast.info(t('ppo_elige_campo')); return; }
    const pg = draft.paginas[pagina];
    const caja = lienzoRef.current.getBoundingClientRect();
    setMenu({
      idx, opciones: deducirAncla(pg.palabras, idx),
      x: ev.clientX - caja.left, y: ev.clientY - caja.top,
    });
  };

  const aplicar = (spec) => {
    setSel((s) => ({ ...s, campos: { ...(s.campos || {}), [campoActivo]: spec } }));
    setMenu(null); setCampoActivo(null);
  };

  // ── Estructura de la quote en Printavo ──────────────────────────────────
  // Se edita sobre `sel.quote` y cada cambio dispara la vista previa, así que el
  // efecto se ve antes de crear nada.
  const editQuote = (fn) => setSel((s) => {
    const q = JSON.parse(JSON.stringify(s.quote || { nickname: "", grupos: [] }));
    fn(q);
    return { ...s, quote: q };
  });
  const editarLinea = (gi, li, cambios) => editQuote((q) => { Object.assign(q.grupos[gi].lineas[li], cambios); });
  const agregarLinea = (gi) => editQuote((q) => { q.grupos[gi].lineas.push({ tipo: "texto", texto: "" }); });
  const quitarLinea = (gi, li) => editQuote((q) => { q.grupos[gi].lineas.splice(li, 1); });
  const moverLinea = (gi, li, d) => editQuote((q) => {
    const ls = q.grupos[gi].lineas, j = li + d;
    if (j < 0 || j >= ls.length) return;
    [ls[li], ls[j]] = [ls[j], ls[li]];
  });
  const agregarGrupo = () => editQuote((q) => { q.grupos.push({ lineas: [] }); });
  const quitarGrupo = (gi) => {
    if (!window.confirm(t('ppo_q_quitar_grupo'))) return;
    editQuote((q) => { q.grupos.splice(gi, 1); });
  };

  const editarTallas = (cambios) =>
    setSel((s) => ({ ...s, tallas: { ...(s.tallas || {}), ...cambios } }));

  const quitarCampo = (k) => setSel((s) => {
    const c = { ...(s.campos || {}) }; delete c[k]; return { ...s, campos: c };
  });

  const valorDe = (k) => {
    const r = previa?.records?.[0];
    if (!r) return null;
    const v = r[k];
    return v === null || v === undefined || v === "" ? null : String(v);
  };

  const pg = draft?.paginas?.[pagina];

  return (
    <div className="min-h-screen bg-background text-foreground font-barlow">
      <header className="sticky top-0 z-40 bg-background/80 backdrop-blur-xl border-b border-border h-16 flex items-center justify-between px-6">
        <div className="flex items-center gap-4">
          <button onClick={() => navigate("/home")} className="w-10 h-10 flex items-center justify-center rounded-xl bg-secondary/50 hover:bg-secondary border border-white/5">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-xl font-black uppercase tracking-widest flex items-center gap-2">
              <Crosshair className="w-5 h-5 text-primary" /> {t('ppo_titulo')}
            </h1>
            <p className="text-xs text-muted-foreground font-mono leading-none mt-1">{t('ppo_subtitulo')}</p>
          </div>
        </div>
        <button onClick={nueva} className="px-4 py-2 bg-primary text-black rounded-lg font-black text-[11px] uppercase tracking-widest flex items-center gap-2">
          <Plus className="w-4 h-4" /> {t('ppo_nueva')}
        </button>
      </header>

      <main className="w-full max-w-[1500px] mx-auto px-4 md:px-6 py-6 grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-5">
        {/* Columna izquierda: plantillas y campos */}
        <aside className="space-y-5">
          <section className="bg-card/60 border border-border rounded-2xl p-4">
            <h2 className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mb-3">{t('ppo_plantillas')}</h2>
            {lista.length === 0 && <p className="text-sm text-muted-foreground">{t('ppo_sin_plantillas')}</p>}
            <div className="space-y-1.5">
              {lista.map((p) => (
                <div key={p.template_id}
                  className={`flex items-center gap-2 rounded-lg px-3 py-2 cursor-pointer border ${sel?.template_id === p.template_id ? "bg-primary/10 border-primary/40" : "border-transparent hover:bg-secondary/40"}`}
                  onClick={() => { setSel(p); setPrevia(null); setCampoActivo(null); }}>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold truncate">{p.nombre}</p>
                    <p className="text-[10px] font-mono text-muted-foreground">
                      {p.activa ? t('ppo_estado_activa') : p.validada_con ? t('ppo_estado_validada') : t('ppo_estado_borrador')}
                      {" · "}{Object.keys(p.campos || {}).length} {t('ppo_campos')}
                    </p>
                  </div>
                  <span className={`w-2 h-2 rounded-full shrink-0 ${p.activa ? "bg-emerald-500" : p.validada_con ? "bg-amber-500" : "bg-muted-foreground/40"}`} />
                  <button onClick={(e) => { e.stopPropagation(); borrar(p); }} className="p-1 rounded hover:bg-destructive/10 text-destructive"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              ))}
            </div>
          </section>

          {sel && (
            <section className="bg-card/60 border border-border rounded-2xl p-4 space-y-3">
              <h2 className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('ppo_datos')}</h2>
              <p className="text-xs text-muted-foreground">{t('ppo_como')}</p>
              <div className="space-y-1">
                {CAMPOS.map(({ k, req }) => {
                  const spec = (sel.campos || {})[k];
                  const val = valorDe(k);
                  const activo = campoActivo === k;
                  return (
                    <div key={k}
                      onClick={() => setCampoActivo(activo ? null : k)}
                      className={`rounded-lg px-3 py-2 cursor-pointer border transition-colors ${activo ? "border-primary bg-primary/10" : spec ? "border-border bg-secondary/20" : "border-dashed border-border/60"}`}>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-black uppercase tracking-wide flex-1">{t(`ppo_campo_${k}`)}{req && <span className="text-destructive">*</span>}</span>
                        {spec && <button onClick={(e) => { e.stopPropagation(); quitarCampo(k); }} className="p-0.5 rounded hover:bg-secondary"><X className="w-3 h-3" /></button>}
                      </div>
                      {val !== null
                        ? <p className="text-sm font-mono text-emerald-600 truncate">{val}</p>
                        : spec ? <p className="text-xs text-amber-600">{t('ppo_sin_valor')}</p>
                          : <p className="text-xs text-muted-foreground/60">{activo ? t('ppo_ahora_senala') : t('ppo_sin_mapear')}</p>}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {sel && (
            <section className="bg-card/60 border border-border rounded-2xl p-4 space-y-3">
              <h2 className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('ppo_t_titulo')}</h2>
              <p className="text-xs text-muted-foreground">{t('ppo_t_ayuda')}</p>

              <div className="flex gap-2">
                {["rejilla", "pares"].map((tipo) => (
                  <button key={tipo} onClick={() => editarTallas({ tipo })}
                    className={`flex-1 px-2 py-2 rounded-lg border text-[11px] font-black uppercase tracking-wide ${((sel.tallas || {}).tipo || "rejilla") === tipo ? "bg-primary/15 border-primary/50 text-primary" : "border-border hover:bg-secondary/40"}`}>
                    {t(`ppo_t_${tipo}`)}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground/80">
                {t(`ppo_t_${((sel.tallas || {}).tipo || "rejilla")}_ej`)}
              </p>

              {((sel.tallas || {}).tipo || "rejilla") === "rejilla" ? (
                <div className="grid grid-cols-2 gap-2">
                  <Campo label={t('ppo_t_rotulo_tallas')} mono
                    value={(sel.tallas || {}).rotulo_tallas ?? "SIZE"}
                    onChange={(v) => editarTallas({ rotulo_tallas: v })} />
                  <Campo label={t('ppo_t_rotulo_cant')} mono
                    value={(sel.tallas || {}).rotulo_cantidades ?? "QTY"}
                    onChange={(v) => editarTallas({ rotulo_cantidades: v })} />
                </div>
              ) : (
                <Campo label={t('ppo_t_excluir')} mono
                  value={((sel.tallas || {}).excluir || ["TOTAL", "UNITS"]).join(", ")}
                  onChange={(v) => editarTallas({ excluir: v.split(",").map((x) => x.trim()).filter(Boolean) })} />
              )}

              {previa?.records?.[0] && (
                <div className="border-t border-border pt-2">
                  <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/60 mb-1">{t('ppo_t_leidas')}</p>
                  <p className="text-sm font-mono">
                    {Object.entries(previa.records[0].sizes || {}).map(([k, v]) => `${k}:${v}`).join("  ") || "—"}
                  </p>
                  <p className={`text-xs mt-1 ${previa.records[0].sizes_match ? "text-emerald-600" : "text-amber-600"}`}>
                    {t('ppo_t_suma', { a: previa.records[0].qty_from_sizes, b: previa.records[0].qty ?? "—" })}
                  </p>
                </div>
              )}
            </section>
          )}
        </aside>

        {/* Columna derecha: el PDF y la vista previa */}
        <section className="space-y-5 min-w-0">
          {!sel && (
            <div className="bg-card/60 border border-border rounded-2xl p-10 text-center">
              <Crosshair className="w-8 h-8 mx-auto text-muted-foreground/40 mb-3" />
              <p className="text-sm text-muted-foreground">{t('ppo_empieza')}</p>
            </div>
          )}

          {sel && (
            <>
              <div className="bg-card/60 border border-border rounded-2xl p-4 flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 bg-secondary/40 border border-dashed border-border rounded-lg px-3 py-2 cursor-pointer text-sm">
                  <FileText className="w-4 h-4 text-muted-foreground" />
                  {draft ? draft.filename : t('ppo_sube_pdf')}
                  <input type="file" accept="application/pdf" className="hidden"
                    onChange={(e) => subirPDF(e.target.files?.[0])} />
                </label>
                {cargando && <Loader2 className="w-4 h-4 animate-spin" />}
                {draft && draft.paginas.length > 1 && (
                  <div className="flex items-center gap-1">
                    {draft.paginas.map((_, i) => (
                      <button key={i} onClick={() => { setPagina(i); setMenu(null); }}
                        className={`w-7 h-7 rounded text-[11px] font-mono ${i === pagina ? "bg-primary text-black" : "bg-secondary/60 hover:bg-secondary"}`}>{i + 1}</button>
                    ))}
                  </div>
                )}
                <div className="flex-1" />
                <button onClick={guardar} className="px-3 py-2 rounded-lg bg-secondary/60 hover:bg-secondary border border-border text-[11px] font-black uppercase tracking-widest flex items-center gap-1.5">
                  <Save className="w-3.5 h-3.5" /> {t('save')}
                </button>
                <label className="px-3 py-2 rounded-lg bg-secondary/60 hover:bg-secondary border border-border text-[11px] font-black uppercase tracking-widest cursor-pointer flex items-center gap-1.5">
                  <Upload className="w-3.5 h-3.5" /> {t('ppo_validar')}
                  <input type="file" accept="application/pdf" className="hidden"
                    onChange={(e) => subirPDF(e.target.files?.[0], true)} />
                </label>
                <button onClick={() => activar(!sel.activa)}
                  className={`px-3 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest flex items-center gap-1.5 ${sel.activa ? "bg-emerald-500/15 text-emerald-600 border border-emerald-500/40" : "bg-primary text-black"}`}>
                  <Power className="w-3.5 h-3.5" /> {sel.activa ? t('ppo_activa') : t('ppo_activar')}
                </button>
              </div>

              {!sel.validada_con && (
                <div className="text-xs bg-amber-500/10 border border-amber-500/30 text-amber-600 rounded-lg px-3 py-2">
                  {t('ppo_falta_validar')}
                </div>
              )}

              {/* La página: no es una imagen, son las palabras del PDF en su lugar */}
              {pg && (
                <div className="bg-card/60 border border-border rounded-2xl p-4">
                  <div ref={lienzoRef} className="relative w-full bg-white rounded-lg overflow-hidden"
                    style={{ height: pg.alto * escala }}>
                    {pg.palabras.map((w, i) => (
                      <span key={i} onClick={(e) => clicPalabra(i, e)}
                        title={w.t}
                        className="absolute whitespace-pre cursor-pointer hover:bg-primary/30 rounded-[2px] text-black leading-none"
                        style={{
                          left: w.x * escala, top: w.y * escala,
                          fontSize: Math.max(5, (w.y1 - w.y) * escala * 0.92),
                        }}>{w.t}</span>
                    ))}
                    {menu && (
                      <div className="absolute z-20 bg-card border border-border rounded-xl shadow-2xl p-2 w-64"
                        style={{ left: Math.min(menu.x, 300), top: menu.y + 8 }}>
                        <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground px-2 pb-1">
                          {t(`ppo_campo_${campoActivo}`)}
                        </p>
                        {menu.opciones.map((o, i) => (
                          <button key={i} onClick={() => aplicar(o.spec)}
                            className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-secondary/60 text-sm">
                            {t(`ppo_modo_${o.modo}`, { r: o.rotulo })}
                          </button>
                        ))}
                        <button onClick={() => setMenu(null)} className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-secondary/60 text-xs text-muted-foreground">
                          {t('cancel')}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Vista previa */}
              <div className="bg-card/60 border border-border rounded-2xl p-4 space-y-2">
                <h2 className="text-[10px] font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                  {previa?.error ? <AlertTriangle className="w-4 h-4 text-destructive" /> : <CheckCircle2 className="w-4 h-4 text-primary" />}
                  {t('ppo_previa')}
                </h2>
                {previa?.error && <p className="text-sm text-destructive">{previa.error}</p>}
                {previa && !previa.error && (
                  <>
                    <p className="text-xs text-muted-foreground font-mono">
                      {t('ppo_previa_resumen', { p: previa.paginas, e: previa.estilos })}
                    </p>
                    {previa.records.slice(0, 4).map((r, i) => (
                      <div key={i} className="border border-border rounded-lg p-3 text-sm">
                        <p className="font-bold font-mono">{r.design_num} · {r.color} · {r.qty} pcs</p>
                        <p className="text-xs text-muted-foreground font-mono mt-1">
                          PO {r.po_number || "—"} · {r.brand || "—"} · {JSON.stringify(r.sizes)}
                        </p>
                        {!r.sizes_match && <p className="text-xs text-amber-600 mt-1">{t('ppo_tallas_no_cuadran', { a: r.qty_from_sizes, b: r.qty })}</p>}
                      </div>
                    ))}
                    {previa.estilos === 0 && <p className="text-sm text-amber-600">{t('ppo_nada_aun')}</p>}
                  </>
                )}
              </div>

              {/* Cómo se verá en Printavo */}
              <div className="bg-card/60 border border-border rounded-2xl p-4 space-y-3">
                <h2 className="text-[10px] font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                  <Receipt className="w-4 h-4 text-primary" /> {t('ppo_q_titulo')}
                </h2>
                <p className="text-xs text-muted-foreground">{t('ppo_q_ayuda')}</p>

                <Campo label={t('ppo_q_nickname')} value={(sel.quote || {}).nickname || ""}
                  onChange={(v) => editQuote((q) => { q.nickname = v; })} mono />

                {((sel.quote || {}).grupos || []).map((g, gi) => (
                  <div key={gi} className="border border-border rounded-xl p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground flex-1">
                        {t('ppo_q_grupo', { n: gi + 1 })}
                      </span>
                      <button onClick={() => agregarLinea(gi)} className="px-2 py-1 rounded-lg bg-secondary/60 hover:bg-secondary border border-border text-[10px] font-black uppercase tracking-wide">
                        + {t('ppo_q_linea')}
                      </button>
                      <button onClick={() => quitarGrupo(gi)} className="p-1 rounded hover:bg-destructive/10 text-destructive"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                    {(g.lineas || []).length === 0 && <p className="text-xs text-muted-foreground/60">{t('ppo_q_grupo_vacio')}</p>}
                    {(g.lineas || []).map((ln, li) => (
                      <div key={li} className="flex flex-wrap items-start gap-2 bg-secondary/20 rounded-lg p-2">
                        <select value={ln.tipo || "texto"} onChange={(e) => editarLinea(gi, li, { tipo: e.target.value })}
                          className="bg-background/60 border border-border/50 rounded px-2 py-1 text-xs">
                          <option value="texto">{t('ppo_q_tipo_texto')}</option>
                          <option value="prenda">{t('ppo_q_tipo_prenda')}</option>
                          <option value="packing">{t('ppo_q_tipo_packing')}</option>
                        </select>
                        {(ln.tipo || "texto") === "texto" && (
                          <textarea value={ln.texto || ""} rows={Math.min(5, (ln.texto || "").split("\n").length || 1)}
                            onChange={(e) => editarLinea(gi, li, { texto: e.target.value })}
                            placeholder={t('ppo_q_texto_ph')}
                            className="flex-1 min-w-[200px] bg-background/60 border border-border/50 rounded px-2 py-1 text-xs font-mono resize-y" />
                        )}
                        {ln.tipo === "packing" && (
                          <input value={ln.encabezado || ""} onChange={(e) => editarLinea(gi, li, { encabezado: e.target.value })}
                            placeholder={t('ppo_q_packing_ph')}
                            className="flex-1 min-w-[200px] bg-background/60 border border-border/50 rounded px-2 py-1 text-xs font-mono" />
                        )}
                        {ln.tipo === "prenda" && (
                          <p className="flex-1 min-w-[200px] text-xs text-muted-foreground py-1">{t('ppo_q_prenda_nota')}</p>
                        )}
                        <input value={ln.precio ?? ""} onChange={(e) => editarLinea(gi, li, { precio: e.target.value })}
                          placeholder="$" title={t('ppo_q_precio')}
                          className="w-16 bg-background/60 border border-border/50 rounded px-2 py-1 text-xs font-mono" />
                        <div className="flex items-center gap-0.5">
                          <button onClick={() => moverLinea(gi, li, -1)} className="p-1 rounded hover:bg-secondary"><ChevronUp className="w-3.5 h-3.5" /></button>
                          <button onClick={() => moverLinea(gi, li, 1)} className="p-1 rounded hover:bg-secondary"><ChevronDown className="w-3.5 h-3.5" /></button>
                          <button onClick={() => quitarLinea(gi, li)} className="p-1 rounded hover:bg-destructive/10 text-destructive"><X className="w-3.5 h-3.5" /></button>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
                <button onClick={agregarGrupo} className="px-3 py-1.5 rounded-lg bg-secondary/60 hover:bg-secondary border border-border text-[11px] font-black uppercase tracking-widest">
                  + {t('ppo_q_grupo_nuevo')}
                </button>

                {previa?.quote && (
                  <div className="border-t border-border pt-3 space-y-2">
                    <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">{t('ppo_q_asi_queda')}</p>
                    {previa.quote.error
                      ? <p className="text-sm text-destructive">{previa.quote.error}</p>
                      : <>
                        <p className="text-sm font-mono font-bold">{previa.quote.nickname}</p>
                        {(previa.quote.grupos || []).map((g, i) => (
                          <div key={i} className="border border-border/60 rounded-lg p-2">
                            <p className="text-[10px] font-black uppercase text-muted-foreground/60 mb-1">{t('ppo_q_grupo', { n: i + 1 })}</p>
                            {g.map((d, j) => (
                              <p key={j} className="text-[11px] font-mono whitespace-pre-wrap border-b border-border/30 last:border-0 py-1">{d}</p>
                            ))}
                          </div>
                        ))}
                      </>}
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
