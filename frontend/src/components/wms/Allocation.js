import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Plus, Trash2, Loader2, Link2 } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, poster, deleter, logLoadError } from "./lib";

export const AllocationModule = () => {
  const { t } = useLang();
  const [allocations, setAllocations] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [orders, setOrders] = useState([]);
  const [inventory, setInventory] = useState([]);
  const [selectedOrder, setSelectedOrder] = useState('');
  const [items, setItems] = useState([{ sku: '', color: '', size: '', qty: '', maxQty: 0 }]);
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(false);

  const loadAllocations = useCallback(() => { fetcher('/allocations').then(setAllocations).catch(logLoadError('data')); }, []);
  const loadOrders = useCallback(() => { fetcher('/orders').then(setOrders).catch(logLoadError('data')); }, []);
  const loadInventory = useCallback(() => { fetcher('/inventory').then(setInventory).catch(logLoadError('data')); }, []);
  useEffect(() => { loadAllocations(); loadOrders(); loadInventory(); }, [loadAllocations, loadOrders, loadInventory]);

  const availableInv = inventory.filter(inv => (inv.available || 0) > 0);
  const addItem = () => setItems(p => [...p, { sku: '', color: '', size: '', qty: '', maxQty: 0 }]);
  const removeItem = (i) => setItems(p => p.filter((_, idx) => idx !== i));
  const updateItem = (i, field, val) => setItems(p => p.map((it, idx) => idx === i ? { ...it, [field]: val } : it));

  const selectInventoryItem = (i, invKey) => {
    if (!invKey) { updateItem(i, 'sku', ''); updateItem(i, 'color', ''); updateItem(i, 'size', ''); return; }
    const [sku, color, size] = invKey.split('||');
    const inv = inventory.find(x => (x.style || x.sku) === sku && (x.color || '') === color && (x.size || '') === size);
    setItems(p => p.map((it, idx) => idx === i ? { ...it, sku, color, size, qty: '', maxQty: inv?.available || 0 } : it));
  };

  const handleSubmit = async () => {
    if (!selectedOrder) { toast.error(t('wms_select_order_err')); return; }
    const validItems = items.filter(it => it.sku && parseInt(it.qty) > 0);
    if (validItems.length === 0) { toast.error(t('wms_min_item_err')); return; }
    setLoading(true);
    try {
      const res = await poster('/allocations', {
        order_id: selectedOrder,
        items: validItems.map(it => ({ sku: it.sku, color: it.color, size: it.size, qty: parseInt(it.qty) }))
      });
      if (res.ok) {
        toast.success(t('wms_alloc_success'));
        setShowForm(false); setSelectedOrder(''); setItems([{ sku: '', color: '', size: '', qty: '', maxQty: 0 }]);
        loadAllocations(); loadInventory();
      } else { const err = await res.json().catch(() => ({})); toast.error(err.detail || t('wms_alloc_create_err')); }
    } catch { toast.error(t('error_connection')); }
    finally { setLoading(false); }
  };

  const handleDelete = async (id) => {
    if (!window.confirm(t('wms_alloc_del_conf'))) return;
    try {
      const res = await deleter(`/allocations/${id}`);
      if (res.ok) {
        toast.success(t('wms_alloc_deleted') || 'Allocation eliminada');
        loadAllocations(); loadInventory();
      } else {
        toast.error(t('wms_alloc_del_err'));
      }
    }
    catch { toast.error(t('error_connection')); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-foreground">{t('allocation')}</h2>
        <button onClick={() => setShowForm(!showForm)} className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm flex items-center gap-1.5" data-testid="new-allocation-btn">
          <Plus className="w-4 h-4" /> {t('wms_new_loc')}
        </button>
      </div>
      {showForm && (
        <div className="border border-border rounded-lg p-4 bg-secondary/30 space-y-3" data-testid="allocation-form">
          <div>
            <label className="text-xs uppercase tracking-wider text-muted-foreground font-bold block mb-1">{t('order')}</label>
            <select value={selectedOrder} onChange={e => setSelectedOrder(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="alloc-order-select">
              <option value="">{t('select_order_placeholder')}</option>
              {orders.map(o => (
                <option key={o.order_id} value={o.order_id}>
                  {o.order_number} - {o.client || o.customer || t('no_client')} ({o.wms_status || 'pending'})
                </option>
              ))}
            </select>
          </div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground font-bold">{t('items_to_allocate')}</div>
          {items.map((item, i) => (
            <div key={i} className="grid grid-cols-6 gap-2 items-end">
              <div className="col-span-3">
                <select value={item.sku ? `${item.sku}||${item.color}||${item.size}` : ''} onChange={e => selectInventoryItem(i, e.target.value)}
                  className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm text-foreground" data-testid={`alloc-inv-${i}`}>
                  <option value="">{t('select_inventory')}</option>
                  {availableInv.map(inv => (
                    <option key={`${inv.style || inv.sku}-${inv.color}-${inv.size}-${inv.inv_location || ''}`} value={`${inv.style || inv.sku}||${inv.color || ''}||${inv.size || ''}`}>
                      {inv.customer ? `[${inv.customer}] ` : ''}{inv.style || inv.sku} {inv.color} {inv.size} ({t('avail')}: {inv.available})
                    </option>
                  ))}
                </select>
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {item.maxQty > 0 && <span>{t('max')}: {item.maxQty}</span>}
              </div>
              <input type="number" placeholder={t('qty')} value={item.qty} onChange={e => updateItem(i, 'qty', e.target.value)} min="1" max={item.maxQty || 99999}
                className="px-2 py-1.5 bg-background border border-border rounded text-sm text-foreground" data-testid={`alloc-qty-${i}`} />
              <button onClick={() => removeItem(i)} className="p-1.5 text-muted-foreground hover:text-destructive"><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
          <button onClick={addItem} className="text-xs text-primary hover:underline flex items-center gap-1"><Plus className="w-3 h-3" /> {t('add_item')}</button>
          <div className="flex gap-2">
            <button onClick={handleSubmit} disabled={loading} className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm flex items-center gap-1.5 disabled:opacity-50" data-testid="alloc-submit">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />} {t('allocate_inventory')}
            </button>
            <button onClick={() => setShowForm(false)} className="px-4 py-2 bg-secondary text-foreground rounded text-sm">{t('cancel')}</button>
          </div>
        </div>
      )}
      <div className="space-y-2">
        {allocations.map(a => (
          <div key={a.allocation_id} className="border border-border rounded-lg p-3 bg-card" data-testid={`alloc-${a.allocation_id}`}>
            <div className="flex items-center justify-between">
              <div>
                <span className="font-mono font-bold text-primary text-sm">{a.order_number}</span>
                <span className={`ml-2 text-xs px-2 py-0.5 rounded-full ${a.status === 'allocated' ? 'bg-orange-500/15 text-orange-400' : 'bg-green-500/15 text-green-400'}`}>{a.status}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{new Date(a.created_at).toLocaleDateString()}</span>
                <button onClick={() => handleDelete(a.allocation_id)} className="p-1 text-muted-foreground hover:text-destructive" title={t('delete')} data-testid={`alloc-delete-${a.allocation_id}`}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {(a.items || []).map((it, i) => <span key={i} className="text-xs bg-secondary px-2 py-1 rounded">{it.sku} {it.color} {it.size}: {it.qty}</span>)}
            </div>
          </div>
        ))}
        {allocations.length === 0 && <div className="text-center text-muted-foreground text-sm py-8">{t('no_allocations')}</div>}
      </div>
    </div>
  );
};
