import { useState, useEffect, useCallback, useMemo } from "react";
import { Loader2, RefreshCw, Trash2, Camera, Images, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { fetcher } from "./lib";
import { Card, StatCard, Btn, EmptyState } from "./ui";

// Inventario por foto — panel PC. El piso sólo TOMA FOTOS en la PDA (sin datos,
// sin contenedor); aquí se revisan las fotos guardadas, segmentadas en packing
// lists de 550. El armado del packing con IA se cuelga de aquí (paso siguiente).

const API = `${process.env.REACT_APP_BACKEND_URL}/api/wms`;
// Las fotos se sirven en /api/uploads (fuera de /api/wms); URL relativa -> absoluta.
const IMG = (u) => (u ? `${process.env.REACT_APP_BACKEND_URL}${u}` : "");

export const PhotoInventoryTab = () => {
  const [packing, setPacking] = useState(0);      // 0 = todos
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetcher(`/recon/photo/archive?limit=500${packing ? `&packing=${packing}` : ""}`));
    } catch { toast.error("No se pudo cargar el inventario por foto"); }
    finally { setLoading(false); }
  }, [packing]);

  useEffect(() => { load(); }, [load]);

  const items = useMemo(() => data?.items || [], [data]);
  const packings = useMemo(() => data?.packings || [], [data]);
  const total = data?.total || 0;
  const size = data?.packing_size || 550;

  const del = async (photo_id) => {
    if (!window.confirm("¿Borrar esta foto? (no se puede deshacer)")) return;
    try {
      const res = await fetch(`${API}/recon/photo/archive/${photo_id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) { const e = await res.json().catch(() => ({})); toast.error(e.detail || "No se pudo borrar"); return; }
      toast.success("Foto borrada"); load();
    } catch { toast.error("Error de conexión"); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <select value={packing} onChange={e => setPacking(Number(e.target.value))}
          className="h-9 px-3 rounded-md bg-card border border-input text-sm focus:outline-none focus:ring-2 focus:ring-ring/25">
          <option value={0}>Todos los packing</option>
          {packings.map(p => (
            <option key={p.packing_no} value={p.packing_no}>Packing #{p.packing_no} ({p.fotos})</option>
          ))}
        </select>
        <Btn onClick={load} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Actualizar
        </Btn>
        <Btn variant="primary" className="ml-auto" disabled title="Próximo paso: leer las fotos con IA y armar el packing list">
          <Sparkles className="w-4 h-4" /> Generar packing con IA (pendiente)
        </Btn>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Fotos guardadas" value={total.toLocaleString()} />
        <StatCard label="Packing lists" value={packings.length} sub={`de ${size} c/u`} />
        <StatCard label="En esta vista" value={items.length.toLocaleString()}
          sub={packing ? `packing #${packing}` : "todos"} />
      </div>

      <Card className="overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <Camera className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Fotos guardadas {items.length ? `(${items.length})` : ""}</span>
        </div>
        {loading && !data ? (
          <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : !items.length ? (
          <EmptyState title="Sin fotos" hint="El piso las toma desde Inventario por foto en la PDA." />
        ) : (
          <div className="p-4 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2">
            {items.map(ph => (
              <div key={ph.photo_id} className="relative group rounded-lg overflow-hidden border border-border bg-muted/30">
                <a href={IMG(ph.photo_url)} target="_blank" rel="noreferrer" title={`#${ph.seq} · packing ${ph.packing_no}`}>
                  <img src={IMG(ph.photo_url)} alt="" loading="lazy" className="w-full aspect-square object-cover" />
                </a>
                <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/60 text-[9px] font-bold text-white tabular-nums">
                  #{ph.seq}
                </div>
                <button onClick={() => del(ph.photo_id)} title="Borrar foto"
                  className="absolute bottom-1 right-1 p-1 rounded-md bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600/80">
                  <Trash2 className="w-3.5 h-3.5 text-white" />
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="flex items-start gap-2 text-xs text-muted-foreground px-1">
        <Images className="w-4 h-4 shrink-0 mt-0.5" />
        <span>
          Cada {size} fotos forman un packing list (por orden de captura). Cuando termines de capturar,
          el siguiente paso es leer las fotos con IA —por partes, no todas de golpe— y armar cada packing con su información.
        </span>
      </div>
    </div>
  );
};

export default PhotoInventoryTab;
