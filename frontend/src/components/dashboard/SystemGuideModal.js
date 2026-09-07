import { useState, useMemo } from "react";
import { Zap, LayoutDashboard, Search, ArrowRight, ChevronDown, ChevronUp, Shield, Layers, Cpu, Download, FileText } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { useLang } from "../../contexts/LanguageContext";

// Las secciones se construyen con `t` para que la guía salga en el idioma
// activo; el componente las memoiza por `t`.
const getSections = (t) => [
  {
    id: "overview",
    icon: <LayoutDashboard className="w-4 h-4" />,
    title: t('guide_overview_title'),
    color: "text-blue-400",
    bg: "bg-blue-500/10 border-blue-500/30",
    content: [
      { label: "MOS System", desc: t('guide_overview_mos_desc') },
      { label: t('guide_overview_boards_label'), desc: t('guide_overview_boards_desc') },
      { label: t('guide_overview_master_label'), desc: t('guide_overview_master_desc') },
      { label: t('guide_overview_secret_label'), desc: t('guide_overview_secret_desc') },
    ]
  },
  {
    id: "search",
    icon: <Search className="w-4 h-4" />,
    title: t('guide_search_title'),
    color: "text-green-400",
    bg: "bg-green-500/10 border-green-500/30",
    content: [
      { label: t('guide_search_how_label'), desc: t('guide_search_how_desc') },
      { label: t('guide_search_exact_label'), desc: t('guide_search_exact_desc') },
      { label: t('guide_search_multi_label'), desc: t('guide_search_multi_desc') },
      { label: "201492", desc: t('guide_search_code_desc') },
    ]
  },
  {
    id: "automations",
    icon: <Zap className="w-4 h-4" />,
    title: t('guide_auto_title'),
    color: "text-yellow-400",
    bg: "bg-yellow-500/10 border-yellow-500/30",
    content: [
      { label: t('guide_auto_what_label'), desc: t('guide_auto_what_desc') },
      { label: t('guide_auto_flow_label'), desc: t('guide_auto_flow_desc') },
      { label: t('guide_auto_triggers_label'), desc: t('guide_auto_triggers_desc') },
      { label: t('guide_auto_conditions_label'), desc: t('guide_auto_conditions_desc') },
      { label: t('guide_auto_actions_label'), desc: t('guide_auto_actions_desc') },
      { label: t('guide_auto_scoped_label'), desc: t('guide_auto_scoped_desc') },
    ]
  },
  {
    id: "automation_flow",
    icon: <Cpu className="w-4 h-4" />,
    title: t('guide_flow_title'),
    color: "text-purple-400",
    bg: "bg-purple-500/10 border-purple-500/30",
    isFlow: true,
    steps: [
      { icon: "⚡", label: t('guide_flow_step1_label'), desc: t('guide_flow_step1_desc') },
      { icon: "🔍", label: t('guide_flow_step2_label'), desc: t('guide_flow_step2_desc') },
      { icon: "📋", label: t('guide_flow_step3_label'), desc: t('guide_flow_step3_desc') },
      { icon: "🎯", label: t('guide_flow_step4_label'), desc: t('guide_flow_step4_desc') },
      { icon: "📝", label: t('guide_flow_step5_label'), desc: t('guide_flow_step5_desc') },
    ]
  },
  {
    id: "modules",
    icon: <Layers className="w-4 h-4" />,
    title: t('guide_modules_title'),
    color: "text-cyan-400",
    bg: "bg-cyan-500/10 border-cyan-500/30",
    content: [
      { label: "📊 Analytics", desc: t('guide_modules_analytics_desc') },
      { label: t('guide_modules_production_label'), desc: t('guide_modules_production_desc') },
      { label: "📅 Gantt", desc: t('guide_modules_gantt_desc') },
      { label: t('guide_modules_capacity_label'), desc: t('guide_modules_capacity_desc') },
      { label: "🏗️ WMS", desc: t('guide_modules_wms_desc') },
      { label: t('guide_modules_comments_label'), desc: t('guide_modules_comments_desc') },
      { label: t('guide_modules_notifications_label'), desc: t('guide_modules_notifications_desc') },
      { label: "📋 Activity Log", desc: t('guide_modules_activity_desc') },
    ]
  },
  {
    id: "admin",
    icon: <Shield className="w-4 h-4" />,
    title: t('guide_admin_title'),
    color: "text-red-400",
    bg: "bg-red-500/10 border-red-500/30",
    content: [
      { label: t('guide_admin_users_label'), desc: t('guide_admin_users_desc') },
      { label: t('automations'), desc: t('guide_admin_automations_desc') },
      { label: t('dash_boards'), desc: t('guide_admin_boards_desc') },
      { label: t('columns'), desc: t('guide_admin_columns_desc') },
      { label: t('guide_admin_options_label'), desc: t('guide_admin_options_desc') },
      { label: t('undo'), desc: t('guide_admin_undo_desc') },
    ]
  },
];

