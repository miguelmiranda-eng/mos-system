import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useLang } from "../contexts/LanguageContext";
import { API } from "../lib/constants";
import {
  ArrowLeft, CalendarClock, Clock, Users, FileText, Send,
  Plus, X, Loader2, Save, Mail, CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PRESETS = ["today", "yesterday", "week", "month"];

const DEFAULT_CONFIG = {
  enabled: false,
  hour: 19,
  minute: 0,
  recipients: [],
  preset: "today",
  format: "pdf",
  subject: "Reporte Diario de Producción",
  last_sent_date: null,
};

export default function ScheduledReports() {
  const { t } = useLang();
  const navigate = useNavigate();

  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [testEmail, setTestEmail] = useState("");

  useEffect(() => {
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/report-schedule`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setConfig({ ...DEFAULT_CONFIG, ...data });
      } else {
        toast.error(t("rs_load_error"));
      }
    } catch {
      toast.error(t("rs_load_error"));
    } finally {
      setLoading(false);
    }
  };

  const patch = (changes) => setConfig((c) => ({ ...c, ...changes }));

  const addEmail = () => {
    const email = newEmail.trim().toLowerCase();
    if (!email) return;
    if (!EMAIL_RE.test(email)) {
      toast.error(t("rs_invalid_email"));
      return;
    }
    if (config.recipients.some((r) => r.toLowerCase() === email)) {
      toast.error(t("rs_duplicate_email"));
      return;
    }
    patch({ recipients: [...config.recipients, email] });
    setNewEmail("");
  };

  const removeEmail = (email) => {
    patch({ recipients: config.recipients.filter((r) => r !== email) });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API}/report-schedule`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          enabled: config.enabled,
          hour: config.hour,
          minute: config.minute,
          recipients: config.recipients,
          preset: config.preset,
          subject: config.subject,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setConfig({ ...DEFAULT_CONFIG, ...data });
        toast.success(t("rs_saved"));
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t("rs_save_error"));
      }
    } catch {
      toast.error(t("rs_save_error"));
    } finally {
      setSaving(false);
    }
  };

  const handleSendNow = async () => {
    const to = testEmail.trim().toLowerCase();
    if (to && !EMAIL_RE.test(to)) {
      toast.error(t("rs_invalid_email"));
      return;
    }
    setSending(true);
    try {
      const res = await fetch(`${API}/report-schedule/run-now`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(to ? { to } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success(`${t("rs_sent")} ${(data.recipients || []).join(", ")}`);
        setTestEmail("");
        fetchConfig();
      } else {
        toast.error(data.detail || t("rs_send_error"));
      }
    } catch {
      toast.error(t("rs_send_error"));
    } finally {
      setSending(false);
    }
  };

  const presetLabel = (p) => t(`rs_preset_${p}`);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-10 h-10 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground font-barlow flex flex-col relative overflow-hidden">
      {/* Background decor */}
      <div className="absolute top-0 right-0 w-1/2 h-1/2 bg-primary/5 blur-[120px] rounded-full -translate-y-1/2 translate-x-1/2 pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-1/3 h-1/3 bg-cyan-500/5 blur-[100px] rounded-full translate-y-1/2 -translate-x-1/3 pointer-events-none" />

      {/* Header */}
      <header className="sticky top-0 z-40 bg-background/80 backdrop-blur-xl border-b border-border h-16 flex items-center justify-between px-6 shadow-sm">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate("/home")}
            className="w-10 h-10 flex flex-shrink-0 items-center justify-center rounded-xl bg-secondary/50 hover:bg-secondary border border-white/5 transition-all text-muted-foreground hover:text-foreground hover:shadow-lg hover:-translate-x-0.5"
            title="Volver a MOS Home"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-xl font-black uppercase tracking-widest text-foreground flex items-center gap-2">
              <CalendarClock className="w-5 h-5 text-primary" />
              {t("rs_title")}
            </h1>
            <p className="text-xs text-muted-foreground font-mono leading-none mt-1">
              {t("rs_subtitle")}
            </p>
          </div>
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          className="px-6 py-2 bg-gradient-to-r from-primary to-orange-500 hover:from-primary/90 hover:to-orange-500/90 text-white rounded-lg font-black tracking-widest text-sm transition-all shadow-[0_4px_20px_rgba(255,193,7,0.3)] hover:shadow-[0_4px_25px_rgba(255,193,7,0.5)] flex items-center gap-2 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {t("rs_save")}
        </button>
      </header>

      {/* Body */}
      <main className="flex-1 relative z-10 w-full max-w-3xl mx-auto px-4 md:px-6 py-8 space-y-6">

        {/* Master toggle */}
        <section className="bg-card/60 backdrop-blur-xl border border-border rounded-2xl p-6 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-bold text-foreground">{t("rs_enabled")}</h2>
            <p className="text-sm text-muted-foreground mt-1">{t("rs_enabled_hint")}</p>
            <p className="text-xs text-muted-foreground/70 mt-2 flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5" />
              {t("rs_last_sent")}: <span className="font-semibold text-foreground/80">{config.last_sent_date || t("rs_never")}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={() => patch({ enabled: !config.enabled })}
            className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background ${config.enabled ? "bg-green-500" : "bg-secondary"}`}
            aria-pressed={config.enabled}
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${config.enabled ? "translate-x-6" : "translate-x-1"}`} />
          </button>
        </section>

        {/* Schedule */}
        <section className="bg-card/60 backdrop-blur-xl border border-border rounded-2xl p-6 space-y-4">
          <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
            <Clock className="w-4 h-4 text-primary" /> {t("rs_section_schedule")}
          </h2>
          <div className="grid grid-cols-2 gap-4 max-w-xs">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t("rs_hour")}</label>
              <select
                value={config.hour}
                onChange={(e) => patch({ hour: parseInt(e.target.value, 10) })}
                className="w-full bg-secondary/50 border border-border p-2.5 rounded-lg text-foreground"
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>{String(h).padStart(2, "0")}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t("rs_minute")}</label>
              <select
                value={config.minute}
                onChange={(e) => patch({ minute: parseInt(e.target.value, 10) })}
                className="w-full bg-secondary/50 border border-border p-2.5 rounded-lg text-foreground"
              >
                {Array.from({ length: 60 }, (_, m) => (
                  <option key={m} value={m}>{String(m).padStart(2, "0")}</option>
                ))}
              </select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground/70">{t("rs_timezone_note")}</p>
        </section>

        {/* Recipients */}
        <section className="bg-card/60 backdrop-blur-xl border border-border rounded-2xl p-6 space-y-4">
          <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
            <Users className="w-4 h-4 text-primary" /> {t("rs_section_recipients")}
          </h2>

          <div className="flex flex-col gap-2">
            {config.recipients.length === 0 ? (
              <p className="text-sm text-muted-foreground/70 italic">{t("rs_no_recipients")}</p>
            ) : (
              config.recipients.map((email) => (
                <div key={email} className="flex items-center justify-between gap-2 bg-secondary/40 border border-white/5 rounded-lg px-3 py-2">
                  <span className="flex items-center gap-2 text-sm text-foreground truncate">
                    <Mail className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span className="truncate">{email}</span>
                  </span>
                  <button
                    onClick={() => removeEmail(email)}
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
              className="flex-1 bg-secondary/50 border border-border p-2.5 rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <button
              onClick={addEmail}
              className="px-4 py-2 bg-secondary hover:bg-secondary/70 border border-border rounded-lg text-sm font-semibold text-foreground flex items-center gap-1.5 transition-colors"
            >
              <Plus className="w-4 h-4" /> {t("rs_add_email")}
            </button>
          </div>
        </section>

        {/* Report content */}
        <section className="bg-card/60 backdrop-blur-xl border border-border rounded-2xl p-6 space-y-4">
          <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
            <FileText className="w-4 h-4 text-primary" /> {t("rs_section_content")}
          </h2>
          <div>
            <label className="text-xs text-muted-foreground mb-2 block">{t("rs_preset")}</label>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => patch({ preset: p })}
                  className={`px-4 py-2 rounded-lg text-sm font-semibold border transition-all ${config.preset === p ? "bg-primary text-white border-primary shadow-[0_2px_12px_rgba(255,193,7,0.3)]" : "bg-secondary/50 text-muted-foreground border-border hover:text-foreground hover:border-primary/40"}`}
                >
                  {presetLabel(p)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">{t("rs_subject")}</label>
            <input
              type="text"
              value={config.subject}
              onChange={(e) => patch({ subject: e.target.value })}
              placeholder={t("rs_subject_placeholder")}
              maxLength={200}
              className="w-full bg-secondary/50 border border-border p-2.5 rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <p className="text-xs text-muted-foreground/70">{t("rs_format_note")}</p>
        </section>

        {/* Manual send */}
        <section className="bg-card/60 backdrop-blur-xl border border-border rounded-2xl p-6 space-y-4">
          <h2 className="text-xs font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
            <Send className="w-4 h-4 text-primary" /> {t("rs_section_manual")}
          </h2>
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
        </section>
      </main>
    </div>
  );
}
