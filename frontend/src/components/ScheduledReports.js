import React, { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useLang } from "../contexts/LanguageContext";
import { API } from "../lib/constants";
import {
  ArrowLeft, Mail, FileSpreadsheet, BarChart3, Clock, Users, FileText, Send,
  X, Loader2, Save, Eye, History, CheckCircle2, AlertTriangle, Undo2,
} from "lucide-react";
import { toast } from "sonner";

// Catálogo fijo de reportes (el backend manda el mismo orden). Cada tipo tiene
// su propia configuración: contenido, destinatarios y horario.
const ICONS = { production_daily: FileSpreadsheet, executive_production: BarChart3 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PRESETS = ["today", "yesterday", "week", "month"];
const DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [0, 1, 2, 3, 4];
const EDITABLE = ["enabled", "hour", "minute", "weekdays", "recipients", "subject",
  "preset", "format", "quotes_report", "quotes_days", "lang"];

const pad = (n) => String(n).padStart(2, "0");
const pick = (s) => Object.fromEntries(EDITABLE.filter((k) => k in (s || {})).map((k) => [k, s[k]]));
const sameDays = (a, b) => a.length === b.length && a.every((d, i) => d === b[i]);

const api = async (path, opts = {}) => {
  const res = await fetch(`${API}${path}`, {
    credentials: "include",
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
};

const chip = (active) =>
  `px-3.5 py-2 rounded-lg text-sm font-semibold border transition-all ${active
    ? "bg-primary text-white border-primary shadow-[0_2px_12px_rgba(255,193,7,0.3)]"
    : "bg-secondary/50 text-muted-foreground border-border hover:text-foreground hover:border-primary/40"}`;

const inputCls = "w-full bg-secondary/50 border border-border p-2.5 rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary";

function Toggle({ on, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      aria-label={label}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background ${on ? "bg-green-500" : "bg-secondary"}`}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${on ? "translate-x-6" : "translate-x-1"}`} />
    </button>
  );
}

function Step({ n, icon: Icon, title, hint, children }) {
  return (
    <section className="bg-card/60 backdrop-blur-xl border border-border rounded-2xl p-5 md:p-6 space-y-4">
      <div className="flex items-start gap-3">
        <span className="w-7 h-7 shrink-0 rounded-full bg-primary/15 text-primary text-sm font-black flex items-center justify-center">{n}</span>
        <div className="min-w-0">
          <h2 className="text-base font-bold text-foreground flex items-center gap-2">
            <Icon className="w-4 h-4 text-primary" /> {title}
          </h2>
          {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

export default function ScheduledReports() {
  const { t } = useLang();
  const navigate = useNavigate();

  const [reports, setReports] = useState([]);
  const [sends, setSends] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState(null);
  const [newEmail, setNewEmail] = useState("");
  const [testEmail, setTestEmail] = useState("");

  const selected = reports.find((r) => r.schedule_id === selectedId) || null;
  const dirty = !!(selected && draft && JSON.stringify(pick(selected)) !== JSON.stringify(pick(draft)));

  const load = useCallback(async (keepId) => {
    try {
      const data = await api("/report-schedules");
      const list = data.schedules || [];
      setReports(list);
      setSends(data.sends || []);
      const id = list.some((r) => r.schedule_id === keepId) ? keepId : list[0]?.schedule_id;
      setSelectedId(id || null);
      setDraft(list.find((r) => r.schedule_id === id) || null);
    } catch {
      toast.error(t("rs_load_error"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const select = (id) => {
    if (id === selectedId) return;
    if (dirty && !window.confirm(t("rs_unsaved_confirm"))) return;
    setSelectedId(id);
    setDraft(reports.find((r) => r.schedule_id === id) || null);
    setNewEmail("");
    setTestEmail("");
  };

  const patch = (changes) => setDraft((d) => ({ ...d, ...changes }));

  // Acepta uno o varios correos pegados (separados por coma, espacio o ;).
  const addEmails = () => {
    const parts = newEmail.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (!parts.length) return;
    const bad = parts.filter((e) => !EMAIL_RE.test(e));
    if (bad.length) { toast.error(`${t("rs_invalid_email")}: ${bad.join(", ")}`); return; }
    setDraft((d) => ({ ...d, recipients: [...new Set([...d.recipients, ...parts])] }));
    setNewEmail("");
  };

  const toggleDay = (d) => setDraft((cur) => {
    const days = cur.weekdays || DAYS;
    const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort();
    return next.length ? { ...cur, weekdays: next } : cur;   // al menos un día
  });

  const handleSave = async () => {
    setSaving(true);
    try {
      await api(`/report-schedules/${selectedId}`, { method: "PUT", body: JSON.stringify(pick(draft)) });
      toast.success(t("rs_saved"));
      await load(selectedId);
    } catch (e) {
      toast.error(e.message || t("rs_save_error"));
    } finally {
      setSaving(false);
    }
  };

  const handlePreview = async () => {
    if (dirty) { toast.error(t("rs_save_first")); return; }
    setPreviewing(true);
    try {
      setPreview(await api(`/report-schedules/${selectedId}/preview`));
    } catch (e) {
      toast.error(e.message || t("rs_load_error"));
    } finally {
      setPreviewing(false);
    }
  };

  const handleSendNow = async () => {
    const to = testEmail.trim().toLowerCase();
    if (to && !EMAIL_RE.test(to)) { toast.error(t("rs_invalid_email")); return; }
    if (dirty) { toast.error(t("rs_save_first")); return; }
    if (!to && !window.confirm(t("rs_send_all_confirm", { n: draft.recipients.length }))) return;
    setSending(true);
    try {
      const data = await api(`/report-schedules/${selectedId}/run-now`, {
        method: "POST", body: JSON.stringify(to ? { to } : {}),
      });
      toast.success(`${t("rs_sent")} ${(data.recipients || []).join(", ")}`);
      setTestEmail("");
      await load(selectedId);
    } catch (e) {
      toast.error(e.message || t("rs_send_error"));
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-10 h-10 animate-spin text-primary" />
      </div>
    );
  }

  const type = draft?.report_type;
  const days = draft?.weekdays || DAYS;
  const mySends = sends.filter((s) => s.schedule_id === selectedId).slice(0, 15);
  const daysLabel = (list) => {
    const l = list || DAYS;
    if (sameDays(l, DAYS)) return t("rs_days_all");
    if (sameDays(l, WEEKDAYS)) return t("rs_days_weekdays");
    return l.map((d) => t(`rs_day_${d}`)).join(" ");
  };

  return (
    <div className="min-h-screen bg-background text-foreground font-barlow flex flex-col relative overflow-hidden">
      <div className="absolute top-0 right-0 w-1/2 h-1/2 bg-primary/5 blur-[120px] rounded-full -translate-y-1/2 translate-x-1/2 pointer-events-none" />

      <header className="sticky top-0 z-40 bg-background/80 backdrop-blur-xl border-b border-border h-16 flex items-center gap-4 px-4 md:px-6 shadow-sm">
        <button
          onClick={() => navigate("/home")}
          className="w-10 h-10 flex flex-shrink-0 items-center justify-center rounded-xl bg-secondary/50 hover:bg-secondary border border-white/5 transition-all text-muted-foreground hover:text-foreground"
          title={t("admin_back_mos_home")}
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="min-w-0">
          <h1 className="text-lg md:text-xl font-black uppercase tracking-widest text-foreground flex items-center gap-2">
            <Mail className="w-5 h-5 text-primary" /> {t("rs_title")}
          </h1>
          <p className="text-xs text-muted-foreground leading-none mt-1 truncate">{t("rs_subtitle")}</p>
        </div>
      </header>

      <main className="flex-1 relative z-10 w-full max-w-4xl mx-auto px-4 md:px-6 py-6 space-y-6">
        {/* Un reporte = una tarjeta */}
        <div className="grid gap-3 sm:grid-cols-2">
          {reports.map((r) => {
            const Icon = ICONS[r.report_type] || FileText;
            const active = r.schedule_id === selectedId;
            return (
              <button
                key={r.schedule_id}
                onClick={() => select(r.schedule_id)}
                className={`text-left p-4 rounded-2xl border-2 transition-all ${active
                  ? "border-primary bg-primary/10" : "border-border bg-card/60 hover:border-primary/40"}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Icon className="w-5 h-5 text-primary shrink-0" />
                    <span className="font-bold text-foreground">{t(`rs_type_${r.report_type}`)}</span>
                  </div>
                  <span className={`shrink-0 text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${r.enabled
                    ? "bg-green-500/15 text-green-600 dark:text-green-400" : "bg-secondary text-muted-foreground"}`}>
                    {r.enabled ? t("rs_on") : t("rs_off")}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-2">{t(`rs_type_${r.report_type}_hint`)}</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-xs text-foreground/80">
                  <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" />{pad(r.hour)}:{pad(r.minute)} · {daysLabel(r.weekdays)}</span>
                  <span className="flex items-center gap-1"><Users className="w-3.5 h-3.5" />{r.recipients.length} {t("rs_recipients_count")}</span>
                </div>
              </button>
            );
          })}
        </div>

        {draft && (
          <>
            {/* 1. Qué contiene */}
            <Step n={1} icon={FileText} title={t("rs_q_what")}>
              <p className="text-sm text-muted-foreground">{t(`rs_desc_${type}`)}</p>
              {type === "executive_production" && (
                <div>
                  <label className="text-xs text-muted-foreground mb-2 block">{t("rs_lang")}</label>
                  <div className="flex gap-2">
                    {["en", "es"].map((l) => (
                      <button key={l} onClick={() => patch({ lang: l })} className={chip(draft.lang === l)}>{t(`rs_lang_${l}`)}</button>
                    ))}
                  </div>
                </div>
              )}
              {type === "production_daily" && (
                <>
                  <div>
                    <label className="text-xs text-muted-foreground mb-2 block">{t("rs_preset")}</label>
                    <div className="flex flex-wrap gap-2">
                      {PRESETS.map((p) => (
                        <button key={p} onClick={() => patch({ preset: p })} className={chip(draft.preset === p)}>{t(`rs_preset_${p}`)}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-2 block">{t("rs_format")}</label>
                    <div className="flex gap-2">
                      {["excel", "pdf"].map((f) => (
                        <button key={f} onClick={() => patch({ format: f })} className={chip(draft.format === f)}>
                          {f === "excel" ? t("rs_format_excel") : t("rs_format_pdf")}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-start justify-between gap-4 pt-3 border-t border-border/60">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-foreground">{t("rs_quotes_title")}</div>
                      <p className="text-xs text-muted-foreground mt-0.5">{t("rs_quotes_hint")}</p>
                    </div>
                    <Toggle on={!!draft.quotes_report} label={t("rs_quotes_title")} onClick={() => patch({ quotes_report: !draft.quotes_report })} />
                  </div>
                  {draft.quotes_report && (
                    <div className="max-w-xs">
                      <label className="text-xs text-muted-foreground mb-1 block">{t("rs_quotes_days")}</label>
                      <input
                        type="number" min="1" max="365" value={draft.quotes_days}
                        onChange={(e) => patch({ quotes_days: Math.max(1, Math.min(365, parseInt(e.target.value || "30", 10))) })}
                        className={inputCls}
                      />
                    </div>
                  )}
                </>
              )}
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">{t("rs_subject")}</label>
                <input type="text" value={draft.subject || ""} maxLength={200} onChange={(e) => patch({ subject: e.target.value })} className={inputCls} />
              </div>
              <button
                onClick={handlePreview}
                disabled={previewing}
                className="px-4 py-2 bg-secondary hover:bg-secondary/70 border border-border rounded-lg text-sm font-semibold text-foreground flex items-center gap-1.5 transition-colors disabled:opacity-50"
              >
                {previewing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />} {t("rs_preview")}
              </button>
            </Step>

            {/* 2. A quién le llega */}
            <Step n={2} icon={Users} title={t("rs_q_who")} hint={t("rs_who_hint")}>
              <div className="flex flex-wrap gap-2">
                {draft.recipients.length === 0 && <p className="text-sm text-muted-foreground/70 italic">{t("rs_no_recipients")}</p>}
                {draft.recipients.map((email) => (
                  <span key={email} className="inline-flex items-center gap-1.5 bg-secondary/60 border border-border rounded-full pl-3 pr-1 py-1 text-sm text-foreground max-w-full">
                    <span className="truncate">{email}</span>
                    <button
                      onClick={() => patch({ recipients: draft.recipients.filter((x) => x !== email) })}
                      className="p-1 rounded-full text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      title={t("delete")}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addEmails(); } }}
                  placeholder={t("rs_emails_placeholder")}
                  className={`${inputCls} flex-1 min-w-0`}
                />
                <button
                  onClick={addEmails}
                  className="px-4 py-2 bg-secondary hover:bg-secondary/70 border border-border rounded-lg text-sm font-semibold text-foreground shrink-0"
                >
                  {t("rs_add_email")}
                </button>
              </div>
            </Step>

            {/* 3. Cuándo */}
            <Step n={3} icon={Clock} title={t("rs_q_when")} hint={t("rs_timezone_note")}>
              <div className="flex items-center justify-between gap-4 p-3 rounded-xl bg-secondary/40 border border-border">
                <div>
                  <div className="text-sm font-semibold text-foreground">{t("rs_enabled")}</div>
                  <p className="text-xs text-muted-foreground">{draft.enabled ? t("rs_enabled_hint") : t("rs_disabled_hint")}</p>
                </div>
                <Toggle on={!!draft.enabled} label={t("rs_enabled")} onClick={() => patch({ enabled: !draft.enabled })} />
              </div>
              <div className="flex flex-wrap items-end gap-6">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">{t("rs_time")}</label>
                  <input
                    type="time"
                    value={`${pad(draft.hour)}:${pad(draft.minute)}`}
                    onChange={(e) => {
                      const [h, m] = (e.target.value || "0:0").split(":").map((x) => parseInt(x, 10) || 0);
                      patch({ hour: h, minute: m });
                    }}
                    className={`${inputCls} w-36`}
                  />
                </div>
                <div className="min-w-0">
                  <label className="text-xs text-muted-foreground mb-1 block">{t("rs_weekdays")}</label>
                  <div className="flex flex-wrap gap-1.5">
                    {DAYS.map((d) => (
                      <button key={d} onClick={() => toggleDay(d)} className={chip(days.includes(d))}>{t(`rs_day_${d}`)}</button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="flex gap-2 text-xs">
                <button onClick={() => patch({ weekdays: WEEKDAYS })} className="text-primary hover:underline">{t("rs_days_weekdays")}</button>
                <span className="text-muted-foreground">·</span>
                <button onClick={() => patch({ weekdays: DAYS })} className="text-primary hover:underline">{t("rs_days_all")}</button>
              </div>
            </Step>

            {/* Probar */}
            <section className="bg-card/60 backdrop-blur-xl border border-border rounded-2xl p-5 md:p-6 space-y-3">
              <h2 className="text-base font-bold text-foreground flex items-center gap-2"><Send className="w-4 h-4 text-primary" /> {t("rs_section_manual")}</h2>
              <p className="text-xs text-muted-foreground">{t("rs_send_now_hint")}</p>
              <div className="flex flex-col sm:flex-row gap-2">
                <input type="email" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} placeholder={t("rs_test_placeholder")} className={`${inputCls} flex-1`} />
                <button
                  onClick={handleSendNow}
                  disabled={sending}
                  className="px-5 py-2.5 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white rounded-lg font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  {sending ? t("rs_sending") : (testEmail.trim() ? t("rs_send_test") : t("rs_send_now"))}
                </button>
              </div>
            </section>

            {/* Historial de este reporte */}
            <section className="bg-card/60 backdrop-blur-xl border border-border rounded-2xl p-5 md:p-6 space-y-3">
              <h2 className="text-base font-bold text-foreground flex items-center gap-2"><History className="w-4 h-4 text-primary" /> {t("rs_recent_sends")}</h2>
              {mySends.length === 0 ? (
                <p className="text-sm text-muted-foreground/70 italic">{t("rs_no_sends")}</p>
              ) : (
                <div className="divide-y divide-border/60">
                  {mySends.map((s) => (
                    <div key={s.send_id} className="py-2 flex items-start gap-3 text-sm">
                      {s.ok ? <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 shrink-0" /> : <AlertTriangle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <div className="text-foreground truncate">{s.ok ? s.subject : s.error}</div>
                        <div className="text-xs text-muted-foreground truncate">{t(`rs_trigger_${s.trigger}`)} · {(s.recipients || []).join(", ")}</div>
                      </div>
                      <span className="text-xs text-muted-foreground font-mono shrink-0">{new Date(s.at).toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
            {dirty && <div className="h-16" />}
          </>
        )}
      </main>

      {/* Barra de guardado: sólo aparece con cambios pendientes */}
      {dirty && (
        <div className="sticky bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur-xl">
          <div className="max-w-4xl mx-auto px-4 md:px-6 py-3 flex items-center justify-between gap-3">
            <span className="text-sm font-semibold text-foreground truncate">{t("rs_unsaved_badge")}</span>
            <div className="flex gap-2 shrink-0">
              <button onClick={() => setDraft(selected)} className="px-4 py-2 rounded-lg text-sm font-semibold text-muted-foreground hover:text-foreground hover:bg-secondary flex items-center gap-1.5">
                <Undo2 className="w-4 h-4" /> {t("rs_discard")}
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-5 py-2 bg-gradient-to-r from-primary to-orange-500 text-white rounded-lg font-black tracking-wider text-sm flex items-center gap-2 disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} {t("rs_save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {preview && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => setPreview(null)}>
          <div className="bg-card border border-border rounded-2xl w-full max-w-3xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border">
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground uppercase tracking-widest">{t("rs_preview_title")}</div>
                <div className="text-sm font-semibold text-foreground truncate">{preview.subject}</div>
              </div>
              <button onClick={() => setPreview(null)} className="p-1.5 text-muted-foreground hover:text-foreground rounded-md"><X className="w-5 h-5" /></button>
            </div>
            <iframe title={t("rs_preview_title")} srcDoc={preview.html} sandbox="" className="flex-1 w-full min-h-[70vh] bg-white rounded-b-2xl" />
          </div>
        </div>
      )}
    </div>
  );
}