// ── helpers ────────────────────────────────────────────────────────────────────

/** Build HTML rows for a section's content */
const sectionToHTML = (section) => {
  if (section.isFlow) {
    return section.steps.map((step, i) => `
      <div class="flow-step">
        <div class="step-icon">${step.icon}</div>
        <div class="step-body">
          <p class="step-label">${i + 1}. ${step.label}</p>
          <p class="step-desc">${step.desc}</p>
        </div>
        ${i < section.steps.length - 1 ? '<div class="step-arrow">↓</div>' : ''}
      </div>`).join('');
  }
  return section.content.map(item => `
    <div class="item">
      <span class="item-label">▸ ${item.label}:</span>
      <span class="item-desc">${item.desc}</span>
    </div>`).join('');
};

/** Open a print window — user saves as PDF from the browser dialog */
const printToPDF = (sections, t) => {
  const date = new Date().toLocaleDateString('es-MX', { year: 'numeric', month: 'long', day: 'numeric' });
  const isSingle = sections.length === 1;
  const title = isSingle ? sections[0].title : t('guide_full_title');

  const body = sections.map(section => `
    <section class="section">
      <h2 class="section-title">${section.title}</h2>
      <div class="section-body">${sectionToHTML(section)}</div>
    </section>`).join('');

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <title>MOS System — ${title}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;700;900&family=Roboto+Mono:wght@400;700&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Roboto', sans-serif; color: #0f172a; background: #fff; padding: 24px; font-size: 13px; line-height: 1.6; }
    @media (min-width: 768px) { body { padding: 48px; } }
    .cover { text-align: center; padding: 60px 0 40px; border-bottom: 3px solid #6366f1; margin-bottom: 40px; }
    .cover .logo { font-size: 11px; letter-spacing: 6px; color: #6366f1; font-weight: 900; text-transform: uppercase; margin-bottom: 12px; }
    .cover h1 { font-size: 24px; font-weight: 900; text-transform: uppercase; letter-spacing: 3px; color: #0f172a; }
    @media (min-width: 768px) { .cover h1 { font-size: 28px; } }
    .cover .subtitle { font-size: 12px; color: #64748b; margin-top: 8px; font-family: 'Roboto Mono', monospace; }
    .cover .date { font-size: 11px; color: #94a3b8; margin-top: 4px; font-family: 'Roboto Mono', monospace; }
    .section { margin-bottom: 32px; break-inside: avoid; }
    .section-title { font-size: 13px; font-weight: 900; text-transform: uppercase; letter-spacing: 2px; color: #6366f1; padding: 8px 12px; background: #eef2ff; border-left: 4px solid #6366f1; border-radius: 0 6px 6px 0; margin-bottom: 12px; }
    .item { display: flex; gap: 8px; padding: 8px 12px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; margin-bottom: 6px; }
    .item-label { font-weight: 700; color: #334155; white-space: nowrap; flex-shrink: 0; }
    .item-desc { color: #475569; }
    .flow-step { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 4px; }
    .step-icon { font-size: 20px; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 8px; flex-shrink: 0; }
    .step-body { padding-top: 2px; }
    .step-label { font-weight: 900; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #1e293b; }
    .step-desc { font-size: 11px; color: #64748b; margin-top: 2px; }
    .step-arrow { text-align: left; padding: 2px 0 2px 46px; color: #94a3b8; font-size: 16px; line-height: 1; }
    .footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #e2e8f0; text-align: center; font-family: 'Roboto Mono', monospace; font-size: 10px; letter-spacing: 3px; color: #94a3b8; text-transform: uppercase; }
    @media print {
      body { padding: 24px; }
      .section { break-inside: avoid; }
      @page { margin: 20mm; size: A4; }
    }
  </style>
</head>
<body>
  <div class="cover">
    <p class="logo">MOS System · Prosper MFG</p>
    <h1>${title}</h1>
    <p class="subtitle">${t('guide_pdf_subtitle')}</p>
    <p class="date">${date}</p>
  </div>
  ${body}
  <div class="footer">MOS System · Prosper MFG · ${t('guide_access_code')}</div>
  <script>window.onload = () => { window.print(); };<\/script>
</body>
</html>`;

  const win = window.open('', '_blank');
  if (win) { win.document.write(html); win.document.close(); }
};

// ── component ──────────────────────────────────────────────────────────────────

export const SystemGuideModal = ({ isOpen, onClose }) => {
  const { t } = useLang();
  const SECTIONS = useMemo(() => getSections(t), [t]);
  const [expanded, setExpanded] = useState({ overview: true });

  const toggleSection = (id) => {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const handleDownloadSection = (e, section) => {
    e.stopPropagation(); // don't toggle accordion
    printToPDF([section], t);
  };

  const handleDownloadAll = () => {
    printToPDF(SECTIONS, t);
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[95vw] md:max-w-3xl max-h-[90vh] bg-card border-border overflow-hidden flex flex-col p-4 md:p-6">
        <DialogHeader>
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 sm:gap-3">
            <div>
              <DialogTitle className="font-roboto text-lg md:text-xl uppercase tracking-widest flex items-center gap-2 md:gap-3 text-primary">
                <span className="text-xl md:text-2xl">🔐</span>
                <span className="leading-tight">
                  {t('guide_title')} <span className="text-muted-foreground text-xs md:text-sm font-mono block sm:inline mt-0.5 sm:mt-0">v201492</span>
                </span>
              </DialogTitle>
              <p className="text-[11px] md:text-xs text-muted-foreground font-mono mt-1.5 md:mt-1">{t('guide_subtitle')}</p>
            </div>
            {/* Download ALL button */}
            <button
              onClick={handleDownloadAll}
              title={t('guide_export_all_title')}
              className="flex-shrink-0 self-start sm:self-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 border border-primary/30 text-primary hover:bg-primary/20 transition-all text-[11px] font-black uppercase tracking-wider w-full sm:w-auto justify-center"
            >
              <FileText className="w-3.5 h-3.5" />
              {t('guide_full_pdf')}
            </button>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
          {SECTIONS.map((section) => (
            <div key={section.id} className={`border rounded-xl overflow-hidden ${section.bg}`}>
              {/* Section header — click to expand, download button on right */}
              <div className="flex items-center w-full">
                <button
                  onClick={() => toggleSection(section.id)}
                  className="flex-1 flex items-center justify-between px-4 py-3 hover:bg-white/5 transition-colors text-left"
                >
                  <div className="flex items-start sm:items-center gap-2.5 max-w-[85%] text-left">
                    <span className={`mt-0.5 sm:mt-0 ${section.color}`}>{section.icon}</span>
                    <span className={`font-roboto font-black text-xs sm:text-sm uppercase tracking-wider ${section.color} leading-snug`}>
                      {section.title}
                    </span>
                  </div>
                  {expanded[section.id]
                    ? <ChevronUp className="w-4 h-4 text-muted-foreground" />
                    : <ChevronDown className="w-4 h-4 text-muted-foreground" />
                  }
                </button>

                {/* Per-section download button */}
                <button
                  onClick={(e) => handleDownloadSection(e, section)}
                  title={t('guide_download_section', { title: section.title })}
                  className="flex-shrink-0 mr-3 p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-white/10 transition-all"
                >
                  <Download className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Expanded body */}
              {expanded[section.id] && (
                <div className="px-4 pb-4 space-y-2 animate-in slide-in-from-top-2 duration-200">
                  {section.isFlow ? (
                    <div className="flex flex-col gap-2 mt-1">
                      {section.steps.map((step, i) => (
                        <div key={i} className="flex items-start gap-3">
                          <div className="flex flex-col items-center flex-shrink-0">
                            <div className="w-9 h-9 rounded-xl bg-background border border-border flex items-center justify-center text-lg shadow-inner">
                              {step.icon}
                            </div>
                            {i < section.steps.length - 1 && (
                              <div className="w-px h-4 bg-border/60 mt-1" />
                            )}
                          </div>
                          <div className="pt-1.5">
                            <p className="text-xs font-black text-foreground uppercase tracking-wider">{step.label}</p>
                            <p className="text-[11px] text-muted-foreground leading-relaxed mt-0.5">{step.desc}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="grid gap-2 mt-1">
                      {section.content.map((item, i) => (
                        <div key={i} className="flex gap-3 items-start bg-background/40 rounded-lg px-3 py-2 border border-border/30">
                          <ArrowRight className="w-3.5 h-3.5 text-muted-foreground mt-0.5 flex-shrink-0" />
                          <div>
                            <span className="text-xs font-black text-foreground">{item.label}: </span>
                            <span className="text-[11px] text-muted-foreground leading-relaxed">{item.desc}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          {/* Footer */}
          <div className="text-center py-3 text-[10px] text-muted-foreground font-mono tracking-widest">
            {t('guide_footer')}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
