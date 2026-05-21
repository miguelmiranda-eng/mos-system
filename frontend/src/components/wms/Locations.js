import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Printer, Plus, X, MapPin, Loader2, Edit3, Trash2, Search } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { API, fetcher, poster } from "./lib";

export const LocationsModule = () => {
  const { t } = useLang();
  const [locations, setLocations] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showNewLoc, setShowNewLoc] = useState(false);
  const [search, setSearch] = useState('');
  const [newLoc, setNewLoc] = useState({ name: '', zone: '', type: 'rack' });
  const [activeTab, setActiveTab] = useState('custom'); // 'custom' or 'system'

  const load = useCallback(() => {
    setLoading(true);
    fetcher('/locations')
      .then(setLocations)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreateLoc = async () => {
    const name = newLoc.name.trim().toUpperCase();
    if (!name) { toast.error(t('wms_name_req') || 'Nombre requerido'); return; }

    // Client-side check for immediate feedback
    if (locations.some(l => l.name.toUpperCase() === name)) {
      toast.error(`La ubicación '${name}' ya existe`);
      return;
    }

    setLoading(true);
    try {
      const res = await poster('/locations', { ...newLoc, name });
      if (res.ok) {
        toast.success(t('wms_loc_created') || 'Ubicación creada');
        setNewLoc({ name: '', zone: '', type: 'rack' });
        setShowNewLoc(false);
        load();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Error al crear ubicación');
      }
    } catch {
      toast.error(t('error_connection'));
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id, name) => {
    if (!window.confirm(`¿Estás seguro de eliminar la ubicación '${name}'?`)) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/locations/${id}`, { method: 'DELETE', credentials: 'include' });
      if (res.ok) {
        toast.success('Ubicación eliminada');
        load();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Error al eliminar');
      }
    } catch {
      toast.error(t('error_connection'));
    } finally {
      setLoading(false);
    }
  };

  const [editingLoc, setEditingLoc] = useState(null);

  const handleUpdateLoc = async () => {
    const name = editingLoc.name.trim().toUpperCase();
    if (!name) { toast.error(t('wms_name_req') || 'Nombre requerido'); return; }

    if (locations.some(l => l.name.toUpperCase() === name && l.location_id !== editingLoc.location_id)) {
      toast.error(`La ubicación '${name}' ya existe`);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API}/locations/${editingLoc.location_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, zone: editingLoc.zone.toUpperCase() }),
        credentials: 'include'
      });
      if (res.ok) {
        toast.success('Ubicación actualizada');
        setEditingLoc(null);
        load();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Error al actualizar');
      }
    } catch {
      toast.error(t('error_connection'));
    } finally {
      setLoading(false);
    }
  };

  const filtered = locations.filter(l => {
    const summary = l.inventory_summary || { total_units: 0, skus_count: 0, items: [] };
    const matchesSearch = l.name.toLowerCase().includes(search.toLowerCase()) ||
                         (l.zone || '').toLowerCase().includes(search.toLowerCase()) ||
                         summary.items.some(item => item.style.toLowerCase().includes(search.toLowerCase()));
    const matchesTab = activeTab === 'custom' ? l.is_custom === true : l.is_custom !== true;
    return matchesSearch && matchesTab;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-black uppercase tracking-tighter">Gestión de Ubicaciones</h2>
          <p className="text-xs text-muted-foreground font-bold uppercase tracking-widest opacity-60">Mapa lógico del almacén</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => window.open(`${API}/locations/print?ids=all`, '_blank')}
            className="flex items-center gap-2 px-6 py-3 bg-emerald-500 text-white rounded-2xl font-black uppercase tracking-widest text-xs hover:scale-105 transition-all shadow-lg shadow-emerald-500/20"
          >
            <Printer className="w-4 h-4" />
            Imprimir Etiquetas
          </button>
          <button
            onClick={() => setShowNewLoc(!showNewLoc)}
            className="flex items-center gap-2 px-6 py-3 bg-primary text-black rounded-2xl font-black uppercase tracking-widest text-xs hover:scale-105 transition-all shadow-lg"
          >
            {showNewLoc ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
            {showNewLoc ? t('cancel') : 'Nueva Ubicación'}
          </button>
        </div>
      </div>

      {/* Tabs de Separación */}
      <div className="flex gap-2 p-1 bg-secondary/20 rounded-2xl w-fit border border-border/40">
        <button
          onClick={() => setActiveTab('custom')}
          className={`px-6 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'custom' ? 'bg-primary text-black shadow-lg shadow-primary/20' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/40'}`}
        >
          Mis Locaciones
          <span className="ml-2 px-1.5 py-0.5 bg-black/10 rounded-md text-[9px]">{locations.filter(l => l.is_custom).length}</span>
        </button>
        <button
          onClick={() => setActiveTab('system')}
          className={`px-6 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'system' ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/20' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/40'}`}
        >
          Sistema / Inventario
          <span className="ml-2 px-1.5 py-0.5 bg-white/10 rounded-md text-[9px]">{locations.filter(l => !l.is_custom).length}</span>
        </button>
      </div>

      {showNewLoc && (
        <div className="p-6 bg-card/60 backdrop-blur-xl border border-primary/30 rounded-[2.5rem] shadow-2xl animate-in fade-in zoom-in duration-300">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground ml-2">Nombre de Locación</label>
              <div className="relative">
                <MapPin className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-primary" />
                <input
                  placeholder="Ej: A-01-01"
                  value={newLoc.name}
                  onChange={e => setNewLoc(p => ({ ...p, name: e.target.value.toUpperCase() }))}
                  className="w-full pl-12 pr-4 py-4 bg-background border border-border rounded-2xl text-lg font-black font-mono focus:ring-4 focus:ring-primary/10 transition-all"
                />
              </div>
              {locations.some(l => l.name.toUpperCase() === newLoc.name.trim().toUpperCase()) && (
                <p className="text-[10px] font-bold text-red-400 mt-1 ml-2 uppercase animate-pulse">Esta ubicación ya existe</p>
              )}
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground ml-2">Zona / Pasillo</label>
              <input
                placeholder="Ej: ZONA A"
                value={newLoc.zone}
                onChange={e => setNewLoc(p => ({ ...p, zone: e.target.value.toUpperCase() }))}
                className="w-full px-4 py-4 bg-background border border-border rounded-2xl text-lg font-black focus:ring-4 focus:ring-primary/10 transition-all"
              />
            </div>
            <div className="flex items-end pb-1">
              <button
                onClick={handleCreateLoc}
                disabled={loading || !newLoc.name || locations.some(l => l.name.toUpperCase() === newLoc.name.trim().toUpperCase())}
                className="w-full py-4 bg-primary text-black rounded-2xl font-black uppercase tracking-widest text-sm shadow-xl shadow-primary/20 hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-30"
              >
                {loading ? <Loader2 className="w-5 h-5 animate-spin mx-auto" /> : 'Confirmar Creación'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="relative group">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground group-focus-within:text-primary transition-colors" />
        <input
          placeholder={`Buscar en ${activeTab === 'custom' ? 'mis locaciones' : 'locaciones de sistema'}...`}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-12 pr-4 py-4 bg-card/40 border border-border/40 rounded-2xl text-sm font-bold focus:ring-4 focus:ring-primary/10 transition-all"
        />
      </div>

      <div className="space-y-10 pb-10">
        {(() => {
          const grouped = filtered.reduce((acc, l) => {
            const zone = l.zone || 'SIN ZONA';
            if (!acc[zone]) acc[zone] = [];
            acc[zone].push(l);
            return acc;
          }, {});

          const sortedZones = Object.keys(grouped).sort();

          if (filtered.length === 0) return (
            <div className="py-20 text-center bg-secondary/10 rounded-[3rem] border-2 border-dashed border-border/20">
              <MapPin className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
              <p className="text-sm font-black text-muted-foreground uppercase tracking-widest">No se encontraron ubicaciones</p>
            </div>
          );

          return sortedZones.map(zone => (
            <div key={zone} className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="h-6 w-1 bg-primary rounded-full shadow-[0_0_10px_rgba(255,193,7,0.5)]" />
                <h3 className="text-lg font-black uppercase tracking-tighter flex items-center gap-2">
                  {zone}
                  <span className="text-[10px] font-bold bg-secondary/50 px-2.5 py-1 rounded-full text-muted-foreground">
                    {grouped[zone].length} {t('wms_locations') || 'UBICACIONES'}
                  </span>
                </h3>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                {grouped[zone].map(l => {
                  const summary = l.inventory_summary || { total_units: 0, skus_count: 0, items: [] };
                  const isEmpty = summary.total_units === 0;

                  return (
                    <div
                      key={l.location_id}
                      className={`group p-5 bg-card/40 border border-border/40 rounded-[2rem] hover:border-primary/40 transition-all hover:scale-[1.02] hover:shadow-xl relative flex flex-col ${activeTab === 'system' ? 'border-l-4 border-l-indigo-500/50' : ''}`}
                    >
                      <div className="flex items-start justify-between mb-4 gap-2">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={`w-12 h-12 flex-shrink-0 rounded-2xl flex items-center justify-center transition-all ${isEmpty ? 'bg-secondary/20 text-muted-foreground/30' : 'bg-primary/10 text-primary shadow-inner shadow-primary/10'}`}>
                            <MapPin className="w-6 h-6" />
                          </div>
                          <div className="min-w-0">
                            <div className="font-mono font-black text-xl tracking-tighter text-foreground leading-none truncate">{l.name}</div>
                            <div className="text-[10px] font-bold text-muted-foreground/60 uppercase tracking-widest mt-0.5">{zone}</div>
                          </div>
                        </div>

                        {/* Acciones - Ahora integradas en el flex para no encimarse */}
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0 pt-1">
                          <button
                            onClick={() => window.open(`${API}/locations/print?ids=${l.location_id}`, '_blank')}
                            className="p-2 text-muted-foreground hover:text-primary transition-all"
                            title="Imprimir etiqueta"
                          >
                            <Printer className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => setEditingLoc({ location_id: l.location_id, name: l.name, zone: l.zone || '' })}
                            className="p-2 text-muted-foreground hover:text-yellow-500 transition-all"
                            title="Editar ubicación"
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDelete(l.location_id, l.name)}
                            className="p-2 text-muted-foreground hover:text-red-500 transition-all"
                            title="Eliminar ubicación"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      {/* Resumen de Inventario */}
                      <div className="flex-1 mt-2 space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/40">Inventario</span>
                          <span className={`text-xs font-black tabular-nums ${isEmpty ? 'text-muted-foreground/30' : 'text-emerald-500'}`}>
                            {summary.total_units} PCS
                          </span>
                        </div>

                        {!isEmpty ? (
                          <div className="space-y-1.5 p-3 bg-black/10 rounded-2xl border border-white/5">
                            {summary.items.map((item, idx) => (
                              <div key={idx} className="flex items-center justify-between text-[10px] font-bold">
                                <span className="truncate text-foreground/80 pr-2">{item.style}</span>
                                <span className="text-muted-foreground tabular-nums">{item.units}</span>
                              </div>
                            ))}
                            {summary.skus_count > 5 && (
                              <div className="pt-1.5 mt-1.5 border-t border-white/5 text-[9px] font-black text-center text-primary/40 uppercase tracking-tighter">
                                + {summary.skus_count - 5} {t('more') || 'MÁS'} SKUS
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="py-4 text-center border border-dashed border-border/20 rounded-2xl">
                            <span className="text-[10px] font-bold text-muted-foreground/20 uppercase tracking-widest">Vacio</span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ));
        })()}
      </div>
      {editingLoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md animate-in fade-in duration-200">
          <div className="w-full max-w-md p-6 bg-card border border-border rounded-[2.5rem] shadow-2xl space-y-6 mx-4">
            <div>
              <h3 className="text-xl font-black uppercase tracking-tighter">Editar Ubicación</h3>
              <p className="text-xs text-muted-foreground font-bold uppercase tracking-widest opacity-60">Modificar parámetros de la ubicación</p>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground ml-2">Nombre de Locación</label>
                <input
                  value={editingLoc.name}
                  onChange={e => setEditingLoc(p => ({ ...p, name: e.target.value.toUpperCase() }))}
                  className="w-full px-4 py-3.5 bg-background border border-border rounded-2xl text-lg font-black font-mono focus:ring-4 focus:ring-primary/10 transition-all"
                />
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground ml-2">Zona / Pasillo</label>
                <input
                  value={editingLoc.zone}
                  onChange={e => setEditingLoc(p => ({ ...p, zone: e.target.value.toUpperCase() }))}
                  className="w-full px-4 py-3.5 bg-background border border-border rounded-2xl text-lg font-black focus:ring-4 focus:ring-primary/10 transition-all"
                />
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleUpdateLoc}
                disabled={loading || !editingLoc.name}
                className="flex-1 py-4 bg-primary text-black rounded-2xl font-black uppercase tracking-widest text-xs shadow-xl shadow-primary/20 hover:scale-[1.02] active:scale-95 transition-all"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'Guardar Cambios'}
              </button>
              <button
                onClick={() => setEditingLoc(null)}
                className="flex-1 py-4 bg-secondary text-foreground rounded-2xl font-black uppercase tracking-widest text-xs hover:bg-secondary/80 transition-all"
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
