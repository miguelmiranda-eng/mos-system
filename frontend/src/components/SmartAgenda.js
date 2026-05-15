import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Calendar, dateFnsLocalizer, Views } from 'react-big-calendar';
import {
  format, parse, startOfWeek, getDay, parseISO, addMinutes,
  differenceInMinutes, isSameDay, addDays, subDays,
  addWeeks, subWeeks, addMonths, subMonths, endOfWeek,
} from 'date-fns';
import { es } from 'date-fns/locale';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import { useAuth } from '../App';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '../contexts/ThemeContext';
import { toast } from 'sonner';
import { Toaster } from './ui/sonner';
import { cn } from '../lib/utils';
import { API } from '../lib/constants';
import {
  CalendarDays, Plus, ChevronLeft, ChevronRight, X, Edit2, Trash2,
  Clock, MapPin, Users, Repeat, AlignLeft, Bell, Search, Loader2,
  ArrowLeft, Check, Flag, Lock, Globe, RefreshCw,
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';

// ─── Domain constants ──────────────────────────────────────────────────────

const CATEGORIES = [
  { id: 'meeting',    label: 'Reunión',       color: '#3b82f6', emoji: '🤝' },
  { id: 'production', label: 'Producción',    color: '#f59e0b', emoji: '🏭' },
  { id: 'personal',   label: 'Personal',      color: '#8b5cf6', emoji: '👤' },
  { id: 'urgent',     label: 'Urgente',       color: '#ef4444', emoji: '🔴' },
  { id: 'reminder',   label: 'Recordatorio',  color: '#10b981', emoji: '🔔' },
  { id: 'deadline',   label: 'Deadline',      color: '#f97316', emoji: '⏰' },
  { id: 'google',     label: 'Google',        color: '#4285f4', emoji: '🌐' },
];

const PRIORITIES = [
  { id: 'low',    label: 'Baja',    color: '#6b7280' },
  { id: 'normal', label: 'Normal',  color: '#3b82f6' },
  { id: 'high',   label: 'Alta',    color: '#f59e0b' },
  { id: 'urgent', label: 'Urgente', color: '#ef4444' },
];

const RECURRENCE_OPTIONS = [
  { id: 'none',    label: 'Sin repetición' },
  { id: 'daily',   label: 'Diario' },
  { id: 'weekly',  label: 'Semanal' },
  { id: 'monthly', label: 'Mensual' },
];

const STATUS_OPTIONS = [
  { id: 'pending',     label: 'Pendiente' },
  { id: 'in_progress', label: 'En progreso' },
  { id: 'completed',   label: 'Completado' },
  { id: 'cancelled',   label: 'Cancelado' },
];

const getCatMeta  = (id) => CATEGORIES.find(c => c.id === id) || CATEGORIES[0];
const getPrioMeta = (id) => PRIORITIES.find(p => p.id === id) || PRIORITIES[1];

// ─── react-big-calendar localizer (date-fns v4 compatible) ─────────────────

const locales = { es };

const fmtLocale = (date, fmt, culture) =>
  format(date, fmt, { locale: locales[culture] || locales.es });

const parseLocale = (value, fmt, ref) =>
  parse(value, fmt, ref, { locale: locales.es });

const startOfWeekLocale = (date) =>
  startOfWeek(date, { locale: locales.es });

const localizer = dateFnsLocalizer({
  format: fmtLocale,
  parse: parseLocale,
  startOfWeek: startOfWeekLocale,
  getDay,
  locales,
});

// ─── Theme-aware CSS injector for react-big-calendar ──────────────────────

function injectRBCStyles(isDark) {
  const existing = document.getElementById('rbc-mos-styles');
  if (existing) existing.remove();

  const bg       = isDark ? '#0f172a' : '#ffffff';
  const bgCard   = isDark ? '#1e293b' : '#f8fafc';
  const border   = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.08)';
  const txt      = isDark ? '#e2e8f0' : '#1e293b';
  const muted    = isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.38)';
  const todayBg  = isDark ? 'rgba(59,130,246,0.09)' : 'rgba(59,130,246,0.05)';
  const slotLine = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.05)';

  const style = document.createElement('style');
  style.id = 'rbc-mos-styles';
  style.textContent = `
    .rbc-calendar { background:${bg}; color:${txt}; font-family:inherit; border:none; }
    .rbc-toolbar  { display:none; }

    /* ── Month view ── */
    .rbc-month-view { border:1px solid ${border}; border-radius:12px; overflow:hidden; background:${bg}; }
    .rbc-month-view .rbc-header { background:${bgCard}; border-bottom:1px solid ${border}; border-right:1px solid ${border}; padding:10px 0; font-weight:700; font-size:11px; text-transform:uppercase; letter-spacing:.1em; color:${muted}; }
    .rbc-month-view .rbc-header:last-child { border-right:none; }
    .rbc-month-row + .rbc-month-row { border-top:1px solid ${border}; }
    .rbc-day-bg   { background:${bg}; border-right:1px solid ${border}; }
    .rbc-day-bg:last-child { border-right:none; }
    .rbc-off-range-bg { background:${isDark ? '#080e1a' : '#f1f5f9'}; }
    .rbc-today    { background:${todayBg} !important; }
    .rbc-date-cell { padding:5px 8px; font-size:12px; font-weight:500; color:${txt}; }
    .rbc-date-cell.rbc-off-range { color:${muted}; }
    .rbc-date-cell.rbc-now > a { color:#3b82f6; font-weight:800; }
    .rbc-row-segment { padding:0 2px 2px; }
    .rbc-show-more { color:#3b82f6; font-size:11px; font-weight:700; background:transparent; padding:0 4px; }

    /* ── Time views (week / day) ── */
    .rbc-time-view { border:1px solid ${border}; border-radius:12px; overflow:hidden; background:${bg}; }
    .rbc-time-header { background:${bgCard}; border-bottom:1px solid ${border}; }
    .rbc-time-header-content { border-left:1px solid ${border}; }
    .rbc-time-header-content .rbc-header { background:${bgCard}; border-bottom:none; border-right:1px solid ${border}; font-weight:700; font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:${muted}; padding:10px 0; }
    .rbc-time-header-gutter { background:${bgCard}; }
    .rbc-time-content { border-top:1px solid ${border}; }
    .rbc-time-gutter  { background:${bgCard}; }
    .rbc-timeslot-group { border-bottom:1px solid ${border}; }
    .rbc-time-slot    { border-top:1px solid ${slotLine}; }
    .rbc-label        { font-size:10px; color:${muted}; padding:0 10px; font-weight:600; letter-spacing:.02em; }
    .rbc-day-slot     { background:${bg}; border-right:1px solid ${border}; }
    .rbc-day-slot.rbc-today { background:${todayBg}; }
    .rbc-current-time-indicator { background:#3b82f6; height:2px; }
    .rbc-current-time-indicator::before { content:''; display:block; width:8px; height:8px; border-radius:50%; background:#3b82f6; margin-top:-3px; margin-left:-4px; }
    .rbc-allday-cell  { background:${bgCard}; min-height:24px; }
    .rbc-slot-selection { background:rgba(59,130,246,.18); border:1px solid #3b82f6; border-radius:4px; }

    /* ── Events ── */
    .rbc-event { border:none !important; border-radius:6px !important; padding:2px 7px !important; font-size:12px !important; font-weight:600 !important; line-height:1.4 !important; cursor:pointer !important; }
    .rbc-event:focus { outline:none; box-shadow:0 0 0 2px rgba(59,130,246,.6); }
    .rbc-event.rbc-selected { box-shadow:0 0 0 2px rgba(59,130,246,.9) !important; }

    /* ── Agenda view ── */
    .rbc-agenda-view { border:1px solid ${border}; border-radius:12px; overflow:hidden; }
    .rbc-agenda-view table { color:${txt}; background:${bg}; }
    .rbc-agenda-date-cell, .rbc-agenda-time-cell { background:${bgCard}; font-size:12px; font-weight:600; color:${muted}; }
    .rbc-agenda-event-cell { font-size:13px; }
    .rbc-agenda-empty { color:${muted}; padding:32px; text-align:center; }
  `;
  document.head.appendChild(style);
}

