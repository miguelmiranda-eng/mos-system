import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { MapPin, ScanLine, Loader2, ClipboardCheck, Package, ChevronRight, X, Keyboard } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { API, fetcher, poster, logLoadError } from "./lib";
import { BoxStatus } from "./constants";
import { cls } from "./ui";

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
  // Scannable location input: default ON, fallback to manual select if toggled
  const [manualMode, setManualMode] = useState(false);
  const [scanInput, setScanInput] = useState('');
  // When a scan resolves to a valid location, store the match here to show overlay
  const [pendingConfirm, setPendingConfirm] = useState(null);

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

  const handlePutaway = async (overrideLocation) => {
    const targetLoc = overrideLocation || location;
    if (!boxId || !targetLoc) { toast.error(t('wms_box_loc_req')); return; }
    setLoading(true);
    try {
      const payload = { box_id: boxId, location: targetLoc };
      if (boxDetails && boxDetails.po) {
        payload.po = boxDetails.po; // Enviar PO posiblemente editado
      }
      const res = await poster('/putaway', payload);
      if (res.ok) {
        toast.success(t('wms_box_located', { boxId, location: targetLoc }));
        setBoxId('');
        setBoxDetails(null);
        setLocation('');
        loadPending();
      }
      else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error'); }
    } catch { toast.error(t('conn_error')); }
    finally { setLoading(false); }
  };

  // Scanner submission: validate against known locations, then show confirm overlay
  const handleScanSubmit = (e) => {
    if (e) e.preventDefault();
    const raw = scanInput.trim().toUpperCase();
    if (!raw) return;
    const match = locations.find(l => l.name.toUpperCase() === raw);
    if (!match) {
      toast.error(`Ubicación "${raw}" no existe`);
      setScanInput('');
      return;
    }
    if (!boxId) {
      toast.error('Primero escanea una caja');
      return;
    }
    setPendingConfirm(match);
  };

  const confirmPutaway = async () => {
    if (!pendingConfirm) return;
    const locName = pendingConfirm.name;
    setPendingConfirm(null);
    setScanInput('');
    await handlePutaway(locName);
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="border border-border rounded-lg p-4 bg-card space-y-3">
          <div className="text-sm font-semibold text-foreground flex items-center gap-2"><ScanLine className="w-4 h-4 text-muted-foreground" /> {t('wms_scan_input')}</div>
          <div className="relative">
            <input placeholder={t('wms_box_id_placeholder')} value={boxId} onChange={e => setBoxId(e.target.value.toUpperCase())} className={`${cls.input} font-mono`} data-testid="putaway-box-input" />
            {searching && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-primary animate-spin" />}
          </div>
          {/* Location: scannable input by default, manual <select> fallback */}
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {manualMode ? 'Seleccionar manual' : 'Escanear ubicación'}
            </span>
            <button
              type="button"
              onClick={() => { setManualMode(m => !m); setScanInput(''); setLocation(''); }}
              className="text-xs font-medium text-primary hover:underline flex items-center gap-1"
            >
              <Keyboard className="w-3 h-3" /> {manualMode ? 'Usar scanner' : 'Escribir manualmente'}
            </button>
          </div>

          {manualMode ? (
            <select value={location} onChange={e => setLocation(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded text-sm text-foreground" data-testid="putaway-loc-select">
              <option value="">{t('wms_select_location')}</option>
              {locations.map(l => <option key={l.location_id} value={l.name}>{l.name} {l.zone ? `(${l.zone})` : ''}</option>)}
            </select>
          ) : (
            <form onSubmit={handleScanSubmit}>
              <div className="relative">
                <ScanLine className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  type="text"
                  value={scanInput}
                  onChange={e => setScanInput(e.target.value.toUpperCase())}
                  placeholder="Escanea ubicación destino (Enter para confirmar)"
                  autoComplete="off"
                  className={`${cls.input} pl-10 font-mono`}
                  data-testid="putaway-loc-scan"
                />
              </div>
            </form>
          )}

          <button
            onClick={() => {
              if (!boxId || !location) { toast.error(t('wms_box_loc_req')); return; }
              const match = locations.find(l => l.name === location);
              if (!match) { toast.error(`Ubicación "${location}" no encontrada`); return; }
              setPendingConfirm(match);
            }}
            disabled={loading || !boxId || !location || !manualMode}
            className="w-full px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium flex items-center justify-center gap-2 hover:opacity-90 transition-colors disabled:opacity-50"
            data-testid="putaway-submit"
            title={!manualMode ? 'En modo scanner se confirma vía overlay' : 'Abrirá confirmación antes de aplicar'}
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
                   <div className="text-xs font-medium text-muted-foreground">{t('wms_label_sku')}</div>
                   <div className="text-sm font-semibold font-mono">{boxDetails.sku}</div>
                 </div>
                 <div className="text-right">
                   <div className="text-xs font-medium text-muted-foreground">{t('units')}</div>
                   <div className="text-sm font-semibold tabular-nums">{boxDetails.units}</div>
                 </div>
               </div>
               <div className="p-3 bg-muted/40 rounded-lg border border-border">
                 <label className="text-xs font-medium text-muted-foreground block mb-1">PO / ORDER (Editable)</label>
                 <input
                   value={boxDetails.po || ''}
                   onChange={e => setBoxDetails(p => ({ ...p, po: e.target.value }))}
                   className="w-full bg-transparent border-none p-0 text-sm font-medium focus:ring-0"
                 />
               </div>
            </div>
          ) : (
            <div className="text-center text-sm text-muted-foreground">
              {t('wms_scan_hint') || 'Escanea una caja para ver detalles'}
            </div>
          )}
        </div>
      </div>
        <div className="border border-border rounded-lg p-4 bg-card space-y-4">
          <div className="text-xs font-medium text-muted-foreground flex items-center gap-2">
          <Package className="w-4 h-4" /> {t('wms_unlocated_mat')}
        </div>
        <div className="space-y-2 max-h-[400px] overflow-auto custom-scrollbar pr-2 font-mono">
          {pendingBoxes.map(b => (
            <button
              key={b.box_id}
              onClick={() => setBoxId(b.box_id)}
              className={`w-full flex items-center justify-between p-3 rounded-md border transition-colors
                ${boxId === b.box_id ? 'bg-primary/10 border-primary text-primary' : 'bg-card border-border text-muted-foreground hover:bg-muted hover:text-foreground'}`}
            >
              <div className="flex flex-col items-start">
                <span className="text-xs font-semibold">{b.box_id}</span>
                <span className="text-xs opacity-60">{b.sku} / {b.units} UN</span>
              </div>
              <ChevronRight className="w-4 h-4 opacity-40" />
            </button>
          ))}
          {pendingBoxes.length === 0 && <div className="text-center text-muted-foreground text-xs py-4">{t('wms_all_located')}</div>}
        </div>
      </div>

      {/* Confirm overlay (shown after a valid location scan) */}
      {pendingConfirm && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-card border border-border rounded-lg w-full max-w-md shadow-xl p-6 space-y-5 animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ScanLine className="w-5 h-5 text-muted-foreground" />
                <h3 className="font-semibold text-sm">Confirmar Putaway</h3>
              </div>
              <button onClick={() => setPendingConfirm(null)} className="p-1 hover:bg-secondary rounded-lg transition-all" disabled={loading}>
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="bg-muted/40 rounded-lg p-4 space-y-3 border border-border">
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">Caja</div>
                <div className="font-mono font-semibold">{boxId}</div>
                {boxDetails?.sku && <div className="text-xs text-muted-foreground mt-1">{boxDetails.sku} · {boxDetails.units} pcs</div>}
              </div>
              <div className="border-t border-border/60 pt-3">
                <div className="text-xs font-medium text-muted-foreground mb-1">Ubicación destino</div>
                <div className="font-mono font-semibold text-lg">{pendingConfirm.name}</div>
                <div className="text-xs text-muted-foreground mt-1">
                  {pendingConfirm.zone || 'SIN ZONA'}
                  {pendingConfirm.inventory_summary?.total_units > 0 && (
                    <span className="ml-2 text-amber-600 dark:text-amber-400">· Ya ocupada: {pendingConfirm.inventory_summary.total_units} pcs</span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={confirmPutaway}
                disabled={loading}
                className="flex-1 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-md hover:opacity-90 active:scale-95 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardCheck className="w-4 h-4" />}
                Confirmar
              </button>
              <button
                onClick={() => setPendingConfirm(null)}
                disabled={loading}
                className="flex-1 py-3 bg-card border border-border text-foreground text-sm font-medium rounded-md hover:bg-muted transition-colors disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
