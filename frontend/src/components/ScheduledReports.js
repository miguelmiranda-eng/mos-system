import React, { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useLang } from "../contexts/LanguageContext";
import { API } from "../lib/constants";
import {
  ArrowLeft, CalendarClock, Clock, Users, FileText, Send,
  Plus, X, Loader2, Save, Mail, CheckCircle2, Eye, Trash2, History, AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PRESETS = ["today", "yesterday", "week", "month"];
const DAYS = [0, 1, 2, 3, 4, 5, 6];
const LEGACY_ID = "daily_production";

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

const pad = (n) => String(n).padStart(2, "0");

// Campos editables (lo demás — last_sent_date, created_at — es del servidor).
const EDITABLE = ["name", "enabled", "hour", "minute", "weekdays", "recipients", "subject",
  "preset", "format", "quotes_report", "quotes_days", "lang"];
const pick = (s) => Object.fromEntries(EDITABLE.filter((k) => k in (s || {})).map((k) => [k, s[k]]));

function Toggle({ on, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background ${on ? "bg-green-500" : "bg-secondary"}`}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${on ? "translate-x-6" : "translate-x-1"}`} />
    </button>
  );
}

function Section({ icon: Icon, title, children }) {
  return (
    <section className="bg-card/60 backdrop-blur-xl border border-border rounded-2xl p-6 space-y-4">
      <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
        <Icon className="w-4 h-4 text-primary" /> {title}
      </h2>
      {children}
    </section>
  );
}

const chip = (active) =>
  `px-4 py-2 rounded-lg text-sm font-semibold border transition-all ${active
    ? "bg-primary text-white border-primary shadow-[0_2px_12px_rgba(255,193,7,0.3)]"
    : "bg-secondary/50 text-muted-foreground border-border hover:text-foreground hover:border-primary/40"}`;

