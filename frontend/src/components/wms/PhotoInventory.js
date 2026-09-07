import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Loader2, RefreshCw, Trash2, Camera, Images, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher } from "./lib";
import { Card, StatCard, Btn, EmptyState } from "./ui";

// Inventario por foto — panel PC. El piso sólo TOMA FOTOS en la PDA (sin datos,
// sin contenedor); aquí se revisan las fotos guardadas, segmentadas en packing
// lists de 550. El armado del packing con IA se cuelga de aquí (paso siguiente).

const API = `${process.env.REACT_APP_BACKEND_URL}/api/wms`;
// Las fotos se sirven en /api/uploads (fuera de /api/wms); URL relativa -> absoluta.
const IMG = (u) => (u ? `${process.env.REACT_APP_BACKEND_URL}${u}` : "");

export const PhotoInventoryTab = () => {
  const { t } = useLang();
  // La carga no debe re-correr al cambiar idioma: el traductor va por ref.
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);
  const [packing, setPacking] = useState(0);      // 0 = todos
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetcher(`/recon/photo/archive?limit=500${packing ? `&packing=${packing}` : ""}`));
    } catch { toast.error(tRef.current("wms_photo_load_err")); }
    finally { setLoading(false); }
  }, [packing]);

  useEffect(() => { load(); }, [load]);

  const items = useMemo(() => data?.items || [], [data]);
  const packings = useMemo(() => data?.packings || [], [data]);
  const total = data?.total || 0;
  const size = data?.packing_size || 550;

  const del = async (photo_id) => {
    if (!window.confirm(t("wms_photo_delete_conf"))) return;
    try {
      const res = await fetch(`${API}/recon/photo/archive/${photo_id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) { const e = await res.json().catch(() => ({})); toast.error(e.detail || t("wms_photo_delete_err")); return; }
      toast.success(t("wms_photo_deleted")); load();
    } catch { toast.error(t("wms_conn_err")); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <select value={packing} onChange={e => setPacking(Number(e.target.value))}
          className="h-9 px-3 rounded-md bg-card border border-input text-sm focus:outline-none focus:ring-2 focus:ring-ring/25">
          <option value={0}>{t("wms_photo_all_packings")}</option>
          {packings.map(p => (
            <option key={p.packing_no} value={p.packing_no}>{t("wms_photo_packing_opt", { n: p.packing_no, count: p.fotos })}</option>
          ))}
        </select>
        <Btn onClick={load} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} {t("wms_refresh")}
        </Btn>
        <Btn variant="primary" className="ml-auto" disabled title={t("wms_photo_ai_title")}>
          <Sparkles className="w-4 h-4" /> {t("wms_photo_ai_btn")}
        </Btn>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <StatCard label={t("wms_photo_saved")} value={total.toLocaleString()} />
        <StatCard label={t("wms_photo_packing_lists")} value={packings.length} sub={t("wms_photo_each_of", { n: size })} />
        <StatCard label={t("wms_photo_in_view")} value={items.length.toLocaleString()}
          sub={packing ? t("wms_photo_packing_n", { n: packing }) : t("wms_photo_all")} />
      </div>

      <Card className="overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <Camera className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-semibold">{t("wms_photo_saved")} {items.length ? `(${items.length})` : ""}</span>
        </div>
        {loading && !data ? (
          <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : !items.length ? (
          <EmptyState art="scan" title={t("wms_photo_empty_title")} hint={t("wms_photo_empty_hint")} />
        ) : (
          <div className="p-4 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2">
            {items.map(ph => (
              <div key={ph.photo_id} className="relative group rounded-lg overflow-hidden border border-border bg-muted/30">
                <a href={IMG(ph.photo_url)} target="_blank" rel="noreferrer" title={t("wms_photo_thumb_title", { seq: ph.seq, n: ph.packing_no })}>
                  <img src={IMG(ph.photo_url)} alt="" loading="lazy" className="w-full aspect-square object-cover" />
                </a>
                <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/60 text-[9px] font-bold text-white tabular-nums">
                  #{ph.seq}
                </div>
                <button onClick={() => del(ph.photo_id)} title={t("wms_photo_delete_btn")}
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
        <span>{t("wms_photo_footer", { n: size })}</span>
      </div>
    </div>
  );
};

export default PhotoInventoryTab;