// ─── Event form default ────────────────────────────────────────────────────

const blankForm = () => {
  const now   = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0);
  const end   = addMinutes(start, 60);
  return {
    title:       '',
    description: '',
    start_dt:    format(start, "yyyy-MM-dd'T'HH:mm"),
    end_dt:      format(end,   "yyyy-MM-dd'T'HH:mm"),
    all_day:     false,
    category:    'meeting',
    priority:    'normal',
    color:       '',
    status:      'pending',
    location:    '',
    notes:       '',
    assigned_to: '',
    recurrence:  'none',
    visibility:  'team',
  };
};

// ─── EventModal ────────────────────────────────────────────────────────────

const EventModal = ({ open, onClose, onSave, initialData, isDark, saving }) => {
  const [form, setForm] = useState(blankForm);

  useEffect(() => {
    if (!open) return;
    setForm(initialData ? { ...blankForm(), ...initialData } : blankForm());
  }, [open, initialData]);

  const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.title.trim()) { toast.error('El título es requerido'); return; }
    if (form.end_dt <= form.start_dt && !form.all_day) {
      toast.error('La hora de fin debe ser posterior al inicio'); return;
    }
    onSave(form);
  };

  const cat = getCatMeta(form.category);

  const inputCls = cn(
    'w-full px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all',
    isDark
      ? 'bg-slate-800 border-white/10 text-white placeholder:text-white/25'
      : 'bg-neutral-50 border-neutral-200 text-neutral-900 placeholder:text-neutral-400',
  );

  const labelCls = cn(
    'block text-[10px] font-bold uppercase tracking-widest mb-1',
    isDark ? 'text-white/35' : 'text-neutral-400',
  );

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className={cn(
        'max-w-lg border shadow-2xl',
        isDark ? 'bg-slate-900 border-white/10 text-white' : 'bg-white border-neutral-200 text-neutral-900',
      )}>
        {/* Color stripe */}
        <div className="absolute top-0 left-0 right-0 h-0.5 rounded-t-lg" style={{ background: cat.color }} />

        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-bold">
            <span>{cat.emoji}</span>
            {initialData?.event_id ? 'Editar Evento' : 'Nuevo Evento'}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 mt-1">
          {/* Title */}
          <div>
            <label className={labelCls}>Título *</label>
            <input
              value={form.title}
              onChange={e => set('title', e.target.value)}
              placeholder="¿Qué tienes planeado?"
              required
              className={cn(inputCls, 'font-medium')}
            />
          </div>

          {/* All-day toggle */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => set('all_day', !form.all_day)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border transition-all',
                form.all_day
                  ? 'bg-blue-600 border-blue-600 text-white'
                  : isDark
                    ? 'border-white/10 text-white/40 hover:text-white/70'
                    : 'border-neutral-200 text-neutral-400 hover:text-neutral-700',
              )}
            >
              <CalendarDays size={12} />
              Todo el día
            </button>
          </div>

          {/* Start / End */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Inicio</label>
              <input
                type={form.all_day ? 'date' : 'datetime-local'}
                value={form.all_day ? form.start_dt.slice(0, 10) : form.start_dt}
                onChange={e => set('start_dt', form.all_day ? e.target.value + 'T00:00' : e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Fin</label>
              <input
                type={form.all_day ? 'date' : 'datetime-local'}
                value={form.all_day ? form.end_dt.slice(0, 10) : form.end_dt}
                onChange={e => set('end_dt', form.all_day ? e.target.value + 'T23:59' : e.target.value)}
                className={inputCls}
              />
            </div>
          </div>

          {/* Category / Priority */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Categoría</label>
              <select value={form.category} onChange={e => set('category', e.target.value)} className={inputCls}>
                {CATEGORIES.map(c => (
                  <option key={c.id} value={c.id}>{c.emoji} {c.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Prioridad</label>
              <select value={form.priority} onChange={e => set('priority', e.target.value)} className={inputCls}>
                {PRIORITIES.map(p => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Status (only on edit) */}
          {initialData?.event_id && (
            <div>
              <label className={labelCls}>Estado</label>
              <select value={form.status} onChange={e => set('status', e.target.value)} className={inputCls}>
                {STATUS_OPTIONS.map(s => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
            </div>
          )}

          {/* Location */}
          <div>
            <label className={labelCls}><MapPin size={9} className="inline mr-1" />Ubicación</label>
            <input
              value={form.location}
              onChange={e => set('location', e.target.value)}
              placeholder="Sala de juntas, Zoom, Planta 2…"
              className={inputCls}
            />
          </div>

          {/* Assigned to */}
          <div>
            <label className={labelCls}><Users size={9} className="inline mr-1" />Asignado a</label>
            <input
              value={form.assigned_to}
              onChange={e => set('assigned_to', e.target.value)}
              placeholder="Nombre o email del responsable"
              className={inputCls}
            />
          </div>

          {/* Description */}
          <div>
            <label className={labelCls}><AlignLeft size={9} className="inline mr-1" />Descripción</label>
            <textarea
              value={form.description}
              onChange={e => set('description', e.target.value)}
              placeholder="Detalles, agenda, notas previas…"
              rows={3}
              className={cn(inputCls, 'resize-none')}
            />
          </div>

          {/* Recurrence */}
          <div>
            <label className={labelCls}><Repeat size={9} className="inline mr-1" />Repetición</label>
            <select value={form.recurrence} onChange={e => set('recurrence', e.target.value)} className={inputCls}>
              {RECURRENCE_OPTIONS.map(r => (
                <option key={r.id} value={r.id}>{r.label}</option>
              ))}
            </select>
          </div>

          {/* Visibility toggle */}
          <div>
            <label className={labelCls}>Visibilidad</label>
            <div className={cn('flex rounded-lg border overflow-hidden', isDark ? 'border-white/10' : 'border-neutral-200')}>
              <button
                type="button"
                onClick={() => set('visibility', 'team')}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-bold transition-colors',
                  form.visibility === 'team'
                    ? 'bg-blue-600 text-white'
                    : isDark ? 'text-white/40 hover:text-white/70 hover:bg-white/5' : 'text-neutral-400 hover:text-neutral-700 hover:bg-neutral-50',
                )}
              >
                <Globe size={12} /> Equipo
              </button>
              <button
                type="button"
                onClick={() => set('visibility', 'private')}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-bold transition-colors border-l',
                  form.visibility === 'private'
                    ? 'bg-violet-600 text-white border-violet-600'
                    : isDark ? 'text-white/40 hover:text-white/70 hover:bg-white/5 border-white/10' : 'text-neutral-400 hover:text-neutral-700 hover:bg-neutral-50 border-neutral-200',
                )}
              >
                <Lock size={12} /> Privado
              </button>
            </div>
            <p className={cn('text-[10px] mt-1', isDark ? 'text-white/25' : 'text-neutral-400')}>
              {form.visibility === 'private'
                ? 'Solo tú y los administradores pueden ver este evento.'
                : 'Visible para todos los miembros del equipo.'}
            </p>
          </div>

          {/* Footer actions */}
          <div className="flex justify-end gap-2 pt-2 border-t" style={{ borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.07)' }}>
            <button
              type="button"
              onClick={onClose}
              className={cn(
                'px-4 py-2 rounded-lg text-sm font-semibold border transition-all',
                isDark
                  ? 'border-white/10 text-white/50 hover:text-white hover:border-white/20'
                  : 'border-neutral-200 text-neutral-500 hover:text-neutral-800',
              )}
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-bold bg-blue-600 hover:bg-blue-500 text-white transition-all shadow-lg shadow-blue-600/25 disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              {initialData?.event_id ? 'Guardar' : 'Crear Evento'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};

// ─── EventDetailPanel ──────────────────────────────────────────────────────

const EventDetailPanel = ({ event, onClose, onEdit, onDelete, isDark, currentUser }) => {
  const cat        = getCatMeta(event.category);
  const prio       = getPrioMeta(event.priority);
  const recLabel   = RECURRENCE_OPTIONS.find(r => r.id === event.recurrence)?.label || '';
  const statusLabel = STATUS_OPTIONS.find(s => s.id === event.status)?.label || event.status;
  const isPrivate  = event.visibility === 'private';
  const isAdmin    = ['admin', 'ceo', 'supersu'].includes(currentUser?.role);
  const isOwner    = currentUser?.user_id === event.created_by;
  const canEdit    = isOwner || isAdmin;

  const fmtTime = (dt) => {
    try { return format(parseISO(dt), 'HH:mm'); } catch { return dt; }
  };
  const fmtDate = (dt) => {
    try { return format(parseISO(dt), "EEEE d 'de' MMMM yyyy", { locale: es }); } catch { return dt; }
  };

  const borderColor = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.08)';

  return (
    <aside
      className={cn(
        'w-72 flex-shrink-0 flex flex-col border-l h-full overflow-hidden',
        isDark ? 'bg-slate-900 border-white/8' : 'bg-white border-neutral-200',
      )}
    >
      {/* Category color stripe */}
      <div className="h-1 flex-shrink-0" style={{ background: event.color || cat.color }} />

      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0"
        style={{ borderColor }}
      >
        <div className="flex items-center gap-2">
          <span className="text-base">{cat.emoji}</span>
          <span className={cn('text-[10px] font-bold uppercase tracking-widest', isDark ? 'text-white/35' : 'text-neutral-400')}>
            {cat.label}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={canEdit ? onEdit : undefined}
            disabled={!canEdit}
            className={cn(
              'p-1.5 rounded-lg transition-colors',
              canEdit
                ? isDark ? 'text-white/35 hover:text-white hover:bg-white/8' : 'text-neutral-400 hover:text-neutral-800 hover:bg-neutral-100'
                : 'opacity-25 cursor-not-allowed',
            )}
            title={canEdit ? 'Editar' : 'No tienes permiso para editar este evento'}
          >
            <Edit2 size={14} />
          </button>
          <button
            onClick={canEdit ? () => onDelete(event.event_id) : undefined}
            disabled={!canEdit}
            className={cn(
              'p-1.5 rounded-lg transition-colors',
              canEdit
                ? isDark ? 'text-white/35 hover:text-red-400 hover:bg-red-500/10' : 'text-neutral-400 hover:text-red-500 hover:bg-red-50'
                : 'opacity-25 cursor-not-allowed',
            )}
            title={canEdit ? 'Eliminar' : 'No tienes permiso para eliminar este evento'}
          >
            <Trash2 size={14} />
          </button>
          <button
            onClick={onClose}
            className={cn('p-1.5 rounded-lg transition-colors ml-1', isDark ? 'text-white/35 hover:text-white hover:bg-white/8' : 'text-neutral-400 hover:text-neutral-800 hover:bg-neutral-100')}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Title */}
        <h2 className={cn('text-[15px] font-bold leading-snug', isDark ? 'text-white' : 'text-neutral-900')}>
          {event.title}
        </h2>

        {/* Status + Priority + Visibility row */}
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide"
            style={{ background: `${prio.color}20`, color: prio.color }}
          >
            {prio.label}
          </span>
          <span className={cn('text-[10px] font-semibold px-2 py-0.5 rounded-full border', isDark ? 'border-white/10 text-white/50' : 'border-neutral-200 text-neutral-500')}>
            {statusLabel}
          </span>
          {isPrivate ? (
            <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-400">
              <Lock size={9} /> Privado
            </span>
          ) : (
            <span className={cn('flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full', isDark ? 'bg-blue-500/10 text-blue-400' : 'bg-blue-50 text-blue-500')}>
              <Globe size={9} /> Equipo
            </span>
          )}
        </div>

        {/* Time */}
        <div className="flex items-start gap-2.5">
          <Clock size={14} className={cn('mt-0.5 flex-shrink-0', isDark ? 'text-white/30' : 'text-neutral-400')} />
          <div>
            <p className={cn('text-sm font-semibold capitalize', isDark ? 'text-white/80' : 'text-neutral-700')}>
              {fmtDate(event.start_dt)}
            </p>
            {event.all_day ? (
              <p className={cn('text-xs', isDark ? 'text-white/35' : 'text-neutral-400')}>Todo el día</p>
            ) : (
              <p className={cn('text-xs', isDark ? 'text-white/35' : 'text-neutral-400')}>
                {fmtTime(event.start_dt)} → {fmtTime(event.end_dt)}
                {(() => {
                  try {
                    const diff = differenceInMinutes(parseISO(event.end_dt), parseISO(event.start_dt));
                    return diff > 0 ? ` · ${diff >= 60 ? `${Math.floor(diff / 60)}h${diff % 60 ? ` ${diff % 60}m` : ''}` : `${diff}m`}` : '';
                  } catch { return ''; }
                })()}
              </p>
            )}
          </div>
        </div>

        {/* Location */}
        {event.location && (
          <div className="flex items-center gap-2.5">
            <MapPin size={14} className={cn('flex-shrink-0', isDark ? 'text-white/30' : 'text-neutral-400')} />
            <span className={cn('text-sm', isDark ? 'text-white/65' : 'text-neutral-600')}>{event.location}</span>
          </div>
        )}

        {/* Assigned to */}
        {event.assigned_to && (
          <div className="flex items-center gap-2.5">
            <Users size={14} className={cn('flex-shrink-0', isDark ? 'text-white/30' : 'text-neutral-400')} />
            <span className={cn('text-sm', isDark ? 'text-white/65' : 'text-neutral-600')}>{event.assigned_to}</span>
          </div>
        )}

        {/* Recurrence */}
        {event.recurrence && event.recurrence !== 'none' && (
          <div className="flex items-center gap-2.5">
            <Repeat size={14} className={cn('flex-shrink-0', isDark ? 'text-white/30' : 'text-neutral-400')} />
            <span className={cn('text-sm', isDark ? 'text-white/65' : 'text-neutral-600')}>{recLabel}</span>
          </div>
        )}

        {/* Description */}
        {event.description && (
          <div className={cn('p-3 rounded-xl text-sm leading-relaxed', isDark ? 'bg-slate-800/80' : 'bg-neutral-50')}>
            <p className={cn('text-[10px] font-bold uppercase tracking-widest mb-1.5', isDark ? 'text-white/25' : 'text-neutral-400')}>
              Descripción
            </p>
            <p className={isDark ? 'text-white/65' : 'text-neutral-600'}>{event.description}</p>
          </div>
        )}

        {/* Notes */}
        {event.notes && (
          <div className={cn('p-3 rounded-xl text-sm leading-relaxed', isDark ? 'bg-slate-800/80' : 'bg-neutral-50')}>
            <p className={cn('text-[10px] font-bold uppercase tracking-widest mb-1.5', isDark ? 'text-white/25' : 'text-neutral-400')}>
              Notas
            </p>
            <p className={isDark ? 'text-white/65' : 'text-neutral-600'}>{event.notes}</p>
          </div>
        )}

        {/* Meta */}
        <div
          className={cn('pt-3 border-t text-[10px]', isDark ? 'border-white/5 text-white/20' : 'border-neutral-100 text-neutral-400')}
        >
          Creado por {event.created_by_name || 'Sistema'}
        </div>
      </div>
    </aside>
  );
};

// ─── Custom calendar event renderer ───────────────────────────────────────

const AgendaEventBlock = ({ event }) => {
  const cat = getCatMeta(event.category);
  return (
    <div className="flex items-center gap-1 h-full w-full overflow-hidden px-0.5">
      <span className="text-[11px] leading-none flex-shrink-0" aria-hidden>{cat.emoji}</span>
      <span className="text-[11px] font-semibold truncate leading-tight flex-1">{event.title}</span>
      {event.visibility === 'private' && (
        <Lock size={9} className="flex-shrink-0 opacity-70" aria-label="Privado" />
      )}
    </div>
  );
};

// ─── SmartAgenda (main) ────────────────────────────────────────────────────

const SmartAgenda = () => {
  const { user }  = useAuth();
  const navigate  = useNavigate();
  const { theme } = useTheme();
  const isDark    = theme === 'dark';

  const [events,         setEvents]         = useState([]);
  const [loading,        setLoading]        = useState(true);
  const [saving,         setSaving]         = useState(false);
  const [view,           setView]           = useState(Views.WEEK);
  const [currentDate,    setCurrentDate]    = useState(new Date());
  const [selectedEvent,  setSelectedEvent]  = useState(null);
  const [showModal,      setShowModal]      = useState(false);
  const [editingEvent,   setEditingEvent]   = useState(null);
  const [filterCat,      setFilterCat]      = useState('all');
  const [searchQuery,    setSearchQuery]    = useState('');
  const [showSearch,     setShowSearch]     = useState(false);
  const [googleEvents,   setGoogleEvents]   = useState([]);
  const [googleStatus,   setGoogleStatus]   = useState({ connected: false });
  const [syncingGoogle,  setSyncingGoogle]  = useState(false);

  const alertTimers = useRef([]);

  // ── CSS injection ──────────────────────────────────────────────────────
  useEffect(() => {
    injectRBCStyles(isDark);
    return () => { document.getElementById('rbc-mos-styles')?.remove(); };
  }, [isDark]);

  // ── Load events ────────────────────────────────────────────────────────
  const loadEvents = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/agenda/events`, { credentials: 'include' });
      if (res.ok) setEvents(await res.json());
      else toast.error('Error al cargar eventos');
    } catch { toast.error('Error de conexión'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  // ── Google Calendar Sync ──────────────────────────────────────────────
  const fetchGoogleEvents = useCallback(async () => {
    setSyncingGoogle(true);
    try {
      const res = await fetch(`${API}/agenda/google/sync`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        console.log("Google Sync Data:", data);
        if (data && data.events) {
          setGoogleEvents(data.events);
          if (data.error) toast.error(`Google: ${data.error}`);
        } else {
          setGoogleEvents([]);
        }
      } else {
        const errData = await res.json().catch(() => ({}));
        toast.error(`Error de sincronización (${res.status}): ${errData.detail || 'Fallo en el servidor'}`);
      }
    } catch (err) { 
      console.error("Google Sync Error:", err);
      toast.error('Error de conexión al sincronizar con Google'); 
    }
    finally { setSyncingGoogle(false); }
  }, []);

  const checkGoogleStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API}/agenda/google/status`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setGoogleStatus(data);
        if (data.connected) fetchGoogleEvents();
      }
    } catch { /* ignore */ }
  }, [fetchGoogleEvents]);

  useEffect(() => {
    checkGoogleStatus();
    
    // Auto-sync every 60 seconds
    const interval = setInterval(() => {
      console.log("Auto-syncing events...");
      loadEvents();
      if (googleStatus.connected) fetchGoogleEvents();
    }, 60000);

    // Check if we just came back from a redirect
    const params = new URLSearchParams(window.location.search);
    if (params.get('google_connected')) {
      toast.success('¡Google Calendar conectado con éxito!');
      // Clean URL
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    return () => clearInterval(interval);
  }, [checkGoogleStatus, loadEvents, fetchGoogleEvents, googleStatus.connected]);

  const handleConnectGoogle = async () => {
    try {
      const res = await fetch(`${API}/agenda/google/auth-url`, { credentials: 'include' });
      if (res.ok) {
        const { url } = await res.json();
        window.location.href = url;
      }
    } catch { toast.error('Error al iniciar conexión con Google'); }
  };

  // ── Alert / notification system ────────────────────────────────────────
  useEffect(() => {
    alertTimers.current.forEach(clearTimeout);
    alertTimers.current = [];
    if (!events.length) return;

    const now = new Date();
    events.forEach(evt => {
      try {
        const start   = parseISO(evt.start_dt);
        const mins    = differenceInMinutes(start, now);
        if (mins <= 0 || mins > 120) return;

        if (mins > 15) {
          const delay = (mins - 15) * 60_000;
          alertTimers.current.push(setTimeout(() =>
            toast(`🔔 En 15 min: ${evt.title}`, { duration: 8000, description: evt.location || undefined }),
          delay));
        }
        if (mins > 5) {
          const delay = (mins - 5) * 60_000;
          alertTimers.current.push(setTimeout(() =>
            toast.warning(`⏰ En 5 min: ${evt.title}`, { duration: 12000, description: evt.location || undefined }),
          delay));
        }
      } catch { /* skip events with invalid dates */ }
    });

    return () => alertTimers.current.forEach(clearTimeout);
  }, [events]);

  // ── Transform events for react-big-calendar ────────────────────────────
  const rbcEvents = useMemo(() => {
    let list = [...events, ...googleEvents];
    if (filterCat !== 'all') list = list.filter(e => e.category === filterCat);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(e =>
        e.title.toLowerCase().includes(q) ||
        (e.description || '').toLowerCase().includes(q) ||
        (e.location || '').toLowerCase().includes(q),
      );
    }
    const mapped = list.map(e => ({
      ...e,
      start:  parseISO(e.start_dt),
      end:    parseISO(e.end_dt),
      allDay: e.all_day,
    }));
    console.log("RBC Final List:", mapped);
    return mapped;
  }, [events, googleEvents, filterCat, searchQuery]);

  // ── Upcoming events list (sidebar) ─────────────────────────────────────
  const upcomingEvents = useMemo(() => {
    const now = new Date();
    return [...rbcEvents]
      .filter(e => e.start >= now)
      .sort((a, b) => a.start - b.start)
      .slice(0, 6);
  }, [rbcEvents]);

  // ── CRUD ───────────────────────────────────────────────────────────────
  const createEvent = async (form) => {
    setSaving(true);
    try {
      const res = await fetch(`${API}/agenda/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(form),
      });
      if (res.ok) {
        const created = await res.json();
        setEvents(prev => [...prev, created]);
        toast.success('Evento creado');
        setShowModal(false);
        setEditingEvent(null);
      } else {
        toast.error('Error al crear evento');
      }
    } catch { toast.error('Error de conexión'); }
    finally { setSaving(false); }
  };

  const updateEvent = async (form) => {
    if (!editingEvent?.event_id) return;
    setSaving(true);
    try {
      const res = await fetch(`${API}/agenda/events/${editingEvent.event_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(form),
      });
      if (res.ok) {
        const updated = await res.json();
        setEvents(prev => prev.map(e => e.event_id === updated.event_id ? updated : e));
        toast.success('Evento actualizado');
        setShowModal(false);
        setSelectedEvent(updated);
        setEditingEvent(null);
      } else {
        toast.error('Error al actualizar');
      }
    } catch { toast.error('Error de conexión'); }
    finally { setSaving(false); }
  };

  const deleteEvent = async (eventId) => {
    if (!window.confirm('¿Eliminar este evento permanentemente?')) return;
    try {
      const res = await fetch(`${API}/agenda/events/${eventId}`, {
        method: 'DELETE', credentials: 'include',
      });
      if (res.ok) {
        setEvents(prev => prev.filter(e => e.event_id !== eventId));
        setSelectedEvent(null);
        toast.success('Evento eliminado');
      } else { toast.error('Error al eliminar'); }
    } catch { toast.error('Error de conexión'); }
  };

  const handleSave = (form) => {
    if (editingEvent?.event_id) updateEvent(form);
    else createEvent(form);
  };

  // ── Calendar callbacks ─────────────────────────────────────────────────
  const handleSelectSlot = useCallback(({ start, end, action }) => {
    if (action !== 'select' && action !== 'click') return;
    const isAllDay = differenceInMinutes(end, start) >= 1440;
    setEditingEvent({
      start_dt: format(start, "yyyy-MM-dd'T'HH:mm"),
      end_dt:   format(isAllDay ? start : end, "yyyy-MM-dd'T'HH:mm"),
      all_day:  isAllDay,
    });
    setShowModal(true);
  }, []);

  const handleSelectEvent = useCallback((evt) => {
    setSelectedEvent(evt);
  }, []);

  const eventStyleGetter = useCallback((event) => ({
    style: {
      backgroundColor: event.color || getCatMeta(event.category).color,
      border: 'none',
      borderRadius: '6px',
      opacity: event.status === 'completed' ? 0.55 : 1,
      color: '#fff',
    },
  }), []);

  // ── Date navigation ────────────────────────────────────────────────────
  const navPrev = () => {
    setCurrentDate(d =>
      view === Views.MONTH ? subMonths(d, 1) :
      view === Views.WEEK  ? subWeeks(d, 1)  :
      subDays(d, 1),
    );
  };
  const navNext = () => {
    setCurrentDate(d =>
      view === Views.MONTH ? addMonths(d, 1) :
      view === Views.WEEK  ? addWeeks(d, 1)  :
      addDays(d, 1),
    );
  };
  const navToday = () => setCurrentDate(new Date());

  const dateLabel = useMemo(() => {
    if (view === Views.MONTH) return format(currentDate, 'MMMM yyyy', { locale: es });
    if (view === Views.WEEK) {
      const s = startOfWeek(currentDate, { locale: es });
      const e = endOfWeek(currentDate, { locale: es });
      return `${format(s, 'd MMM', { locale: es })} – ${format(e, 'd MMM yyyy', { locale: es })}`;
    }
    if (view === Views.DAY) return format(currentDate, "EEEE, d 'de' MMMM yyyy", { locale: es });
    return format(currentDate, 'MMMM yyyy', { locale: es });
  }, [view, currentDate]);

  // ── UI helpers ─────────────────────────────────────────────────────────
  const borderColor = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.08)';

  const navBtnCls = cn(
    'p-1.5 rounded-lg transition-colors',
    isDark ? 'text-white/40 hover:text-white hover:bg-white/8' : 'text-neutral-400 hover:text-neutral-800 hover:bg-neutral-100',
  );

  const viewBtnCls = (active) => cn(
    'px-3 py-1.5 text-xs font-bold transition-colors',
    active
      ? 'bg-blue-600 text-white'
      : isDark ? 'text-white/45 hover:text-white hover:bg-white/6' : 'text-neutral-500 hover:text-neutral-800 hover:bg-neutral-100',
  );

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className={cn('flex flex-col h-screen overflow-hidden', isDark ? 'bg-slate-950 text-white' : 'bg-slate-50 text-neutral-900')}>
      <Toaster position="top-right" theme={isDark ? 'dark' : 'light'} richColors />

      {/* ══ TOP HEADER ══════════════════════════════════════════════════ */}
      <header
        className="flex items-center justify-between px-4 h-14 flex-shrink-0 border-b"
        style={{ background: isDark ? '#0d1e35' : '#ffffff', borderColor }}
      >
        {/* Left: back + logo */}
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={() => navigate(-1)} className={navBtnCls} title="Volver">
            <ArrowLeft size={16} />
          </button>
          <div className="flex items-center gap-2">
            <CalendarDays size={17} className="text-blue-500 flex-shrink-0" />
            <span className="font-bold text-[14px] tracking-tight">Smart Agenda</span>
            <span className={cn('hidden sm:inline text-[10px] font-bold uppercase tracking-widest', isDark ? 'text-white/20' : 'text-neutral-400')}>
              · Prosper Mfg.
            </span>
          </div>
        </div>

        {/* Center: date navigation */}
        <div className="flex items-center gap-1">
          <button onClick={navPrev} className={navBtnCls}><ChevronLeft size={16} /></button>
          <button
            onClick={navToday}
            className={cn('px-3 py-1 rounded-lg text-xs font-bold transition-colors', isDark ? 'bg-white/6 text-white/60 hover:bg-white/12' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200')}
          >
            Hoy
          </button>
          <button onClick={navNext} className={navBtnCls}><ChevronRight size={16} /></button>
          <span className={cn('text-sm font-semibold ml-2 capitalize min-w-[160px] hidden sm:block', isDark ? 'text-white/75' : 'text-neutral-700')}>
            {dateLabel}
          </span>
        </div>

        {/* Right: search + filter + view + new */}
        <div className="flex items-center gap-1.5">
          {showSearch ? (
            <div className="flex items-center gap-1">
              <input
                autoFocus
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Buscar…"
                className={cn(
                  'w-40 px-3 py-1.5 rounded-lg border text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/40',
                  isDark ? 'bg-slate-800 border-white/10 text-white placeholder:text-white/25' : 'bg-neutral-50 border-neutral-200',
                )}
              />
              <button onClick={() => { setShowSearch(false); setSearchQuery(''); }} className={navBtnCls}><X size={13} /></button>
            </div>
          ) : (
            <button onClick={() => setShowSearch(true)} className={navBtnCls} title="Buscar"><Search size={15} /></button>
          )}

          {/* Category filter */}
          <select
            value={filterCat}
            onChange={e => setFilterCat(e.target.value)}
            className={cn(
              'px-2 py-1.5 rounded-lg border text-xs font-semibold focus:outline-none cursor-pointer',
              isDark ? 'bg-slate-800 border-white/10 text-white/60' : 'bg-neutral-50 border-neutral-200 text-neutral-600',
            )}
          >
            <option value="all">Todas</option>
            {CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.emoji} {c.label}</option>)}
          </select>

          {/* View switcher */}
          <div className={cn('flex rounded-lg border overflow-hidden', isDark ? 'border-white/10' : 'border-neutral-200')}>
            {[
              { v: Views.MONTH, label: 'Mes' },
              { v: Views.WEEK,  label: 'Semana' },
              { v: Views.DAY,   label: 'Día' },
            ].map(({ v, label }) => (
              <button key={v} onClick={() => setView(v)} className={viewBtnCls(view === v)}>
                {label}
              </button>
            ))}
          </div>

          {/* Google Connect/Sync */}
          {googleStatus.connected ? (
            <button
              onClick={fetchGoogleEvents}
              disabled={syncingGoogle}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all border',
                isDark 
                  ? 'border-blue-500/30 text-blue-400 hover:bg-blue-500/10' 
                  : 'border-blue-200 text-blue-600 hover:bg-blue-50'
              )}
              title="Sincronizar con Google"
            >
              <RefreshCw size={13} className={cn(syncingGoogle && 'animate-spin')} />
              <span className="hidden lg:inline">{syncingGoogle ? 'Sincronizando...' : 'Google'}</span>
            </button>
          ) : (
            <button
              onClick={handleConnectGoogle}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all border border-blue-500/50 text-blue-500 hover:bg-blue-500 hover:text-white shadow-lg shadow-blue-500/10'
              )}
            >
              <Globe size={13} />
              <span className="hidden lg:inline">Conectar Google</span>
            </button>
          )}

          {/* New event */}
          <button
            onClick={() => { setEditingEvent(null); setShowModal(true); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold transition-all shadow-lg shadow-blue-600/30"
          >
            <Plus size={14} /> Nuevo
          </button>
        </div>
      </header>

      {/* ══ MAIN LAYOUT ═════════════════════════════════════════════════ */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Left mini sidebar ────────────────────────────────────────── */}
        <aside
          className="w-52 flex-shrink-0 flex flex-col border-r hidden lg:flex overflow-hidden"
          style={{ background: isDark ? '#0d1e35' : '#ffffff', borderColor }}
        >
          {/* Upcoming events */}
          <div className="p-3 flex-1 overflow-y-auto">
            <p className={cn('text-[9px] font-black uppercase tracking-[0.18em] mb-2', isDark ? 'text-white/25' : 'text-neutral-400')}>
              Próximos eventos
            </p>
            {upcomingEvents.length === 0 ? (
              <p className={cn('text-xs', isDark ? 'text-white/20' : 'text-neutral-400')}>Sin eventos próximos</p>
            ) : (
              <div className="space-y-1">
                {upcomingEvents.map(evt => {
                  const cat = getCatMeta(evt.category);
                  return (
                    <button
                      key={evt.event_id}
                      onClick={() => setSelectedEvent(evt)}
                      className={cn('w-full text-left p-2 rounded-lg transition-colors', isDark ? 'hover:bg-white/5' : 'hover:bg-neutral-50')}
                    >
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: evt.color || cat.color }} />
                        <span className={cn('text-xs font-semibold truncate', isDark ? 'text-white/80' : 'text-neutral-700')}>
                          {evt.title}
                        </span>
                      </div>
                      <p className={cn('text-[10px] ml-3', isDark ? 'text-white/28' : 'text-neutral-400')}>
                        {evt.all_day ? 'Todo el día' : format(evt.start, 'HH:mm') + ' · ' + format(evt.start, 'd MMM', { locale: es })}
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Category filter legend */}
          <div className="p-3 border-t" style={{ borderColor }}>
            <p className={cn('text-[9px] font-black uppercase tracking-[0.18em] mb-2', isDark ? 'text-white/25' : 'text-neutral-400')}>
              Categorías
            </p>
            <div className="space-y-0.5">
              {CATEGORIES.map(cat => (
                <button
                  key={cat.id}
                  onClick={() => setFilterCat(prev => prev === cat.id ? 'all' : cat.id)}
                  className={cn(
                    'flex items-center gap-2 w-full px-1.5 py-1 rounded-md transition-colors text-left',
                    filterCat === cat.id ? 'opacity-100' : 'opacity-50 hover:opacity-85',
                  )}
                >
                  <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: cat.color }} />
                  <span className={cn('text-xs font-medium', isDark ? 'text-white/70' : 'text-neutral-600')}>
                    {cat.label}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </aside>

        {/* ── Calendar main area ───────────────────────────────────────── */}
        <main className="flex-1 overflow-hidden p-3 relative">
          {loading && (
            <div className="absolute inset-0 z-20 flex items-center justify-center rounded-xl" style={{ background: isDark ? 'rgba(15,23,42,0.7)' : 'rgba(248,250,252,0.75)', backdropFilter: 'blur(4px)' }}>
              <div className="flex items-center gap-2">
                <Loader2 size={18} className="animate-spin text-blue-500" />
                <span className={cn('text-sm font-medium', isDark ? 'text-white/60' : 'text-neutral-500')}>Cargando agenda…</span>
              </div>
            </div>
          )}

          <Calendar
            localizer={localizer}
            culture="es"
            events={rbcEvents}
            startAccessor="start"
            endAccessor="end"
            titleAccessor="title"
            allDayAccessor="allDay"
            view={view}
            onView={setView}
            date={currentDate}
            onNavigate={setCurrentDate}
            selectable
            popup
            onSelectSlot={handleSelectSlot}
            onSelectEvent={handleSelectEvent}
            eventPropGetter={eventStyleGetter}
            components={{
              toolbar: () => null,
              event: AgendaEventBlock,
            }}
            messages={{
              noEventsInRange: 'Sin eventos en este período',
              showMore: n => `+${n} más`,
              allDay: 'Todo el día',
              date: 'Fecha',
              time: 'Hora',
              event: 'Evento',
            }}
            min={new Date(0, 0, 0, 5, 0, 0)}
            max={new Date(0, 0, 0, 22, 30, 0)}
            step={30}
            timeslots={2}
            style={{ height: '100%' }}
          />
        </main>

        {/* ── Event detail panel ───────────────────────────────────────── */}
        {selectedEvent && (
          <EventDetailPanel
            event={selectedEvent}
            isDark={isDark}
            currentUser={user}
            onClose={() => setSelectedEvent(null)}
            onEdit={() => {
              setEditingEvent(selectedEvent);
              setShowModal(true);
              setSelectedEvent(null);
            }}
            onDelete={deleteEvent}
          />
        )}
      </div>

      {/* ══ CREATE / EDIT MODAL ══════════════════════════════════════════ */}
      <EventModal
        open={showModal}
        onClose={() => { setShowModal(false); setEditingEvent(null); }}
        onSave={handleSave}
        initialData={editingEvent}
        isDark={isDark}
        saving={saving}
      />
    </div>
  );
};

export default SmartAgenda;
