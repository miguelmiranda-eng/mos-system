import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Loader2, Trash2, Pencil, X, AlertTriangle, Minus } from 'lucide-react';
import { toast } from 'sonner';
import { API } from '../lib/constants';

const EMPTY = { name: '', brand: '', ink_type: 'PLASTISOL', color: '', units_on_hand: '', unit: 'kg', reorder_point: '', cost_per_unit: '' };

export default function PaintInventory() {
  const [items, setItems] = useState([]);
  const [lowCount, setLowCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/paint/inventory`, { credentials: 'include' }).then(r => r.json());
      setItems(r.items || []); setLowCount(r.low_count || 0);
    } catch { toast.error('Error al cargar inventario'); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!form.name.trim()) { toast.error('Escribe el nombre de la tinta'); return; }
    const body = { ...form, units_on_hand: parseFloat(form.units_on_hand) || 0, reorder_point: parseFloat(form.reorder_point) || 0, cost_per_unit: parseFloat(form.cost_per_unit) || 0 };
    try {
      const isNew = !editing.ink_id;
      const res = await fetch(`${API}/paint/inventory${isNew ? '' : '/' + editing.ink_id}`, {
        method: isNew ? 'POST' : 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || 'Error'); }
      toast.success(isNew ? 'Tinta agregada' : 'Actualizada'); setEditing(null); load();
    } catch (e) { toast.error(e.message); }
  };
  const del = async (it) => {
    if (!window.confirm(`¿Eliminar ${it.name} del inventario?`)) return;
    try { await fetch(`${API}/paint/inventory/${it.ink_id}`, { method: 'DELETE', credentials: 'include' }); load(); }
    catch { toast.error('Error al eliminar'); }
  };
  const adjust = async (it, delta) => {
    const next = Math.max(0, Math.round(((it.units_on_hand || 0) + delta) * 100) / 100);
    try {
      await fetch(`${API}/paint/inventory/${it.ink_id}`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ units_on_hand: next }) });
      load();
    } catch { toast.error('Error al ajustar'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="flex-1" />
        <button onClick={() => { setForm(EMPTY); setEditing({}); }} className="px-4 py-2.5 bg-primary text-black rounded-xl font-black text-xs uppercase tracking-widest flex items-center gap-2"><Plus size={16} /> Nueva tinta</button>
      </div>

      {lowCount > 0 && (
        <div className="flex items-center gap-2 px-4 py-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-sm text-amber-500">
          <AlertTriangle size={16} /> {lowCount} tinta(s) en o por debajo del punto de reorden.
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
      ) : items.length === 0 ? (
        <div className="text-center text-muted-foreground py-16 text-sm">Sin tintas registradas. Agrega tus tintas base.</div>
      ) : (
        <div className="bg-card/40 border border-border rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-secondary/50">
                <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left font-black px-3 py-2">Tinta</th>
                  <th className="text-left font-black px-3 py-2">Tipo</th>
                  <th className="text-right font-black px-3 py-2">En mano</th>
                  <th className="text-right font-black px-3 py-2">Reorden</th>
                  <th className="text-right font-black px-3 py-2">Costo/u</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {items.map(it => (
                  <tr key={it.ink_id} className={`border-t border-border/30 ${it.low_stock ? 'bg-amber-500/5' : ''}`}>
                    <td className="px-3 py-2">
                      <div className="font-bold">{it.name}{it.color ? ` · ${it.color}` : ''}</div>
                      <div className="text-[11px] text-muted-foreground">{it.brand}</div>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{it.ink_type}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button onClick={() => adjust(it, -1)} className="p-1 rounded hover:bg-secondary/40"><Minus size={13} /></button>
                        <span className={`font-mono font-bold ${it.low_stock ? 'text-amber-500' : ''}`}>{it.units_on_hand} {it.unit}</span>
                        <button onClick={() => adjust(it, 1)} className="p-1 rounded hover:bg-secondary/40"><Plus size={13} /></button>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-muted-foreground">{it.reorder_point} {it.unit}</td>
                    <td className="px-3 py-2 text-right font-mono text-muted-foreground">{it.cost_per_unit ? `$${it.cost_per_unit}` : '—'}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => { setForm({ ...EMPTY, ...it }); setEditing(it); }} className="p-1.5 rounded hover:bg-secondary/40"><Pencil size={14} /></button>
                        <button onClick={() => del(it)} className="p-1.5 rounded hover:bg-secondary/40 text-red-400"><Trash2 size={14} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setEditing(null)}>
          <div className="bg-card border border-border rounded-2xl w-full max-w-md p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-black uppercase tracking-widest text-sm">{editing.ink_id ? 'Editar tinta' : 'Nueva tinta'}</h3>
              <button onClick={() => setEditing(null)} className="p-1.5 rounded hover:bg-secondary/40"><X size={18} /></button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2"><label className="text-[10px] uppercase font-black text-muted-foreground">Nombre *</label>
                <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} className="w-full mt-1 bg-background border border-border rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="text-[10px] uppercase font-black text-muted-foreground">Marca</label>
                <input value={form.brand} onChange={e => setForm(p => ({ ...p, brand: e.target.value }))} className="w-full mt-1 bg-background border border-border rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="text-[10px] uppercase font-black text-muted-foreground">Tipo</label>
                <input value={form.ink_type} onChange={e => setForm(p => ({ ...p, ink_type: e.target.value }))} className="w-full mt-1 bg-background border border-border rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="text-[10px] uppercase font-black text-muted-foreground">Color</label>
                <input value={form.color} onChange={e => setForm(p => ({ ...p, color: e.target.value }))} className="w-full mt-1 bg-background border border-border rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="text-[10px] uppercase font-black text-muted-foreground">Unidad</label>
                <input value={form.unit} onChange={e => setForm(p => ({ ...p, unit: e.target.value }))} className="w-full mt-1 bg-background border border-border rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="text-[10px] uppercase font-black text-muted-foreground">En mano</label>
                <input value={form.units_on_hand} onChange={e => setForm(p => ({ ...p, units_on_hand: e.target.value }))} type="number" className="w-full mt-1 bg-background border border-border rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="text-[10px] uppercase font-black text-muted-foreground">Punto reorden</label>
                <input value={form.reorder_point} onChange={e => setForm(p => ({ ...p, reorder_point: e.target.value }))} type="number" className="w-full mt-1 bg-background border border-border rounded-lg px-3 py-2 text-sm" /></div>
              <div className="col-span-2"><label className="text-[10px] uppercase font-black text-muted-foreground">Costo por unidad $</label>
                <input value={form.cost_per_unit} onChange={e => setForm(p => ({ ...p, cost_per_unit: e.target.value }))} type="number" className="w-full mt-1 bg-background border border-border rounded-lg px-3 py-2 text-sm" /></div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setEditing(null)} className="px-4 py-2 rounded-lg border border-border text-sm">Cancelar</button>
              <button onClick={save} className="px-5 py-2 rounded-lg bg-primary text-black font-black text-xs uppercase tracking-widest">Guardar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
