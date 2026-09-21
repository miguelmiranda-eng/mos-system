import React, { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { API } from "../lib/constants";
import { useLang } from "../contexts/LanguageContext";
import {
  ArrowLeft, Upload, Loader2, CheckCircle2, AlertTriangle,
  Search, FileText, Send, X, Package, Mail, RefreshCw, Trash2, ExternalLink, Settings2,
} from "lucide-react";
import { toast } from "sonner";

export default function PrintavoExport() {
  const navigate = useNavigate();
  const { t } = useLang();
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

  // ── Bandeja "Del correo" (Gmail intake) ─────────────────────────────────
  // Los PDFs de PO que llegan al correo ya vienen parseados por el backend con
  // el MISMO parser del botón "Analizar". Aquí sólo se revisan y se confirman.
  const [searchParams, setSearchParams] = useSearchParams();
  const [intake, setIntake] = useState(null);          // status/config del intake
  const [items, setItems] = useState([]);              // pendientes
  const [intakeItem, setIntakeItem] = useState(null);  // item cargado en revisión
  const [running, setRunning] = useState(false);
  const [showCfg, setShowCfg] = useState(false);
  const showCfgRef = useRef(false);
  showCfgRef.current = showCfg;
  const [cfgDraft, setCfgDraft] = useState({ label_name: "", allowed_domains: "", days_back: 7 });

  const loadIntake = useCallback(async () => {
    try {
      const [st, it] = await Promise.all([
        fetch(`${API}/gmail-intake/status`, { credentials: "include" }).then((r) => r.json()),
        fetch(`${API}/gmail-intake/items?status=pendiente`, { credentials: "include" }).then((r) => r.json()),
      ]);
      setIntake(st);
      setItems(it.items || []);
      // Sólo refresca el borrador si el panel está cerrado: una pasada (↻) no
      // debe borrar lo que el usuario está escribiendo.
      if (!showCfgRef.current) {
        setCfgDraft({ label_name: st.label_name || "", allowed_domains: (st.allowed_domains || []).join(", "), days_back: st.days_back || 7 });
      }
    } catch { /* la bandeja es opcional: si falla, la carga manual sigue funcionando */ }
  }, []);

  // Contacto fijo para auto-crear (mismo buscador de contactos que el paso 3)
  const [autoQuery, setAutoQuery] = useState("");
  const [autoContacts, setAutoContacts] = useState([]);
  const searchAutoContacts = async (q) => {
    setAutoQuery(q);
    if (q.trim().length < 2) { setAutoContacts([]); return; }
    try {
      const res = await fetch(`${API}/printavo-export/contacts?q=${encodeURIComponent(q.trim())}`, { credentials: "include" });
      const data = await res.json();
      setAutoContacts(data.contacts || []);
    } catch { setAutoContacts([]); }
  };
  const putConfig = async (body, okMsg) => {
    try {
      const res = await fetch(`${API}/gmail-intake/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json()).detail || "Error");
      if (okMsg) toast.success(okMsg);
      loadIntake();
    } catch (e) { toast.error(e.message); }
  };
  const setAutoContact = (c) => { setAutoContacts([]); setAutoQuery(""); putConfig({ auto_contact_id: c.id, auto_contact_name: `${c.company} · ${c.name}` }, t('pexport_intake_auto_contact_set')); };
  const toggleAutoCreate = (on) => {
    if (on && !window.confirm(t('pexport_intake_auto_create_confirm'))) return;
    putConfig({ auto_create: on });
  };

  useEffect(() => { loadIntake(); }, [loadIntake]);
  useEffect(() => {
    if (searchParams.get("gmail_connected")) {
      toast.success(t('pexport_intake_connected'));
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams, t]);

  const connectGmail = async () => {
    try {
      const res = await fetch(`${API}/gmail-intake/auth-url`, { credentials: "include" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Error");
      window.location.href = data.url;
    } catch (e) { toast.error(e.message); }
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const res = await fetch(`${API}/gmail-intake/run-now`, { method: "POST", credentials: "include" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Error");
      toast.success(t('pexport_intake_run_result', { n: data.orders, e: data.evaluated }));
      loadIntake();
    } catch (e) { toast.error(e.message); }
    finally { setRunning(false); }
  };

  const toggleEnabled = async (enabled) => {
    try {
      const res = await fetch(`${API}/gmail-intake/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ enabled }) });
      if (!res.ok) throw new Error((await res.json()).detail || "Error");
      loadIntake();
    } catch (e) { toast.error(e.message); }
  };

  const saveCfg = async () => {
    try {
      const res = await fetch(`${API}/gmail-intake/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ label_name: cfgDraft.label_name, allowed_domains: cfgDraft.allowed_domains, days_back: Number(cfgDraft.days_back) || 7 }) });
      if (!res.ok) throw new Error((await res.json()).detail || "Error");
      toast.success(t('pexport_intake_cfg_saved'));
      setShowCfg(false); loadIntake();
    } catch (e) { toast.error(e.message); }
  };

  const reviewItem = (it) => {
    setIntakeItem(it); setFile(null); setResults(null);
    setStyles(it.styles || []);
    setSelected(Object.fromEntries((it.styles || []).map((_, i) => [i, true])));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const discardItem = async (it) => {
    if (!window.confirm(t('pexport_intake_discard_confirm', { po: it.po_number || it.subject }))) return;
    try {
      const res = await fetch(`${API}/gmail-intake/items/${it.item_id}/discard`, { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).detail || "Error");
      if (intakeItem?.item_id === it.item_id) { setIntakeItem(null); setStyles([]); }
      loadIntake();
    } catch (e) { toast.error(e.message); }
  };

  const handleParse = async () => {
    if (!file) { toast.error(t('admin_pexport_select_pdf')); return; }
    setParsing(true); setStyles([]); setResults(null); setIntakeItem(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${API}/printavo-export/parse`, { method: "POST", credentials: "include", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || t('admin_pexport_err_read_pdf'));
      setStyles(data.styles);
      setSelected(Object.fromEntries(data.styles.map((_, i) => [i, true])));
      toast.success(t('admin_pexport_styles_detected', { n: data.count }));
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
    if (!contact) { toast.error(t('admin_pexport_choose_contact')); return; }
    if (!chosen.length) { toast.error(t('admin_pexport_select_style')); return; }
    if (chosen.some((r) => !(r.brand || "").trim())) { toast.error(t('pexport_flag_retailer_missing')); return; }
    setCreating(true); setResults(null);
    try {
      const url = intakeItem ? `${API}/gmail-intake/items/${intakeItem.item_id}/create` : `${API}/printavo-export/create`;
      const res = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ contact_id: contact.id, styles: chosen }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || t('admin_pexport_err_create'));
      setResults(data);
      if (intakeItem && data.created) { setIntakeItem(null); loadIntake(); }
      toast[data.failed ? "warning" : "success"](`${t('admin_pexport_quotes_created', { n: data.created })}${data.failed ? `, ${t('admin_pexport_with_error', { n: data.failed })}` : ""}`);
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
            <p className="text-xs text-muted-foreground font-mono leading-none mt-1">{t('admin_pexport_subtitle')}</p>
          </div>
        </div>
      </header>

      <main className="flex-1 relative z-10 w-full max-w-4xl mx-auto px-4 md:px-6 py-8 space-y-6">
        {/* 0. Del correo (Gmail intake) */}
        {intake && (
          <section className="bg-card/60 backdrop-blur-xl border border-border rounded-2xl p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                <Mail className="w-4 h-4 text-primary" /> {t('pexport_intake_title')}
                {items.length > 0 && <span className="ml-1 px-2 py-0.5 rounded-full bg-primary text-black text-[10px]">{items.length}</span>}
              </h2>
              <div className="flex items-center gap-2">
                {intake.connected ? (
                  <>
                    <span className={`text-[10px] font-mono px-2 py-1 rounded ${intake.auth_error ? "bg-destructive/10 text-destructive" : "bg-emerald-500/10 text-emerald-600"}`}>
                      {intake.email || t('pexport_intake_connected_short')}
                    </span>
                    <label className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide cursor-pointer select-none">
                      <input type="checkbox" checked={!!intake.enabled} onChange={(e) => toggleEnabled(e.target.checked)} className="w-3.5 h-3.5" />
                      {t('pexport_intake_auto')}
                    </label>
                    <button onClick={runNow} disabled={running} title={t('pexport_intake_run_now')}
                      className="p-2 rounded-lg bg-secondary/60 hover:bg-secondary border border-border disabled:opacity-50">
                      {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                    </button>
                  </>
                ) : (
                  <button onClick={connectGmail} disabled={!intake.google_configured}
                    className="px-4 py-2 bg-primary text-black rounded-lg font-black text-[11px] uppercase tracking-widest hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2">
                    <Mail className="w-4 h-4" /> {t('pexport_intake_connect')}
                  </button>
                )}
                <button onClick={() => setShowCfg((v) => !v)} className="p-2 rounded-lg bg-secondary/60 hover:bg-secondary border border-border" title={t('pexport_intake_cfg')}>
                  <Settings2 className="w-4 h-4" />
                </button>
              </div>
            </div>

            {intake.auth_error && (
              <div className="text-xs bg-destructive/10 border border-destructive/30 text-destructive rounded-lg px-3 py-2 flex flex-wrap items-center justify-between gap-2">
                <span>{t('pexport_intake_auth_error')}: {intake.auth_error}</span>
                <button onClick={connectGmail} className="underline font-bold">{t('pexport_intake_reconnect')}</button>
              </div>
            )}
            {!intake.auth_error && intake.last_error && (
              <div className="text-xs bg-amber-500/10 border border-amber-500/30 text-amber-600 rounded-lg px-3 py-2">{intake.last_error}</div>
            )}
            {intake.connected && (
              <p className="text-[11px] text-muted-foreground font-mono">
                {t('pexport_intake_meta', { label: intake.label_name, last: intake.last_run_at ? new Date(intake.last_run_at).toLocaleString() : "—" })}
                {" · "}
                {intake.auto_create
                  ? t('pexport_intake_auto_on', { contact: intake.auto_contact_name || "?", n: intake.auto_created_count || 0 })
                  : t('pexport_intake_auto_off')}
              </p>
            )}
            {intake.last_auto_error && (
              <div className="text-xs bg-amber-500/10 border border-amber-500/30 text-amber-600 rounded-lg px-3 py-2">
                {t('pexport_intake_auto_error')}: {intake.last_auto_error}
              </div>
            )}

            {showCfg && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 bg-secondary/20 border border-border rounded-xl p-4">
                <Field label={t('pexport_intake_cfg_label')} value={cfgDraft.label_name} onChange={(v) => setCfgDraft((d) => ({ ...d, label_name: v }))} />
                <Field label={t('pexport_intake_cfg_domains')} value={cfgDraft.allowed_domains} onChange={(v) => setCfgDraft((d) => ({ ...d, allowed_domains: v }))} />
                <Field label={t('pexport_intake_cfg_days')} value={cfgDraft.days_back} onChange={(v) => setCfgDraft((d) => ({ ...d, days_back: v }))} />
                <div className="md:col-span-3 flex justify-end">
                  <button onClick={saveCfg} className="px-4 py-2 bg-primary text-black rounded-lg font-black text-[11px] uppercase tracking-widest">{t('save')}</button>
                </div>

                {/* Auto-crear en Printavo: contacto fijo + switch */}
                <div className="md:col-span-3 border-t border-border pt-3 space-y-2">
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-black">{t('pexport_intake_auto_title')}</p>
                  <p className="text-xs text-muted-foreground">{t('pexport_intake_auto_help')}</p>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="relative flex-1 min-w-[240px]">
                      {intake.auto_contact_id ? (
                        <div className="flex items-center justify-between bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2">
                          <span className="text-sm font-bold">{intake.auto_contact_name}</span>
                          <button onClick={() => putConfig({ auto_contact_id: null, auto_create: false })} className="p-1 hover:bg-secondary rounded"><X className="w-4 h-4" /></button>
                        </div>
                      ) : (
                        <input value={autoQuery} onChange={(e) => searchAutoContacts(e.target.value)} placeholder={t('pexport_intake_auto_contact_search')}
                          className="w-full bg-secondary/50 border border-border p-2 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary" />
                      )}
                      {autoContacts.length > 0 && (
                        <div className="absolute z-20 mt-1 w-full bg-card border border-border rounded-lg divide-y divide-border/50 overflow-hidden shadow-xl">
                          {autoContacts.map((c) => (
                            <button key={c.id} onClick={() => setAutoContact(c)} className="w-full text-left px-3 py-2 hover:bg-secondary/50">
                              <p className="text-sm font-semibold">{c.company}</p>
                              <p className="text-xs text-muted-foreground">{c.name} {c.email ? `· ${c.email}` : ""}</p>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <label className={`flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide select-none ${intake.auto_contact_id ? "cursor-pointer" : "opacity-50"}`}>
                      <input type="checkbox" disabled={!intake.auto_contact_id} checked={!!intake.auto_create} onChange={(e) => toggleAutoCreate(e.target.checked)} className="w-3.5 h-3.5" />
                      {t('pexport_intake_auto_switch')}
                    </label>
                  </div>
                </div>
              </div>
            )}

            {intake.connected && items.length === 0 && (
              <p className="text-sm text-muted-foreground">{t('pexport_intake_empty')}</p>
            )}
            {items.length > 0 && (
              <div className="border border-border rounded-xl divide-y divide-border/50 overflow-hidden">
                {items.map((it) => (
                  <div key={it.item_id} className={`px-4 py-3 flex flex-wrap items-center gap-3 ${intakeItem?.item_id === it.item_id ? "bg-primary/10" : "hover:bg-secondary/30"}`}>
                    <div className="flex-1 min-w-[200px]">
                      <p className="text-sm font-bold flex flex-wrap items-center gap-2">
                        <span className="font-mono">PO# {it.po_number || "?"}</span>
                        <span className="text-[10px] font-mono text-muted-foreground">{it.style_count} {t('pexport_intake_styles')} · {it.qty_total} pcs</span>
                        {it.flags?.includes("new_version") && <Flag text={t('pexport_intake_flag_new_version')} />}
                        {it.flags?.includes("existing_order") && <Flag text={t('pexport_intake_flag_existing', { n: it.existing_order })} />}
                        {it.flags?.includes("retailer_missing") && <Flag text={t('pexport_flag_retailer_missing')} />}
                        {it.flags?.includes("store_po_missing") && <Flag text={t('pexport_flag_store_po_missing')} />}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">{it.subject}</p>
                      <p className="text-[10px] text-muted-foreground/70 font-mono">{it.from_email} · {it.received_at ? new Date(it.received_at).toLocaleString() : ""} · {it.pdf_filename}</p>
                      {(it.auto_skipped || it.auto_error) && (
                        <p className="text-[10px] font-bold text-amber-600">{t('pexport_intake_waiting')}: {it.auto_error || it.auto_skipped}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {it.gmail_link && (
                        <a href={it.gmail_link} target="_blank" rel="noreferrer" className="p-2 rounded-lg hover:bg-secondary" title="Gmail"><ExternalLink className="w-4 h-4" /></a>
                      )}
                      <button onClick={() => discardItem(it)} className="p-2 rounded-lg hover:bg-destructive/10 text-destructive" title={t('pexport_intake_discard')}><Trash2 className="w-4 h-4" /></button>
                      <button onClick={() => reviewItem(it)} className="px-3 py-1.5 bg-primary text-black rounded-lg font-black text-[11px] uppercase tracking-widest hover:bg-primary/90">
                        {t('pexport_intake_review')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* 1. Upload */}
        <section className="bg-card/60 backdrop-blur-xl border border-border rounded-2xl p-6 space-y-4">
          <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
            <Upload className="w-4 h-4 text-primary" /> {t('admin_pexport_step1')}
          </h2>
          <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
            <label className="flex-1 flex items-center gap-3 bg-secondary/40 border border-dashed border-border rounded-xl px-4 py-3 cursor-pointer hover:border-primary/50 transition-all">
              <FileText className="w-5 h-5 text-muted-foreground shrink-0" />
              <span className="text-sm truncate">{file ? file.name : t('admin_pexport_select_file')}</span>
              <input type="file" accept="application/pdf" className="hidden" onChange={(e) => setFile(e.target.files?.[0] || null)} />
            </label>
            <button onClick={handleParse} disabled={parsing || !file}
              className="px-6 py-3 bg-primary text-black rounded-xl font-black text-xs uppercase tracking-widest hover:bg-primary/90 transition-all shadow-lg disabled:opacity-50 flex items-center justify-center gap-2">
              {parsing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} {t('admin_pexport_analyze')}
            </button>
          </div>
        </section>

        {/* 2. Review */}
        {styles.length > 0 && (
          <section className="bg-card/60 backdrop-blur-xl border border-border rounded-2xl p-6 space-y-4">
            <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-primary" /> {t('admin_pexport_step2', { sel: selCount, total: styles.length })}
              {intakeItem && (
                <span className="ml-2 normal-case tracking-normal font-mono text-[10px] bg-primary/10 text-primary px-2 py-0.5 rounded flex items-center gap-1">
                  <Mail className="w-3 h-3" /> {intakeItem.subject}
                </span>
              )}
            </h2>
            <div className="space-y-3">
              {styles.map((r, i) => (
                <div key={i} className={`rounded-xl border p-4 transition-all ${selected[i] ? "border-primary/40 bg-secondary/20" : "border-border bg-secondary/5 opacity-60"}`}>
                  <div className="flex items-start gap-3">
                    <input type="checkbox" checked={!!selected[i]} onChange={(e) => setSelected((s) => ({ ...s, [i]: e.target.checked }))} className="w-4 h-4 mt-1 cursor-pointer" />
                    <div className="flex-1 min-w-0 grid grid-cols-2 md:grid-cols-4 gap-3">
                      <Field label={t('pexport_field_brand')} value={r.brand} onChange={(v) => editStyle(i, "brand", v)}
                        warn={!r.brand} />
                      <Field label="PO#" value={r.po_number} onChange={(v) => editStyle(i, "po_number", v)} warn={!r.po_number} />
                      <Field label={t('pexport_field_store_po')} value={r.store_po} onChange={(v) => editStyle(i, "store_po", v)} warn={!r.store_po} />
                      <Field label={t('pexport_field_retailer')} value={r.retailer} readOnly />
                      <Field label="Design #" value={r.design_num} onChange={(v) => editStyle(i, "design_num", v)} />
                      <Field label="Blank" value={r.blank} onChange={(v) => editStyle(i, "blank", v)} />
                      <Field label={t('wms_label_color')} value={r.color} onChange={(v) => editStyle(i, "color", v)} />
                      <Field label={t('quantity')} value={r.qty} readOnly />
                      <div className="col-span-2 md:col-span-4">
                        <Field label={t('description')} value={r.description} onChange={(v) => editStyle(i, "description", v)} />
                      </div>
                      <div className="col-span-2 md:col-span-4 flex flex-wrap gap-2 items-center">
                        <span className="text-[10px] uppercase font-black text-muted-foreground/60">{t('admin_pexport_sizes')}</span>
                        {Object.entries(r.sizes || {}).map(([sz, q]) => (
                          <span key={sz} className="text-[11px] font-mono bg-secondary px-2 py-0.5 rounded">{sz}:{q}</span>
                        ))}
                        {!r.brand && <Flag text={t('pexport_flag_retailer_missing')} />}
                        {!r.store_po && <Flag text={t('pexport_flag_store_po_missing')} />}
                        {!r.po_number && <Flag text={t('pexport_flag_po_missing')} />}
                        {!r.sizes_match && <Flag text={t('admin_pexport_sizes_mismatch')} />}
                        {r.po_discrepancy && <Flag text={t('admin_pexport_po_discrepancy', { table: r.store_po, notes: r.store_po_notes })} />}
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
              <Search className="w-4 h-4 text-primary" /> {t('admin_pexport_step3')}
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
                <input value={contactQuery} onChange={(e) => searchContacts(e.target.value)} placeholder={t('admin_pexport_search_customer')}
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
              {t('admin_pexport_create_btn', { n: selCount })}
            </button>
          </section>
        )}

        {/* Results */}
        {results && (
          <section className="bg-card/60 backdrop-blur-xl border border-border rounded-2xl p-6 space-y-3">
            <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground">{t('admin_pexport_result')}</h2>
            <p className={`text-xs ${results.owner_matched ? "text-muted-foreground" : "text-amber-600 font-semibold"}`}>
              {results.owner_matched
                ? t('admin_pexport_owner_matched', { email: results.owner_email })
                : t('admin_pexport_owner_unmatched', { email: results.owner_email })}
            </p>
            {results.results.map((r, i) => (
              <div key={i} className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg ${r.ok ? "bg-emerald-500/10 text-emerald-600" : "bg-destructive/10 text-destructive"}`}>
                {r.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                <span className="font-mono">{r.design_num}</span>
                <span>{r.ok ? t('admin_pexport_quote_created', { id: r.visual_id }) : `→ ${r.error}`}</span>
              </div>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}

const Field = ({ label, value, onChange, readOnly, warn }) => (
  <div>
    <label className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-black block mb-1">{label}</label>
    <input value={value ?? ""} readOnly={readOnly} onChange={(e) => onChange && onChange(e.target.value)}
      className={`w-full bg-background/60 border rounded px-2 py-1.5 text-sm ${warn ? "border-amber-500/70 bg-amber-500/5" : "border-border/50"} ${readOnly ? "opacity-60 cursor-not-allowed" : "focus:ring-1 focus:ring-primary"}`} />
  </div>
);

const Flag = ({ text }) => (
  <span className="text-[10px] font-black uppercase tracking-wide text-amber-600 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded flex items-center gap-1">
    <AlertTriangle className="w-3 h-3" /> {text}
  </span>
);
