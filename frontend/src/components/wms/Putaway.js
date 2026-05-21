import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { MapPin, ScanLine, Loader2, ClipboardCheck, Plus, Printer, Box, Package, ChevronRight } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { API, fetcher, poster, logLoadError } from "./lib";
import { BoxStatus } from "./constants";

export const PutawayModule = () => {
  const { t } = useLang();
  const [boxId, setBoxId] = useState('');
  const [location, setLocation] = useState('');
  const [locations, setLocations] = useState([]);
  const [pendingBoxes, setPendingBoxes] = useState([]);
  const [boxDetails, setBoxDetails] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [newLoc, setNewLoc] = useState({ name: '', zone: '', type: 'rack' });
  const [showNewLoc, setShowNewLoc] = useState(false);

  const loadLocations = useCallback(() => { fetcher('/locations?summary=false').then(setLocations).catch(logLoadError('data')); }, []);
  const loadPending = useCallback(() => { fetcher(`/boxes?status=${BoxStatus.RECEIVED}`).then(setPendingBoxes).catch(logLoadError('data')); }, []);
  useEffect(() => { loadLocations(); loadPending(); }, [loadLocations, loadPending]);

  const fetchBoxDetails = useCallback(async (id) => {
    if (!id || id.length < 3) { setBoxDetails(null); return; }
    setSearching(true);
    try {
      const res = await fetcher(`/boxes/${id}`);
      if (res && res.box_id) setBoxDetails(res);
      else setBoxDetails(null);
    } catch { setBoxDetails(null); }
    finally { setSearching(false); }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (boxId) fetchBoxDetails(boxId);
    }, 500);
    return () => clearTimeout(timer);
  }, [boxId, fetchBoxDetails]);

  const handlePutaway = async () => {
    if (!boxId || !location) { toast.error(t('wms_box_loc_req')); return; }
    setLoading(true);
    try {
      const payload = { box_id: boxId, location };
      if (boxDetails && boxDetails.po) {
        payload.po = boxDetails.po; // Enviar PO posiblemente editado
      }
      const res = await poster('/putaway', payload);
      if (res.ok) {
        toast.success(t('wms_box_located', { boxId, location }));
        setBoxId('');
        setBoxDetails(null);
        loadPending();
      }
      else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error'); }
    } catch { toast.error(t('conn_error')); }
    finally { setLoading(false); }
  };

  const handleCreateLoc = async () => {
    if (!newLoc.name) { toast.error(t('wms_name_req')); return; }
    const res = await poster('/locations', newLoc);
    if (res.ok) { toast.success(t('wms_loc_created')); setNewLoc({ name: '', zone: '', type: 'rack' }); setShowNewLoc(false); loadLocations(); }
    else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error'); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="text-xs font-black uppercase tracking-widest text-muted-foreground bg-secondary/50 px-3 py-1 rounded-full border border-border/40 flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse" />
          {t('wms_mod_putaway')}
        </div>
        <button
          onClick={() => setShowNewLoc(!showNewLoc)}
          className="px-4 py-2 bg-secondary text-foreground border border-border/40 rounded-xl font-bold uppercase tracking-wider text-xs flex items-center gap-2 transition-all hover:bg-secondary/80 shadow-lg"
        >
          <MapPin className="w-4 h-4 text-primary" /> {showNewLoc ? t('close') : `+ ${t('wms_new_loc_btn') || t('add')}`}
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="border border-border rounded-lg p-4 bg-card space-y-3">
          <div className="text-sm font-bold text-foreground flex items-center gap-2"><ScanLine className="w-4 h-4 text-primary" /> {t('wms_scan_input')}</div>
          <div className="relative">
            <input placeholder={t('wms_box_id_placeholder')} value={boxId} onChange={e => setBoxId(e.target.value.toUpperCase())} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground font-mono" data-testid="putaway-box-input" />
            {searching && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-primary animate-spin" />}
          </div>
          <select value={location} onChange={e => setLocation(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="putaway-loc-select">
            <option value="">{t('wms_select_location')}</option>
            {locations.map(l => <option key={l.location_id} value={l.name}>{l.name} {l.zone ? `(${l.zone})` : ''}</option>)}
          </select>
          <button
            onClick={handlePutaway}
            disabled={loading || !boxId || !location}
            className="w-full px-4 py-2 bg-primary text-primary-foreground rounded text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50"
            data-testid="putaway-submit"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardCheck className="w-4 h-4" />}
            {t('wms_locate_btn')}
          </button>
        </div>

        {/* Box Info View */}
        <div className="border border-border rounded-lg p-4 bg-card flex flex-col justify-center min-h-[150px]">
          {boxDetails ? (
            <div className="space-y-3 animate-in fade-in duration-300">
               <div className="flex justify-between items-start">
                 <div>
                   <div className="text-[10px] font-black uppercase text-muted-foreground">{t('wms_label_sku')}</div>
                   <div className="text-sm font-black text-primary">{boxDetails.sku}</div>
                 </div>
                 <div className="text-right">
                   <div className="text-[10px] font-black uppercase text-muted-foreground">{t('units')}</div>
                   <div className="text-sm font-black">{boxDetails.units}</div>
                 </div>
               </div>
               <div className="p-3 bg-secondary/50 rounded-xl border border-border/20">
                 <label className="text-[9px] font-black uppercase text-blue-400 block mb-1">PO / ORDER (Editable)</label>
                 <input
                   value={boxDetails.po || ''}
                   onChange={e => setBoxDetails(p => ({ ...p, po: e.target.value }))}
                   className="w-full bg-transparent border-none p-0 text-sm font-bold focus:ring-0"
                 />
               </div>
            </div>
          ) : (
            <div className="text-center opacity-30 italic text-xs">
              <Box className="w-8 h-8 mx-auto mb-2 opacity-20" />
              {t('wms_scan_hint') || 'Escanea una caja para ver detalles'}
            </div>
          )}
        </div>
      </div>
        <div className="border border-border rounded-lg p-4 bg-card space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-bold text-foreground flex items-center gap-2"><MapPin className="w-4 h-4 text-primary" /> {t('wms_locations')} ({locations.length})</div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => window.open(`${API}/locations/print?ids=all`, '_blank')}
                className="text-[10px] font-black uppercase tracking-widest text-emerald-500 hover:text-emerald-400 flex items-center gap-1 bg-emerald-500/10 px-2 py-1 rounded-lg transition-all"
                title="Imprimir todas las ubicaciones"
              >
                <Printer className="w-3 h-3" /> Imprimir Todo
              </button>
              <button onClick={() => setShowNewLoc(!showNewLoc)} className="text-xs text-primary hover:underline flex items-center gap-1">
                <Plus className="w-3 h-3" /> {t('add')}
              </button>
            </div>
          </div>
          {showNewLoc && (
            <div className="flex gap-2">
              <input placeholder={t('wms_loc_name_placeholder')} value={newLoc.name} onChange={e => setNewLoc(p => ({ ...p, name: e.target.value }))} className="flex-1 px-2 py-1.5 bg-background border border-border rounded text-sm text-foreground" />
              <input placeholder={t('wms_zone')} value={newLoc.zone} onChange={e => setNewLoc(p => ({ ...p, zone: e.target.value }))} className="w-20 px-2 py-1.5 bg-background border border-border rounded text-sm text-foreground" />
              <button onClick={handleCreateLoc} className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm">{t('wms_create_btn')}</button>
            </div>
          )}
          <div className="max-h-40 overflow-auto space-y-1 pr-1 custom-scrollbar">
            {locations.map(l => (
              <div key={l.location_id} className="flex items-center justify-between px-2 py-1.5 text-xs bg-secondary/50 rounded group hover:bg-secondary transition-colors">
                <div className="flex flex-col">
                  <span className="font-mono font-bold text-foreground">{l.name}</span>
                  <span className="text-[9px] text-muted-foreground uppercase font-black tracking-tighter">{l.zone || 'SIN ZONA'}</span>
                </div>
                <button
                  onClick={() => window.open(`${API}/locations/print?ids=${l.location_id}`, '_blank')}
                  className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-primary/20 rounded text-primary transition-all"
                  title="Imprimir etiqueta"
                >
                  <Printer className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="border border-border/20 rounded-3xl p-6 bg-card/40 backdrop-blur-sm shadow-xl space-y-4">
          <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground opacity-60 flex items-center gap-2">
          <Package className="w-4 h-4" /> {t('wms_unlocated_mat')}
        </div>
        <div className="space-y-2 max-h-[400px] overflow-auto custom-scrollbar pr-2 font-mono">
          {pendingBoxes.map(b => (
            <button
              key={b.box_id}
              onClick={() => setBoxId(b.box_id)}
              className={`w-full flex items-center justify-between p-3 rounded-xl border transition-all
                ${boxId === b.box_id ? 'bg-primary/20 border-primary text-primary shadow-lg shadow-primary/10' : 'bg-secondary/40 border-border/10 text-muted-foreground hover:bg-secondary hover:text-foreground'}`}
            >
              <div className="flex flex-col items-start">
                <span className="text-xs font-black">{b.box_id}</span>
                <span className="text-[10px] opacity-60">{b.sku} / {b.units} UN</span>
              </div>
              <ChevronRight className="w-4 h-4 opacity-40" />
            </button>
          ))}
          {pendingBoxes.length === 0 && <div className="text-center text-muted-foreground text-xs py-4">{t('wms_all_located')}</div>}
        </div>
      </div>
    </div>
  );
};
