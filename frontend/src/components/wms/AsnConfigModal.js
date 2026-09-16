import { useEffect, useState } from "react";
import { toast } from "sonner";
import { X, Plus, Trash2, Loader2, Check, Settings2 } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, putter, logLoadError, useWmsCatalogs } from "./lib";

// Configuración del módulo de Entradas: los catálogos con los que se COMPONE
// el número de parte aduanal (services/part_number.py). Cinco pestañas:
//   Clientes  → prefijo (GTS, SKT, RRB…). Es lo que se toca al llegar un
//               cliente nuevo: sin prefijo, ninguna de sus líneas compone.
//   Prendas   → código, etiqueta y palabras que la delatan en la descripción.
//   Fibras    → letra y palabras (ALGODON/COTTON → C).
//   Países    → nombre o ISO3 capturado → ISO2 del código (CHINA/CHN → CN).
//   Descripciones → catálogo del desplegable "Descripción" de la hoja: la
//               frase aduanal completa del packing list (con composición).
//   Composiciones → catálogo del desplegable "Composición" de la hoja
//               (60% ALGODON 40% POLIESTER…). El servidor las canoniza y
//               rechaza las que no suman 100 o traen fibra desconocida.
//   Tipos     → tipos de operación aduanal (Temporal, Definitivo…).
// Guardar manda SOLO la pestaña activa; el backend fusiona diccionarios por
// llave y reemplaza listas completas. Un cliente/país de fábrica se "quita"
// guardándolo con valor vacío (el backend lo descarta al fusionar).
const TABS = ["customers", "descriptions", "garments", "fibers", "compositions", "countries", "import_types"];
// Listas de texto plano (una fila = un string): comparten editor.
const LIST_TABS = new Set(["import_types", "compositions", "descriptions"]);
// Listas que se capturan en MAYÚSCULAS (van a la hoja tal cual).
const UPPER_TABS = new Set(["compositions", "descriptions"]);

// Vista previa del código de composición (58% ALGODON 42% POLIESTER → 58C42P)
// con las fibras de la config. Solo orientativa: el servidor es quien valida.
const previewComposition = (text, fibers) => {
  const pairs = [];
  const unknown = [];
  const norm = (s) => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  // Mismo criterio que parse_fibers: la fibra se busca DENTRO del segmento
  // hasta el siguiente % ("20% RECYCLED POLYESTER") y la repetida se suma.
  for (const m of norm(text).matchAll(/(\d{1,3})\s*%\s*([^%\d]*)/g)) {
    const words = (m[2].match(/[A-Z]+/g) || []).filter(w => w !== "DE");
    let code = null;
    for (const word of words) {
      const f = (fibers || []).find(x => (x.keywords || []).some(k => word.startsWith(norm(k)) || norm(k).startsWith(word)));
      if (f) { code = String(f.code).toUpperCase(); break; }
    }
    if (code) pairs.push([parseInt(m[1], 10), code]); else if (words.length) unknown.push(words.join(" "));
  }
  const merged = new Map();
  for (const [p, c] of pairs) merged.set(c, (merged.get(c) || 0) + p);
  pairs.length = 0;
  for (const [c, p] of merged) pairs.push([p, c]);
  pairs.sort((a, b) => b[0] - a[0]);
  const total = pairs.reduce((s, [p]) => s + p, 0);
  const code = pairs.map(([p, c]) => (p < 100 ? String(p).padStart(2, "0") : String(p)) + c).join("");
  return { code, total, unknown, ok: pairs.length > 0 && !unknown.length && total === 100 };
};

const cls = {
  input: "h-8 px-2 bg-card border border-input rounded-md text-xs focus:outline-none focus:border-primary",
  th: "px-2 py-1.5 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide",
  iconBtn: "p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10",
};

