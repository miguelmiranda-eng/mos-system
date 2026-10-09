import { Fragment, useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, CalendarClock, Power, RefreshCw, Loader2, Cpu, TrendingUp,
  Settings2, CalendarDays, AlertTriangle, Trash2, Plus, Save, FlaskConical, Eye, Search,
  Pin, ArrowUpDown, LogIn, PauseCircle, Undo2, X, SlidersHorizontal, BellRing, CheckCircle2, Download, PackageCheck, Gauge,
} from "lucide-react";
import * as XLSX from "xlsx";
import { saveAs } from "file-saver";
import { toast } from "sonner";
import { useAuth } from "../App";
import { API } from "../lib/constants";

const WS_URL = `${process.env.REACT_APP_BACKEND_URL || "http://localhost:8000"}`.replace(/^http/, "ws") + "/api/ws";
import { useLang } from "../contexts/LanguageContext";

/* Módulo de Planeación.

   FASE 1 = MODO SOMBRA. El motor se enciende con el interruptor del encabezado
   y calcula el programa (qué orden × posición va en qué máquina, día y turno)
   y los movimientos de tablero que HARÍA, pero NO mueve ninguna orden. El
   backend rechaza cualquier otro modo.

   Todo lo que define la capacidad es editable aquí: máquinas (activa,
   cabezas 8–20, cliente preferido), cuadrillas por turno, personas por
   cuadrilla, calendario (festivos, tiempo extra, más o menos gente) y reglas.
   Leer lo puede cualquiera con sesión; editar y encender el motor, admin. */

const fmt = (n) => (n == null || Number.isNaN(Number(n)) ? "—" : Math.round(Number(n)).toLocaleString("es-MX"));
const hhmm = (iso) => (iso ? iso.slice(11, 16) : "");
const dday = (iso) => (iso ? iso.slice(5, 10) : "");

const planner = async (path, opts = {}) => {
  const res = await fetch(`${API}/planner${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
};

// Alta/baja de máquinas = alta/baja del tablero MAQUINA<n>. Reutiliza el CRUD de
// tableros del CRM (invalida la caché de capacidad y, al borrar, manda las
// órdenes de esa máquina a MASTER); el Planner no duplica esa lógica.
const configApi = async (path, opts = {}) => {
  const res = await fetch(`${API}/config${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
};

const MISS_KEYS = ["contado", "cuadros", "label", "ejemplo"];

const STATUS_STYLE = {
  A_TIEMPO: "bg-emerald-50 text-emerald-700 border-emerald-200",
  EN_RIESGO: "bg-amber-50 text-amber-700 border-amber-200",
  VENCIDA: "bg-red-50 text-red-700 border-red-200",
  FUERA_DE_HORIZONTE: "bg-slate-100 text-slate-600 border-slate-200",
  SIN_FECHA: "bg-slate-100 text-slate-600 border-slate-200",
};

const VOLUME_STYLE = {
  ALTO: "bg-violet-100 text-violet-700",
  MEDIO: "bg-sky-100 text-sky-700",
  BAJO: "bg-slate-100 text-slate-600",
};

const Card = ({ children, className = "" }) => (
  <div className={`bg-white border border-slate-200 rounded-xl ${className}`}>{children}</div>
);

const Stat = ({ label, value, color = "text-slate-900" }) => (
  <Card className="px-4 py-3">
    <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{label}</div>
    <div className={`text-2xl font-black tabular-nums ${color}`}>{value}</div>
  </Card>
);

const SectionTitle = ({ children, hint }) => (
  <div className="mb-3">
    <h2 className="text-sm font-black uppercase tracking-wider text-slate-700">{children}</h2>
    {hint && <p className="text-xs text-slate-500 mt-0.5">{hint}</p>}
  </div>
);

const Empty = ({ children }) => (
  <div className="py-12 text-center text-sm text-slate-500">{children}</div>
);

const NumberInput = ({ value, onChange, min, max, step = 1, disabled, className = "w-24" }) => (
  <input type="number" value={value ?? ""} min={min} max={max} step={step} disabled={disabled}
    onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
    className={`h-9 px-2 rounded-lg border border-slate-200 text-sm tabular-nums disabled:bg-slate-50 disabled:text-slate-400 ${className}`} />
);

const KIND_STYLE = { REORDEN: "bg-sky-50 text-sky-700 border-sky-200", NUEVA: "bg-violet-50 text-violet-700 border-violet-200",
  SIN_DATO: "bg-slate-50 text-slate-500 border-slate-200" };

// Marca trabajo que no es impresión (rhinestones, glitter, puff, foil…).
const ExtraWorkBadge = ({ extra, tr }) => {
  if (!extra || !extra.length) return null;
  return (
    <span className="px-1.5 py-0.5 rounded bg-fuchsia-100 text-fuchsia-700 text-[9px] font-black uppercase align-middle whitespace-nowrap"
      title={extra.join(" · ")}>{tr("plan_extra_work")}</span>
  );
};

// Reorden / Nueva, y en qué va el ejemplo de las nuevas.
const KindBadge = ({ kind, state, tr }) => {
  if (!kind) return null;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-bold whitespace-nowrap ${KIND_STYLE[kind] || KIND_STYLE.SIN_DATO}`}
      title={state ? tr(`plan_sample_${state}`) : ""}>
      {tr(`plan_kind_${kind}`)}
      {kind === "NUEVA" && state && tr(`plan_sample_short_${state}`) && (
        <span className="font-normal opacity-80">· {tr(`plan_sample_short_${state}`)}</span>
      )}
    </span>
  );
};

const ReadyBadges = ({ ready, tr }) => (
  <div className="flex gap-1">
    {[["contado", tr("plan_req_counted")], ["cuadros", tr("plan_req_screens")], ["label", tr("plan_req_label")],
      ["ejemplo", tr("plan_req_sample")]].filter(([k]) => ready && k in ready).map(([k, label]) => (
      <span key={k} className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
        ready?.[k] ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600 line-through"}`}>{label}</span>
    ))}
  </div>
);

/* ── Ajustes manuales ────────────────────────────────────────────────────── */
const KIND_ICON = { assign: Pin, priority: ArrowUpDown, force: LogIn, hold: PauseCircle };

const describeOverride = (o, tr) => {
  const p = o.params || {};
  if (o.kind === "assign") {
    const parts = [];
    if (p.machine) parts.push(p.machine.replace("MAQUINA", "M"));
    if (p.queue_pos) parts.push(tr("plan_ov_queue_n", { n: p.queue_pos }));
    if (p.not_before) parts.push(tr("plan_ov_not_before_d", { d: p.not_before }));
    return `${tr("plan_ov_kind_assign")}: ${parts.join(" · ")}`;
  }
  if (o.kind === "priority") return `${tr("plan_ov_kind_priority")}: ${tr(`plan_prio_${p.level}`)}`;
  if (o.kind === "hold") return `${tr("plan_ov_kind_hold")}${p.until ? ` ${tr("plan_ov_until_d", { d: p.until })}` : ""}`;
  return tr("plan_ov_kind_force");
};

const OverrideBadges = ({ manual, warnings, tr }) => (
  <span className="inline-flex gap-1 align-middle">
    {(manual || []).map((k) => {
      const Icon = KIND_ICON[k] || Pin;
      return <Icon key={k} className="w-3.5 h-3.5 text-violet-600" title={tr(`plan_ov_kind_${k}`)} />;
    })}
    {(warnings || []).map((w) => (
      <AlertTriangle key={w} className="w-3.5 h-3.5 text-amber-500" title={tr(`plan_warn_${w}`)} />
    ))}
  </span>
);