export default function ScheduledReports() {
  const { t } = useLang();
  const navigate = useNavigate();

  const [schedules, setSchedules] = useState([]);
  const [types, setTypes] = useState([]);
  const [sends, setSends] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState(null);
  const [newMenu, setNewMenu] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [testEmail, setTestEmail] = useState("");

  const selected = schedules.find((s) => s.schedule_id === selectedId) || null;
  const dirty = !!(selected && draft && JSON.stringify(pick(selected)) !== JSON.stringify(pick(draft)));

  const load = useCallback(async (keepId) => {
    try {
      const data = await api("/report-schedules");
      setSchedules(data.schedules || []);
      setTypes(data.types || []);
      setSends(data.sends || []);
      const id = keepId && data.schedules.some((s) => s.schedule_id === keepId)
        ? keepId : data.schedules[0]?.schedule_id;
      setSelectedId(id || null);
      setDraft(data.schedules.find((s) => s.schedule_id === id) || null);
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
    setDraft(schedules.find((s) => s.schedule_id === id) || null);
    setNewEmail("");
    setTestEmail("");
  };

  const patch = (changes) => setDraft((d) => ({ ...d, ...changes }));
  const typeName = (type) => t(`rs_type_${type}`);

  const addEmail = () => {
    const email = newEmail.trim().toLowerCase();
    if (!email) return;
    if (!EMAIL_RE.test(email)) { toast.error(t("rs_invalid_email")); return; }
    if (draft.recipients.some((r) => r.toLowerCase() === email)) { toast.error(t("rs_duplicate_email")); return; }
    patch({ recipients: [...draft.recipients, email] });
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

  const handleCreate = async (type) => {
    setNewMenu(false);
    if (dirty && !window.confirm(t("rs_unsaved_confirm"))) return;
    try {
      const s = await api("/report-schedules", { method: "POST", body: JSON.stringify({ report_type: type }) });
      toast.success(t("rs_created"));
      await load(s.schedule_id);
    } catch (e) {
      toast.error(e.message || t("rs_save_error"));
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(t("rs_delete_confirm", { name: draft.name }))) return;
    try {
      await api(`/report-schedules/${selectedId}`, { method: "DELETE" });
      toast.success(t("rs_deleted"));
      await load();
    } catch (e) {
      toast.error(e.message || t("rs_save_error"));
    }
  };

  const handlePreview = async () => {
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

  const isExec = draft?.report_type === "executive_production";

  return (
    <div className="min-h-screen bg-background text-foreground font-barlow flex flex-col relative overflow-hidden">
      <div className="absolute top-0 right-0 w-1/2 h-1/2 bg-primary/5 blur-[120px] rounded-full -translate-y-1/2 translate-x-1/2 pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-1/3 h-1/3 bg-cyan-500/5 blur-[100px] rounded-full translate-y-1/2 -translate-x-1/3 pointer-events-none" />

      <header className="sticky top-0 z-40 bg-background/80 backdrop-blur-xl border-b border-border h-16 flex items-center justify-between px-6 shadow-sm">
        <div className="flex items-center gap-4 min-w-0">
          <button
            onClick={() => navigate("/home")}
            className="w-10 h-10 flex flex-shrink-0 items-center justify-center rounded-xl bg-secondary/50 hover:bg-secondary border border-white/5 transition-all text-muted-foreground hover:text-foreground hover:shadow-lg hover:-translate-x-0.5"
            title={t("admin_back_mos_home")}
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <h1 className="text-xl font-black uppercase tracking-widest text-foreground flex items-center gap-2">
              <CalendarClock className="w-5 h-5 text-primary" />
              {t("rs_title")}
            </h1>
            <p className="text-xs text-muted-foreground font-mono leading-none mt-1 truncate">{t("rs_subtitle")}</p>
          </div>
        </div>
        <div className="relative">
          <button
            onClick={() => setNewMenu((v) => !v)}
            className="px-4 py-2 bg-secondary hover:bg-secondary/70 border border-border rounded-lg text-sm font-semibold text-foreground flex items-center gap-1.5 transition-colors"
          >
            <Plus className="w-4 h-4" /> {t("rs_new")}
          </button>
          {newMenu && (
            <div className="absolute right-0 mt-2 w-72 bg-card border border-border rounded-xl shadow-xl p-1 z-50">
              {types.map((ty) => (
                <button
                  key={ty.type}
                  onClick={() => handleCreate(ty.type)}
                  className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-secondary/60"
                >
                  <div className="text-sm font-semibold text-foreground">{typeName(ty.type)}</div>
                  <div className="text-xs text-muted-foreground">{t(`rs_type_${ty.type}_hint`)}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 relative z-10 w-full max-w-6xl mx-auto px-4 md:px-6 py-8 grid gap-6 md:grid-cols-[280px_1fr] items-start">
        {/* Lista de programaciones */}
        <aside className="space-y-2">
          {schedules.map((s) => (
            <button
              key={s.schedule_id}
              onClick={() => select(s.schedule_id)}
              className={`w-full text-left p-4 rounded-xl border transition-all ${s.schedule_id === selectedId
                ? "bg-primary/10 border-primary/50" : "bg-card/60 border-border hover:border-primary/30"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-bold text-foreground truncate">{s.name}</span>
                <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${s.enabled ? "bg-green-500" : "bg-muted-foreground/40"}`}
                  title={s.enabled ? t("rs_on") : t("rs_off")} />
              </div>
              <div className="text-xs text-muted-foreground mt-1">{typeName(s.report_type)}</div>
              <div className="text-xs text-muted-foreground/80 mt-1 font-mono">
                {pad(s.hour)}:{pad(s.minute)} · {(s.weekdays || DAYS).map((d) => t(`rs_day_${d}`)).join(" ")}
              </div>
              <div className="text-xs text-muted-foreground/70 mt-1">
                {s.recipients.length} {t("rs_recipients_count")} · {t("rs_last_sent")}: {s.last_sent_date || t("rs_never")}
              </div>
            </button>
          ))}
        </aside>

        {draft && (
          <div className="space-y-6 min-w-0">
            {/* Nombre + encendido */}
            <section className="bg-card/60 backdrop-blur-xl border border-border rounded-2xl p-6 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <label className="text-xs text-muted-foreground mb-1 block">{t("rs_name")}</label>
                  <input
                    type="text"
                    value={draft.name || ""}
                    onChange={(e) => patch({ name: e.target.value })}
                    maxLength={80}
                    className="w-full bg-secondary/50 border border-border p-2.5 rounded-lg text-sm font-semibold text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                  <p className="text-xs text-muted-foreground mt-2">
                    {typeName(draft.report_type)}
                    {draft.schedule_id === LEGACY_ID && <span className="ml-2 px-1.5 py-0.5 rounded bg-secondary text-[10px] uppercase tracking-wider">{t("rs_original_badge")}</span>}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <Toggle on={!!draft.enabled} onClick={() => patch({ enabled: !draft.enabled })} />
                  <span className="text-xs text-muted-foreground">{draft.enabled ? t("rs_on") : t("rs_off")}</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground/70 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {t("rs_last_sent")}: <span className="font-semibold text-foreground/80">{draft.last_sent_date || t("rs_never")}</span>
              </p>
            </section>

            {/* Horario */}
            <Section icon={Clock} title={t("rs_section_schedule")}>
              <div className="grid grid-cols-2 gap-4 max-w-xs">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">{t("rs_hour")}</label>
                  <select
                    value={draft.hour}
                    onChange={(e) => patch({ hour: parseInt(e.target.value, 10) })}
                    className="w-full bg-secondary/50 border border-border p-2.5 rounded-lg text-foreground"
                  >
                    {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{pad(h)}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">{t("rs_minute")}</label>
                  <select
                    value={draft.minute}
                    onChange={(e) => patch({ minute: parseInt(e.target.value, 10) })}
                    className="w-full bg-secondary/50 border border-border p-2.5 rounded-lg text-foreground"
                  >
                    {Array.from({ length: 60 }, (_, m) => <option key={m} value={m}>{pad(m)}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-2 block">{t("rs_weekdays")}</label>
                <div className="flex flex-wrap gap-2">
                  {DAYS.map((d) => (
                    <button key={d} onClick={() => toggleDay(d)} className={chip((draft.weekdays || DAYS).includes(d))}>
                      {t(`rs_day_${d}`)}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-xs text-muted-foreground/70">{t("rs_timezone_note")}</p>
            </Section>

            {/* Destinatarios */}
            <Section icon={Users} title={t("rs_section_recipients")}>
              <div className="flex flex-col gap-2">
                {draft.recipients.length === 0 ? (
                  <p className="text-sm text-muted-foreground/70 italic">{t("rs_no_recipients")}</p>
                ) : (
                  draft.recipients.map((email) => (
                    <div key={email} className="flex items-center justify-between gap-2 bg-secondary/40 border border-white/5 rounded-lg px-3 py-2">
                      <span className="flex items-center gap-2 text-sm text-foreground truncate">
                        <Mail className="w-4 h-4 text-muted-foreground shrink-0" />
                        <span className="truncate">{email}</span>
                      </span>
                      <button
                        onClick={() => patch({ recipients: draft.recipients.filter((r) => r !== email) })}
                        className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md transition-colors shrink-0"
                        title={t("delete")}
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))
                )}
              </div>
              <div className="flex gap-2">
                <input
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addEmail(); } }}
                  placeholder={t("rs_email_placeholder")}
                  className="flex-1 min-w-0 bg-secondary/50 border border-border p-2.5 rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <button
                  onClick={addEmail}
                  className="px-4 py-2 bg-secondary hover:bg-secondary/70 border border-border rounded-lg text-sm font-semibold text-foreground flex items-center gap-1.5 transition-colors"
                >
                  <Plus className="w-4 h-4" /> {t("rs_add_email")}
                </button>
              </div>
            </Section>

            {/* Contenido */}
            <Section icon={FileText} title={t("rs_section_content")}>
              {isExec ? (
                <>
                  <p className="text-sm text-muted-foreground">{t("rs_exec_desc")}</p>
                  <div>
                    <label className="text-xs text-muted-foreground mb-2 block">{t("rs_lang")}</label>
                    <div className="flex gap-2">
                      {["en", "es"].map((l) => (
                        <button key={l} onClick={() => patch({ lang: l })} className={chip(draft.lang === l)}>
                          {t(`rs_lang_${l}`)}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="text-xs text-muted-foreground mb-2 block">{t("rs_preset")}</label>
                    <div className="flex flex-wrap gap-2">
                      {PRESETS.map((p) => (
                        <button key={p} onClick={() => patch({ preset: p })} className={chip(draft.preset === p)}>
                          {t(`rs_preset_${p}`)}
                        </button>
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
                    <Toggle on={!!draft.quotes_report} onClick={() => patch({ quotes_report: !draft.quotes_report })} />
                  </div>
                  {draft.quotes_report && (
                    <div className="max-w-xs">
                      <label className="text-xs text-muted-foreground mb-1 block">{t("rs_quotes_days")}</label>
                      <input
                        type="number" min="1" max="365" value={draft.quotes_days}
                        onChange={(e) => patch({ quotes_days: Math.max(1, Math.min(365, parseInt(e.target.value || "30", 10))) })}
                        className="w-full bg-secondary/50 border border-border p-2.5 rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                      />
                    </div>
                  )}
                </>
              )}
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">{t("rs_subject")}</label>
                <input
                  type="text"
                  value={draft.subject || ""}
                  onChange={(e) => patch({ subject: e.target.value })}
                  placeholder={t("rs_subject_placeholder")}
                  maxLength={200}
                  className="w-full bg-secondary/50 border border-border p-2.5 rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <button
                onClick={handlePreview}
                disabled={previewing}
                className="px-4 py-2 bg-secondary hover:bg-secondary/70 border border-border rounded-lg text-sm font-semibold text-foreground flex items-center gap-1.5 transition-colors disabled:opacity-50"
              >
                {previewing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
                {t("rs_preview")}
              </button>
            </Section>

            {/* Envío manual */}
            <Section icon={Send} title={t("rs_section_manual")}>
              <p className="text-sm text-muted-foreground">{t("rs_send_now_hint")}</p>
              <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
                <div className="flex-1">
                  <label className="text-xs text-muted-foreground mb-1 block">{t("rs_test_to")}</label>
                  <input
                    type="email"
                    value={testEmail}
                    onChange={(e) => setTestEmail(e.target.value)}
                    placeholder={t("rs_test_placeholder")}
                    className="w-full bg-secondary/50 border border-border p-2.5 rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
                <button
                  onClick={handleSendNow}
                  disabled={sending}
                  className="px-6 py-2.5 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white rounded-lg font-bold text-sm transition-all shadow-[0_4px_20px_rgba(8,145,178,0.3)] flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  {sending ? t("rs_sending") : t("rs_send_now")}
                </button>
              </div>
            </Section>

            {/* Acciones */}
            <div className="flex items-center justify-between gap-3">
              {draft.schedule_id !== LEGACY_ID ? (
                <button
                  onClick={handleDelete}
                  className="px-4 py-2 text-sm font-semibold text-destructive hover:bg-destructive/10 rounded-lg flex items-center gap-1.5"
                >
                  <Trash2 className="w-4 h-4" /> {t("rs_delete")}
                </button>
              ) : <span />}
              <button
                onClick={handleSave}
                disabled={saving || !dirty}
                className="px-6 py-2 bg-gradient-to-r from-primary to-orange-500 hover:from-primary/90 hover:to-orange-500/90 text-white rounded-lg font-black tracking-widest text-sm transition-all shadow-[0_4px_20px_rgba(255,193,7,0.3)] flex items-center gap-2 disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {t("rs_save")}
              </button>
            </div>

            {/* Últimos envíos */}
            <Section icon={History} title={t("rs_recent_sends")}>
              {sends.length === 0 ? (
                <p className="text-sm text-muted-foreground/70 italic">{t("rs_no_sends")}</p>
              ) : (
                <div className="divide-y divide-border/60">
                  {sends.map((s) => (
                    <div key={s.send_id} className="py-2 flex items-start gap-3 text-sm">
                      {s.ok
                        ? <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 shrink-0" />
                        : <AlertTriangle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <div className="text-foreground truncate">{s.ok ? s.subject : s.error}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          {s.name} · {t(`rs_trigger_${s.trigger}`)} · {(s.recipients || []).join(", ")}
                        </div>
                      </div>
                      <span className="text-xs text-muted-foreground font-mono shrink-0">
                        {new Date(s.at).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </div>
        )}
      </main>

      {preview && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => setPreview(null)}>
          <div className="bg-card border border-border rounded-2xl w-full max-w-3xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border">
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground uppercase tracking-widest">{t("rs_preview_title")}</div>
                <div className="text-sm font-semibold text-foreground truncate">{preview.subject}</div>
              </div>
              <button onClick={() => setPreview(null)} className="p-1.5 text-muted-foreground hover:text-foreground rounded-md">
                <X className="w-5 h-5" />
              </button>
            </div>
            <iframe title={t("rs_preview_title")} srcDoc={preview.html} sandbox="" className="flex-1 w-full min-h-[70vh] bg-white rounded-b-2xl" />
          </div>
        </div>
      )}
    </div>
  );
}