export function AsnConfigModal({ open, onClose, onSaved }) {
  const { t } = useLang();
  const catalogs = useWmsCatalogs();
  const [cfg, setCfg] = useState(null);
  const [tab, setTab] = useState("customers");
  const [saving, setSaving] = useState(false);
  // Borradores por pestaña. Los diccionarios se editan como lista de pares
  // [llave, valor] para poder renombrar y ordenar sin perder filas.
  const [pairs, setPairs] = useState([]);        // customers | countries
  const [rows, setRows] = useState([]);          // garments | fibers | genders (con keywords como texto)
  const [types, setTypes] = useState([]);        // import_types | compositions

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    fetcher("/asn/part-number/config").then(c => { if (alive) setCfg(c); }).catch(logLoadError("part-number config"));
    return () => { alive = false; };
  }, [open]);

  // Al cambiar de pestaña (o al cargar) se arma el borrador desde la config.
  useEffect(() => {
    if (!cfg) return;
    if (tab === "customers" || tab === "countries") {
      setPairs(Object.entries(cfg[tab] || {}).sort((a, b) => a[0].localeCompare(b[0])));
    } else if (LIST_TABS.has(tab)) {
      setTypes([...(cfg[tab] || [])]);
    } else {
      setRows((cfg[tab] || []).map(r => ({ code: r.code, label: r.label || "", keywords: (r.keywords || []).join(", ") })));
    }
  }, [cfg, tab]);

  if (!open) return null;

  const save = async () => {
    let body;
    if (tab === "customers" || tab === "countries") {
      const dict = {};
      for (const [k, v] of pairs) {
        const key = k.trim().toUpperCase();
        if (!key) continue;
        const val = v.trim().toUpperCase();
        if (tab === "customers" && val && !/^[A-Z]{2,4}$/.test(val)) { toast.error(t("wms_asn_cfg_prefix_bad", { c: key })); return; }
        if (tab === "countries" && val && !/^[A-Z]{2}$/.test(val)) { toast.error(t("wms_asn_cfg_iso2_bad", { c: key })); return; }
        dict[key] = val;
      }
      const used = Object.values(dict).filter(Boolean);
      if (tab === "customers" && new Set(used).size !== used.length) { toast.error(t("wms_asn_cfg_prefix_dup")); return; }
      body = { [tab]: dict };
    } else if (LIST_TABS.has(tab)) {
      body = { [tab]: types.map(x => x.trim()).filter(Boolean) };
    } else {
      const list = rows.map(r => ({ code: r.code.trim().toUpperCase(), label: r.label.trim(), keywords: r.keywords.split(",").map(k => k.trim().toUpperCase()).filter(Boolean) }))
        .filter(r => r.code || tab === "genders");
      body = { [tab]: list };
    }
    setSaving(true);
    try {
      const res = await putter("/asn/part-number/config", body);
      const r = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(r.detail || t("wms_asn_cfg_save_err")); return; }
      setCfg(r);
      toast.success(t("wms_asn_cfg_saved"));
      onSaved?.(r);
    } catch (e) { logLoadError("save part-number config")(e); toast.error(t("wms_conn_error")); }
    finally { setSaving(false); }
  };

  // Clientes del catálogo curado que aún no tienen prefijo: para que agregar
  // uno nuevo sea elegirlo, no teclearlo.
  const missingCustomers = (catalogs.customers || []).filter(c => !pairs.some(([k]) => k.toUpperCase() === String(c).toUpperCase()));

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => !saving && onClose()}>
      <div className="w-full max-w-3xl max-h-[90vh] flex flex-col bg-card border border-border rounded-xl shadow-2xl" onClick={e => e.stopPropagation()} data-testid="asn-config-modal">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h3 className="font-bold text-base flex items-center gap-2"><Settings2 className="w-5 h-5" /> {t("wms_asn_cfg_title")}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex gap-1 px-5 pt-3">
          {TABS.map(k => (
            <button key={k} onClick={() => setTab(k)} data-testid={`asn-cfg-tab-${k}`}
              className={`px-3 py-1.5 text-xs font-medium rounded-md ${tab === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>
              {t(`wms_asn_cfg_tab_${k}`)}
            </button>
          ))}
        </div>
        <p className="px-5 pt-2 text-xs text-muted-foreground">{t(`wms_asn_cfg_help_${tab}`)}</p>

        <div className="flex-1 overflow-auto px-5 py-3">
          {!cfg ? <div className="py-8 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
          : (tab === "customers" || tab === "countries") ? (
            <table className="w-full text-sm">
              <thead><tr>
                <th className={cls.th}>{tab === "customers" ? t("wms_asn_customer") : t("wms_country")}</th>
                <th className={cls.th}>{tab === "customers" ? t("wms_asn_cfg_prefix") : "ISO2"}</th>
                <th className="w-10" />
              </tr></thead>
              <tbody>
                {pairs.map(([k, v], i) => (
                  <tr key={i} className="border-t border-border/60">
                    <td className="p-1"><input value={k} onChange={e => { const v = e.target.value; setPairs(p => p.map((r, j) => j === i ? [v.toUpperCase(), r[1]] : r)); }} className={`${cls.input} w-full`} /></td>
                    <td className="p-1"><input value={v} onChange={e => { const v = e.target.value; setPairs(p => p.map((r, j) => j === i ? [r[0], v.toUpperCase()] : r)); }} className={`${cls.input} w-24 font-mono`} maxLength={tab === "customers" ? 4 : 2} data-testid={`asn-cfg-value-${i}`} /></td>
                    <td className="p-1 text-center"><button onClick={() => setPairs(p => p.filter((_, j) => j !== i))} className={cls.iconBtn} title={t("wms_remove")}><Trash2 className="w-3.5 h-3.5" /></button></td>
                  </tr>
                ))}
                <tr className="border-t border-border/60">
                  <td className="p-1" colSpan={3}>
                    <div className="flex items-center gap-2">
                      {tab === "customers" && missingCustomers.length > 0 ? (
                        <select defaultValue="" onChange={e => {
                          // Leer el valor ANTES de encolar el estado: el updater corre
                          // después y para entonces el select ya está reiniciado.
                          const chosen = e.target.value;
                          if (chosen) { setPairs(p => [...p, [chosen, ""]]); e.target.value = ""; }
                        }} className={`${cls.input} min-w-[220px]`} data-testid="asn-cfg-add-customer">
                          <option value="">{t("wms_asn_cfg_add_customer")}</option>
                          {missingCustomers.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      ) : null}
                      <button onClick={() => setPairs(p => [...p, ["", ""]])} className="inline-flex items-center gap-1 text-xs text-primary hover:underline"><Plus className="w-3.5 h-3.5" /> {t("wms_asn_cfg_add_row")}</button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          ) : LIST_TABS.has(tab) ? (
            <div className="space-y-1">
              {types.map((v, i) => {
                const pv = tab === "compositions" && v.trim() ? previewComposition(v, cfg.fibers) : null;
                return (
                  <div key={i} className="flex items-center gap-2">
                    <input value={v} onChange={e => { const v = e.target.value; setTypes(p => p.map((x, j) => j === i ? (UPPER_TABS.has(tab) ? v.toUpperCase() : v) : x)); }}
                      className={`${cls.input} flex-1 ${tab === "compositions" ? "font-mono" : ""}`}
                      placeholder={tab === "compositions" ? "60% ALGODON 40% POLIESTER" : tab === "descriptions" ? "CAMISETA MANGA CORTA PARA HOMBRE DE PUNTO 100% ALGODÓN" : undefined}
                      data-testid={`asn-cfg-list-${i}`} />
                    {pv && (
                      <span className={`w-28 text-[11px] font-mono truncate ${pv.ok ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400"}`}
                        title={pv.ok ? pv.code : (pv.unknown.length ? `${t("wms_asn_cfg_comp_unknown")}: ${pv.unknown.join(", ")}` : t("wms_asn_cfg_comp_sum", { n: pv.total }))}>
                        {pv.ok ? pv.code : (pv.unknown.length ? `? ${pv.unknown[0]}` : `Σ ${pv.total}%`)}
                      </span>
                    )}
                    <button onClick={() => setTypes(p => p.filter((_, j) => j !== i))} className={cls.iconBtn}><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                );
              })}
              <button onClick={() => setTypes(p => [...p, ""])} className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-1" data-testid="asn-cfg-list-add"><Plus className="w-3.5 h-3.5" /> {t("wms_asn_cfg_add_row")}</button>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead><tr>
                <th className={cls.th}>{t("wms_asn_cfg_code")}</th>
                <th className={cls.th}>{t("wms_asn_cfg_label")}</th>
                <th className={cls.th}>{t("wms_asn_cfg_keywords")}</th>
                <th className="w-10" />
              </tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t border-border/60">
                    <td className="p-1"><input value={r.code} onChange={e => { const v = e.target.value; setRows(p => p.map((x, j) => j === i ? { ...x, code: v.toUpperCase() } : x)); }} className={`${cls.input} w-20 font-mono`} /></td>
                    <td className="p-1"><input value={r.label} onChange={e => { const v = e.target.value; setRows(p => p.map((x, j) => j === i ? { ...x, label: v } : x)); }} className={`${cls.input} w-full`} /></td>
                    <td className="p-1"><input value={r.keywords} onChange={e => { const v = e.target.value; setRows(p => p.map((x, j) => j === i ? { ...x, keywords: v } : x)); }} className={`${cls.input} w-full`} placeholder="MANGA CORTA, SHORT SLEEVE" /></td>
                    <td className="p-1 text-center"><button onClick={() => setRows(p => p.filter((_, j) => j !== i))} className={cls.iconBtn}><Trash2 className="w-3.5 h-3.5" /></button></td>
                  </tr>
                ))}
                <tr className="border-t border-border/60"><td className="p-1" colSpan={4}>
                  <button onClick={() => setRows(p => [...p, { code: "", label: "", keywords: "" }])} className="inline-flex items-center gap-1 text-xs text-primary hover:underline"><Plus className="w-3.5 h-3.5" /> {t("wms_asn_cfg_add_row")}</button>
                </td></tr>
              </tbody>
            </table>
          )}
        </div>

        <div className="flex items-center justify-between px-5 py-3 border-t border-border">
          <span className="text-xs text-muted-foreground">{t("wms_asn_cfg_footer")}</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-md text-muted-foreground hover:text-foreground">{t("cancel")}</button>
            <button onClick={save} disabled={saving || !cfg} className="px-4 py-1.5 text-sm font-semibold rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5" data-testid="asn-cfg-save">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} {t("wms_asn_cfg_save_tab")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
