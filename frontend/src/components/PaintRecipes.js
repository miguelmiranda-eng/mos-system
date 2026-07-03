import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Search, Loader2, Trash2, Pencil, Printer, X, Beaker, Calculator } from 'lucide-react';
import { toast } from 'sonner';
import { API } from '../lib/constants';

const EMPTY = { color_name: '', pantone: '', ink_type: 'PLASTISOL', unit: 'g', total_volume: '', cost: '', notes: '', ingredients: [{ name: '', qty: '', unit: 'g' }] };

export default function PaintRecipes() {
  const [recipes, setRecipes] = useState([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);      // recipe being edited (or {} for new)
  const [form, setForm] = useState(EMPTY);
  const [est, setEst] = useState({ area: '', prints: '', deposit: '1.8' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/paint/recipes?q=${encodeURIComponent(q)}`, { credentials: 'include' }).then(r => r.json());
      setRecipes(r.recipes || []);
    } catch { toast.error('Error al cargar recetas'); } finally { setLoading(false); }
  }, [q]);
  useEffect(() => { const id = setTimeout(load, 200); return () => clearTimeout(id); }, [load]);

  const openNew = () => { setForm(EMPTY); setEst({ area: '', prints: '', deposit: '1.8' }); setEditing({}); };
  const openEdit = (r) => {
    setForm({ ...EMPTY, ...r, total_volume: r.total_volume ?? '', cost: r.cost ?? '', ingredients: r.ingredients?.length ? r.ingredients : EMPTY.ingredients });
    setEditing(r);
  };

  const save = async () => {
    if (!form.color_name.trim()) { toast.error('Escribe el nombre del color'); return; }
    const body = {
      ...form,
      total_volume: parseFloat(form.total_volume) || 0,
      cost: parseFloat(form.cost) || 0,
      ingredients: (form.ingredients || []).filter(i => (i.name || '').trim()).map(i => ({ name: i.name.trim(), qty: parseFloat(i.qty) || 0, unit: i.unit || 'g' })),
    };
    try {
      const isNew = !editing.recipe_id;
      const res = await fetch(`${API}/paint/recipes${isNew ? '' : '/' + editing.recipe_id}`, {
        method: isNew ? 'POST' : 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || 'Error'); }
      toast.success(isNew ? 'Receta creada' : 'Receta actualizada');
      setEditing(null); load();
    } catch (e) { toast.error(e.message); }
  };
  const del = async (r) => {
    if (!window.confirm(`¿Eliminar la receta ${r.color_name}?`)) return;
    try { await fetch(`${API}/paint/recipes/${r.recipe_id}`, { method: 'DELETE', credentials: 'include' }); load(); }
    catch { toast.error('Error al eliminar'); }
  };

  const setIng = (i, k, v) => setForm(p => ({ ...p, ingredients: p.ingredients.map((row, idx) => idx === i ? { ...row, [k]: v } : row) }));
  const addIng = () => setForm(p => ({ ...p, ingredients: [...p.ingredients, { name: '', qty: '', unit: p.unit || 'g' }] }));
  const rmIng = (i) => setForm(p => ({ ...p, ingredients: p.ingredients.filter((_, idx) => idx !== i) }));

  const estTotal = Math.round(((parseFloat(est.area) || 0) / 100) * (parseFloat(est.deposit) || 0) * (parseFloat(est.prints) || 0));

  const printLabel = (r) => {
    const ings = (r.ingredients || []).map(i => `<tr><td>${i.name}</td><td style="text-align:right">${i.qty} ${i.unit || ''}</td></tr>`).join('');
    const w = window.open('', '_blank', 'width=420,height=560');
    if (!w) return;
    w.document.write(`<html><head><title>Etiqueta ${r.color_name}</title><style>
      body{font-family:Arial,sans-serif;padding:16px;color:#111}
      h1{font-size:20px;margin:0 0 2px} .p{color:#555;font-size:13px;margin:0 0 10px}
      table{width:100%;border-collapse:collapse;font-size:13px} td{padding:3px 0;border-bottom:1px solid #eee}
      .box{border:2px solid #111;border-radius:10px;padding:14px}
      .big{font-size:15px;font-weight:bold;margin:10px 0 4px}</style></head><body>
      <div class="box"><h1>${r.color_name}</h1><p class="p">${r.pantone ? 'Pantone ' + r.pantone + ' · ' : ''}${r.ink_type || ''}</p>
      <div class="big">Ingredientes</div><table>${ings}</table>
      <div class="big">Volumen total: ${r.total_volume || 0} ${r.unit || 'g'}</div>
      ${r.notes ? `<p class="p">${r.notes}</p>` : ''}
      <p class="p" style="margin-top:12px">Impreso ${new Date().toLocaleString('es-MX')}</p></div>
      <script>window.print()</script></body></html>`);
    w.document.close();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar color, pantone o tipo…"
            className="w-full bg-secondary/40 border border-border rounded-xl pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary" />
        </div>
        <button onClick={openNew} className="px-4 py-2.5 bg-primary text-black rounded-xl font-black text-xs uppercase tracking-widest flex items-center gap-2"><Plus size={16} /> Nueva receta</button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
      ) : recipes.length === 0 ? (
        <div className="text-center text-muted-foreground py-16 text-sm">Sin recetas todavía. Crea la primera fórmula de mezcla.</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {recipes.map(r => (
            <div key={r.recipe_id} className="bg-card/60 border border-border rounded-2xl p-4">
              <div className="flex items-start gap-2">
                <div className="w-9 h-9 rounded-lg bg-primary/15 text-primary flex items-center justify-center shrink-0"><Beaker size={18} /></div>
                <div className="min-w-0 flex-1">
                  <div className="font-black text-sm truncate">{r.color_name}</div>
                  <div className="text-[11px] text-muted-foreground truncate">{r.pantone ? `Pantone ${r.pantone} · ` : ''}{r.ink_type}</div>
                </div>
              </div>
              <div className="mt-3 space-y-1">
                {(r.ingredients || []).slice(0, 4).map((i, idx) => (
                  <div key={idx} className="flex justify-between text-xs"><span className="text-foreground/80 truncate">{i.name}</span><span className="text-muted-foreground font-mono">{i.qty} {i.unit}</span></div>
                ))}
                {(r.ingredients || []).length > 4 && <div className="text-[11px] text-muted-foreground">+{r.ingredients.length - 4} más</div>}
              </div>
              <div className="flex items-center justify-between mt-3 pt-3 border-t border-border/40">
                <span className="text-xs font-bold">{r.total_volume || 0} {r.unit || 'g'}{r.cost ? ` · $${r.cost}` : ''}</span>
                <div className="flex items-center gap-1">
                  <button onClick={() => printLabel(r)} title="Imprimir etiqueta" className="p-1.5 rounded hover:bg-secondary/40"><Printer size={15} /></button>
                  <button onClick={() => openEdit(r)} title="Editar" className="p-1.5 rounded hover:bg-secondary/40"><Pencil size={15} /></button>
                  <button onClick={() => del(r)} title="Eliminar" className="p-1.5 rounded hover:bg-secondary/40 text-red-400"><Trash2 size={15} /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setEditing(null)}>
          <div className="bg-card border border-border rounded-2xl w-full max-w-lg max-h-[90vh] overflow-auto p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-black uppercase tracking-widest text-sm">{editing.recipe_id ? 'Editar receta' : 'Nueva receta'}</h3>
              <button onClick={() => setEditing(null)} className="p-1.5 rounded hover:bg-secondary/40"><X size={18} /></button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2"><label className="text-[10px] uppercase font-black text-muted-foreground">Color *</label>
                <input value={form.color_name} onChange={e => setForm(p => ({ ...p, color_name: e.target.value }))} className="w-full mt-1 bg-background border border-border rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="text-[10px] uppercase font-black text-muted-foreground">Pantone</label>
                <input value={form.pantone} onChange={e => setForm(p => ({ ...p, pantone: e.target.value }))} className="w-full mt-1 bg-background border border-border rounded-lg px-3 py-2 text-sm font-mono" /></div>
              <div><label className="text-[10px] uppercase font-black text-muted-foreground">Tipo</label>
                <input value={form.ink_type} onChange={e => setForm(p => ({ ...p, ink_type: e.target.value }))} className="w-full mt-1 bg-background border border-border rounded-lg px-3 py-2 text-sm" /></div>
            </div>

            <div className="mt-4">
              <div className="flex items-center justify-between mb-1"><label className="text-[10px] uppercase font-black text-muted-foreground">Ingredientes</label>
                <button onClick={addIng} className="text-[11px] text-primary font-bold flex items-center gap-1"><Plus size={12} /> Agregar</button></div>
              <div className="space-y-2">
                {form.ingredients.map((row, i) => (
                  <div key={i} className="flex gap-2">
                    <input value={row.name} onChange={e => setIng(i, 'name', e.target.value)} placeholder="Componente" className="flex-1 min-w-0 bg-background border border-border rounded-lg px-2 py-1.5 text-sm" />
                    <input value={row.qty} onChange={e => setIng(i, 'qty', e.target.value)} placeholder="Cant." type="number" className="w-20 bg-background border border-border rounded-lg px-2 py-1.5 text-sm" />
                    <input value={row.unit} onChange={e => setIng(i, 'unit', e.target.value)} placeholder="u" className="w-14 bg-background border border-border rounded-lg px-2 py-1.5 text-sm" />
                    <button onClick={() => rmIng(i)} className="p-1.5 rounded text-red-400 hover:bg-secondary/40"><X size={15} /></button>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4 bg-secondary/30 rounded-xl p-3">
              <div className="flex items-center gap-1.5 text-[11px] font-black uppercase text-muted-foreground mb-2"><Calculator size={13} /> Estimador de volumen</div>
              <div className="grid grid-cols-3 gap-2">
                <input value={est.area} onChange={e => setEst(p => ({ ...p, area: e.target.value }))} placeholder="Área in²" type="number" className="bg-background border border-border rounded-lg px-2 py-1.5 text-sm" />
                <input value={est.prints} onChange={e => setEst(p => ({ ...p, prints: e.target.value }))} placeholder="# piezas" type="number" className="bg-background border border-border rounded-lg px-2 py-1.5 text-sm" />
                <input value={est.deposit} onChange={e => setEst(p => ({ ...p, deposit: e.target.value }))} placeholder="g/100in²" type="number" className="bg-background border border-border rounded-lg px-2 py-1.5 text-sm" />
              </div>
              <div className="flex items-center justify-between mt-2 text-sm"><span className="text-muted-foreground">≈ <b className="text-foreground">{estTotal} g</b> de tinta</span>
                <button onClick={() => setForm(p => ({ ...p, total_volume: String(estTotal), unit: 'g' }))} className="text-[11px] text-primary font-bold">Usar como volumen</button></div>
            </div>

            <div className="grid grid-cols-3 gap-3 mt-4">
              <div><label className="text-[10px] uppercase font-black text-muted-foreground">Volumen total</label>
                <input value={form.total_volume} onChange={e => setForm(p => ({ ...p, total_volume: e.target.value }))} type="number" className="w-full mt-1 bg-background border border-border rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="text-[10px] uppercase font-black text-muted-foreground">Unidad</label>
                <input value={form.unit} onChange={e => setForm(p => ({ ...p, unit: e.target.value }))} className="w-full mt-1 bg-background border border-border rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="text-[10px] uppercase font-black text-muted-foreground">Costo $</label>
                <input value={form.cost} onChange={e => setForm(p => ({ ...p, cost: e.target.value }))} type="number" className="w-full mt-1 bg-background border border-border rounded-lg px-3 py-2 text-sm" /></div>
            </div>
            <div className="mt-3"><label className="text-[10px] uppercase font-black text-muted-foreground">Notas</label>
              <textarea value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} rows={2} className="w-full mt-1 bg-background border border-border rounded-lg px-3 py-2 text-sm" /></div>

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