const AdjustPanel = ({ job, machines, overrides, engineOn, onClose, onChanged, tr }) => {
  const [scope, setScope] = useState("job");
  const [machine, setMachine] = useState((job.machines || [])[0] || "");
  const [queuePos, setQueuePos] = useState("");
  const [notBefore, setNotBefore] = useState("");
  const [holdUntil, setHoldUntil] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const mine = overrides.filter((o) => o.order_id === job.order_id && (o.position === "*" || o.position === job.position));

  const send = async (kind, params = {}) => {
    setBusy(true);
    try {
      await planner("/overrides", {
        method: "POST",
        body: JSON.stringify({ order_id: job.order_id, position: scope === "order" ? "*" : job.position, kind, params, reason }),
      });
      toast.success(tr("plan_ov_saved"));
      await onChanged(true);
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  const undo = async (id) => {
    setBusy(true);
    try {
      await planner(`/overrides/${id}`, { method: "DELETE" });
      toast.success(tr("plan_ov_undone"));
      await onChanged(false);
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };

  const Btn = ({ onClick, children, tone = "slate", disabled }) => (
    <button onClick={onClick} disabled={busy || disabled}
      className={`h-9 px-3 rounded-lg text-sm font-bold inline-flex items-center gap-1.5 disabled:opacity-50 ${tone === "blue"
        ? "bg-blue-600 text-white hover:bg-blue-700" : tone === "red"
        ? "bg-white border border-red-200 text-red-700 hover:bg-red-50" : "bg-white border border-slate-200 text-slate-700 hover:border-blue-300"}`}>
      {children}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/30" onClick={onClose}>
      <div className="w-full max-w-md h-full bg-white shadow-xl overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-slate-200 px-5 py-4 flex items-start gap-3">
          <div className="mr-auto">
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{tr("plan_ov_title")}</div>
            <div className="text-lg font-black text-slate-900">{job.order_number} · {job.position}</div>
            <div className="text-xs text-slate-500">{job.client}</div>
            <div className="text-xs text-slate-500 mt-1 tabular-nums">
              {(job.machines || []).length ? `${job.machines.join(", ").replace(/MAQUINA/g, "M")} · ` : ""}
              {job.start ? `${dday(job.start)} ${hhmm(job.start)}` : tr("plan_ov_not_scheduled")}
              {job.target_date ? ` · ${tr("plan_target")} ${job.target_date}` : ""}
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 space-y-5">
          <div className="flex items-start gap-2 text-xs text-sky-800 bg-sky-50 border border-sky-200 rounded-lg px-3 py-2">
            <Eye className="w-4 h-4 shrink-0" /> {tr("plan_ov_shadow_note")}
          </div>
          {!engineOn && <div className="text-xs text-amber-700">{tr("plan_ov_engine_off")}</div>}

          <div>
            <div className="text-xs font-bold text-slate-500 mb-1">{tr("plan_ov_scope")}</div>
            <div className="flex gap-1">
              {[["job", tr("plan_ov_scope_job", { p: job.position })], ["order", tr("plan_ov_scope_order")]].map(([k, l]) => (
                <button key={k} onClick={() => setScope(k)}
                  className={`px-3 h-8 rounded-lg border text-xs font-bold ${scope === k ? "bg-slate-900 text-white border-slate-900" : "bg-white border-slate-200"}`}>{l}</button>
              ))}
            </div>
          </div>

          <label className="block text-xs text-slate-500">{tr("plan_ov_reason")}
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={tr("plan_ov_reason_ph")}
              className="mt-1 w-full h-9 px-2 rounded-lg border border-slate-200 text-sm" /></label>

          <section className="border border-slate-200 rounded-xl p-3 space-y-2">
            <div className="font-black text-sm flex items-center gap-1.5"><Pin className="w-4 h-4 text-violet-600" />{tr("plan_ov_assign_title")}</div>
            <div className="flex flex-wrap gap-2 text-xs text-slate-500">
              <label>{tr("plan_machine")}<br />
                <select value={machine} onChange={(e) => setMachine(e.target.value)} className="h-9 px-2 rounded-lg border border-slate-200 text-sm">
                  <option value="">{tr("plan_ov_any_machine")}</option>
                  {machines.map((m) => <option key={m.machine} value={m.machine} disabled={!m.active}>
                    {m.machine}{m.active ? "" : ` (${tr("plan_ov_inactive")})`} · {m.heads} {tr("plan_heads").toLowerCase()}
                  </option>)}
                </select></label>
              <label>{tr("plan_ov_queue_pos")}<br />
                <NumberInput value={queuePos} min={1} onChange={setQueuePos} className="w-20" /></label>
              <label>{tr("plan_ov_not_before")}<br />
                <input type="date" value={notBefore} onChange={(e) => setNotBefore(e.target.value)} className="h-9 px-2 rounded-lg border border-slate-200 text-sm" /></label>
            </div>
            <p className="text-[11px] text-slate-400">{tr("plan_ov_assign_hint")}</p>
            <Btn tone="blue" disabled={!machine && !notBefore}
              onClick={() => send("assign", { machine: machine || undefined, queue_pos: queuePos || undefined, not_before: notBefore || undefined })}>
              <Pin className="w-4 h-4" />{tr("plan_ov_assign_btn")}
            </Btn>
          </section>

          <section className="border border-slate-200 rounded-xl p-3 space-y-2">
            <div className="font-black text-sm flex items-center gap-1.5"><ArrowUpDown className="w-4 h-4 text-violet-600" />{tr("plan_ov_priority_title")}</div>
            <div className="flex flex-wrap gap-2">
              {["TOP", "UP", "DOWN"].map((lvl) => (
                <Btn key={lvl} onClick={() => send("priority", { level: lvl })}>{tr(`plan_prio_${lvl}`)}</Btn>
              ))}
            </div>
          </section>

          <section className="border border-slate-200 rounded-xl p-3 space-y-2">
            <div className="font-black text-sm flex items-center gap-1.5"><LogIn className="w-4 h-4 text-violet-600" />{tr("plan_ov_force_title")}</div>
            <p className="text-[11px] text-slate-400">{tr("plan_ov_force_hint")}</p>
            {job.ready && <ReadyBadges ready={job.ready} tr={tr} />}
            <Btn onClick={() => send("force")}><LogIn className="w-4 h-4" />{tr("plan_ov_force_btn")}</Btn>
          </section>

          <section className="border border-slate-200 rounded-xl p-3 space-y-2">
            <div className="font-black text-sm flex items-center gap-1.5"><PauseCircle className="w-4 h-4 text-violet-600" />{tr("plan_ov_hold_title")}</div>
            <label className="text-xs text-slate-500">{tr("plan_ov_hold_until")}<br />
              <input type="date" value={holdUntil} onChange={(e) => setHoldUntil(e.target.value)} className="h-9 px-2 rounded-lg border border-slate-200 text-sm" /></label>
            <div><Btn tone="red" onClick={() => send("hold", { until: holdUntil || undefined })}><PauseCircle className="w-4 h-4" />{tr("plan_ov_hold_btn")}</Btn></div>
          </section>

          <section>
            <div className="text-xs font-bold text-slate-500 mb-2">{tr("plan_ov_active_here")} ({mine.length})</div>
            {mine.length === 0 ? <div className="text-xs text-slate-400">{tr("plan_ov_none_here")}</div> : (
              <ul className="space-y-1.5">
                {mine.map((o) => (
                  <li key={o.override_id} className="flex items-center gap-2 text-xs border border-violet-100 bg-violet-50/50 rounded-lg px-2 py-1.5">
                    <span className="mr-auto">
                      <b>{describeOverride(o, tr)}</b>{o.position === "*" ? ` · ${tr("plan_ov_scope_order")}` : ""}
                      {o.reason ? <span className="text-slate-500"> — {o.reason}</span> : null}
                    </span>
                    <button onClick={() => undo(o.override_id)} disabled={busy}
                      className="px-2 h-7 rounded border border-slate-200 bg-white font-bold inline-flex items-center gap-1 hover:border-red-300 hover:text-red-700">
                      <Undo2 className="w-3.5 h-3.5" />{tr("plan_ov_undo")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};

const OverridesCard = ({ overrides, history, canEdit, onUndo, onOpen, tr }) => {
  const [showHistory, setShowHistory] = useState(false);
  return (
    <Card className="p-4">
      <SectionTitle hint={tr("plan_ov_list_hint")}>{tr("plan_ov_list_title")} ({overrides.length})</SectionTitle>
      {overrides.length === 0 ? <div className="text-sm text-slate-400">{tr("plan_ov_list_empty")}</div> : (
        <table className="min-w-full text-sm">
          <tbody className="divide-y divide-slate-100">
            {overrides.map((o) => (
              <tr key={o.override_id}>
                <td className="py-1.5 pr-3 font-black whitespace-nowrap">
                  <button className="hover:underline" onClick={() => onOpen(o)}>{o.order_number}</button>
                  <span className="text-xs text-slate-400 font-normal"> · {o.position === "*" ? tr("plan_ov_scope_order") : o.position}</span>
                </td>
                <td className="pr-3 text-xs">{describeOverride(o, tr)}</td>
                <td className="pr-3 text-xs text-slate-500">{o.reason}</td>
                <td className="pr-3 text-[11px] text-slate-400 whitespace-nowrap">{o.created_by_name || o.created_by} · {new Date(o.created_at).toLocaleString("es-MX")}</td>
                <td>{canEdit && (
                  <button onClick={() => onUndo(o.override_id)} className="px-2 h-7 rounded border border-slate-200 text-xs font-bold inline-flex items-center gap-1 hover:border-red-300 hover:text-red-700">
                    <Undo2 className="w-3.5 h-3.5" />{tr("plan_ov_undo")}
                  </button>
                )}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button onClick={() => setShowHistory(!showHistory)} className="mt-3 text-xs font-bold text-slate-500 hover:text-slate-800">
        {tr("plan_ov_history")} ({history.length}) {showHistory ? "▾" : "▸"}
      </button>
      {showHistory && (
        <ul className="mt-2 text-xs text-slate-500 space-y-1">
          {history.map((o) => (
            <li key={o.override_id}>
              <b className="text-slate-700">{o.order_number}</b> · {o.position === "*" ? tr("plan_ov_scope_order") : o.position} · {describeOverride(o, tr)}
              {" — "}{tr(`plan_ov_removed_${o.removed_reason === "reemplazado" ? "replaced" : "undone"}`)} {o.removed_by} · {o.removed_at ? new Date(o.removed_at).toLocaleString("es-MX") : ""}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
};

/* ── Programa (sombra) ───────────────────────────────────────────────────── */
// Fechas "YYYY-MM-DD" sin pasar por Date (evita el corrimiento de zona horaria).
const addDays = (iso, n) => {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
};
const addHours = (hhmm, h) => {
  const [a, b] = (hhmm || "07:00").split(":").map(Number);
  const mins = a * 60 + b + Math.round((Number(h) || 0) * 60);
  const nextDay = mins >= 24 * 60;
  const m = mins % (24 * 60);
  return { time: `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`, nextDay };
};

const weekdayIdx = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;   // 0 = lunes
};

const MachineGrid = ({ run, onAdjust, tr }) => {
  const [week, setWeek] = useState(0);
  const dayNames = tr("plan_weekday_names").split(",");

  // Semana completa de lunes a domingo, día y noche, aunque esté vacía. Los
  // turnos y sus cuadrillas vienen del backend (run.windows); si la corrida es
  // vieja y no los trae, se arman con los días que tengan trabajo.
  const { weeks, cells, machines } = useMemo(() => {
    const c = {};
    const dates = new Set();
    (run.jobs || []).forEach((j) => (j.segments || []).forEach((s) => {
      dates.add(s.date);
      const k = `${s.machine}|${s.date}|${s.shift}`;
      (c[k] = c[k] || []).push({ ...s, job: j, order_number: j.order_number, position: j.position, status: j.status });
    }));
    let wins = run.windows;
    if (!wins || !wins.length) {
      const first = [...dates].sort()[0];
      wins = [];
      if (first) {
        const monday = addDays(first, -weekdayIdx(first));
        for (let i = 0; i < 14; i += 1) {
          ["DIA", "NOCHE"].forEach((sh) => wins.push({ date: addDays(monday, i), shift: sh, crews: null, holiday: null }));
        }
      }
    }
    const byWeek = [];
    wins.forEach((w) => {
      const monday = addDays(w.date, -weekdayIdx(w.date));
      let wk = byWeek.find((x) => x.monday === monday);
      if (!wk) { wk = { monday, windows: [] }; byWeek.push(wk); }
      wk.windows.push(w);
    });
    return { weeks: byWeek, cells: c, machines: run.active_machines || [] };
  }, [run]);

  if (!weeks.length) return <Empty>{tr("plan_grid_empty")}</Empty>;
  const cur = weeks[Math.min(week, weeks.length - 1)];
  const sunday = addDays(cur.monday, 6);

  // Totales. "hits" = impresiones programadas; el % de uso incluye el setup
  // contra lo que pueden las cuadrillas del turno (cuadrillas × hits por turno
  // × eficiencia aplicada en la corrida).
  const perCrew = (run.hits_per_shift || 4500) * (run.efficiency || 1);
  const tot = {};
  cur.windows.forEach((w) => {
    const key = `${w.date}|${w.shift}`;
    let hits = 0;
    let used = 0;
    machines.forEach((m) => (cells[`${m}|${key}`] || []).forEach((s) => { hits += s.hits; used += s.hits + s.setup_hits; }));
    tot[key] = { hits, used, cap: w.crews == null ? null : w.crews * perCrew };
  });
  const dayTot = (date) => cur.windows.filter((w) => w.date === date)
    .reduce((a, w) => {
      const x = tot[`${w.date}|${w.shift}`];
      return { hits: a.hits + x.hits, used: a.used + x.used, cap: x.cap == null ? a.cap : (a.cap || 0) + x.cap };
    }, { hits: 0, used: 0, cap: null });
  const weekTot = Object.values(tot).reduce((a, x) => ({ hits: a.hits + x.hits, used: a.used + x.used,
    cap: x.cap == null ? a.cap : (a.cap || 0) + x.cap }), { hits: 0, used: 0, cap: null });
  const pct = (x) => (x.cap ? Math.round((x.used / x.cap) * 100) : null);
  const pctColor = (p) => (p == null ? "text-slate-400" : p > 100 ? "text-red-600" : p >= 85 ? "text-emerald-600" : "text-amber-600");
  const days = [...new Set(cur.windows.map((w) => w.date))];

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <button onClick={() => setWeek(Math.max(0, week - 1))} disabled={week === 0}
          className="h-8 w-8 rounded-lg border border-slate-200 text-sm font-bold disabled:opacity-40">‹</button>
        <span className="text-sm font-black text-slate-700 tabular-nums">
          {tr("plan_week_of", { from: dday(cur.monday), to: dday(sunday) })}
        </span>
        <button onClick={() => setWeek(Math.min(weeks.length - 1, week + 1))} disabled={week >= weeks.length - 1}
          className="h-8 w-8 rounded-lg border border-slate-200 text-sm font-bold disabled:opacity-40">›</button>
        {week > 0 && (
          <button onClick={() => setWeek(0)} className="h-8 px-2 rounded-lg border border-slate-200 text-xs font-bold">{tr("plan_this_week")}</button>
        )}
        <span className="ml-auto text-xs text-slate-600 tabular-nums">
          {tr("plan_week_total", { hits: fmt(weekTot.hits), cap: fmt(weekTot.cap) })}
          {pct(weekTot) != null && <b className={`ml-1.5 ${pctColor(pct(weekTot))}`}>{pct(weekTot)}%</b>}
        </span>
      </div>
      {/* Área de scroll PROPIA (alto limitado): así el encabezado de días se
          queda arriba y la columna de máquina a la izquierda. Se fijan con
          `style` y NO con la clase `sticky`: index.css pinta de negro todo
          td.sticky en tema oscuro. */}
      <div className="overflow-auto max-h-[70vh] rounded-lg border border-slate-200">
        <table className="min-w-full text-xs border-separate border-spacing-0">
          <thead>
            <tr>
              <th style={{ position: "sticky", top: 0, left: 0, zIndex: 30 }}
                className="planner-th px-3 py-2 text-left font-bold text-slate-500 border-b border-r border-slate-200">{tr("plan_machine")}</th>
              {cur.windows.map((w) => {
                const off = w.crews === 0;
                return (
                  <th key={`${w.date}|${w.shift}`} style={{ position: "sticky", top: 0, zIndex: 20 }}
                    className={`planner-th px-2 py-2 text-left whitespace-nowrap border-b border-slate-200 ${
                      w.shift === "NOCHE" ? "border-r" : ""}`}>
                    <div className={`font-bold ${off ? "text-slate-400" : "text-slate-700"}`}>
                      {dayNames[weekdayIdx(w.date)]} {dday(w.date)} · {w.shift === "DIA" ? tr("plan_shift_day") : tr("plan_shift_night")}
                    </div>
                    <div className={`text-[10px] font-normal ${w.holiday ? "text-red-500" : "text-slate-400"}`}>
                      {w.holiday ? w.holiday
                        : w.crews == null ? ""
                        : off ? tr("plan_no_shift")
                        : w.overtime ? tr("plan_ot_window", { n: w.crews, s: w.start, e: addHours(w.start, w.hours).time })
                        : tr("plan_crews_n", { n: w.crews })}
                    </div>
                    {(() => {
                      const x = tot[`${w.date}|${w.shift}`];
                      if (!x.hits && !x.cap) return null;
                      const p = pct(x);
                      return (
                        <div className="text-[11px] font-bold tabular-nums text-slate-700 mt-0.5">
                          {tr("plan_shift_load", { n: fmt(x.hits) })}
                          {p != null && <span className={`ml-1 ${pctColor(p)}`}>{p}%</span>}
                        </div>
                      );
                    })()}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {machines.map((m) => (
              <tr key={m}>
                <td style={{ position: "sticky", left: 0, zIndex: 10 }}
                  className="planner-machine-cell px-3 py-2 font-black text-slate-700 whitespace-nowrap align-top border-b border-r border-slate-200">
                  {m.replace("MAQUINA", "M")}
                </td>
                {cur.windows.map((w) => {
                  const segs = cells[`${m}|${w.date}|${w.shift}`] || [];
                  const used = segs.reduce((a, s) => a + s.hits + s.setup_hits, 0);
                  const off = w.crews === 0;
                  return (
                    <td key={`${w.date}|${w.shift}`}
                      className={`px-2 py-1.5 align-top min-w-[140px] border-b border-slate-100 ${
                        w.shift === "NOCHE" ? "border-r border-r-slate-200" : ""} ${off ? "bg-slate-100/70" : ""}`}>
                      {segs.length === 0 ? <span className="text-slate-300">—</span> : (
                        <div className="space-y-1">
                          {segs.map((s, i) => (
                            <div key={i} onClick={() => onAdjust && onAdjust(s.job)}
                              className={`px-1.5 py-1 rounded border ${onAdjust ? "cursor-pointer hover:ring-2 hover:ring-blue-300" : ""} ${STATUS_STYLE[s.status] || "border-slate-200"}`}
                              title={`${hhmm(s.start)}–${hhmm(s.end)} · ${fmt(s.hits)} hits · setup ${fmt(s.setup_hits)}`}>
                              <span className="font-black">{s.order_number}</span>{" "}
                              <span className="opacity-70">{s.position}</span>{" "}
                              {s.job.kind === "NUEVA" && (
                                <span className="px-1 rounded bg-violet-100 text-violet-700 text-[9px] font-black" title={tr("plan_kind_NUEVA")}>N</span>
                              )}{" "}
                              {s.hits > 0
                                ? <span className="tabular-nums">{fmt(s.hits)}</span>
                                : <span className="italic opacity-70">{tr("plan_setup_only")}</span>}{" "}
                              <OverrideBadges manual={s.job.manual} warnings={s.job.warnings} tr={tr} />
                            </div>
                          ))}
                          <div className="text-[10px] text-slate-400 tabular-nums">{tr("plan_shift_load", { n: fmt(used) })}</div>
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td style={{ position: "sticky", left: 0, bottom: 0, zIndex: 30 }}
                className="planner-machine-cell px-3 py-2 font-black text-slate-700 border-t border-r border-slate-200">
                {tr("plan_day_total")}
              </td>
              {days.map((d) => {
                const x = dayTot(d);
                const p = pct(x);
                return (
                  <td key={d} colSpan={cur.windows.filter((w) => w.date === d).length}
                    style={{ position: "sticky", bottom: 0, zIndex: 20 }}
                    className="planner-machine-cell px-2 py-2 border-t border-r border-slate-200 tabular-nums">
                    <span className="font-black text-slate-800">{fmt(x.hits)}</span>
                    <span className="text-slate-500"> {tr("plan_hits").toLowerCase()}</span>
                    {x.cap ? <span className="text-slate-400"> / {fmt(x.cap)}</span> : null}
                    {p != null && <b className={`ml-1.5 ${pctColor(p)}`}>{p}%</b>}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
};

/* ── Autorizar movimientos ─────────────────────────────────────────────────
   El motor propone; un administrador autoriza. Autorizar mueve la orden a su
   tablero MAQUINA por el mismo camino que un movimiento manual del CRM
   (candado QC, guardas, bitácora, automatizaciones). Todo se puede revertir
   desde "Movimientos autorizados". */
const MovesCard = ({ run, canEdit, onApply, onAdjust, tr }) => {
  const moves = run.moves || [];
  const [sel, setSel] = useState([]);
  const [confirm, setConfirm] = useState(null);     // lista de movimientos a autorizar
  const [busy, setBusy] = useState(false);
  useEffect(() => { setSel([]); }, [run.run_id]);
  const toggle = (id) => setSel(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
  const allOn = moves.length > 0 && sel.length === moves.length;
  const doApply = async () => {
    setBusy(true);
    try { await onApply(confirm.map((m) => m.order_id)); setConfirm(null); setSel([]); } finally { setBusy(false); }
  };
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start gap-2">
        <SectionTitle hint={canEdit ? tr("plan_moves_hint_auth") : tr("plan_moves_hint")}>
          {tr("plan_moves_title")} ({moves.length})
        </SectionTitle>
        {canEdit && moves.length > 0 && (
          <div className="ml-auto flex gap-2">
            <button onClick={() => setConfirm(moves.filter((m) => sel.includes(m.order_id)))} disabled={!sel.length}
              className="h-9 px-3 rounded-lg bg-blue-600 text-white text-sm font-bold inline-flex items-center gap-1.5 disabled:opacity-40">
              <CheckCircle2 className="w-4 h-4" />{tr("plan_auth_selected", { n: sel.length })}
            </button>
            <button onClick={() => setConfirm(moves)}
              className="h-9 px-3 rounded-lg border border-blue-300 text-blue-700 text-sm font-bold hover:bg-blue-50">
              {tr("plan_auth_all", { n: moves.length })}
            </button>
          </div>
        )}
      </div>
      {moves.length === 0 ? <Empty>{tr("plan_moves_empty")}</Empty> : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-400">
              {canEdit && (
                <th className="py-2 pr-2">
                  <input type="checkbox" checked={allOn} onChange={() => setSel(allOn ? [] : moves.map((m) => m.order_id))} className="w-4 h-4" />
                </th>
              )}
              <th className="py-2 pr-4">{tr("plan_order")}</th><th className="pr-4">{tr("plan_client")}</th>
              <th className="pr-4">{tr("plan_from")}</th><th className="pr-4">{tr("plan_to")}</th>
              <th className="pr-4">{tr("plan_positions")}</th><th className="pr-4">{tr("plan_starts")}</th><th />
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {moves.map((m) => (
                <tr key={m.order_id} className={sel.includes(m.order_id) ? "bg-blue-50/60" : ""}>
                  {canEdit && (
                    <td className="py-2 pr-2"><input type="checkbox" checked={sel.includes(m.order_id)} onChange={() => toggle(m.order_id)} className="w-4 h-4" /></td>
                  )}
                  <td className="py-2 pr-4 font-black">{m.order_number}</td>
                  <td className="pr-4 text-slate-500">{m.client}</td>
                  <td className="pr-4">{m.from_board}</td>
                  <td className="pr-4 font-bold text-blue-700">{m.to_board}</td>
                  <td className="pr-4 text-xs text-slate-500">
                    {m.positions.map((p) => `${p.position} → ${p.machines.join(", ").replace(/MAQUINA/g, "M")}`).join(" · ")}
                  </td>
                  <td className="pr-4 tabular-nums text-slate-500">{dday(m.start)} {hhmm(m.start)}</td>
                  <td className="whitespace-nowrap">{canEdit && (
                    <span className="inline-flex gap-1.5">
                      <button onClick={() => onAdjust((run.jobs || []).find((j) => j.order_id === m.order_id) || {
                        order_id: m.order_id, order_number: m.order_number, client: m.client, start: m.start,
                        position: m.positions[0]?.position, machines: m.positions[0]?.machines || [] })}
                        className="px-2.5 h-7 rounded-lg border border-slate-300 text-slate-700 text-xs font-bold inline-flex items-center gap-1 hover:border-blue-300 hover:text-blue-700">
                        <SlidersHorizontal className="w-3.5 h-3.5" />{tr("plan_reschedule")}
                      </button>
                      <button onClick={() => setConfirm([m])}
                        className="px-2.5 h-7 rounded-lg bg-blue-600 text-white text-xs font-bold hover:bg-blue-700">{tr("plan_auth_one")}</button>
                    </span>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => !busy && setConfirm(null)}>
          <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-slate-200">
              <div className="font-black text-slate-900">{tr("plan_auth_confirm_title", { n: confirm.length })}</div>
              <div className="text-xs text-amber-700 mt-1 flex items-start gap-1.5">
                <AlertTriangle className="w-4 h-4 shrink-0" />{tr("plan_auth_confirm_warn")}
              </div>
            </div>
            <ul className="px-5 py-3 max-h-[45vh] overflow-y-auto divide-y divide-slate-100 text-sm">
              {confirm.map((m) => (
                <li key={m.order_id} className="py-1.5 flex gap-2">
                  <b className="w-14">{m.order_number}</b>
                  <span className="text-slate-500">{m.from_board}</span>→<b className="text-blue-700">{m.to_board}</b>
                  <span className="ml-auto text-xs text-slate-400 tabular-nums">{dday(m.start)} {hhmm(m.start)}</span>
                </li>
              ))}
            </ul>
            <div className="px-5 py-4 border-t border-slate-200 flex justify-end gap-2">
              <button onClick={() => setConfirm(null)} disabled={busy} className="h-9 px-3 rounded-lg border border-slate-200 text-sm font-bold">{tr("plan_otm_cancel")}</button>
              <button onClick={doApply} disabled={busy}
                className="h-9 px-4 rounded-lg bg-blue-600 text-white text-sm font-bold inline-flex items-center gap-1.5 disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}{tr("plan_auth_confirm_btn")}
              </button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
};

const AppliedMovesCard = ({ rows, canEdit, onRevert, lastResults, tr }) => {
  const [open, setOpen] = useState(true);
  const problems = (lastResults || []).filter((r) => r.result !== "applied");
  return (
    <Card className="p-4">
      <button onClick={() => setOpen(!open)} className="w-full text-left">
        <SectionTitle hint={tr("plan_applied_hint")}>{tr("plan_applied_title")} ({rows.length}) {open ? "▾" : "▸"}</SectionTitle>
      </button>
      {problems.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <b>{tr("plan_auth_not_applied", { n: problems.length })}</b>
          <ul className="mt-1 space-y-0.5">
            {problems.map((r) => <li key={r.order_id}><b>{r.order_number || r.order_id}</b>: {r.reason}</li>)}
          </ul>
        </div>
      )}
      {open && (rows.length === 0 ? <div className="text-sm text-slate-400">{tr("plan_applied_empty")}</div> : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-400">
              <th className="py-2 pr-3">{tr("plan_order")}</th><th className="pr-3">{tr("plan_from")}</th><th className="pr-3">{tr("plan_to")}</th>
              <th className="pr-3">{tr("plan_applied_when")}</th><th className="pr-3">{tr("plan_applied_who")}</th><th className="pr-3">{tr("plan_status")}</th><th />
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.apply_id} className={r.status === "reverted" ? "opacity-50" : ""}>
                  <td className="py-1.5 pr-3 font-black">{r.order_number}</td>
                  <td className="pr-3 text-xs">{r.from_board}</td>
                  <td className="pr-3 text-xs font-bold text-blue-700">{r.to_board}</td>
                  <td className="pr-3 text-xs tabular-nums">{new Date(r.applied_at).toLocaleString("es-MX")}</td>
                  <td className="pr-3 text-xs text-slate-500">{r.applied_by_name || r.applied_by}</td>
                  <td className="pr-3">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${r.status === "applied"
                      ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                      {r.status === "applied" ? tr("plan_applied_ok") : tr("plan_applied_reverted", { who: r.reverted_by || "" })}
                    </span>
                  </td>
                  <td>{canEdit && r.status === "applied" && (
                    <button onClick={() => onRevert(r)}
                      className="px-2 h-7 rounded border border-slate-200 text-xs font-bold inline-flex items-center gap-1 hover:border-red-300 hover:text-red-700">
                      <Undo2 className="w-3.5 h-3.5" />{tr("plan_applied_revert")}
                    </button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </Card>
  );
};

const ScheduleTab = ({ config, efficiency, run, running, onRun, canEdit, onToggle, onAdjust, overrides, history, onUndo,
  onApplyMoves, applied, onRevertMove, lastApply, tr }) => {
  const [status, setStatus] = useState("");
  const [kindF, setKindF] = useState("");
  const [extraOnly, setExtraOnly] = useState(false);
  const [showBlocked, setShowBlocked] = useState(false);
  const [miss, setMiss] = useState("");
  const [onlyThat, setOnlyThat] = useState(false);
  const [blockedSearch, setBlockedSearch] = useState("");
  // Rango por CANCEL DATE (YYYY-MM-DD, se compara como texto).
  const [dFrom, setDFrom] = useState("");
  const [dTo, setDTo] = useState("");
  const todayIso = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const setQuick = (k) => {
    const t = todayIso();
    const mon = addDays(t, -weekdayIdx(t));
    if (k === "overdue") { setDFrom(""); setDTo(addDays(t, -1)); }
    if (k === "week") { setDFrom(mon); setDTo(addDays(mon, 6)); }
    if (k === "next") { setDFrom(addDays(mon, 7)); setDTo(addDays(mon, 13)); }
    if (k === "clear") { setDFrom(""); setDTo(""); }
  };

  // Filtro de bloqueados por lo que les falta. "Sólo eso" = les falta
  // únicamente ese requisito (los que están a un paso de entrar).
  const blockedAll = useMemo(() => run?.blocked || [], [run]);
  const lacks = (b, k) => !b.held && b.ready && k in b.ready && !b.ready[k];
  const missCount = (k) => blockedAll.filter((b) => lacks(b, k)).length;
  const blockedRows = useMemo(() => {
    const q = blockedSearch.trim().toLowerCase();
    return blockedAll.filter((b) => {
      if (miss === "held" && !b.held) return false;
      if (MISS_KEYS.includes(miss)) {
        if (!lacks(b, miss)) return false;
        if (onlyThat && MISS_KEYS.some((k) => k !== miss && lacks(b, k))) return false;
      }
      if (q && !String(b.order_number).toLowerCase().includes(q) && !String(b.client || "").toLowerCase().includes(q)) return false;
      const cd = String(b.cancel_date || "").slice(0, 10);
      if ((dFrom || dTo) && !cd) return false;
      if (dFrom && cd < dFrom) return false;
      if (dTo && cd > dTo) return false;
      return true;
    });
  }, [blockedAll, miss, onlyThat, blockedSearch, dFrom, dTo]); // eslint-disable-line react-hooks/exhaustive-deps

  // Exporta los bloqueados a Excel con UNA HOJA POR DEPARTAMENTO (lo que le
  // falta a cada uno), para mandarles su pendiente. Cada hoja lista las órdenes
  // a las que les falta ese requisito; además una hoja "Retenidas" y "Todos".
  const exportBlocked = () => {
    const head = [tr("plan_order"), tr("plan_position"), tr("plan_client"), tr("plan_kind_col"),
                  tr("plan_board"), tr("plan_hits_left"), tr("plan_target"), tr("plan_missing")];
    const missOf = (b) => (b.held ? tr("plan_ov_kind_hold")
      : MISS_KEYS.filter((k) => lacks(b, k)).map((k) => tr(`plan_miss_${k}`)).join(", "));
    const kindOf = (b) => tr(`plan_kind_${b.kind || "SIN_DATO"}`)
      + (b.kind === "NUEVA" && b.sample_state && tr(`plan_sample_short_${b.sample_state}`)
         ? ` · ${tr(`plan_sample_short_${b.sample_state}`)}` : "");
    const row = (b) => [b.order_number, b.position, b.client, kindOf(b), b.board,
                        b.remaining || 0, b.target_date || b.cancel_date || "", missOf(b)];
    const sheet = (list) => {
      const ws = XLSX.utils.aoa_to_sheet([head, ...list.map(row)]);
      ws["!cols"] = [{ wch: 9 }, { wch: 10 }, { wch: 24 }, { wch: 18 }, { wch: 14 },
                     { wch: 11 }, { wch: 12 }, { wch: 30 }];
      return ws;
    };
    const wb = XLSX.utils.book_new();
    let any = false;
    MISS_KEYS.forEach((k) => {
      const list = blockedAll.filter((b) => lacks(b, k));
      if (list.length) { XLSX.utils.book_append_sheet(wb, sheet(list), tr(`plan_miss_${k}`).slice(0, 31)); any = true; }
    });
    const held = blockedAll.filter((b) => b.held);
    if (held.length) { XLSX.utils.book_append_sheet(wb, sheet(held), tr("plan_ov_kind_hold").slice(0, 31)); any = true; }
    if (blockedAll.length) XLSX.utils.book_append_sheet(wb, sheet(blockedAll), tr("plan_all").slice(0, 31));
    if (!any && !blockedAll.length) { toast.error(tr("plan_export_empty")); return; }
    const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    saveAs(new Blob([buf], { type: "application/octet-stream" }),
           `Planeacion_Bloqueados_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const on = config?.engine_mode === "shadow";

  if (!on) {
    return (
      <Card className="p-8 text-center">
        <Power className="w-10 h-10 mx-auto text-slate-300" />
        <div className="mt-3 text-lg font-black text-slate-800">{tr("plan_engine_off_title")}</div>
        <p className="text-sm text-slate-500 mt-1 max-w-xl mx-auto">{tr("plan_engine_off_hint")}</p>
        {canEdit ? (
          <button onClick={() => onToggle(true)}
            className="mt-5 h-11 px-6 rounded-xl bg-blue-600 text-white font-bold inline-flex items-center gap-2 hover:bg-blue-700">
            <Power className="w-4 h-4" /> {tr("plan_engine_turn_on")}
          </button>
        ) : <p className="text-xs text-slate-400 mt-4">{tr("plan_engine_admin_only")}</p>}
      </Card>
    );
  }
  if (!run?.run_id) {
    return (
      <Card className="p-8 text-center">
        <div className="text-sm text-slate-600">{tr("plan_no_runs")}</div>
        <button onClick={onRun} disabled={running}
          className="mt-4 h-10 px-5 rounded-xl bg-blue-600 text-white font-bold inline-flex items-center gap-2 disabled:opacity-60">
          {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} {tr("plan_run_now")}
        </button>
      </Card>
    );
  }
  const by = run.stats?.by_status || {};
  const jobs = (run.jobs || []).filter((j) => (!status || j.status === status) && (!kindF || j.kind === kindF)
    && (!extraOnly || j.has_extra_work));
  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 bg-sky-50 border border-sky-200 rounded-xl px-4 py-3 text-sm text-sky-800">
        <Eye className="w-4 h-4 mt-0.5 shrink-0" />
        <span>{tr("plan_shadow_banner")}</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <Stat label={tr("plan_st_scheduled")} value={fmt(run.stats?.scheduled)} />
        <Stat label={tr("plan_st_on_time")} value={fmt(by.A_TIEMPO || 0)} color="text-emerald-600" />
        <Stat label={tr("plan_st_at_risk")} value={fmt(by.EN_RIESGO || 0)} color="text-amber-600" />
        <Stat label={tr("plan_st_overdue")} value={fmt(by.VENCIDA || 0)} color="text-red-600" />
        <Stat label={tr("plan_st_blocked")} value={fmt(run.stats?.blocked)} color="text-slate-500" />
        <Stat label={tr("plan_st_hits")} value={fmt(run.stats?.hits_scheduled)} color="text-blue-600" />
      </div>

      {(() => {
        const rr = efficiency?.measured?.run_rates || {};
        const rates = rr.rates || {};
        const glob = rr.global_rate;
        const rpph = config?.rate_pph || 407;
        return (
          <Card className="p-3">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{tr("plan_speed_title")}</span>
              {glob != null ? (
                <>
                  {["BAJO", "MEDIO", "ALTO"].map((v) => (
                    <span key={v} className="text-sm tabular-nums text-slate-700">
                      {tr(`plan_run_${v}`)}: <b className="text-violet-700">{fmt(rates[v] || glob)}</b> h/h
                    </span>
                  ))}
                  <span className="text-sm tabular-nums text-slate-700">
                    {tr("plan_speed_global")}: <b className="text-violet-700">{fmt(glob)}</b> h/h
                  </span>
                  <span className="ml-auto text-xs text-slate-400">{tr("plan_speed_measured", { w: 8, r: fmt(rpph) })}</span>
                </>
              ) : (
                <span className="text-sm text-slate-500">{tr("plan_speed_none", { r: fmt(rpph) })}</span>
              )}
            </div>
          </Card>
        );
      })()}

      {(run.impact || []).length > 0 && (
        <Card className="p-4 border-violet-200">
          <SectionTitle hint={tr("plan_impact_hint")}>{tr("plan_impact_title")} ({run.impact.length})</SectionTitle>
          <ul className="flex flex-wrap gap-2 text-xs">
            {run.impact.map((i) => (
              <li key={i.job_id} className="px-2 py-1 rounded-lg border border-slate-200 bg-white">
                <b>{i.order_number}</b> {i.position}: {tr(`plan_status_${i.from}`)} → <b>{tr(`plan_status_${i.to}`)}</b>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <OverridesCard overrides={overrides} history={history} canEdit={canEdit} onUndo={onUndo}
        onOpen={(o) => {
          const j = (run.jobs || []).find((x) => x.order_id === o.order_id && (o.position === "*" || x.position === o.position))
            || (run.blocked || []).find((x) => x.order_id === o.order_id && (o.position === "*" || x.position === o.position));
          onAdjust(j || { order_id: o.order_id, order_number: o.order_number, position: o.position === "*" ? "FRENTE" : o.position });
        }}
        tr={tr} />

      <MovesCard run={run} canEdit={canEdit} onApply={onApplyMoves} onAdjust={onAdjust} tr={tr} />
      <AppliedMovesCard rows={applied} canEdit={canEdit} onRevert={onRevertMove} lastResults={lastApply} tr={tr} />

      <Card className="p-4">
        <SectionTitle hint={tr("plan_grid_hint")}>{tr("plan_grid_title")}</SectionTitle>
        <MachineGrid run={run} onAdjust={canEdit ? onAdjust : null} tr={tr} />
      </Card>

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <SectionTitle>{tr("plan_jobs_title")}</SectionTitle>
          <div className="ml-auto flex flex-wrap gap-1.5">
            {["", "REORDEN", "NUEVA"].map((k) => (
              <button key={`k${k || "all"}`} onClick={() => setKindF(k)}
                className={`px-2.5 py-1 rounded-lg border text-xs font-bold ${kindF === k
                  ? "bg-violet-700 border-violet-700 text-white" : "bg-white border-slate-200 text-slate-600"}`}>
                {k ? tr(`plan_kind_${k}_pl`) : tr("plan_all_kinds")}
                <span className="opacity-60 ml-1">{(run.jobs || []).filter((j) => !k || j.kind === k).length}</span>
              </button>
            ))}
            <span className="w-px bg-slate-200 mx-1" />
            {["", "A_TIEMPO", "EN_RIESGO", "VENCIDA", "FUERA_DE_HORIZONTE"].map((s) => (
              <button key={s || "all"} onClick={() => setStatus(s)}
                className={`px-2.5 py-1 rounded-lg border text-xs font-bold ${status === s
                  ? "bg-slate-900 border-slate-900 text-white" : "bg-white border-slate-200 text-slate-600"}`}>
                {s ? tr(`plan_status_${s}`) : tr("plan_all")}
              </button>
            ))}
            <button onClick={() => setExtraOnly(!extraOnly)}
              className={`px-2.5 py-1 rounded-lg border text-xs font-bold ${extraOnly
                ? "bg-fuchsia-600 border-fuchsia-600 text-white" : "bg-white border-slate-200 text-slate-600"}`}>
              {tr("plan_extra_only")} <span className="opacity-60 ml-1">{(run.jobs || []).filter((j) => j.has_extra_work).length}</span>
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-400">
              <th className="py-2 pr-3">{tr("plan_order")}</th><th className="pr-3">{tr("plan_position")}</th>
              <th className="pr-3">{tr("plan_client")}</th><th className="pr-3">{tr("plan_kind_col")}</th><th className="pr-3">{tr("plan_volume")}</th>
              <th className="pr-3 text-right">{tr("plan_hits_left")}</th><th className="pr-3">{tr("plan_machines")}</th>
              <th className="pr-3">{tr("plan_start")}</th><th className="pr-3">{tr("plan_end")}</th>
              <th className="pr-3">{tr("plan_target")}</th><th className="pr-3">{tr("plan_cancel")}</th>
              <th className="pr-3">{tr("plan_status")}</th><th className="pr-3">{tr("plan_suggested_cancel")}</th><th />
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {jobs.map((j) => (
                <tr key={j.job_id}>
                  <td className="py-1.5 pr-3 font-black whitespace-nowrap">{j.order_number} <OverrideBadges manual={j.manual} warnings={j.warnings} tr={tr} /> <ExtraWorkBadge extra={j.extra_work} tr={tr} /></td>
                  <td className="pr-3 text-xs">{j.position}</td>
                  <td className="pr-3 text-xs text-slate-500 max-w-[160px] truncate">{j.client}</td>
                  <td className="pr-3"><KindBadge kind={j.kind} state={j.sample_state} tr={tr} /></td>
                  <td className="pr-3"><span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${VOLUME_STYLE[j.volume]}`}>{j.volume}</span></td>
                  <td className="pr-3 text-right tabular-nums">{fmt(j.remaining)}</td>
                  <td className="pr-3 text-xs">{(j.machines || []).join(", ").replace(/MAQUINA/g, "M")}</td>
                  <td className="pr-3 text-xs tabular-nums">{dday(j.start)} {hhmm(j.start)}</td>
                  <td className="pr-3 text-xs tabular-nums">{j.end ? `${dday(j.end)} ${hhmm(j.end)}` : "—"}</td>
                  <td className="pr-3 text-xs tabular-nums">{j.target_date || "—"}</td>
                  <td className="pr-3 text-xs tabular-nums">{j.cancel_date || "—"}</td>
                  <td className="pr-3"><span className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${STATUS_STYLE[j.status]}`}>{tr(`plan_status_${j.status}`)}</span></td>
                  <td className="pr-3 text-xs tabular-nums font-bold text-amber-700">{j.suggested_cancel_date || ""}</td>
                  <td>{canEdit && (
                    <button onClick={() => onAdjust(j)} className="px-2 h-7 rounded-lg border border-slate-200 text-xs font-bold inline-flex items-center gap-1 hover:border-blue-300 hover:text-blue-700">
                      <SlidersHorizontal className="w-3.5 h-3.5" />{tr("plan_adjust")}
                    </button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-4">
        <button onClick={() => setShowBlocked(!showBlocked)} className="w-full text-left">
          <SectionTitle hint={tr("plan_blocked_hint")}>
            {tr("plan_blocked_title")} ({(run.blocked || []).length}) {showBlocked ? "▾" : "▸"}
          </SectionTitle>
        </button>
        {showBlocked && (
          <div>
            <div className="flex flex-wrap items-center gap-1.5 mb-3">
              {[["", tr("plan_all"), blockedAll.length], ...MISS_KEYS.map((k) => [k, tr(`plan_miss_${k}`), missCount(k)]),
                ["held", tr("plan_ov_kind_hold"), blockedAll.filter((b) => b.held).length]].map(([k, label, n]) => (
                <button key={k || "all"} onClick={() => setMiss(k)}
                  className={`px-2.5 py-1 rounded-lg border text-xs font-bold ${miss === k
                    ? "bg-slate-900 border-slate-900 text-white" : "bg-white border-slate-200 text-slate-600 hover:border-slate-400"}`}>
                  {label} <span className="opacity-60">{n}</span>
                </button>
              ))}
              {MISS_KEYS.includes(miss) && (
                <label className="ml-2 flex items-center gap-1.5 text-xs text-slate-600">
                  <input type="checkbox" checked={onlyThat} onChange={(e) => setOnlyThat(e.target.checked)} className="w-4 h-4" />
                  {tr("plan_miss_only")}
                </label>
              )}
              <div className="w-full flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                <span className="font-bold">{tr("plan_cancel_range")}</span>
                <input type="date" value={dFrom} onChange={(e) => setDFrom(e.target.value)} className="h-8 px-2 rounded-lg border border-slate-200 text-xs" />
                <span>—</span>
                <input type="date" value={dTo} onChange={(e) => setDTo(e.target.value)} className="h-8 px-2 rounded-lg border border-slate-200 text-xs" />
                {[["overdue", "plan_range_overdue"], ["week", "plan_range_week"], ["next", "plan_range_next"]].map(([k, l]) => (
                  <button key={k} onClick={() => setQuick(k)} className="px-2 h-8 rounded-lg border border-slate-200 bg-white font-bold hover:border-slate-400">{tr(l)}</button>
                ))}
                {(dFrom || dTo) && (
                  <button onClick={() => setQuick("clear")} className="px-2 h-8 rounded-lg text-slate-400 hover:text-red-600 inline-flex items-center gap-1">
                    <X className="w-3.5 h-3.5" />{tr("plan_range_clear")}
                  </button>
                )}
              </div>
              <input value={blockedSearch} onChange={(e) => setBlockedSearch(e.target.value)} placeholder={tr("plan_search_order_client")}
                className="ml-auto h-8 px-2 rounded-lg border border-slate-200 text-xs w-52" />
              <button onClick={exportBlocked} title={tr("plan_export_blocked_hint")}
                className="h-8 px-3 rounded-lg bg-green-600 text-white text-xs font-bold inline-flex items-center gap-1.5 hover:bg-green-700">
                <Download className="w-3.5 h-3.5" />{tr("plan_export_excel")}
              </button>
              <span className="text-xs text-slate-500 tabular-nums w-full sm:w-auto">
                {tr("plan_blocked_showing", { n: blockedRows.length, hits: fmt(blockedRows.reduce((a, b) => a + (b.remaining || 0), 0)) })}
              </span>
            </div>
            <div className="overflow-auto max-h-[70vh]">
            <table className="min-w-full text-sm">
              <thead className="planner-freeze"><tr className="text-left text-[11px] uppercase tracking-wider text-slate-400">
                <th className="py-2 pr-3">{tr("plan_order")}</th><th className="pr-3">{tr("plan_position")}</th>
                <th className="pr-3">{tr("plan_client")}</th><th className="pr-3">{tr("plan_kind_col")}</th><th className="pr-3">{tr("plan_board")}</th>
                <th className="pr-3 text-right">{tr("plan_hits_left")}</th><th className="pr-3">{tr("plan_target")}</th>
                <th className="pr-3">{tr("plan_missing")}</th><th />
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {blockedRows.map((b) => (
                  <tr key={b.job_id}>
                    <td className="py-1.5 pr-3 font-black whitespace-nowrap">{b.order_number} <ExtraWorkBadge extra={b.extra_work} tr={tr} /></td>
                    <td className="pr-3 text-xs">{b.position}</td>
                    <td className="pr-3 text-xs text-slate-500">{b.client}</td>
                    <td className="pr-3"><KindBadge kind={b.kind} state={b.sample_state} tr={tr} /></td>
                    <td className="pr-3 text-xs">{b.board}</td>
                    <td className="pr-3 text-right tabular-nums">{fmt(b.remaining)}</td>
                    <td className="pr-3 text-xs tabular-nums">{b.target_date || "—"}</td>
                    <td className="pr-3">
                      {b.held ? <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-50 text-red-700">{tr("plan_ov_kind_hold")}</span>
                        : <ReadyBadges ready={b.ready} tr={tr} />}
                    </td>
                    <td>{canEdit && (
                      <button onClick={() => onAdjust(b)} className="px-2 h-7 rounded-lg border border-slate-200 text-xs font-bold inline-flex items-center gap-1 hover:border-blue-300 hover:text-blue-700">
                        <SlidersHorizontal className="w-3.5 h-3.5" />{tr("plan_adjust")}
                      </button>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
};

/* ── Proyección ──────────────────────────────────────────────────────────── */
/* ── Órdenes de la proyección ─────────────────────────────────────────────
   TODAS las órdenes del horizonte a la vista; la semana es un filtro más
   (primero ves, luego filtras). Semana = la de su fecha objetivo (lo atrasado,
   en la semana actual). Una línea por orden juntando sus posiciones, con lo
   que el motor programó para ellas en la última corrida. */
const STATUS_RANK = { VENCIDA: 0, EN_RIESGO: 1, FUERA_DE_HORIZONTE: 2, SIN_FECHA: 3, A_TIEMPO: 4 };

const WeekOrders = ({ weeks, run, weekF, setWeekF, tr }) => {
  const jobs = useMemo(() => (weeks || []).flatMap((w) => (w.jobs || []).map((j) => ({
    ...j, week: w.week_start, iso_week: w.iso_week }))), [weeks]);
  const [q, setQ] = useState("");
  const [client, setClient] = useState("");
  const [kind, setKind] = useState("");
  const [readyF, setReadyF] = useState("");
  const [planF, setPlanF] = useState("");
  const [vol, setVol] = useState("");

  const orders = useMemo(() => {
    const plan = {};
    (run?.jobs || []).forEach((j) => { plan[j.job_id] = j; });
    const by = new Map();
    jobs.forEach((j) => {
      let o = by.get(j.order_id);
      if (!o) {
        o = { ...j, positions: [], remaining: 0, ready: { ...(j.ready || {}) }, is_ready: true,
          machines: new Set(), start: null, end: null, status: null, scheduled: 0 };
        by.set(j.order_id, o);
      }
      o.positions.push(j.position);
      o.remaining += j.remaining || 0;
      Object.keys(j.ready || {}).forEach((k) => { o.ready[k] = o.ready[k] && j.ready[k]; });
      o.is_ready = o.is_ready && (j.is_ready || j.started);
      const p = plan[j.job_id];
      if (p) {
        o.scheduled += 1;
        (p.machines || []).forEach((m) => o.machines.add(m));
        if (p.start && (!o.start || p.start < o.start)) o.start = p.start;
        if (p.end && (!o.end || p.end > o.end)) o.end = p.end;
        if (!o.status || (STATUS_RANK[p.status] ?? 9) < (STATUS_RANK[o.status] ?? 9)) o.status = p.status;
      }
    });
    return [...by.values()]
      .map((o) => ({ ...o, machines: [...o.machines], plan: o.scheduled ? o.status : "SIN_PROGRAMAR" }))
      .sort((a, b) => ((a.target_date || "") < (b.target_date || "") ? -1 : (a.target_date || "") > (b.target_date || "") ? 1
        : String(a.order_number).localeCompare(String(b.order_number), undefined, { numeric: true })));
  }, [jobs, run]);

  const clients = useMemo(() => [...new Set(orders.map((o) => o.client).filter(Boolean))].sort(), [orders]);
  const rows = orders.filter((o) => {
    const s = q.trim().toLowerCase();
    if (s && ![o.order_number, o.client, o.branding].some((x) => String(x || "").toLowerCase().includes(s))) return false;
    if (weekF && o.week !== weekF) return false;
    if (client && o.client !== client) return false;
    if (kind && o.kind !== kind) return false;
    if (readyF === "ready" && !o.is_ready) return false;
    if (readyF === "blocked" && o.is_ready) return false;
    if (planF && o.plan !== planF) return false;
    if (vol && o.volume !== vol) return false;
    return true;
  });
  const sel = "h-8 px-2 rounded-lg border border-slate-200 text-xs bg-white";

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr("plan_search_order_client")}
          className="h-8 px-2 rounded-lg border border-slate-200 text-xs w-48 bg-white" />
        <select value={weekF} onChange={(e) => setWeekF(e.target.value)} className={sel}>
          <option value="">{tr("plan_f_all_weeks")}</option>
          {(weeks || []).map((w) => (
            <option key={w.week_start} value={w.week_start}>S{w.iso_week} · {w.week_start}</option>
          ))}
        </select>
        <select value={client} onChange={(e) => setClient(e.target.value)} className={sel}>
          <option value="">{tr("plan_f_all_clients")}</option>
          {clients.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)} className={sel}>
          <option value="">{tr("plan_all_kinds")}</option>
          <option value="REORDEN">{tr("plan_kind_REORDEN_pl")}</option>
          <option value="NUEVA">{tr("plan_kind_NUEVA_pl")}</option>
        </select>
        <select value={readyF} onChange={(e) => setReadyF(e.target.value)} className={sel}>
          <option value="">{tr("plan_f_all_ready")}</option>
          <option value="ready">{tr("plan_f_ready")}</option>
          <option value="blocked">{tr("plan_f_blocked")}</option>
        </select>
        <select value={planF} onChange={(e) => setPlanF(e.target.value)} className={sel}>
          <option value="">{tr("plan_f_all_plan")}</option>
          {["A_TIEMPO", "EN_RIESGO", "VENCIDA", "FUERA_DE_HORIZONTE", "SIN_PROGRAMAR"].map((s) => (
            <option key={s} value={s}>{tr(`plan_status_${s}`)}</option>
          ))}
        </select>
        <select value={vol} onChange={(e) => setVol(e.target.value)} className={sel}>
          <option value="">{tr("plan_f_all_volume")}</option>
          {["ALTO", "MEDIO", "BAJO"].map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <span className="ml-auto text-xs text-slate-600 tabular-nums">
          {tr("plan_week_orders_count", { n: rows.length, total: orders.length, hits: fmt(rows.reduce((a, o) => a + o.remaining, 0)) })}
        </span>
      </div>
      {!run?.run_id && <div className="text-[11px] text-amber-700 mb-2">{tr("plan_week_no_run")}</div>}
      <div className="overflow-auto max-h-[60vh] bg-white rounded-lg border border-slate-200">
        <table className="min-w-full text-xs">
          <thead><tr className="text-left text-[10px] uppercase tracking-wider text-slate-400">
            <th className="py-2 px-2">{tr("plan_order")}</th><th className="px-2">{tr("plan_week")}</th><th className="px-2">{tr("plan_client")}</th>
            <th className="px-2">{tr("plan_kind_col")}</th><th className="px-2 text-right">{tr("plan_qty")}</th>
            <th className="px-2">{tr("plan_positions")}</th><th className="px-2 text-right">{tr("plan_hits_left")}</th>
            <th className="px-2">{tr("plan_cancel")}</th><th className="px-2">{tr("plan_target")}</th>
            <th className="px-2">{tr("plan_board")}</th><th className="px-2">{tr("plan_requirements")}</th>
            <th className="px-2">{tr("plan_machines")}</th><th className="px-2">{tr("plan_start")}</th>
            <th className="px-2">{tr("plan_end")}</th><th className="px-2">{tr("plan_status")}</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 && (
              <tr><td colSpan={15} className="py-6 text-center text-slate-400">{tr("plan_week_none")}</td></tr>
            )}
            {rows.map((o) => (
              <tr key={o.order_id}>
                <td className="py-1.5 px-2 font-black whitespace-nowrap">{o.order_number}</td>
                <td className="px-2 whitespace-nowrap font-bold text-slate-600">S{o.iso_week}</td>
                <td className="px-2 text-slate-500 max-w-[180px] truncate" title={`${o.client} · ${o.branding}`}>
                  {o.client}<span className="text-slate-400"> · {o.branding}</span>
                </td>
                <td className="px-2"><KindBadge kind={o.kind} state={o.sample_state} tr={tr} /></td>
                <td className="px-2 text-right tabular-nums">{fmt(o.quantity)}</td>
                <td className="px-2">{o.positions.join(", ")}</td>
                <td className="px-2 text-right tabular-nums font-bold">{fmt(o.remaining)}</td>
                <td className="px-2 tabular-nums">{o.cancel_date || "—"}</td>
                <td className={`px-2 tabular-nums ${o.overdue ? "text-red-600 font-bold" : ""}`}>{o.target_date || "—"}</td>
                <td className="px-2">{o.board}</td>
                <td className="px-2"><ReadyBadges ready={o.ready} tr={tr} /></td>
                <td className="px-2 whitespace-nowrap">{o.machines.join(", ").replace(/MAQUINA/g, "M") || "—"}</td>
                <td className="px-2 tabular-nums whitespace-nowrap">{o.start ? `${dday(o.start)} ${hhmm(o.start)}` : "—"}</td>
                <td className="px-2 tabular-nums whitespace-nowrap">{o.end ? `${dday(o.end)} ${hhmm(o.end)}` : "—"}</td>
                <td className="px-2">
                  <span className={`px-1.5 py-0.5 rounded border text-[10px] font-bold whitespace-nowrap ${STATUS_STYLE[o.plan] || "bg-slate-50 text-slate-500 border-slate-200"}`}>
                    {tr(`plan_status_${o.plan}`)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/* ── Tiempo extra: modal de captura / edición ──────────────────────────────
   Un solo modal para: agregar a la simulación, editar lo simulado y editar o
   eliminar lo ya guardado en el calendario. Pide día, turno, hora de inicio,
   HORAS que se trabajarán, cuadrillas y nota, y muestra al momento cuántos
   hits agrega (fijo): cuadrillas × hits por turno × horas ÷ horas del turno. */
const OvertimeModal = ({ initial, mode, weekStart, shifts, hitsPerShift, onSave, onDelete, onClose, busy, tr }) => {
  const shiftCfg = (k) => (shifts || []).find((s) => s.key === k) || { start: k === "NOCHE" ? "19:00" : "07:00", hours: 12, crews: 0 };
  const [date, setDate] = useState(initial.date_from);
  const [shift, setShift] = useState(initial.shift === "NOCHE" ? "NOCHE" : "DIA");
  const [start, setStart] = useState(initial.start || shiftCfg(initial.shift === "NOCHE" ? "NOCHE" : "DIA").start);
  const [hours, setHours] = useState(initial.hours || shiftCfg(initial.shift === "NOCHE" ? "NOCHE" : "DIA").hours);
  const [crews, setCrews] = useState(initial.crews ?? shiftCfg("DIA").crews);
  const [note, setNote] = useState(initial.note || "");
  const dayNames = tr("plan_weekday_names").split(",");
  const full = Number(shiftCfg(shift).hours) || 12;
  const hits = Math.round((Number(crews) || 0) * (hitsPerShift || 4500) * (Number(hours) || 0) / full);
  const end = addHours(start, hours);
  const quick = weekStart ? [4, 5, 6].map((k) => addDays(weekStart, k)) : [];
  const valid = date && Number(hours) > 0 && Number(hours) <= 24 && Number(crews) > 0;
  const changeShift = (k) => {
    setShift(k);
    setStart(shiftCfg(k).start);
    setHours(shiftCfg(k).hours);
    setCrews(shiftCfg(k).crews || crews);
  };
  const title = mode === "saved" ? tr("plan_otm_title_saved") : mode === "sim-edit" ? tr("plan_otm_title_sim_edit") : tr("plan_otm_title_new");
  const inp = "h-9 px-2 rounded-lg border border-slate-200 text-sm";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-2">
          <CalendarClock className="w-5 h-5 text-blue-600" />
          <div className="mr-auto">
            <div className="font-black text-slate-900">{title}</div>
            <div className="text-[11px] text-slate-500">
              {mode === "saved" ? tr("plan_otm_saved_hint") : tr("plan_otm_sim_hint")}
            </div>
          </div>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 space-y-4 text-sm">
          <div>
            <div className="text-xs font-bold text-slate-500 mb-1">{tr("plan_otm_day")}</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {quick.map((d) => (
                <button key={d} onClick={() => setDate(d)}
                  className={`px-2.5 h-9 rounded-lg border text-xs font-bold ${date === d ? "bg-blue-600 border-blue-600 text-white" : "bg-white border-slate-200 text-slate-600"}`}>
                  {dayNames[weekdayIdx(d)]} {dday(d)}
                </button>
              ))}
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inp} />
            </div>
          </div>

          <div>
            <div className="text-xs font-bold text-slate-500 mb-1">{tr("plan_shift")}</div>
            <div className="flex gap-1.5">
              {["DIA", "NOCHE"].map((k) => (
                <button key={k} onClick={() => changeShift(k)}
                  className={`px-3 h-9 rounded-lg border text-xs font-bold ${shift === k ? "bg-slate-900 border-slate-900 text-white" : "bg-white border-slate-200 text-slate-600"}`}>
                  {k === "DIA" ? tr("plan_shift_day") : tr("plan_shift_night")}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <label className="text-xs font-bold text-slate-500">{tr("plan_otm_start")}
              <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className={`${inp} w-full mt-1`} /></label>
            <label className="text-xs font-bold text-slate-500">{tr("plan_otm_hours")}
              <input type="number" min={0.5} max={24} step={0.5} value={hours} onChange={(e) => setHours(e.target.value)}
                className={`${inp} w-full mt-1 tabular-nums`} /></label>
            <label className="text-xs font-bold text-slate-500">{tr("plan_crews")}
              <input type="number" min={1} value={crews} onChange={(e) => setCrews(e.target.value)}
                className={`${inp} w-full mt-1 tabular-nums`} /></label>
          </div>
          <div className="text-xs text-slate-600">
            {tr("plan_otm_ends", { time: end.time })}{end.nextDay ? ` ${tr("plan_otm_next_day")}` : ""}
            {Number(hours) < full && <span className="text-slate-400"> · {tr("plan_otm_partial", { h: hours, full })}</span>}
          </div>

          <label className="block text-xs font-bold text-slate-500">{tr("plan_note")}
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr("plan_otm_note_ph")}
              className={`${inp} w-full mt-1`} /></label>

          <div className="rounded-xl bg-blue-50 border border-blue-100 px-3 py-2 text-blue-900">
            {tr("plan_otm_adds", { hits: fmt(hits) })}
            <div className="text-[11px] text-blue-700/80">{tr("plan_otm_formula", { c: crews || 0, per: fmt(hitsPerShift || 4500), h: hours || 0, full })}</div>
          </div>
        </div>

        <div className="px-5 py-4 border-t border-slate-200 flex items-center gap-2">
          {onDelete && (
            <button onClick={onDelete} disabled={busy}
              className="h-9 px-3 rounded-lg border border-red-200 text-red-700 text-sm font-bold inline-flex items-center gap-1.5 hover:bg-red-50 disabled:opacity-50">
              <Trash2 className="w-4 h-4" />{tr("plan_otm_delete")}
            </button>
          )}
          <button onClick={onClose} className="ml-auto h-9 px-3 rounded-lg border border-slate-200 text-sm font-bold">{tr("plan_otm_cancel")}</button>
          <button disabled={!valid || busy}
            onClick={() => onSave({ kind: "overtime", date_from: date, date_to: date, shift, start, hours: Number(hours),
              crews: Number(crews), note: note || tr("plan_ot_note") })}
            className="h-9 px-4 rounded-lg bg-blue-600 text-white text-sm font-bold inline-flex items-center gap-1.5 disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {mode === "saved" ? tr("plan_otm_save_changes") : tr("plan_otm_add")}
          </button>
        </div>
      </div>
    </div>
  );
};

const otLabel = (e, dayNames, tr) => {
  const end = addHours(e.start || (e.shift === "NOCHE" ? "19:00" : "07:00"), e.hours || 12);
  return `${dayNames[weekdayIdx(e.date_from)]} ${dday(e.date_from)} · ${e.shift === "NOCHE" ? tr("plan_shift_night") : tr("plan_shift_day")} ${
    e.start || (e.shift === "NOCHE" ? "19:00" : "07:00")}–${end.time} · ${e.crews} ${tr("plan_crews_short")}`;
};

/* Celda "Turnos extra" de la proyección: lo que falta, lo guardado (✓, clic
   para editar/eliminar), lo simulado (clic para editar, × para quitar) y el
   botón que abre el modal. */
const OvertimeCell = ({ w, savedEntries, simEntries, onOpen, onRemove, busy, tr }) => {
  const dayNames = tr("plan_weekday_names").split(",");
  return (
    <div className="flex flex-col items-end gap-1" onClick={(ev) => ev.stopPropagation()}>
      {w.overtime_shifts_needed ? (
        <span className="text-slate-700">{tr("plan_ot_needed", { n: w.overtime_shifts_needed })}</span>
      ) : <span className="text-slate-300">—</span>}
      {savedEntries.map((e) => (
        <button key={e.cal_id} onClick={() => onOpen({ mode: "saved", entry: e })} title={tr("plan_ot_saved_hint")}
          className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 text-[10px] font-bold whitespace-nowrap hover:ring-2 hover:ring-emerald-200">
          ✓ {otLabel(e, dayNames, tr)}
        </button>
      ))}
      {simEntries.map(({ e, i }) => (
        <span key={i} className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-bold whitespace-nowrap inline-flex items-center gap-1">
          <button onClick={() => onOpen({ mode: "sim-edit", entry: e, index: i })} className="hover:underline">+ {otLabel(e, dayNames, tr)}</button>
          <button onClick={() => onRemove(i)} className="hover:text-red-700" title={tr("plan_ot_remove")}><X className="w-3 h-3" /></button>
        </span>
      ))}
      <button onClick={() => onOpen({ mode: "new", entry: { date_from: addDays(w.week_start, 4), shift: "DIA" } })} disabled={busy}
        className="px-2 h-6 rounded border border-dashed border-blue-300 text-blue-700 text-[11px] font-bold hover:bg-blue-50 disabled:opacity-50">
        {tr("plan_ot_add")}
      </button>
    </div>
  );
};

const ProjectionTab = ({ canEdit, run, onCalendarSaved, calendar, hitsPerShift, tr }) => {
  const [otModal, setOtModal] = useState(null);
  const [otBusy, setOtBusy] = useState(false);
  const [weekF, setWeekF] = useState("");
  const listRef = useRef(null);
  const pickWeek = (ws) => {
    setWeekF(weekF === ws ? "" : ws);
    setTimeout(() => listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [scenario, setScenario] = useState([]);
  const [draft, setDraft] = useState({ kind: "overtime", date_from: "", date_to: "", shift: "DIA", crews: 9 });

  const load = useCallback(async (entries) => {
    setLoading(true);
    try {
      const d = entries && entries.length
        ? await planner("/projection/simulate", { method: "POST", body: JSON.stringify({ entries }) })
        : await planner("/projection");
      setData(d);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(scenario); }, [load, scenario]);

  const addScenario = () => {
    if (!draft.date_from) return toast.error(tr("plan_need_date"));
    setScenario([...scenario, { ...draft, date_to: draft.date_to || draft.date_from }]);
  };
  const [savingSim, setSavingSim] = useState(false);
  // Modal de tiempo extra: nuevo → simulación; sim-edit → reemplaza en la
  // simulación; saved → PUT/DELETE al calendario y recalcula todo.
  const saveOt = async (entry) => {
    if (!otModal) return;
    if (otModal.mode === "new") setScenario([...scenario, entry]);
    else if (otModal.mode === "sim-edit") setScenario(scenario.map((e, k) => (k === otModal.index ? entry : e)));
    else {
      setOtBusy(true);
      try {
        await planner(`/calendar/${otModal.entry.cal_id}`, { method: "PUT", body: JSON.stringify(entry) });
        toast.success(tr("plan_otm_updated"));
        await load(scenario);
        if (onCalendarSaved) onCalendarSaved();
      } catch (e) { toast.error(e.message); setOtBusy(false); return; }
      setOtBusy(false);
    }
    setOtModal(null);
  };
  const deleteOt = async () => {
    if (!otModal) return;
    if (otModal.mode === "sim-edit") {
      setScenario(scenario.filter((_, k) => k !== otModal.index));
      setOtModal(null);
      return;
    }
    if (!window.confirm(tr("plan_otm_confirm_delete"))) return;
    setOtBusy(true);
    try {
      await planner(`/calendar/${otModal.entry.cal_id}`, { method: "DELETE" });
      toast.success(tr("plan_otm_deleted"));
      await load(scenario);
      if (onCalendarSaved) onCalendarSaved();
      setOtModal(null);
    } catch (e) { toast.error(e.message); } finally { setOtBusy(false); }
  };
  // La simulación pasa a ser real: cada excepción se guarda en el calendario.
  const saveScenario = async () => {
    if (!window.confirm(tr("plan_ot_confirm_save", { n: scenario.length }))) return;
    setSavingSim(true);
    try {
      for (const e of scenario) {
        await planner("/calendar", { method: "POST", body: JSON.stringify(e) });
      }
      toast.success(tr("plan_ot_saved"));
      setScenario([]);
      if (onCalendarSaved) onCalendarSaved();
    } catch (e) { toast.error(e.message); } finally { setSavingSim(false); }
  };

  if (loading && !data) return <div className="py-20 flex justify-center"><Loader2 className="w-7 h-7 animate-spin text-blue-600" /></div>;
  if (!data) return null;
  const hasReal = data.run_rates != null;
  const hist = data.efficiency?.measured || {};
  const rr = data.run_rates?.rates || {};
  const ph = data.productive_hours || 11.06;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label={tr("plan_cap_crew_shift")} value={fmt(data.capacity_per_crew_shift)} />
        <Card className="px-4 py-3">
          <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{tr("plan_cap_crew_shift_real")}</div>
          {hasReal ? (
            <div className="text-xs font-bold tabular-nums text-violet-700 leading-snug mt-1">
              {["BAJO", "MEDIO", "ALTO"].filter((v) => rr[v]).map((v) => (
                <div key={v}>{tr(`plan_run_${v}`)}: <b className="text-sm">{fmt(rr[v] * ph)}</b></div>
              ))}
            </div>
          ) : <div className="text-2xl font-black text-slate-300">—</div>}
        </Card>
        <Stat label={tr("plan_weekly_real")} value={fmt(hist.weekly_avg)} color="text-violet-700" />
        <Stat label={tr("plan_efficiency")} value={`${Math.round((data.efficiency?.applied || 0) * 100)}%`} />
        <Stat label={tr("plan_overdue_demand")} value={fmt(data.overdue?.demand)} color="text-red-600" />
        <Stat label={tr("plan_active_machines")} value={fmt(data.active_machines)} />
      </div>
      {hasReal && (
        <div className="text-xs text-slate-500 space-y-0.5">
          <div>{tr("plan_hist_runs", {
            b: fmt(rr.BAJO), m: fmt(rr.MEDIO), a: fmt(rr.ALTO), h: ph,
            hb: fmt(data.run_rates.hours?.BAJO), hm: fmt(data.run_rates.hours?.MEDIO), ha: fmt(data.run_rates.hours?.ALTO) })}</div>
          <div>{tr("plan_hist_how")}</div>
          {hist.weekly_avg != null && <div>{tr("plan_hist_weekly", { hits: fmt(hist.weekly_avg), w: hist.weeks })}</div>}
        </div>
      )}

      <Card className="p-4">
        <SectionTitle hint={tr("plan_proj_hint")}>{tr("plan_proj_title")}</SectionTitle>
        {scenario.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm text-amber-900">
            <FlaskConical className="w-4 h-4" />
            <b>{tr("plan_ot_sim_banner", { n: scenario.length })}</b>
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            <span className="ml-auto flex gap-2">
              {canEdit && (
                <button onClick={saveScenario} disabled={savingSim}
                  className="h-8 px-3 rounded-lg bg-emerald-600 text-white text-xs font-bold inline-flex items-center gap-1 disabled:opacity-50">
                  <Save className="w-3.5 h-3.5" />{tr("plan_ot_save")}
                </button>
              )}
              <button onClick={() => setScenario([])} className="h-8 px-3 rounded-lg border border-amber-300 bg-white text-xs font-bold">{tr("plan_ot_discard")}</button>
            </span>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-400">
              <th className="py-2 pr-3">{tr("plan_week")}</th>
              <th className="pr-3 text-right">{tr("plan_capacity")}</th>
              {hasReal && <th className="pr-3 text-right text-violet-500">{tr("plan_capacity_real")}</th>}
              <th className="pr-3 text-right">{tr("plan_demand")}</th>
              <th className="pr-3 text-right">{tr("plan_demand_ready")}</th>
              <th className="pr-3 text-right">{tr("plan_delta")}</th>
              <th className="pr-3 text-right">{tr("plan_cumulative")}</th>
              {hasReal && <th className="pr-3 text-right text-violet-500">{tr("plan_cumulative_real")}</th>}
              <th className="pr-3 text-right">{tr("plan_overtime_needed")}</th>
              <th className="pr-3">{tr("plan_hire_day")}</th>
              <th className="pr-3">{tr("plan_hire_night")}</th>
              <th>{tr("plan_holidays")}</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.weeks.map((w) => {
                const neg = w.cumulative_delta < 0;
                const hd = w.hires?.DIA || {};
                const hn = w.hires?.NOCHE || {};
                return (
                  <Fragment key={w.week_start}>
                  <tr onClick={() => pickWeek(w.week_start)}
                    className={`cursor-pointer hover:bg-blue-50/50 ${weekF === w.week_start ? "bg-blue-50/60" : neg ? "bg-red-50/40" : ""}`}
                    title={tr("plan_week_click")}>
                    <td className="py-2 pr-3 whitespace-nowrap align-top">
                      <span className="font-black text-blue-700 underline decoration-dotted">S{w.iso_week}</span> <span className="text-xs text-slate-400">{w.week_start}</span>
                      <span className="ml-1 text-[10px] text-slate-400">({(w.jobs || []).length ? new Set(w.jobs.map((j) => j.order_id)).size : 0})</span>
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${w.week_type === "CORTA"
                          ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600"}`}
                          title={(w.holidays || []).map((h) => `${h.date} ${h.name}`).join(", ")}>
                          {tr(w.week_type === "CORTA" ? "plan_week_short" : "plan_week_regular", { n: w.business_days })}
                        </span>
                        {w.days_left < w.business_days && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-50 text-blue-700">
                            {tr("plan_days_left", { n: w.days_left })}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="pr-3 text-right tabular-nums">{fmt(w.capacity)}</td>
                    {hasReal && (
                      <td className="pr-3 text-right tabular-nums text-violet-700"
                        title={tr("plan_hist_cell", { r: fmt(w.hist_rate), s: fmt((w.hist_rate || 0) * ph) })}>
                        {fmt(w.capacity_real)}
                      </td>
                    )}
                    <td className="pr-3 text-right tabular-nums font-bold">{fmt(w.demand)}</td>
                    <td className="pr-3 text-right tabular-nums text-slate-500">{fmt(w.demand_ready)}</td>
                    <td className={`pr-3 text-right tabular-nums font-bold ${w.delta < 0 ? "text-red-600" : "text-emerald-600"}`}>{fmt(w.delta)}</td>
                    <td className={`pr-3 text-right tabular-nums font-bold ${neg ? "text-red-600" : "text-emerald-600"}`}>{fmt(w.cumulative_delta)}</td>
                    {hasReal && (
                      <td className={`pr-3 text-right tabular-nums font-bold ${w.cumulative_delta_real < 0 ? "text-red-600" : "text-emerald-600"}`}
                        title={tr("plan_delta_real_week", { n: fmt(w.delta_real) })}>
                        {fmt(w.cumulative_delta_real)}
                      </td>
                    )}
                    <td className="pr-3 text-right tabular-nums align-top">
                      <OvertimeCell w={w} busy={loading}
                        savedEntries={(calendar || []).filter((e) => e.kind === "overtime"
                          && e.date_from >= w.week_start && e.date_from <= addDays(w.week_start, 6))}
                        simEntries={scenario.map((e, i) => ({ e, i })).filter(({ e }) => e.kind === "overtime"
                          && e.date_from >= w.week_start && e.date_from <= addDays(w.week_start, 6))}
                        onOpen={(m) => (canEdit || m.mode !== "saved" ? setOtModal({ ...m, weekStart: w.week_start }) : null)}
                        onRemove={(i) => setScenario(scenario.filter((_, k) => k !== i))} tr={tr} />
                    </td>
                    <td className="pr-3 text-xs">{hd.crews_needed ? tr("plan_hire_cell", { c: hd.crews_possible, p: hd.people, free: hd.free_machines }) : "—"}</td>
                    <td className="pr-3 text-xs">{hn.crews_needed ? tr("plan_hire_cell", { c: hn.crews_possible, p: hn.people, free: hn.free_machines }) : "—"}</td>
                    <td className="text-xs text-slate-500">{(w.holidays || []).map((h) => `${dday(h.date)} ${h.name}`).join(", ")}</td>
                  </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {otModal && (
        <OvertimeModal initial={otModal.entry} mode={otModal.mode} weekStart={otModal.weekStart}
          shifts={data.shifts} hitsPerShift={hitsPerShift} busy={otBusy}
          onSave={saveOt} onDelete={otModal.mode === "new" ? null : deleteOt}
          onClose={() => setOtModal(null)} tr={tr} />
      )}

      <div ref={listRef}>
        <Card className="p-4">
          <SectionTitle hint={tr("plan_orders_hint")}>{tr("plan_orders_title")}</SectionTitle>
          <WeekOrders weeks={data.weeks} run={run} weekF={weekF} setWeekF={setWeekF} tr={tr} />
        </Card>
      </div>

      <Card className="p-4">
        <SectionTitle hint={tr("plan_sim_hint")}><FlaskConical className="w-4 h-4 inline -mt-0.5 mr-1" />{tr("plan_sim_title")}</SectionTitle>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-500">{tr("plan_kind")}<br />
            <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })} className="h-9 px-2 rounded-lg border border-slate-200 text-sm">
              <option value="overtime">{tr("plan_kind_overtime")}</option>
              <option value="crews">{tr("plan_kind_crews")}</option>
              <option value="holiday">{tr("plan_kind_holiday")}</option>
            </select></label>
          <label className="text-xs text-slate-500">{tr("plan_from_date")}<br />
            <input type="date" value={draft.date_from} onChange={(e) => setDraft({ ...draft, date_from: e.target.value })} className="h-9 px-2 rounded-lg border border-slate-200 text-sm" /></label>
          <label className="text-xs text-slate-500">{tr("plan_to_date")}<br />
            <input type="date" value={draft.date_to} onChange={(e) => setDraft({ ...draft, date_to: e.target.value })} className="h-9 px-2 rounded-lg border border-slate-200 text-sm" /></label>
          <label className="text-xs text-slate-500">{tr("plan_shift")}<br />
            <select value={draft.shift} onChange={(e) => setDraft({ ...draft, shift: e.target.value })} className="h-9 px-2 rounded-lg border border-slate-200 text-sm">
              <option value="DIA">{tr("plan_shift_day")}</option><option value="NOCHE">{tr("plan_shift_night")}</option><option value="AMBOS">{tr("plan_shift_both")}</option>
            </select></label>
          {draft.kind !== "holiday" && (
            <label className="text-xs text-slate-500">{tr("plan_crews")}<br />
              <NumberInput value={draft.crews} min={0} onChange={(v) => setDraft({ ...draft, crews: v })} className="w-20" /></label>
          )}
          <button onClick={addScenario} className="h-9 px-3 rounded-lg bg-slate-900 text-white text-sm font-bold inline-flex items-center gap-1"><Plus className="w-4 h-4" />{tr("plan_add_to_sim")}</button>
          {scenario.length > 0 && (
            <button onClick={() => setScenario([])} className="h-9 px-3 rounded-lg border border-slate-200 text-sm font-bold">{tr("plan_clear_sim")}</button>
          )}
          {loading && <Loader2 className="w-4 h-4 animate-spin text-blue-600 mb-2" />}
        </div>
        {scenario.length > 0 && (
          <ul className="mt-3 text-xs text-slate-600 space-y-1">
            {scenario.map((e, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-700 font-bold">{tr(`plan_kind_${e.kind}`)}</span>
                {e.date_from}{e.date_to !== e.date_from ? ` → ${e.date_to}` : ""} · {e.shift}{e.kind !== "holiday" ? ` · ${e.crews} ${tr("plan_crews").toLowerCase()}` : ""}
                <button onClick={() => setScenario(scenario.filter((_, k) => k !== i))} className="text-slate-400 hover:text-red-600"><Trash2 className="w-3.5 h-3.5" /></button>
              </li>
            ))}
            <li className="text-amber-700 font-bold">{tr("plan_sim_not_saved")}</li>
          </ul>
        )}
        {!canEdit && <p className="text-xs text-slate-400 mt-2">{tr("plan_sim_anyone")}</p>}
      </Card>
    </div>
  );
};

/* ── Máquinas y turnos ───────────────────────────────────────────────────── */
const MachinesTab = ({ cfgData, canEdit, onSaved, tr }) => {
  const [shifts, setShifts] = useState(cfgData.config.shifts);
  const [people, setPeople] = useState(cfgData.config.people_per_crew);
  const [weekdays, setWeekdays] = useState(cfgData.config.base_weekdays);
  const [rows, setRows] = useState(cfgData.machines);
  const [saving, setSaving] = useState(false);
  const [minHeads, maxHeads] = cfgData.heads_range || [8, 16];
  const dayNames = tr("plan_weekday_names").split(",");

  useEffect(() => {
    setShifts(cfgData.config.shifts);
    setPeople(cfgData.config.people_per_crew);
    setWeekdays(cfgData.config.base_weekdays);
    setRows(cfgData.machines);
  }, [cfgData]);

  const saveShifts = async () => {
    setSaving(true);
    try {
      await planner("/config", { method: "PUT", body: JSON.stringify({ shifts, people_per_crew: people, base_weekdays: weekdays }) });
      toast.success(tr("plan_saved"));
      onSaved();
    } catch (e) { toast.error(e.message); } finally { setSaving(false); }
  };

  const saveMachine = async (m, patch) => {
    try {
      await planner(`/machines/${m.machine}`, { method: "PUT", body: JSON.stringify(patch) });
      toast.success(tr("plan_machine_saved", { m: m.machine }));
      onSaved();
    } catch (e) { toast.error(e.message); }
  };

  const [busyMachine, setBusyMachine] = useState(false);
  const addMachine = async () => {
    const next = (rows.reduce((mx, m) => Math.max(mx, m.number || 0), 0)) + 1;
    const name = `MAQUINA${next}`;
    setBusyMachine(true);
    try {
      await configApi("/boards", { method: "POST", body: JSON.stringify({ name }) });
      toast.success(tr("plan_machine_added", { m: name }));
      onSaved();
    } catch (e) { toast.error(e.message); } finally { setBusyMachine(false); }
  };
  const deleteMachine = async (m) => {
    if (!window.confirm(tr("plan_machine_delete_confirm", { m: m.machine }))) return;
    setBusyMachine(true);
    try {
      await configApi(`/boards/${encodeURIComponent(m.machine)}`, { method: "DELETE" });
      // Limpia los ajustes del planner (cabezas, cliente, activa) para que una
      // máquina recreada con el mismo nombre no herede valores viejos.
      await planner(`/machines/${encodeURIComponent(m.machine)}`, { method: "DELETE" }).catch(() => {});
      toast.success(tr("plan_machine_deleted", { m: m.machine }));
      onSaved();
    } catch (e) { toast.error(e.message); } finally { setBusyMachine(false); }
  };

  const active = rows.filter((m) => m.active).length;
  return (
    <div className="space-y-5">
      <Card className="p-4">
        <SectionTitle hint={tr("plan_shifts_hint")}>{tr("plan_shifts_title")}</SectionTitle>
        <div className="grid md:grid-cols-2 gap-4">
          {shifts.map((s, i) => (
            <div key={s.key} className="border border-slate-200 rounded-xl p-3">
              <div className="font-black text-slate-800 mb-2">{s.key === "DIA" ? tr("plan_shift_day") : tr("plan_shift_night")}</div>
              <div className="flex flex-wrap gap-3 text-xs text-slate-500">
                <label>{tr("plan_start_time")}<br />
                  <input type="time" value={s.start} disabled={!canEdit}
                    onChange={(e) => setShifts(shifts.map((x, k) => (k === i ? { ...x, start: e.target.value } : x)))}
                    className="h-9 px-2 rounded-lg border border-slate-200 text-sm" /></label>
                <label>{tr("plan_hours")}<br />
                  <NumberInput value={s.hours} min={1} max={24} disabled={!canEdit} className="w-20"
                    onChange={(v) => setShifts(shifts.map((x, k) => (k === i ? { ...x, hours: v } : x)))} /></label>
                <label>{tr("plan_crews")}<br />
                  <NumberInput value={s.crews} min={0} disabled={!canEdit} className="w-20"
                    onChange={(v) => setShifts(shifts.map((x, k) => (k === i ? { ...x, crews: v } : x)))} /></label>
              </div>
              {s.crews > active && <div className="text-[11px] text-amber-600 mt-2">{tr("plan_crews_over_machines", { n: active })}</div>}
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-4 mt-4">
          <label className="text-xs text-slate-500">{tr("plan_people_per_crew")}<br />
            <NumberInput value={people} min={1} disabled={!canEdit} onChange={setPeople} className="w-20" /></label>
          <div className="text-xs text-slate-500">{tr("plan_base_days")}<br />
            <div className="flex gap-1 mt-0.5">
              {dayNames.map((n, d) => (
                <button key={d} disabled={!canEdit}
                  onClick={() => setWeekdays(weekdays.includes(d) ? weekdays.filter((x) => x !== d) : [...weekdays, d].sort())}
                  className={`w-9 h-9 rounded-lg border text-xs font-bold ${weekdays.includes(d)
                    ? "bg-blue-600 border-blue-600 text-white" : "bg-white border-slate-200 text-slate-500"}`}>{n}</button>
              ))}
            </div>
          </div>
          {canEdit && (
            <button onClick={saveShifts} disabled={saving}
              className="h-9 px-4 rounded-lg bg-blue-600 text-white text-sm font-bold inline-flex items-center gap-2 disabled:opacity-60">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}{tr("plan_save")}
            </button>
          )}
        </div>
      </Card>

      <Card className="p-4">
        <div className="flex items-start justify-between gap-3">
          <SectionTitle hint={tr("plan_machines_hint", { min: minHeads, max: maxHeads })}>
            {tr("plan_machines_title")} · {tr("plan_active_of", { a: active, n: rows.length })}
          </SectionTitle>
          {canEdit && (
            <button onClick={addMachine} disabled={busyMachine}
              className="shrink-0 h-9 px-3 rounded-lg bg-blue-600 text-white text-sm font-bold inline-flex items-center gap-2 disabled:opacity-60">
              {busyMachine ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}{tr("plan_add_machine")}
            </button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-400">
              <th className="py-2 pr-3">{tr("plan_machine")}</th><th className="pr-3">{tr("plan_active")}</th>
              <th className="pr-3">{tr("plan_heads")}</th><th className="pr-3">{tr("plan_pref_client")}</th>
              <th className="pr-3">{tr("plan_pallet")}</th><th className="pr-3">{tr("plan_folder")}</th>
              <th className="pr-3">{tr("plan_notes")}</th><th />
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((m, i) => (
                <tr key={m.machine} className={m.active ? "" : "opacity-50"}>
                  <td className="py-2 pr-3 font-black">{m.machine}</td>
                  <td className="pr-3">
                    <input type="checkbox" checked={!!m.active} disabled={!canEdit}
                      onChange={(e) => saveMachine(m, { active: e.target.checked })} className="w-4 h-4" />
                  </td>
                  <td className="pr-3">
                    <NumberInput value={m.heads} min={minHeads} max={maxHeads} disabled={!canEdit} className="w-20"
                      onChange={(v) => setRows(rows.map((x, k) => (k === i ? { ...x, heads: v } : x)))} />
                  </td>
                  <td className="pr-3">
                    <input value={m.preferred_client || ""} disabled={!canEdit} placeholder={tr("plan_any_client")}
                      onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, preferred_client: e.target.value } : x)))}
                      className="h-9 px-2 rounded-lg border border-slate-200 text-sm w-44" />
                    <label className="ml-2 inline-flex items-center gap-1 text-[11px] text-slate-500 align-middle" title={tr("plan_dedicated_hint")}>
                      <input type="checkbox" checked={!!m.dedicated} disabled={!canEdit}
                        onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, dedicated: e.target.checked } : x)))} className="w-3.5 h-3.5" />
                      {tr("plan_dedicated")}
                    </label>
                  </td>
                  <td className="pr-3">
                    <input value={m.pallet_size || ""} disabled={!canEdit} placeholder={tr("plan_pallet_ph")}
                      onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, pallet_size: e.target.value } : x)))}
                      className="h-9 px-2 rounded-lg border border-slate-200 text-sm w-28" />
                  </td>
                  <td className="pr-3 text-center">
                    <input type="checkbox" checked={!!m.has_folder} disabled={!canEdit}
                      onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, has_folder: e.target.checked } : x)))} className="w-4 h-4" />
                  </td>
                  <td className="pr-3">
                    <input value={m.notes || ""} disabled={!canEdit}
                      onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, notes: e.target.value } : x)))}
                      className="h-9 px-2 rounded-lg border border-slate-200 text-sm w-56" />
                  </td>
                  <td>
                    {canEdit && (
                      <div className="inline-flex items-center gap-1.5">
                      <button onClick={() => saveMachine(m, { heads: m.heads, preferred_client: m.preferred_client || "", dedicated: !!m.dedicated, notes: m.notes || "", pallet_size: m.pallet_size || "", has_folder: !!m.has_folder })}
                        className="h-8 px-3 rounded-lg border border-slate-200 text-xs font-bold hover:border-blue-300 inline-flex items-center gap-1">
                        <Save className="w-3.5 h-3.5" />{tr("plan_save")}
                      </button>
                      <button onClick={() => deleteMachine(m)} disabled={busyMachine} title={tr("plan_machine_delete")}
                        className="h-8 px-2 rounded-lg border border-slate-200 text-red-600 hover:border-red-300 hover:bg-red-50 inline-flex items-center disabled:opacity-60">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
};

/* ── Calendario ──────────────────────────────────────────────────────────── */
const CalendarTab = ({ cfgData, canEdit, onSaved, tr }) => {
  const [editing, setEditing] = useState(null);
  const [editBusy, setEditBusy] = useState(false);
  const saveEdit = async (entry) => {
    setEditBusy(true);
    try {
      await planner(`/calendar/${editing.cal_id}`, { method: "PUT", body: JSON.stringify(entry) });
      toast.success(tr("plan_otm_updated"));
      setEditing(null);
      onSaved();
    } catch (e) { toast.error(e.message); } finally { setEditBusy(false); }
  };
  const [year, setYear] = useState(new Date().getFullYear());
  const [hol, setHol] = useState(null);
  const [draft, setDraft] = useState({ kind: "overtime", date_from: "", date_to: "", shift: "DIA", crews: 9, note: "" });

  useEffect(() => {
    planner(`/holidays?year=${year}`).then(setHol).catch((e) => toast.error(e.message));
  }, [year]);

  const add = async () => {
    if (!draft.date_from) return toast.error(tr("plan_need_date"));
    try {
      await planner("/calendar", { method: "POST", body: JSON.stringify({ ...draft, date_to: draft.date_to || draft.date_from }) });
      toast.success(tr("plan_saved"));
      setDraft({ ...draft, date_from: "", date_to: "", note: "" });
      onSaved();
    } catch (e) { toast.error(e.message); }
  };
  const remove = async (id) => {
    if (!window.confirm(tr("plan_otm_confirm_delete"))) return;
    try { await planner(`/calendar/${id}`, { method: "DELETE" }); onSaved(); } catch (e) { toast.error(e.message); }
  };

  return (
    <div className="grid lg:grid-cols-3 gap-5">
      {editing && (
        <OvertimeModal initial={editing} mode="saved" weekStart={addDays(editing.date_from, -weekdayIdx(editing.date_from))}
          shifts={cfgData.config.shifts} hitsPerShift={cfgData.config.hits_per_shift} busy={editBusy}
          onSave={saveEdit} onDelete={async () => { await remove(editing.cal_id); setEditing(null); }}
          onClose={() => setEditing(null)} tr={tr} />
      )}
      <Card className="p-4 lg:col-span-2">
        <SectionTitle hint={tr("plan_cal_hint")}>{tr("plan_cal_title")}</SectionTitle>
        {canEdit && (
          <div className="flex flex-wrap items-end gap-2 mb-4">
            <label className="text-xs text-slate-500">{tr("plan_kind")}<br />
              <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })} className="h-9 px-2 rounded-lg border border-slate-200 text-sm">
                <option value="overtime">{tr("plan_kind_overtime")}</option>
                <option value="crews">{tr("plan_kind_crews")}</option>
                <option value="holiday">{tr("plan_kind_holiday")}</option>
                <option value="workday">{tr("plan_kind_workday")}</option>
              </select></label>
            <label className="text-xs text-slate-500">{tr("plan_from_date")}<br />
              <input type="date" value={draft.date_from} onChange={(e) => setDraft({ ...draft, date_from: e.target.value })} className="h-9 px-2 rounded-lg border border-slate-200 text-sm" /></label>
            <label className="text-xs text-slate-500">{tr("plan_to_date")}<br />
              <input type="date" value={draft.date_to} onChange={(e) => setDraft({ ...draft, date_to: e.target.value })} className="h-9 px-2 rounded-lg border border-slate-200 text-sm" /></label>
            <label className="text-xs text-slate-500">{tr("plan_shift")}<br />
              <select value={draft.shift} onChange={(e) => setDraft({ ...draft, shift: e.target.value })} className="h-9 px-2 rounded-lg border border-slate-200 text-sm">
                <option value="DIA">{tr("plan_shift_day")}</option><option value="NOCHE">{tr("plan_shift_night")}</option><option value="AMBOS">{tr("plan_shift_both")}</option>
              </select></label>
            {(draft.kind === "overtime" || draft.kind === "crews") && (
              <label className="text-xs text-slate-500">{tr("plan_crews")}<br />
                <NumberInput value={draft.crews} min={0} onChange={(v) => setDraft({ ...draft, crews: v })} className="w-20" /></label>
            )}
            <label className="text-xs text-slate-500">{tr("plan_note")}<br />
              <input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} className="h-9 px-2 rounded-lg border border-slate-200 text-sm w-48" /></label>
            <button onClick={add} className="h-9 px-3 rounded-lg bg-blue-600 text-white text-sm font-bold inline-flex items-center gap-1"><Plus className="w-4 h-4" />{tr("plan_add")}</button>
          </div>
        )}
        {cfgData.calendar.length === 0 ? <Empty>{tr("plan_cal_empty")}</Empty> : (
          <table className="min-w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-400">
              <th className="py-2 pr-3">{tr("plan_kind")}</th><th className="pr-3">{tr("plan_dates")}</th>
              <th className="pr-3">{tr("plan_shift")}</th><th className="pr-3">{tr("plan_otm_schedule")}</th><th className="pr-3">{tr("plan_crews")}</th>
              <th className="pr-3">{tr("plan_note")}</th><th />
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {cfgData.calendar.map((e) => (
                <tr key={e.cal_id}>
                  <td className="py-2 pr-3"><span className="px-2 py-0.5 rounded bg-slate-100 text-xs font-bold">{tr(`plan_kind_${e.kind}`)}</span></td>
                  <td className="pr-3 tabular-nums text-xs">{e.date_from}{e.date_to !== e.date_from ? ` → ${e.date_to}` : ""}</td>
                  <td className="pr-3 text-xs">{e.shift}</td>
                  <td className="pr-3 text-xs tabular-nums">
                    {e.kind === "overtime" ? (e.hours ? `${e.start || "—"}–${addHours(e.start || "07:00", e.hours).time} (${e.hours} h)` : tr("plan_otm_full_shift")) : "—"}
                  </td>
                  <td className="pr-3 tabular-nums">{e.crews ?? "—"}</td>
                  <td className="pr-3 text-xs text-slate-500">{e.note}</td>
                  <td className="whitespace-nowrap">
                    {canEdit && e.kind === "overtime" && (
                      <button onClick={() => setEditing(e)} className="text-slate-400 hover:text-blue-600 mr-2" title={tr("plan_otm_edit")}><SlidersHorizontal className="w-4 h-4" /></button>
                    )}
                    {canEdit && <button onClick={() => remove(e.cal_id)} className="text-slate-400 hover:text-red-600" title={tr("plan_otm_delete")}><Trash2 className="w-4 h-4" /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <SectionTitle>{tr("plan_official_holidays")}</SectionTitle>
          <div className="ml-auto flex items-center gap-1">
            <button onClick={() => setYear(year - 1)} className="px-2 h-7 rounded border border-slate-200 text-xs">‹</button>
            <span className="text-sm font-bold tabular-nums">{year}</span>
            <button onClick={() => setYear(year + 1)} className="px-2 h-7 rounded border border-slate-200 text-xs">›</button>
          </div>
        </div>
        <ul className="text-sm divide-y divide-slate-100">
          {(hol?.official || []).map((h) => (
            <li key={h.date} className="py-1.5 flex justify-between gap-2"><span className="tabular-nums text-slate-500">{h.date}</span><span className="text-right">{h.name}</span></li>
          ))}
        </ul>
        <p className="text-[11px] text-slate-400 mt-3">{tr("plan_official_hint")}</p>
      </Card>
    </div>
  );
};

/* ── Reglas ──────────────────────────────────────────────────────────────── */
const RULE_FIELDS = [
  ["hits_per_shift", "plan_r_hits_per_shift"],
  ["rate_pph", "plan_r_rate_pph"],
  ["setup_min_per_color", "plan_r_setup"],
  ["default_colors", "plan_r_default_colors"],
  ["buffer_business_days", "plan_r_buffer"],
  ["volume_low_max", "plan_r_low"],
  ["volume_high_min", "plan_r_high"],
  ["horizon_weeks", "plan_r_horizon"],
  ["printed_complete_pct", "plan_r_printed_pct"],
  ["printed_alert_days", "plan_r_alert_days"],
];
const LIST_FIELDS = [
  ["ready_blank_statuses", "plan_r_ready_blank"],
  ["ready_production_statuses", "plan_r_ready_prod"],
  ["demand_boards", "plan_r_demand_boards"],
  ["printed_statuses", "plan_r_printed"],
  ["sample_reorder_values", "plan_r_sample_reorder"],
  ["sample_required_values", "plan_r_sample_required"],
  ["sample_approved_values", "plan_r_sample_approved"],
  ["sample_at_machine_values", "plan_r_sample_machine"],
  ["sample_hold_values", "plan_r_sample_hold"],
  ["sample_ok_values", "plan_r_sample_ok"],
  ["extra_work_ignore", "plan_r_extra_ignore"],
];

const RulesTab = ({ cfgData, canEdit, onSaved, tr }) => {
  const [form, setForm] = useState(cfgData.config);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setForm(cfgData.config); }, [cfgData]);
  const eff = cfgData.efficiency || {};

  const movePacking = (i, dir) => {
    const arr = [...(form.packing_priority || [])];
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    setForm({ ...form, packing_priority: arr });
  };

  const save = async () => {
    setSaving(true);
    const body = {};
    RULE_FIELDS.forEach(([k]) => { body[k] = form[k]; });
    LIST_FIELDS.forEach(([k]) => { body[k] = form[k]; });
    body.packing_priority = form.packing_priority || [];
    body.ready_require_screens = !!form.ready_require_screens;
    body.ready_require_sample = !!form.ready_require_sample;
    body.efficiency_mode = form.efficiency_mode;
    body.efficiency_manual_pct = form.efficiency_manual_pct;
    body.auto_recalc = !!form.auto_recalc;
    body.auto_recalc_minutes = form.auto_recalc_minutes;
    try {
      await planner("/config", { method: "PUT", body: JSON.stringify(body) });
      toast.success(tr("plan_saved"));
      onSaved();
    } catch (e) { toast.error(e.message); } finally { setSaving(false); }
  };

  return (
    <div className="space-y-5">
      <Card className="p-4">
        <SectionTitle hint={tr("plan_rules_hint")}>{tr("plan_rules_title")}</SectionTitle>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {RULE_FIELDS.map(([k, label]) => (
            <label key={k} className="text-xs text-slate-500">{tr(label)}<br />
              <NumberInput value={form[k]} min={0} disabled={!canEdit} className="w-32"
                onChange={(v) => setForm({ ...form, [k]: v })} /></label>
          ))}
        </div>
      </Card>
      <Card className="p-4">
        <SectionTitle hint={tr("plan_auto_hint")}>{tr("plan_auto_title")}</SectionTitle>
        <div className="flex flex-wrap items-end gap-4 text-xs text-slate-500">
          <label className="flex items-center gap-2 text-sm text-slate-700 pb-2">
            <input type="checkbox" checked={!!form.auto_recalc} disabled={!canEdit}
              onChange={(e) => setForm({ ...form, auto_recalc: e.target.checked })} className="w-4 h-4" />
            {tr("plan_auto_enable")}
          </label>
          <label>{tr("plan_auto_minutes")}<br />
            <NumberInput value={form.auto_recalc_minutes} min={1} max={240} disabled={!canEdit || !form.auto_recalc}
              className="w-24" onChange={(v) => setForm({ ...form, auto_recalc_minutes: v })} /></label>
        </div>
      </Card>
      <Card className="p-4">
        <SectionTitle hint={tr("plan_packing_hint")}>{tr("plan_packing_title")}</SectionTitle>
        <ol className="space-y-1.5 max-w-xs">
          {(form.packing_priority || []).map((p, i) => (
            <li key={p} className="flex items-center gap-2 text-sm">
              <span className="w-5 text-slate-400 tabular-nums">{i + 1}</span>
              <span className="font-bold flex-1">{p}</span>
              {canEdit && (
                <span className="inline-flex gap-1">
                  <button onClick={() => movePacking(i, -1)} disabled={i === 0}
                    className="w-7 h-7 rounded-lg border border-slate-200 text-slate-600 disabled:opacity-30 hover:border-blue-300">↑</button>
                  <button onClick={() => movePacking(i, 1)} disabled={i === (form.packing_priority || []).length - 1}
                    className="w-7 h-7 rounded-lg border border-slate-200 text-slate-600 disabled:opacity-30 hover:border-blue-300">↓</button>
                </span>
              )}
            </li>
          ))}
        </ol>
      </Card>
      <Card className="p-4">
        <SectionTitle hint={tr("plan_eff_hint")}>{tr("plan_efficiency")}</SectionTitle>
        <div className="flex flex-wrap items-end gap-4 text-xs text-slate-500">
          <label>{tr("plan_eff_mode")}<br />
            <select value={form.efficiency_mode} disabled={!canEdit} onChange={(e) => setForm({ ...form, efficiency_mode: e.target.value })}
              className="h-9 px-2 rounded-lg border border-slate-200 text-sm">
              <option value="manual">{tr("plan_eff_manual")}</option>
              <option value="auto">{tr("plan_eff_auto")}</option>
            </select></label>
          {form.efficiency_mode === "manual" && (
            <label>{tr("plan_eff_pct")}<br />
              <NumberInput value={form.efficiency_manual_pct} min={1} max={150} disabled={!canEdit} className="w-24"
                onChange={(v) => setForm({ ...form, efficiency_manual_pct: v })} /></label>
          )}
          {eff.measured?.value != null && (
            <div className="text-sm text-slate-600 pb-2">
              {tr("plan_eff_measured", { pct: Math.round(eff.measured.value * 100), hits: fmt(eff.measured.median_hits), n: eff.measured.samples })}
            </div>
          )}
        </div>
      </Card>
      <Card className="p-4">
        <SectionTitle hint={tr("plan_ready_hint")}>{tr("plan_ready_title")}</SectionTitle>
        <label className="flex items-center gap-2 text-sm mb-3">
          <input type="checkbox" checked={!!form.ready_require_screens} disabled={!canEdit}
            onChange={(e) => setForm({ ...form, ready_require_screens: e.target.checked })} className="w-4 h-4" />
          {tr("plan_r_require_screens")}
        </label>
        <label className="flex items-center gap-2 text-sm mb-3">
          <input type="checkbox" checked={!!form.ready_require_sample} disabled={!canEdit}
            onChange={(e) => setForm({ ...form, ready_require_sample: e.target.checked })} className="w-4 h-4" />
          {tr("plan_r_require_sample")}
        </label>
        <div className="grid md:grid-cols-2 gap-4">
          {LIST_FIELDS.map(([k, label]) => (
            <label key={k} className="text-xs text-slate-500">{tr(label)}<br />
              <textarea value={(form[k] || []).join(", ")} disabled={!canEdit} rows={2}
                onChange={(e) => setForm({ ...form, [k]: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })}
                className="w-full px-2 py-1.5 rounded-lg border border-slate-200 text-sm" /></label>
          ))}
        </div>
      </Card>
      {canEdit && (
        <button onClick={save} disabled={saving}
          className="h-10 px-5 rounded-xl bg-blue-600 text-white font-bold inline-flex items-center gap-2 disabled:opacity-60">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}{tr("plan_save_rules")}
        </button>
      )}
    </div>
  );
};

/* ── Datos faltantes ─────────────────────────────────────────────────────── */
/* ── Alertas ─────────────────────────────────────────────────────────────── */
const AlertsTab = ({ data, tr }) => {
  if (!data) return <div className="py-20 flex justify-center"><Loader2 className="w-7 h-7 animate-spin text-blue-600" /></div>;
  const rows = data.printed_stale || [];
  return (
    <Card className="p-4">
      <SectionTitle hint={tr("plan_al_hint", { days: data.days, pct: data.pct })}>
        <BellRing className="w-4 h-4 inline -mt-0.5 mr-1 text-red-600" />{tr("plan_al_title")} ({rows.length})
      </SectionTitle>
      {rows.length === 0 ? <Empty>{tr("plan_al_empty")}</Empty> : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-400">
              <th className="py-2 pr-3">{tr("plan_order")}</th><th className="pr-3">{tr("plan_client")}</th>
              <th className="pr-3">{tr("plan_board")}</th><th className="pr-3">{tr("plan_al_status_now")}</th>
              <th className="pr-3 text-right">{tr("plan_al_printed")}</th><th className="pr-3">{tr("plan_al_last_print")}</th>
              <th className="pr-3 text-right">{tr("plan_al_days")}</th><th>{tr("plan_cancel")}</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.order_id}>
                  <td className="py-2 pr-3 font-black">{r.order_number}</td>
                  <td className="pr-3 text-xs text-slate-500">{r.client}</td>
                  <td className="pr-3 text-xs">{r.board}</td>
                  <td className="pr-3"><span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-50 text-amber-700">{r.production_status || "—"}</span></td>
                  <td className="pr-3 text-right tabular-nums text-xs">{fmt(r.made)} / {fmt(r.required)} <b className="text-emerald-600">{r.complete_pct}%</b></td>
                  <td className="pr-3 text-xs tabular-nums">{new Date(r.last_print).toLocaleString("es-MX")}</td>
                  <td className="pr-3 text-right tabular-nums font-black text-red-600">{Math.floor(r.days)}</td>
                  <td className="text-xs tabular-nums">{r.cancel_date || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
};

const DataTab = ({ tr }) => {
  const [data, setData] = useState(null);
  const [flag, setFlag] = useState("");
  useEffect(() => { planner("/data-quality").then(setData).catch((e) => toast.error(e.message)); }, []);
  if (!data) return <div className="py-20 flex justify-center"><Loader2 className="w-7 h-7 animate-spin text-blue-600" /></div>;
  const rows = data.rows.filter((r) => !flag || r.flags.includes(flag));
  return (
    <Card className="p-4">
      <SectionTitle hint={tr("plan_dq_hint", { n: data.default_colors })}>
        {tr("plan_dq_title")} · {tr("plan_dq_count", { n: data.with_issues, total: data.orders_open })}
      </SectionTitle>
      <div className="flex flex-wrap gap-1.5 mb-3">
        <button onClick={() => setFlag("")} className={`px-2.5 py-1 rounded-lg border text-xs font-bold ${!flag ? "bg-slate-900 text-white border-slate-900" : "bg-white border-slate-200"}`}>{tr("plan_all")}</button>
        {Object.entries(data.summary).map(([k, n]) => (
          <button key={k} onClick={() => setFlag(k)} className={`px-2.5 py-1 rounded-lg border text-xs font-bold ${flag === k ? "bg-amber-600 text-white border-amber-600" : "bg-white border-slate-200"}`}>
            {tr(`plan_flag_${k}`)} <span className="opacity-60">{n}</span>
          </button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-400">
            <th className="py-2 pr-3">{tr("plan_order")}</th><th className="pr-3">{tr("plan_client")}</th>
            <th className="pr-3">{tr("plan_board")}</th><th className="pr-3">{tr("plan_cancel")}</th>
            <th className="pr-3 text-right">{tr("plan_qty")}</th><th className="pr-3">{tr("plan_hits")}</th>
            <th className="pr-3">{tr("plan_positions")}</th><th className="pr-3">{tr("plan_colors")}</th><th>{tr("plan_missing")}</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.order_id}>
                <td className="py-1.5 pr-3 font-black">{r.order_number}</td>
                <td className="pr-3 text-xs text-slate-500">{r.client}</td>
                <td className="pr-3 text-xs">{r.board}</td>
                <td className="pr-3 text-xs tabular-nums">{r.cancel_date || "—"}</td>
                <td className="pr-3 text-right tabular-nums">{fmt(r.quantity)}</td>
                <td className="pr-3 tabular-nums">{r.hits ?? "—"}</td>
                <td className="pr-3 text-xs">{(r.positions || []).join(", ") || "—"}</td>
                <td className="pr-3 tabular-nums">{r.colors ?? "—"}</td>
                <td className="text-xs">{r.flags.map((f) => tr(`plan_flag_${f}`)).join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
};

/* ── Dashboard de producción ───────────────────────────────────────────────
   Una sola fuente de verdad: producido, pendiente, capacidad (regular + extra),
   demanda, brecha, envíos por día, Test Orders separadas y excepciones. */
const DashboardTab = ({ tr }) => {
  const [d, setD] = useState(null);
  useEffect(() => { planner("/dashboard").then(setD).catch((e) => toast.error(e.message)); }, []);
  if (!d) return <div className="py-20 flex justify-center"><Loader2 className="w-7 h-7 animate-spin text-blue-600" /></div>;
  const tw = d.this_week, nw = d.next_week, to = d.test_orders, ex = d.exceptions;
  const gcol = (n) => (n < 0 ? "text-red-600" : "text-emerald-600");
  return (
    <div className="space-y-5">
      {!d.overtime_loaded && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{tr("plan_dash_no_ot")}</span>
        </div>
      )}

      <Card className="p-4">
        <SectionTitle hint={tr("plan_dash_unit")}>{tr("plan_dash_this_week")} · {d.week_start}</SectionTitle>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label={tr("plan_dash_produced")} value={fmt(tw.produced)} color="text-violet-700" />
          <Stat label={tr("plan_dash_pending")} value={fmt(tw.pending)} color="text-amber-600" />
          <Stat label={tr("plan_dash_cap_remaining")} value={fmt(tw.capacity)} />
          <Stat label={tr("plan_dash_pull_ahead")} value={fmt(tw.pull_ahead)} color="text-emerald-600" />
        </div>
      </Card>

      <Card className="p-4">
        <SectionTitle>{tr("plan_dash_next_week")}</SectionTitle>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Stat label={tr("plan_dash_cap_regular")} value={fmt(nw.capacity_regular)} />
          <Stat label={tr("plan_dash_cap_ot")} value={fmt(nw.capacity_overtime)} color={nw.capacity_overtime ? "text-slate-900" : "text-slate-300"} />
          <Stat label={tr("plan_dash_cap_total")} value={fmt(nw.capacity)} color="text-blue-600" />
          <Stat label={tr("plan_dash_demand")} value={fmt(nw.demand)} />
          <Stat label={tr("plan_dash_gap")} value={fmt(nw.delta)} color={gcol(nw.delta)} />
        </div>
      </Card>

      <Card className="p-4">
        <SectionTitle hint={tr("plan_dash_test_hint")}>{tr("plan_dash_test")}</SectionTitle>
        <div className="grid grid-cols-3 gap-3 mb-3">
          <Stat label={tr("plan_dash_test_openlbl")} value={fmt(to.open)} />
          <Stat label={tr("plan_dash_test_toprint")} value={fmt(to.to_print)} color="text-amber-600" />
          <Stat label={tr("plan_dash_test_printed")} value={fmt(to.printed_in_process)} color="text-emerald-600" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label={tr("plan_dash_produced")} value={fmt(to.produced)} color="text-violet-700" />
          <Stat label={tr("plan_dash_test_pend_imp")} value={fmt(to.pending)} color="text-amber-600" />
          <Stat label={tr("plan_dash_test_this")} value={fmt(to.pending_this_week)} />
          <Stat label={tr("plan_dash_test_next")} value={fmt(to.pending_next_week)} />
        </div>
      </Card>

      <Card className="p-4">
        <SectionTitle hint={tr("plan_dash_ship_hint")}>{tr("plan_dash_shipments")}</SectionTitle>
        {(d.shipments_by_day || []).length === 0 ? <Empty>{tr("plan_dash_no_ship")}</Empty> : (
          <div className="flex flex-wrap gap-2">
            {d.shipments_by_day.map((s) => (
              <div key={s.date} className="px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm">
                <div className="text-[10px] font-bold uppercase text-slate-400">{s.date}</div>
                <div className="font-black tabular-nums">{fmt(s.impressions)}</div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-4">
        <SectionTitle hint={tr("plan_dash_exc_hint")}>{tr("plan_dash_exceptions")}</SectionTitle>
        <div className="flex flex-wrap gap-2 mb-3 text-xs">
          <span className="px-2.5 py-1 rounded-lg bg-red-50 text-red-700 font-bold">{tr("plan_dash_status_behind", { n: (ex.status_behind || []).length })}</span>
          <span className="px-2.5 py-1 rounded-lg bg-amber-50 text-amber-700 font-bold">{tr("plan_dash_no_capture", { n: (ex.machines_no_capture || []).length })}</span>
          <span className="px-2.5 py-1 rounded-lg bg-slate-100 text-slate-600 font-bold">{tr("plan_dash_no_movement", { n: ex.no_movement_count || 0 })}</span>
        </div>
        {(ex.machines_no_capture || []).length > 0 && (
          <div className="text-xs text-slate-500 mb-3">{tr("plan_dash_no_capture_list")}: {ex.machines_no_capture.join(", ").replace(/MAQUINA/g, "M")}</div>
        )}
        {(ex.status_behind || []).length > 0 && (
          <div className="overflow-auto max-h-[50vh]">
            <table className="min-w-full text-sm">
              <thead className="planner-freeze"><tr className="text-left text-[11px] uppercase tracking-wider text-slate-400">
                <th className="py-2 pr-3">{tr("plan_order")}</th><th className="pr-3">{tr("plan_status")}</th>
                <th className="pr-3">{tr("plan_board")}</th><th className="pr-3 text-right">{tr("plan_dash_pct")}</th>
                <th className="pr-3 text-right">{tr("plan_dash_impressions")}</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {ex.status_behind.map((o) => (
                  <tr key={o.order_number}>
                    <td className="py-1.5 pr-3 font-black">{o.order_number}</td>
                    <td className="pr-3 text-xs">{o.production_status}</td>
                    <td className="pr-3 text-xs">{o.board}</td>
                    <td className="pr-3 text-right tabular-nums">{o.printed_pct}%</td>
                    <td className="pr-3 text-right tabular-nums">{fmt(o.impressions)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
};

/* ── Terminadas de pintar (seguimiento) ────────────────────────────────────
   Órdenes que ya se imprimieron (production_status EN PROCESO DE EMPAQUE) y
   siguen en proceso; se ven con su board/fecha para darles seguimiento. */
const PaintFollowupTab = ({ tr }) => {
  const [data, setData] = useState(null);
  const [q, setQ] = useState("");
  useEffect(() => { planner("/paint-followup").then(setData).catch((e) => toast.error(e.message)); }, []);
  if (!data) return <div className="py-20 flex justify-center"><Loader2 className="w-7 h-7 animate-spin text-blue-600" /></div>;
  const daysSince = (iso) => (iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)) : null);
  const s = q.trim().toLowerCase();
  const rows = (data.orders || []).filter((r) => !s
    || String(r.order_number).toLowerCase().includes(s)
    || String(r.client || "").toLowerCase().includes(s)
    || String(r.customer_po || "").toLowerCase().includes(s));
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <SectionTitle hint={tr("plan_paint_hint")}>{tr("plan_paint_title")} · {tr("plan_paint_count", { n: data.count })}</SectionTitle>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr("plan_search_order_client")}
          className="ml-auto h-8 px-2 rounded-lg border border-slate-200 text-xs w-52" />
      </div>
      <div className="overflow-auto max-h-[70vh]">
        <table className="min-w-full text-sm">
          <thead className="planner-freeze"><tr className="text-left text-[11px] uppercase tracking-wider text-slate-400">
            <th className="py-2 pr-3">{tr("plan_order")}</th><th className="pr-3">{tr("plan_client")}</th>
            <th className="pr-3">{tr("plan_customer_po")}</th><th className="pr-3 text-right">{tr("plan_qty")}</th>
            <th className="pr-3">{tr("plan_board")}</th><th className="pr-3">{tr("plan_paint_done")}</th>
            <th className="pr-3 text-right">{tr("plan_paint_days")}</th><th className="pr-3">{tr("plan_cancel")}</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.order_id}>
                <td className="py-1.5 pr-3 font-black">{r.order_number}</td>
                <td className="pr-3 text-xs text-slate-500">{r.client}</td>
                <td className="pr-3 text-xs">{r.customer_po || "—"}</td>
                <td className="pr-3 text-right tabular-nums">{fmt(r.quantity)}</td>
                <td className="pr-3 text-xs">{r.board}</td>
                <td className="pr-3 text-xs tabular-nums">{r.since ? r.since.slice(0, 10) : "—"}</td>
                <td className="pr-3 text-right tabular-nums">{daysSince(r.since) ?? "—"}</td>
                <td className="pr-3 text-xs tabular-nums">{r.cancel_date || "—"}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8}><Empty>{tr("plan_paint_empty")}</Empty></td></tr>}
          </tbody>
        </table>
      </div>
    </Card>
  );
};

/* ── Página ──────────────────────────────────────────────────────────────── */
/* ── Buscador global del módulo ────────────────────────────────────────────
   Número de orden, PO, cliente, branding o diseño. Por cada orden dice DÓNDE
   está en la planeación: programada (máquina, horario, estatus), bloqueada
   (qué le falta), movimiento propuesto (con Autorizar / Reprogramar), en
   alerta, o fuera de la planeación y por qué (lo contesta /planner/lookup).
   Ctrl+K lo enfoca; Esc lo cierra. */
const GlobalSearch = ({ run, alerts, canEdit, onAdjust, onApply, onGoTab, tr }) => {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [remote, setRemote] = useState([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);
  const boxRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); inputRef.current?.focus(); setOpen(true); }
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onClick); };
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setRemote([]); return undefined; }
    setLoading(true);
    const id = setTimeout(async () => {
      try { setRemote((await planner(`/lookup?q=${encodeURIComponent(term)}`)).rows || []); } catch { setRemote([]); }
      setLoading(false);
    }, 300);
    return () => clearTimeout(id);
  }, [q]);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (term.length < 2) return [];
    const hit = (x) => [x.order_number, x.client, x.branding].some((v) => String(v || "").toLowerCase().includes(term));
    const by = new Map();
    const get = (x) => {
      if (!by.has(x.order_id)) {
        by.set(x.order_id, { order_id: x.order_id, order_number: x.order_number, client: x.client, branding: x.branding,
          cancel_date: x.cancel_date, jobs: [], blocked: [], move: null, alert: null, info: null });
      }
      return by.get(x.order_id);
    };
    (run?.jobs || []).filter(hit).forEach((j) => get(j).jobs.push(j));
    (run?.blocked || []).filter(hit).forEach((b) => get(b).blocked.push(b));
    (run?.moves || []).filter(hit).forEach((m) => { get(m).move = m; });
    (alerts || []).filter(hit).forEach((a) => { get(a).alert = a; });
    remote.forEach((r) => { const o = get(r); o.info = r; o.cancel_date = o.cancel_date || r.cancel_date; o.branding = o.branding || r.branding; });
    return [...by.values()].sort((a, b) => String(b.order_number).localeCompare(String(a.order_number), undefined, { numeric: true })).slice(0, 25);
  }, [q, run, alerts, remote]);

  const missing = (ready) => ["contado", "cuadros", "label", "ejemplo"].filter((k) => ready && k in ready && !ready[k])
    .map((k) => tr(`plan_miss_${k}`)).join(", ");

  return (
    <div ref={boxRef} className="relative w-full md:w-80">
      <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
      <input ref={inputRef} value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        placeholder={tr("plan_search_global")}
        className="h-10 w-full pl-9 pr-14 rounded-xl border border-slate-200 bg-slate-50 text-sm focus:bg-white focus:border-blue-400 outline-none" />
      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-bold text-slate-400 border border-slate-200 rounded px-1">Ctrl K</span>
      {open && q.trim().length >= 2 && (
        <div className="absolute right-0 mt-2 w-[min(640px,92vw)] max-h-[70vh] overflow-y-auto bg-white border border-slate-200 rounded-xl shadow-2xl z-50">
          {loading && results.length === 0 && <div className="p-4 text-sm text-slate-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />{tr("plan_search_loading")}</div>}
          {!loading && results.length === 0 && <div className="p-4 text-sm text-slate-500">{tr("plan_search_none")}</div>}
          {results.map((o) => {
            const inPlan = o.jobs.length || o.blocked.length || o.move;
            return (
              <div key={o.order_id} className="px-4 py-3 border-b border-slate-100 last:border-0">
                <div className="flex items-baseline gap-2">
                  <span className="font-black text-slate-900">{o.order_number}</span>
                  <span className="text-xs text-slate-500 truncate">{o.client}{o.branding ? ` · ${o.branding}` : ""}</span>
                  {o.cancel_date && <span className="ml-auto text-[11px] text-slate-400 tabular-nums whitespace-nowrap">cancel {String(o.cancel_date).slice(0, 10)}</span>}
                </div>
                <div className="mt-1.5 space-y-1 text-xs">
                  {o.jobs.map((j) => (
                    <div key={j.job_id} className="flex flex-wrap items-center gap-1.5">
                      <span className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${STATUS_STYLE[j.status] || ""}`}>{tr(`plan_status_${j.status}`)}</span>
                      <span className="font-bold">{j.position}</span>
                      <span className="text-slate-600">→ {(j.machines || []).join(", ").replace(/MAQUINA/g, "M") || "—"}</span>
                      <span className="text-slate-400 tabular-nums">{j.start ? `${dday(j.start)} ${hhmm(j.start)}` : ""}{j.end ? ` – ${dday(j.end)} ${hhmm(j.end)}` : ""}</span>
                      <span className="text-slate-400">· {fmt(j.remaining)} hits</span>
                    </div>
                  ))}
                  {o.blocked.map((b) => (
                    <div key={b.job_id} className="flex flex-wrap items-center gap-1.5">
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-600">{b.held ? tr("plan_ov_kind_hold") : tr("plan_status_BLOQUEADA")}</span>
                      <span className="font-bold">{b.position}</span>
                      {!b.held && <span className="text-red-600">{tr("plan_search_missing", { what: missing(b.ready) })}</span>}
                    </div>
                  ))}
                  {o.move && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-50 text-blue-700">{tr("plan_search_move")}</span>
                      <span>{o.move.from_board} → <b className="text-blue-700">{o.move.to_board}</b> · {dday(o.move.start)} {hhmm(o.move.start)}</span>
                    </div>
                  )}
                  {o.alert && (
                    <button onClick={() => { onGoTab("alerts"); setOpen(false); }} className="flex items-center gap-1.5 text-red-700 hover:underline">
                      <BellRing className="w-3.5 h-3.5" />{tr("plan_search_alert", { d: Math.floor(o.alert.days) })}
                    </button>
                  )}
                  {!inPlan && o.info && (
                    <div className="text-slate-500">
                      {o.info.reason_code === "in_plan"
                        ? (run?.run_id ? tr("plan_search_in_plan_no_job") : tr("plan_search_engine_off"))
                        : `${tr("plan_search_out")}: ${o.info.reason}`}
                      {o.info.production_status ? <span className="text-slate-400"> · {o.info.production_status}</span> : null}
                    </div>
                  )}
                </div>
                {canEdit && inPlan && (
                  <div className="mt-2 flex gap-1.5">
                    <button onClick={() => { onAdjust(o.jobs[0] || o.blocked[0] || { order_id: o.order_id, order_number: o.order_number,
                      client: o.client, position: o.move?.positions?.[0]?.position, machines: o.move?.positions?.[0]?.machines || [] }); setOpen(false); }}
                      className="px-2.5 h-7 rounded-lg border border-slate-300 text-xs font-bold inline-flex items-center gap-1 hover:border-blue-300 hover:text-blue-700">
                      <SlidersHorizontal className="w-3.5 h-3.5" />{tr("plan_reschedule")}
                    </button>
                    {o.move && (
                      <button onClick={async () => {
                        if (!window.confirm(tr("plan_search_confirm_auth", { n: o.order_number, b: o.move.to_board }))) return;
                        await onApply([o.order_id]); setOpen(false);
                      }} className="px-2.5 h-7 rounded-lg bg-blue-600 text-white text-xs font-bold">{tr("plan_auth_one")}</button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const TABS = [
  ["schedule", "plan_tab_schedule", CalendarClock],
  ["projection", "plan_tab_projection", TrendingUp],
  ["machines", "plan_tab_machines", Cpu],
  ["calendar", "plan_tab_calendar", CalendarDays],
  ["rules", "plan_tab_rules", Settings2],
  ["dashboard", "plan_tab_dashboard", Gauge],
  ["data", "plan_tab_data", AlertTriangle],
  ["alerts", "plan_tab_alerts", BellRing],
  ["paint", "plan_tab_paint", PackageCheck],
];

const PlannerModule = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { t: tr } = useLang();
  const canEdit = ["admin", "supersu"].includes(user?.role) || (user?.admin_level || 0) >= 3;

  const [tab, setTab] = useState("schedule");
  const [cfgData, setCfgData] = useState(null);
  const [run, setRun] = useState(null);
  const [running, setRunning] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [ovData, setOvData] = useState({ active: [], history: [] });
  const [adjusting, setAdjusting] = useState(null);

  const loadConfig = useCallback(async () => {
    try { setCfgData(await planner("/config")); } catch (e) { toast.error(e.message); }
  }, []);

  // trigger: manual | override | auto_timer | auto_change. Los automáticos van
  // en silencio (sin toast) y con max_age: si otra pantalla ya recalculó hace
  // poco, el backend regresa esa corrida en vez de repetirla.
  const runningRef = useRef(false);
  const runEngine = useCallback(async (trigger = "manual", maxAge = 0) => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    const auto = trigger === "auto_timer" || trigger === "auto_change";
    try {
      const qs = new URLSearchParams({ trigger, max_age: String(maxAge) });
      setRun(await planner(`/shadow-run?${qs}`, { method: "POST" }));
      if (!auto) toast.success(tr("plan_run_done"));
    } catch (e) {
      if (!auto) toast.error(e.message);
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }, [tr]);

  const [alertData, setAlertData] = useState(null);
  const loadAlerts = useCallback(async () => {
    try { setAlertData(await planner("/alerts")); } catch { /* la alerta no bloquea el módulo */ }
  }, []);
  // Las alertas se refrescan al abrir y con cada corrida del motor (manual o
  // automática), aunque el motor esté apagado se cargan al entrar.
  useEffect(() => { loadAlerts(); }, [loadAlerts, run?.run_id]);
  const alertCount = alertData?.printed_stale?.length || 0;

  const loadOverrides = useCallback(async () => {
    try { setOvData(await planner("/overrides")); } catch (e) { toast.error(e.message); }
  }, []);

  useEffect(() => {
    loadConfig();
    loadOverrides();
    planner("/shadow-run/latest").then((r) => setRun(r?.run_id ? r : null)).catch(() => {});
  }, [loadConfig, loadOverrides]);

  const toggleEngine = async (turnOn) => {
    if (!turnOn && !window.confirm(tr("plan_confirm_off"))) return;
    setToggling(true);
    try {
      await planner("/config", { method: "PUT", body: JSON.stringify({ engine_mode: turnOn ? "shadow" : "off" }) });
      await loadConfig();
      toast.success(turnOn ? tr("plan_engine_on_toast") : tr("plan_engine_off_toast"));
      if (turnOn) await runEngine("manual");
    } catch (e) { toast.error(e.message); } finally { setToggling(false); }
  };

  const on = cfgData?.config?.engine_mode === "shadow";

  // Tras guardar o deshacer un ajuste: recarga la lista y, si el motor está
  // encendido, recalcula para ver el impacto al momento.
  // Cualquier cambio de capacidad (calendario, máquinas, turnos, reglas)
  // recalcula el programa al momento si el motor está encendido: sin esto, el
  // tiempo extra recién guardado no aparecía hasta el siguiente recálculo.
  const afterConfigChange = async () => {
    await loadConfig();
    if (on) await runEngine("config");
  };

  const afterOverride = async (closePanel) => {
    await loadOverrides();
    if (on) await runEngine("override");
    if (closePanel) setAdjusting(null);
  };
  // ── Recálculo automático (modo sombra) ──
  // 1) por tiempo: si la última corrida tiene más de N minutos;
  // 2) por cambios: una orden o una captura de producción cambió (mismo canal
  //    WebSocket que las pantallas de operador), con espera de 15–25 s para
  //    juntar ráfagas. max_age evita que varias pantallas recalculen lo mismo.
  const autoOn = on && !!cfgData?.config?.auto_recalc;
  const autoMin = Number(cfgData?.config?.auto_recalc_minutes) || 15;
  const runRef = useRef(run);
  useEffect(() => { runRef.current = run; }, [run]);
  useEffect(() => {
    if (!autoOn) return undefined;
    const check = () => {
      const last = runRef.current?.created_at ? new Date(runRef.current.created_at).getTime() : 0;
      if (Date.now() - last > autoMin * 60000) runEngine("auto_timer", 60);
    };
    const first = setTimeout(check, 3000);
    const id = setInterval(check, 60000);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [autoOn, autoMin, runEngine]);
  useEffect(() => {
    if (!autoOn) return undefined;
    let ws;
    let timer;
    try {
      ws = new WebSocket(WS_URL);
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type !== "order_change" && msg.type !== "production_update") return;
          clearTimeout(timer);
          timer = setTimeout(() => runEngine("auto_change", 30), 15000 + Math.random() * 10000);
        } catch { /* mensaje ajeno */ }
      };
    } catch { /* sin WebSocket: queda el recálculo por tiempo */ }
    return () => { clearTimeout(timer); try { ws?.close(); } catch { /* ya cerrado */ } };
  }, [autoOn, runEngine]);

  // ── Autorizar movimientos (escribe en el CRM sólo con autorización) ──
  const [applied, setApplied] = useState([]);
  const [lastApply, setLastApply] = useState([]);
  const loadApplied = useCallback(async () => {
    try { setApplied((await planner("/moves/applied")).rows || []); } catch { /* no bloquea */ }
  }, []);
  useEffect(() => { loadApplied(); }, [loadApplied]);
  const applyMoves = async (orderIds) => {
    try {
      const r = await planner("/moves/apply", { method: "POST", body: JSON.stringify({ run_id: run?.run_id, order_ids: orderIds }) });
      setLastApply(r.results || []);
      if (r.applied) toast.success(tr("plan_auth_done", { n: r.applied }));
      if ((r.results || []).some((x) => x.result !== "applied")) toast.warning(tr("plan_auth_some_skipped"));
    } catch (e) {
      toast.error(e.message);
    }
    await loadApplied();
    if (on) await runEngine("override");
  };
  const revertMove = async (row) => {
    if (!window.confirm(tr("plan_applied_confirm_revert", { n: row.order_number, b: row.from_board }))) return;
    try {
      await planner(`/moves/applied/${row.apply_id}/revert`, { method: "POST" });
      toast.success(tr("plan_applied_reverted_toast", { n: row.order_number }));
    } catch (e) { toast.error(e.message); }
    await loadApplied();
    if (on) await runEngine("override");
  };

  const undoOverride = async (id) => {
    try {
      await planner(`/overrides/${id}`, { method: "DELETE" });
      toast.success(tr("plan_ov_undone"));
      await afterOverride(false);
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div className="planner-page min-h-screen bg-slate-50 text-slate-800">
      <header className="sticky top-0 z-40 bg-white border-b border-slate-200">
        <div className="max-w-[1600px] mx-auto px-4 md:px-8 py-4 flex items-center gap-3 flex-wrap">
          <button onClick={() => navigate("/home")} title={tr("comp_back")}
            className="p-2 rounded-xl bg-white border border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-300">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="leading-none mr-auto">
            <h1 className="text-2xl font-black tracking-tight text-slate-900 flex items-center gap-2">
              <CalendarClock className="w-6 h-6 text-blue-600" /> {tr("plan_title")}
            </h1>
            <span className="block text-xs text-slate-500 mt-1">{tr("plan_subtitle")}</span>
          </div>

          <GlobalSearch run={run} alerts={alertData?.printed_stale} canEdit={canEdit} onAdjust={setAdjusting}
            onApply={applyMoves} onGoTab={setTab} tr={tr} />

          {/* Interruptor del motor */}
          <div className={`flex items-center gap-3 px-3 py-2 rounded-xl border ${on ? "bg-emerald-50 border-emerald-200" : "bg-slate-50 border-slate-200"}`}>
            <div className="leading-tight">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{tr("plan_engine")}</div>
              <div className={`text-sm font-black ${on ? "text-emerald-700" : "text-slate-500"}`}>
                {on ? tr("plan_engine_on_shadow") : tr("plan_engine_off")}
              </div>
            </div>
            <button onClick={() => toggleEngine(!on)} disabled={!canEdit || toggling || !cfgData}
              title={canEdit ? "" : tr("plan_engine_admin_only")} data-testid="planner-engine-switch"
              className={`relative w-12 h-7 rounded-full transition-colors disabled:opacity-50 ${on ? "bg-emerald-500" : "bg-slate-300"}`}>
              <span className={`absolute top-1 w-5 h-5 rounded-full bg-white shadow transition-all ${on ? "left-6" : "left-1"}`} />
            </button>
          </div>

          {alertCount > 0 && (
            <button onClick={() => setTab("alerts")}
              className="h-10 px-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm font-bold inline-flex items-center gap-2 hover:bg-red-100">
              <BellRing className="w-4 h-4" /> {tr("plan_al_chip", { n: alertCount })}
            </button>
          )}
          <button onClick={() => runEngine("manual")} disabled={!on || running}
            className="h-10 px-4 rounded-xl bg-white border border-slate-200 text-sm font-bold text-slate-600 flex items-center gap-2 hover:border-blue-300 disabled:opacity-50">
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {tr("plan_recalc")}
          </button>
          {run?.created_at && (
            <span className="text-[11px] text-slate-400 leading-tight">
              {tr("plan_last_run", { when: new Date(run.created_at).toLocaleString("es-MX") })}
              {" · "}{tr(`plan_trigger_${run.trigger || "manual"}`)}
              {autoOn && <span className="block text-emerald-600 font-bold">{tr("plan_auto_on", { n: autoMin })}</span>}
            </span>
          )}
        </div>
        <nav className="max-w-[1600px] mx-auto px-4 md:px-8 flex gap-1 overflow-x-auto">
          {TABS.map(([key, label, Icon]) => (
            <button key={key} onClick={() => setTab(key)}
              className={`px-3 py-2.5 text-sm font-bold border-b-2 whitespace-nowrap inline-flex items-center gap-1.5 ${tab === key
                ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
              <Icon className="w-4 h-4" /> {tr(label)}
              {key === "alerts" && alertCount > 0 && (
                <span className="ml-1 min-w-[20px] h-5 px-1.5 rounded-full bg-red-600 text-white text-[11px] font-black inline-flex items-center justify-center">{alertCount}</span>
              )}
            </button>
          ))}
        </nav>
      </header>

      <main className="max-w-[1600px] mx-auto px-4 md:px-8 py-6">
        {!cfgData ? (
          <div className="py-20 flex justify-center"><Loader2 className="w-7 h-7 animate-spin text-blue-600" /></div>
        ) : (
          <>
            {tab === "schedule" && <ScheduleTab config={cfgData.config} efficiency={cfgData.efficiency} run={run} running={running} onRun={() => runEngine("manual")} canEdit={canEdit}
              onToggle={toggleEngine} onAdjust={setAdjusting} overrides={ovData.active} history={ovData.history}
              onUndo={undoOverride} onApplyMoves={applyMoves} applied={applied} onRevertMove={revertMove}
              lastApply={lastApply} tr={tr} />}
            {tab === "projection" && <ProjectionTab canEdit={canEdit} run={run} onCalendarSaved={afterConfigChange} calendar={cfgData.calendar}
              hitsPerShift={cfgData.config.hits_per_shift} tr={tr} />}
            {tab === "machines" && <MachinesTab cfgData={cfgData} canEdit={canEdit} onSaved={afterConfigChange} tr={tr} />}
            {tab === "calendar" && <CalendarTab cfgData={cfgData} canEdit={canEdit} onSaved={afterConfigChange} tr={tr} />}
            {tab === "rules" && <RulesTab cfgData={cfgData} canEdit={canEdit} onSaved={afterConfigChange} tr={tr} />}
            {tab === "dashboard" && <DashboardTab tr={tr} />}
            {tab === "data" && <DataTab tr={tr} />}
            {tab === "alerts" && <AlertsTab data={alertData} tr={tr} />}
            {tab === "paint" && <PaintFollowupTab tr={tr} />}
          </>
        )}
      </main>

      {adjusting && cfgData && (
        <AdjustPanel job={adjusting} machines={cfgData.machines} overrides={ovData.active} engineOn={on}
          onClose={() => setAdjusting(null)} onChanged={afterOverride} tr={tr} />
      )}
    </div>
  );
};

export default PlannerModule;
