import { useState } from "react";
import { Zap, LayoutDashboard, Search, ArrowRight, ChevronDown, ChevronUp, Shield, Layers, Cpu, Download, FileText } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";

const SECTIONS = [
  {
    id: "overview",
    icon: <LayoutDashboard className="w-4 h-4" />,
    title: "Resumen del Sistema",
    color: "text-blue-400",
    bg: "bg-blue-500/10 border-blue-500/30",
    content: [
      { label: "MOS System", desc: "CRM de producción para gestión de órdenes de manufactura textil. Cada orden pasa por múltiples tableros según su estado en producción." },
      { label: "Tableros principales", desc: "MASTER → SCHEDULING → READY TO SCHEDULED → BLANKS → SCREENS → NECK → EJEMPLOS → COMPLETOS → FINAL BILL. Las máquinas (MAQUINA1-14) son tableros de producción activa." },
      { label: "Vista MASTER", desc: "Muestra TODAS las órdenes activas en todos los tableros (excepto PAPELERA DE RECICLAJE). Úsala para búsqueda global o supervisión general." },
      { label: "Código secreto", desc: "Escribe '201492' en el buscador para abrir esta guía en cualquier momento." },
    ]
  },
  {
    id: "search",
    icon: <Search className="w-4 h-4" />,
    title: "Búsqueda Global",
    color: "text-green-400",
    bg: "bg-green-500/10 border-green-500/30",
    content: [
      { label: "Cómo buscar", desc: "Escribe en el buscador del header y presiona Enter. Busca por: número de orden, PO, cliente, branding o notas." },
      { label: "Resultado exacto", desc: "Si encuentra 1 sola orden, navega automáticamente al tablero donde está y muestra un toast con su ubicación." },
      { label: "Múltiples resultados", desc: "Si hay múltiples coincidencias, se muestran en una lista de resultados para que puedas seleccionar." },
      { label: "201492", desc: "Código especial que abre esta guía del sistema." },
    ]
  },
  {
    id: "automations",
    icon: <Zap className="w-4 h-4" />,
    title: "Motor de Automatizaciones",
    color: "text-yellow-400",
    bg: "bg-yellow-500/10 border-yellow-500/30",
    content: [
      { label: "¿Qué son?", desc: "Reglas que se ejecutan automáticamente cuando ocurre un evento en una orden. Sin intervención manual." },
      { label: "Flujo de ejecución", desc: "EVENTO (trigger) → CONDICIONES (¿se cumplen?) → ACCIÓN. Si las condiciones no se cumplen, la automatización se omite silenciosamente." },
      { label: "Triggers disponibles", desc: "create (orden creada), move (orden movida de tablero), update (campo actualizado), status_change (cambio de estado específico)." },
      { label: "Condiciones", desc: "Se evalúan contra los campos de la orden. Puedes usar watch_field + watch_value para detectar cambios específicos, o from_board/to_board para movimientos." },
      { label: "Acciones disponibles", desc: "send_email (via Resend), move_board (mover orden a otro tablero), assign_field (asignar valor a un campo), notify_slack (webhook)." },
      { label: "Boards scopeadas", desc: "Cada automatización puede limitarse a tableros específicos. Si el campo 'boards' está vacío, aplica a TODOS los tableros." },
    ]
  },
  {
    id: "automation_flow",
    icon: <Cpu className="w-4 h-4" />,
    title: "Flujo Visual de Automatizaciones",
    color: "text-purple-400",
    bg: "bg-purple-500/10 border-purple-500/30",
    isFlow: true,
    steps: [
      { icon: "⚡", label: "Evento", desc: "Orden creada / movida / actualizada / estado cambiado" },
      { icon: "🔍", label: "Filtrar por tablero", desc: "¿Está la orden en un tablero permitido por la auto?" },
      { icon: "📋", label: "Verificar condiciones", desc: "watch_field, watch_value, from_board, to_board, campos del orden" },
      { icon: "🎯", label: "Ejecutar acción", desc: "Email · Mover tablero · Asignar campo · Notificar Slack" },
      { icon: "📝", label: "Log de actividad", desc: "Se registra en el Activity Log con nombre de la automatización" },
    ]
  },
  {
    id: "modules",
    icon: <Layers className="w-4 h-4" />,
    title: "Módulos del Sistema",
    color: "text-cyan-400",
    bg: "bg-cyan-500/10 border-cyan-500/30",
    content: [
      { label: "📊 Analytics", desc: "Dashboard de métricas: órdenes por tablero, velocidad de producción, distribución por cliente/branding." },
      { label: "🏭 Producción", desc: "Registro de logs de producción por máquina y operador. Incluye cantidad producida, setup y motivos de paro." },
      { label: "📅 Gantt", desc: "Vista de línea de tiempo de órdenes con fechas de entrega (cancel date)." },
      { label: "📆 Capacidad", desc: "Capacity Planning: calcula si se puede cumplir con las fechas de entrega según throughput de máquinas." },
      { label: "🏗️ WMS", desc: "Warehouse Management System: gestión de inventario, recepción de mercancía, picking y labels." },
      { label: "💬 Comentarios", desc: "Sistema de comentarios por orden con @menciones, reacciones con emoji, adjuntos e hilos de respuesta." },
      { label: "🔔 Notificaciones", desc: "Centro de notificaciones en tiempo real vía WebSocket. Menciones, movimientos y comentarios." },
      { label: "📋 Activity Log", desc: "Historial completo de cambios con capacidad de deshacer (undo)." },
    ]
  },
  {
    id: "admin",
    icon: <Shield className="w-4 h-4" />,
    title: "Funciones de Administrador",
    color: "text-red-400",
    bg: "bg-red-500/10 border-red-500/30",
    content: [
      { label: "Gestión de usuarios", desc: "Invitar usuarios, asignar roles (admin/user), configurar permisos por tablero." },
      { label: "Automatizaciones", desc: "Crear, editar y activar/desactivar reglas de automatización desde el botón ⚡ en el header." },
      { label: "Tableros", desc: "Crear y eliminar tableros personalizados. Ocultar tableros sin eliminarlos." },
      { label: "Columnas", desc: "Agregar columnas personalizadas (texto, número, select, fecha). Eliminar columnas existentes." },
      { label: "Opciones", desc: "Gestionar listas de valores: clientes, brandings, estados de producción, etc." },
      { label: "Deshacer", desc: "Botón ↩ para revertir la última acción (disponible en la mayoría de operaciones)." },
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
const printToPDF = (sections) => {
  const date = new Date().toLocaleDateString('es-MX', { year: 'numeric', month: 'long', day: 'numeric' });
  const isSingle = sections.length === 1;
  const title = isSingle ? sections[0].title : 'Guía Completa del Sistema';

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
    <p class="subtitle">Manual de operación y referencia rápida · v201492</p>
    <p class="date">${date}</p>
  </div>
  ${body}
  <div class="footer">MOS System · Prosper MFG · Código de acceso: 201492</div>
  <script>window.onload = () => { window.print(); };<\/script>
</body>
</html>`;

  const win = window.open('', '_blank');
  if (win) { win.document.write(html); win.document.close(); }
};

// ── component ──────────────────────────────────────────────────────────────────

export const SystemGuideModal = ({ isOpen, onClose }) => {
  const [expanded, setExpanded] = useState({ overview: true });

  const toggleSection = (id) => {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const handleDownloadSection = (e, section) => {
    e.stopPropagation(); // don't toggle accordion
    printToPDF([section]);
  };

  const handleDownloadAll = () => {
    printToPDF(SECTIONS);
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
                  GUÍA DEL SISTEMA <span className="text-muted-foreground text-xs md:text-sm font-mono block sm:inline mt-0.5 sm:mt-0">v201492</span>
                </span>
              </DialogTitle>
              <p className="text-[11px] md:text-xs text-muted-foreground font-mono mt-1.5 md:mt-1">MOS System · Referencia rápida</p>
            </div>
            {/* Download ALL button */}
            <button
              onClick={handleDownloadAll}
              title="Exportar guía completa como PDF"
              className="flex-shrink-0 self-start sm:self-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 border border-primary/30 text-primary hover:bg-primary/20 transition-all text-[11px] font-black uppercase tracking-wider w-full sm:w-auto justify-center"
            >
              <FileText className="w-3.5 h-3.5" />
              PDF Completo
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
                  title={`Descargar "${section.title}" (.md)`}
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
            MOS SYSTEM · PROSPER MFG · CÓDIGO ACCESO: 201492
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
