/* Resurtir sobre el MISMO pick ticket (services/resupply.py). Abre la ronda
   R1, R2… con las tallas que producción necesita — incluso tallas que el
   ticket no traía (resize) — y la manda a la PDA del picker, que la surte
   escaneando caja como cualquier ticket. Arriba del umbral (default 10 % de lo
   pedido, acumulado) solo admin nivel 5; el backend lo valida igual. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, RotateCcw, Trash2, X, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, poster } from "./lib";
import { Btn, Chip, cls } from "./ui";

export const ResupplyModal = ({ ticket, operators = [], onClose, onDone }) => {
  const { t } = useLang();
  const [cfg, setCfg] = useState(null);
  const [rounds, setRounds] = useState([]);
  const [sizes, setSizes] = useState(() =>
    Object.fromEntries(Object.keys(ticket.sizes || {}).filter(s => (ticket.sizes[s] || 0) > 0).map(s => [s, ''])));
  const [newSize, setNewSize] = useState('');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [assignee, setAssignee] = useState('');
  const [pv, setPv] = useState(null);
  const [saving, setSaving] = useState(false);

  const loadRounds = () => fetcher(`/resupply/${ticket.ticket_id}/rounds`).then(r => setRounds(r.rounds || [])).catch(() => {});
  useEffect(() => {
    fetcher('/resupply/config').then(c => { setCfg(c); setReason(c.reasons?.[0] || ''); }).catch(() => toast.error(t('wms_rs_load_err')));
    loadRounds();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket.ticket_id]);

  const clean = useMemo(() => Object.fromEntries(
    Object.entries(sizes).map(([k, v]) => [k, parseInt(v, 10) || 0]).filter(([, v]) => v > 0)), [sizes]);
  const total = Object.values(clean).reduce((a, b) => a + b, 0);

  // Vista previa del % acumulado (debounce corto).
  const timer = useRef(null);
  useEffect(() => {
    clearTimeout(timer.current);
    if (!total) { setPv(null); return undefined; }
    timer.current = setTimeout(async () => {
      try {
        const res = await poster(`/resupply/${ticket.ticket_id}/preview`, { sizes: clean });
        if (res.ok) setPv(await res.json());
      } catch { /* la validación final la hace el backend */ }
    }, 300);
    return () => clearTimeout(timer.current);
  }, [clean, total, ticket.ticket_id]);

  const addSize = () => {
    const s = newSize.trim().toUpperCase();
    if (s && !(s in sizes)) setSizes(p => ({ ...p, [s]: '' }));
    setNewSize('');
  };

  const blocked = pv?.over && !pv?.can_over;
  const openRound = rounds.find(r => !['confirmed', 'completed', 'cancelled', 'in_neck_cutting'].includes(r.status) && r.picking_status !== 'completed');

  const submit = async () => {
    if (!total) { toast.error(t('wms_rs_need_qty')); return; }
    setSaving(true);
    try {
      const op = operators.find(o => (o.user_id || o.email) === assignee);
      const res = await poster(`/resupply/${ticket.ticket_id}`, {
        sizes: clean, reason, notes, assigned_to: assignee, assigned_to_name: op?.name || '' });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(r.detail || t('error')); return; }
      toast.success(t('wms_rs_created', { id: r.ticket_id.split('_')[1] || r.ticket_id, n: total }));
      onDone?.();
      onClose();
    } catch { toast.error(t('wms_conn_err')); }
    finally { setSaving(false); }
  };

  const cancelRound = async (id) => {
    if (!window.confirm(t('wms_rs_cancel_confirm'))) return;
    const res = await poster(`/resupply/${id}/cancel`, {});
    const r = await res.json().catch(() => ({}));
    if (!res.ok) { toast.error(r.detail || t('error')); return; }
    toast.success(t('wms_rs_cancelled'));
    loadRounds(); onDone?.();
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-xl border border-border bg-card shadow-2xl" onClick={e => e.stopPropagation()} data-testid="resupply-modal">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h3 className="font-semibold text-foreground flex items-center gap-2"><RotateCcw className="w-4 h-4 text-primary" /> {t('wms_rs_title')}</h3>
            <p className="text-xs text-muted-foreground">#{ticket.order_number} · {ticket.style} · {ticket.color} · {t('wms_rs_base', { n: Object.values(ticket.sizes || {}).reduce((a, b) => a + (parseInt(b, 10) || 0), 0) })}</p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded-md"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 space-y-4">
          {rounds.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">{t('wms_rs_previous')}</div>
              {rounds.map(r => (
                <div key={r.ticket_id} className="flex items-center gap-2 text-xs border border-border rounded-md px-2 py-1.5">
                  <span className="font-mono font-semibold">R{r.resupply_round}</span>
                  <span className="text-muted-foreground">{Object.entries(r.sizes || {}).map(([k, v]) => `${k}:${v}`).join(' ')}</span>
                  <span className="text-muted-foreground truncate">· {r.resupply_reason}</span>
                  <span className="ml-auto">
                    {r.status === 'cancelled' ? <Chip>{t('wms_rs_st_cancelled')}</Chip>
                      : (r.status === 'confirmed' || r.picking_status === 'completed') ? <Chip tone="success">{t('wms_rs_st_done')}</Chip>
                      : <Chip tone="warning">{t('wms_rs_st_open')}</Chip>}
                  </span>
                  {r.status !== 'cancelled' && !r.deducted_map && r.status !== 'confirmed' && (
                    <button onClick={() => cancelRound(r.ticket_id)} title={t('wms_rs_cancel')} className="text-muted-foreground hover:text-red-600"><Trash2 className="w-3.5 h-3.5" /></button>
                  )}
                </div>
              ))}
            </div>
          )}

          {openRound ? (
            <div className="text-sm text-amber-700 dark:text-amber-300 flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> {t('wms_rs_open_exists', { id: `R${openRound.resupply_round}` })}</div>
          ) : (
            <>
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-2">{t('wms_rs_sizes')}</div>
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                  {Object.keys(sizes).map(sz => (
                    <div key={sz} className="flex flex-col items-center gap-1">
                      <span className="text-xs font-medium">{sz}</span>
                      <input type="number" min="0" value={sizes[sz]} placeholder="0" data-testid={`resupply-size-${sz}`}
                        onChange={e => setSizes(p => ({ ...p, [sz]: e.target.value }))}
                        className="w-full text-center bg-background border border-border rounded-md p-1.5 text-sm tabular-nums" />
                    </div>
                  ))}
                </div>
                <div className="flex gap-2 mt-2">
                  <input value={newSize} onChange={e => setNewSize(e.target.value)} placeholder={t('wms_rs_new_size_ph')}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSize(); } }}
                    className={`${cls.input} w-40 font-mono`} />
                  <Btn onClick={addSize}><Plus className="w-4 h-4" /> {t('wms_rs_add_size')}</Btn>
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground block mb-1">{t('wms_rs_reason')}</label>
                  <select value={reason} onChange={e => setReason(e.target.value)} className={cls.input} data-testid="resupply-reason">
                    {(cfg?.reasons || []).map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground block mb-1">{t('wms_rs_assign')}</label>
                  <select value={assignee} onChange={e => setAssignee(e.target.value)} className={cls.input}>
                    <option value="">{t('unassigned')}</option>
                    {operators.map(op => <option key={op.email} value={op.user_id || op.email}>{op.name || op.email}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">{t('wms_notes')}</label>
                <input value={notes} onChange={e => setNotes(e.target.value)} className={cls.input} placeholder={t('wms_rs_notes_ph')} />
              </div>

              {pv && (
                <div className={`text-sm rounded-md border px-3 py-2 ${pv.over ? 'border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30' : 'border-border text-muted-foreground'}`}>
                  {t('wms_rs_pct', { pct: pv.pct, n: pv.prior + pv.new, base: pv.base })}
                  {pv.over && <div className="font-medium mt-0.5">{pv.can_over ? t('wms_rs_over_ok', { th: pv.threshold_pct }) : t('wms_rs_over_blocked', { th: pv.threshold_pct })}</div>}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex gap-2 px-5 py-4 border-t border-border">
          <Btn onClick={onClose} className="flex-1">{t('cancel')}</Btn>
          {!openRound && (
            <Btn variant="primary" onClick={submit} disabled={saving || !total || blocked || !reason} className="flex-1" data-testid="resupply-submit">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />} {t('wms_rs_submit', { n: total })}
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
};

export default ResupplyModal;
