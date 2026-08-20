import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { RefreshCw, Factory } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, poster, logLoadError } from "./lib";
import { Btn, Chip, EmptyState, ModuleToolbar } from "./ui";

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
      <ModuleToolbar
        right={
          <Btn variant="ghost" onClick={load}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`}
      />
          </Btn>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {orders.map(o => (
          <div key={o.order_number} className="p-5 bg-card border border-border rounded-lg transition-colors">
            <div className="flex justify-between items-start mb-4">
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">Pick Ticket en Corte</div>
                <div className="text-2xl font-semibold tracking-tight tabular-nums">#{o.order_number}</div>
                <div className="text-xs text-muted-foreground truncate max-w-[200px]">{o.customer}</div>
              </div>
              <Chip className="tabular-nums">
                {o.total_qty} PCS
              </Chip>
            </div>

            <div className="space-y-2 mb-4 bg-muted/40 p-3 rounded-md border border-border/60">
              <div className="flex justify-between items-center text-xs font-medium text-muted-foreground mb-2">
                <span>Material Surtido</span>
              </div>
              {o.items.map((item, idx) => (
                <div key={idx} className="flex justify-between items-center text-xs gap-4">
                  <span className="text-foreground/80 truncate">{item.sku} - {item.size}</span>
                  <span className="tabular-nums font-medium text-muted-foreground">{item.qty || item.units} PCS</span>
                </div>
              ))}
            </div>

            <Btn
              variant="primary"
              onClick={() => handleDeliver(o)}
              className="w-full"
            >
              <Factory className="w-4 h-4" />
              Surtir a Producción
            </Btn>
          </div>
        ))}
      </div>

      {orders.length === 0 && !loading && (
        <EmptyState art="done" title="No hay órdenes en proceso de corte" />
      )}
    </div>
  );
};
