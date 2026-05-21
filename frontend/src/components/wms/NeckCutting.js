import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { RefreshCw, Factory, Scissors } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, poster, logLoadError } from "./lib";

export const NeckCuttingModule = () => {
  const { t } = useLang();
  const [orders, setOrders] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetcher("/neck-cutting");
      setOrders(data || []);
    } catch (err) { logLoadError('neck-cutting orders')(err); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDeliver = async (order) => {
    if (!window.confirm(`¿Surtir material de la orden #${order.order_number} a producción? Se descontará del inventario global.`)) return;
    try {
      const itemsToDeliver = order.items.map(i => ({ box_id: i.box_id, qty: i.units || i.qty || 0 }));
      const res = await poster("/neck-cutting/deliver", {
        order_number: order.order_number,
        items: itemsToDeliver
      });
      if (res.ok) {
        toast.success("Material surtido a producción exitosamente");
        load();
      } else {
        toast.error("Error al surtir material");
      }
    } catch {
      toast.error("Error de conexión");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-black uppercase tracking-tighter text-pink-500">Área de Corte (Neck)</h2>
          <p className="text-xs text-muted-foreground font-bold uppercase tracking-widest opacity-60">Órdenes en proceso de corte y habilitado</p>
        </div>
        <button onClick={load} className="p-3 bg-secondary/20 rounded-2xl hover:bg-secondary/40 transition-all">
          <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {orders.map(o => (
          <div key={o.order_number} className="group p-6 bg-card/40 border border-border/40 rounded-[2.5rem] hover:border-pink-500/40 transition-all shadow-sm">
            <div className="flex justify-between items-start mb-6">
              <div>
                <div className="text-[10px] font-black uppercase text-pink-500 tracking-widest mb-1">Pick Ticket en Corte</div>
                <div className="text-2xl font-black uppercase tracking-tighter">#{o.order_number}</div>
                <div className="text-[10px] font-bold text-muted-foreground uppercase truncate max-w-[200px]">{o.customer}</div>
              </div>
              <div className="px-4 py-2 bg-pink-500/10 text-pink-500 border border-pink-500/20 rounded-2xl text-xs font-black uppercase tracking-widest">
                {o.total_qty} PCS
              </div>
            </div>

            <div className="space-y-3 mb-6 bg-black/10 p-4 rounded-2xl border border-white/5">
              <div className="flex justify-between items-center text-[10px] font-black uppercase text-muted-foreground/40 mb-2">
                <span>Material Surtido</span>
              </div>
              {o.items.map((item, idx) => (
                <div key={idx} className="flex justify-between items-center text-xs font-bold gap-4">
                  <span className="text-foreground/80 truncate">{item.sku} - {item.size}</span>
                  <span className="tabular-nums text-muted-foreground bg-black/20 px-2 py-0.5 rounded">{item.qty || item.units} PCS</span>
                </div>
              ))}
            </div>

            <button
              onClick={() => handleDeliver(o)}
              className="w-full py-4 bg-pink-500 text-white rounded-2xl font-black uppercase tracking-widest text-[10px] hover:scale-[1.02] active:scale-95 transition-all shadow-lg shadow-pink-500/20 flex items-center justify-center gap-2"
            >
              <Factory className="w-4 h-4" />
              Surtir a Producción
            </button>
          </div>
        ))}
      </div>

      {orders.length === 0 && !loading && (
        <div className="py-20 text-center bg-secondary/10 rounded-[3rem] border-2 border-dashed border-border/20">
          <Scissors className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
          <p className="text-sm font-black text-muted-foreground uppercase tracking-widest">No hay órdenes en proceso de corte</p>
        </div>
      )}
    </div>
  );
};
