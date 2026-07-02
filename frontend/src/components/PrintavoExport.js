import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { API } from "../lib/constants";
import {
  ArrowLeft, Upload, Loader2, CheckCircle2, AlertTriangle,
  Search, FileText, Send, X, Package,
} from "lucide-react";
import { toast } from "sonner";

export default function PrintavoExport() {
  const navigate = useNavigate();
  const [file, setFile] = useState(null);
  const [parsing, setParsing] = useState(false);
  const [styles, setStyles] = useState([]);        // parsed records (full, editable)
  const [selected, setSelected] = useState({});    // idx -> bool

  // contact picker
  const [contactQuery, setContactQuery] = useState("");
  const [contacts, setContacts] = useState([]);
  const [contact, setContact] = useState(null);
  const [searching, setSearching] = useState(false);

  const [creating, setCreating] = useState(false);
  const [results, setResults] = useState(null);

  const handleParse = async () => {
    if (!file) { toast.error("Selecciona un PDF"); return; }
    setParsing(true); setStyles([]); setResults(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${API}/printavo-export/parse`, { method: "POST", credentials: "include", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Error al leer el PDF");
      setStyles(data.styles);
      setSelected(Object.fromEntries(data.styles.map((_, i) => [i, true])));
      toast.success(`${data.count} estilo(s) detectado(s)`);
    } catch (e) { toast.error(e.message); }
    finally { setParsing(false); }
  };

  const searchContacts = async (q) => {
    setContactQuery(q); setContact(null);
    if (q.trim().length < 2) { setContacts([]); return; }
    setSearching(true);
    try {
      const res = await fetch(`${API}/printavo-export/contacts?q=${encodeURIComponent(q.trim())}`, { credentials: "include" });
      const data = await res.json();
      setContacts(data.contacts || []);
    } catch { setContacts([]); }
    finally { setSearching(false); }
  };

  const editStyle = (idx, key, val) =>
    setStyles((s) => s.map((r, i) => (i === idx ? { ...r, [key]: val } : r)));

  const handleCreate = async () => {
    const chosen = styles.filter((_, i) => selected[i]);
    if (!contact) { toast.error("Elige el cliente/contacto de Printavo"); return; }
    if (!chosen.length) { toast.error("Selecciona al menos un estilo"); return; }
    setCreating(true); setResults(null);
    try {
      const res = await fetch(`${API}/printavo-export/create`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ contact_id: contact.id, styles: chosen }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Error al crear las quotes");
      setResults(data);
      toast[data.failed ? "warning" : "success"](`${data.created} quote(s) creada(s)${data.failed ? `, ${data.failed} con error` : ""}`);
    } catch (e) { toast.error(e.message); }
    finally { setCreating(false); }
  };

  const selCount = Object.values(selected).filter(Boolean).length;

  return (
    <div className="min-h-screen bg-background text-foreground font-barlow flex flex-col relative overflow-hidden">
      <div className="absolute top-0 right-0 w-1/2 h-1/2 bg-primary/5 blur-[120px] rounded-full -translate-y-1/2 translate-x-1/2 pointer-events-none" />

      <header className="sticky top-0 z-40 bg-background/80 backdrop-blur-xl border-b border-border h-16 flex items-center justify-between px-6 shadow-sm">
        <div className="flex items-center gap-4">
          <button onClick={() => navigate("/home")} className="w-10 h-10 flex items-center justify-center rounded-xl bg-secondary/50 hover:bg-secondary border border-white/5 transition-all text-muted-foreground hover:text-foreground">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-xl font-black uppercase tracking-widest text-foreground flex items-center gap-2">
              <Package className="w-5 h-5 text-primary" /> PO → Quote Printavo
            </h1>
            <p className="text-xs text-muted-foreground font-mono leading-none mt-1">Sube un PO de cliente y crea las quotes en Printavo</p>
          </div>
        </div>
      </header>

      <main className="flex-1 relative z-10 w-full max-w-4xl mx-auto px-4 md:px-6 py-8 space-y-6">
        {/* 1. Upload */}
        <section className="bg-card/60 backdrop-blur-xl border border-border rounded-2xl p-6 space-y-4">
          <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
            <Upload className="w-4 h-4 text-primary" /> 1. Sube el PDF del PO
          </h2>
          <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
            <label className="flex-1 flex items-center gap-3 bg-secondary/40 border border-dashed border-border rounded-xl px-4 py-3 cursor-pointer hover:border-primary/50 transition-all">
              <FileText className="w-5 h-5 text-muted-foreground shrink-0" />
              <span className="text-sm truncate">{file ? file.name : "Seleccionar archivo PDF…"}</span>
              <input type="file" accept="application/pdf" className="hidden" onChange={(e) => setFile(e.target.files?.[0] || null)} />
            </label>
            <button onClick={handleParse} disabled={parsing || !file}
              className="px-6 py-3 bg-primary text-black rounded-xl font-black text-xs uppercase tracking-widest hover:bg-primary/90 transition-all shadow-lg disabled:opacity-50 flex items-center justify-center gap-2">
              {parsing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} Analizar
            </button>
          </div>
        </section>

        {/* 2. Review */}
        {styles.length > 0 && (
          <section className="bg-card/60 backdrop-blur-xl border border-border rounded-2xl p-6 space-y-4">
            <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-primary" /> 2. Revisa los estilos ({selCount}/{styles.length} seleccionados)
            </h2>
            <div className="space-y-3">
              {styles.map((r, i) => (
                <div key={i} className={`rounded-xl border p-4 transition-all ${selected[i] ? "border-primary/40 bg-secondary/20" : "border-border bg-secondary/5 opacity-60"}`}>
                  <div className="flex items-start gap-3">
                    <input type="checkbox" checked={!!selected[i]} onChange={(e) => setSelected((s) => ({ ...s, [i]: e.target.checked }))} className="w-4 h-4 mt-1 cursor-pointer" />
                    <div className="flex-1 min-w-0 grid grid-cols-2 md:grid-cols-4 gap-3">
                      <Field label="Design #" value={r.design_num} onChange={(v) => editStyle(i, "design_num", v)} />
                      <Field label="Blank" value={r.blank} onChange={(v) => editStyle(i, "blank", v)} />
                      <Field label="Color" value={r.color} onChange={(v) => editStyle(i, "color", v)} />
                      <Field label="Cantidad" value={r.qty} readOnly />
                      <div className="col-span-2 md:col-span-4">
                        <Field label="Descripción" value={r.description} onChange={(v) => editStyle(i, "description", v)} />
                      </div>
                      <div className="col-span-2 md:col-span-4 flex flex-wrap gap-2 items-center">
                        <span className="text-[10px] uppercase font-black text-muted-foreground/60">Tallas:</span>
                        {Object.entries(r.sizes || {}).map(([sz, q]) => (
                          <span key={sz} className="text-[11px] font-mono bg-secondary px-2 py-0.5 rounded">{sz}:{q}</span>
                        ))}
                        {!r.sizes_match && <Flag text="Tallas ≠ cantidad" />}
                        {r.po_discrepancy && <Flag text={`PO tabla ${r.store_po} ≠ notas ${r.store_po_notes}`} />}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* 3. Customer + create */}
        {styles.length > 0 && (
          <section className="bg-card/60 backdrop-blur-xl border border-border rounded-2xl p-6 space-y-4">
            <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
              <Search className="w-4 h-4 text-primary" /> 3. Cliente en Printavo
            </h2>
            {contact ? (
              <div className="flex items-center justify-between bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-4 py-3">
                <div>
                  <p className="text-sm font-bold text-foreground">{contact.company}</p>
                  <p className="text-xs text-muted-foreground">{contact.name} {contact.email ? `· ${contact.email}` : ""}</p>
                </div>
                <button onClick={() => { setContact(null); setContactQuery(""); }} className="p-1.5 hover:bg-secondary rounded-lg"><X className="w-4 h-4" /></button>
              </div>
            ) : (
              <div className="relative">
                <input value={contactQuery} onChange={(e) => searchContacts(e.target.value)} placeholder="Buscar cliente (ej. GOODIE)…"
                  className="w-full bg-secondary/50 border border-border p-2.5 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary" />
                {searching && <Loader2 className="w-4 h-4 animate-spin absolute right-3 top-3 text-muted-foreground" />}
                {contacts.length > 0 && (
                  <div className="mt-2 border border-border rounded-lg divide-y divide-border/50 overflow-hidden">
                    {contacts.map((c) => (
                      <button key={c.id} onClick={() => { setContact(c); setContacts([]); }} className="w-full text-left px-4 py-2 hover:bg-secondary/50 transition-colors">
                        <p className="text-sm font-semibold">{c.company}</p>
                        <p className="text-xs text-muted-foreground">{c.name} {c.email ? `· ${c.email}` : ""}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button onClick={handleCreate} disabled={creating || !contact || selCount === 0}
              className="px-6 py-3 bg-gradient-to-r from-primary to-orange-500 text-white rounded-xl font-black text-xs uppercase tracking-widest hover:from-primary/90 transition-all shadow-lg disabled:opacity-50 flex items-center justify-center gap-2">
              {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Crear {selCount} quote(s) en Printavo
            </button>
          </section>
        )}

        {/* Results */}
        {results && (
          <section className="bg-card/60 backdrop-blur-xl border border-border rounded-2xl p-6 space-y-3">
            <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground">Resultado</h2>
            <p className={`text-xs ${results.owner_matched ? "text-muted-foreground" : "text-amber-600 font-semibold"}`}>
              {results.owner_matched
                ? `Quotes creadas a nombre de: ${results.owner_email}`
                : `⚠ Tu email (${results.owner_email}) no coincide con un usuario de Printavo — quedaron con el owner por defecto.`}
            </p>
            {results.results.map((r, i) => (
              <div key={i} className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg ${r.ok ? "bg-emerald-500/10 text-emerald-600" : "bg-destructive/10 text-destructive"}`}>
                {r.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                <span className="font-mono">{r.design_num}</span>
                <span>{r.ok ? `→ Quote #${r.visual_id} creada` : `→ ${r.error}`}</span>
              </div>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}

const Field = ({ label, value, onChange, readOnly }) => (
  <div>
    <label className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-black block mb-1">{label}</label>
    <input value={value ?? ""} readOnly={readOnly} onChange={(e) => onChange && onChange(e.target.value)}
      className={`w-full bg-background/60 border border-border/50 rounded px-2 py-1.5 text-sm ${readOnly ? "opacity-60 cursor-not-allowed" : "focus:ring-1 focus:ring-primary"}`} />
  </div>
);

const Flag = ({ text }) => (
  <span className="text-[10px] font-black uppercase tracking-wide text-amber-600 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded flex items-center gap-1">
    <AlertTriangle className="w-3 h-3" /> {text}
  </span>
);
