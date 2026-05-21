import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { FileDown, Loader2 } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { API, fetcher, logLoadError } from "./lib";

export const AsnModule = () => {
  const { t } = useLang();
  const [asns, setAsns] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(false);

  const loadAsns = useCallback(async () => {
    try {
      const data = await fetcher("/asn");
      setAsns(data || []);
    } catch (err) { logLoadError('ASNs')(err); }
  }, []);

  useEffect(() => { loadAsns(); }, [loadAsns]);

  const handleImport = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    setLoading(true);
    try {
      const res = await fetch(`${API}/asn/import`, { method: "POST", body: formData, credentials: 'include' });
      if (res.ok) { toast.success("ASN Importado"); loadAsns(); }
      else { toast.error("Error al importar"); }
    } catch { toast.error("Connection error"); }
    finally { setLoading(false); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-black uppercase tracking-tighter">Gestion de ASN</h2>
          <p className="text-xs text-muted-foreground font-bold uppercase tracking-widest">Pre-recibo y planeacion de bultos</p>
        </div>
        <div className="flex gap-3">
          <input type="file" id="asn-import" className="hidden" onChange={handleImport} />
          <label htmlFor="asn-import" className={`flex items-center gap-2 px-6 py-3 bg-indigo-500 text-white rounded-2xl cursor-pointer text-xs font-black uppercase tracking-widest hover:scale-105 transition-all shadow-lg ${loading ? 'opacity-50 pointer-events-none' : ''}`}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
            Importar ASN Excel
          </label>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {asns.map(a => (
          <div key={a.asn_id} className="group p-5 bg-card/40 border border-border/40 rounded-[2rem] hover:bg-card hover:border-primary/30 transition-all shadow-sm">
            <div className="flex justify-between items-start mb-4">
              <div>
                <div className="text-[10px] font-black uppercase text-primary tracking-widest">{a.asn_id}</div>
                <div className="text-lg font-black uppercase tracking-tight leading-tight">{a.vendor}</div>
              </div>
              <div className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest ${a.status === 'received' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-blue-500/10 text-blue-400 border border-blue-500/20'}`}>
                {a.status}
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between items-center text-[10px] font-bold uppercase text-muted-foreground border-b border-border/10 pb-2">
                <span>Items</span>
                <span className="text-foreground">{a.items?.length || 0}</span>
              </div>
              <div className="flex justify-between items-center text-[10px] font-bold uppercase text-muted-foreground">
                <span>Fecha Reg.</span>
                <span className="text-foreground">{new Date(a.created_at).toLocaleDateString()}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
      {asns.length === 0 && (
        <div className="py-20 text-center bg-secondary/10 rounded-[3rem] border-2 border-dashed border-border/20">
          <FileDown className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
          <p className="text-sm font-black text-muted-foreground uppercase tracking-widest">No hay ASNs registrados</p>
        </div>
      )}
    </div>
  );
};
