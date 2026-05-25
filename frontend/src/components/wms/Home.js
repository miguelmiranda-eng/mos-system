import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Trash2, Tag, MapPin, Layers } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, poster, deleter, logLoadError } from "./lib";

const SECTIONS = [
  { type: 'descriptions', label: 'Descripciones', desc: 'Valores para el campo "description" en Receiving', icon: Tag, color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20' },
  { type: 'countries', label: 'Países de origen', desc: 'Valores para "country_of_origin" en Receiving', icon: MapPin, color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20' },
  { type: 'fabrics', label: 'Contenido / Fabric', desc: 'Valores para "fabric_content" en Receiving', icon: Layers, color: 'text-purple-400', bg: 'bg-purple-500/10', border: 'border-purple-500/20' },
];

export const HomeModule = () => {
  const { t } = useLang();
  const [catalogs, setCatalogs] = useState({ descriptions: [], countries: [], fabrics: [] });
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState({ descriptions: '', countries: '', fabrics: '' });
  const [saving, setSaving] = useState(null); // 'descriptions' | 'countries' | 'fabrics' | null
  const [deleting, setDeleting] = useState(null); // catalog_id being deleted

  const load = useCallback(async () => {
    try {
      const data = await fetcher('/catalogs');
      setCatalogs({
        descriptions: data.descriptions || [],
        countries: data.countries || [],
        fabrics: data.fabrics || [],
      });
    } catch (err) { logLoadError('catalogs')(err); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async (type) => {
    const value = drafts[type]?.trim();
    if (!value) { toast.error('Escribe un valor'); return; }
    setSaving(type);
    try {
      const res = await poster('/catalogs', { type, value });
      if (res.ok) {
        toast.success(`Agregado a ${SECTIONS.find(s => s.type === type)?.label}`);
        setDrafts(prev => ({ ...prev, [type]: '' }));
        load();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Error al agregar');
      }
    } catch (err) {
      logLoadError('add catalog')(err);
      toast.error('Error de conexión');
    } finally { setSaving(null); }
  };

  const handleDelete = async (catalog_id, value) => {
    if (!window.confirm(`¿Eliminar "${value}" del catálogo?\n(No afecta registros existentes)`)) return;
    setDeleting(catalog_id);
    try {
      await deleter(`/catalogs/${catalog_id}`);
      toast.success('Eliminado');
      load();
    } catch (err) {
      logLoadError('delete catalog')(err);
      toast.error('Error al eliminar');
    } finally { setDeleting(null); }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-card/40 border border-border/20 rounded-2xl p-5">
        <h2 className="text-sm font-black uppercase tracking-widest text-foreground mb-1">Catálogos maestros</h2>
        <p className="text-xs text-muted-foreground">
          Valores que aparecen en los desplegables de Receiving. Los que escribe el usuario
          inline también se mezclan automáticamente — esto es solo para curar/pre-poblar.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {SECTIONS.map(section => {
          const Icon = section.icon;
          const items = catalogs[section.type] || [];
          return (
            <div key={section.type} className={`border ${section.border} rounded-3xl bg-card/60 backdrop-blur-sm shadow-xl flex flex-col`}>
              {/* Header */}
              <div className="p-5 border-b border-border/10 flex items-center gap-3">
                <div className={`w-10 h-10 rounded-2xl ${section.bg} flex items-center justify-center`}>
                  <Icon className={`w-5 h-5 ${section.color}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-black uppercase tracking-tighter text-sm">{section.label}</h3>
                  <p className="text-[10px] text-muted-foreground font-bold opacity-60 leading-tight">{section.desc}</p>
                </div>
                <span className="text-[10px] font-black tabular-nums bg-secondary/60 px-2 py-1 rounded-lg text-muted-foreground">
                  {items.length}
                </span>
              </div>

              {/* Add new */}
              <div className="p-4 border-b border-border/10 flex gap-2">
                <input
                  type="text"
                  value={drafts[section.type]}
                  onChange={e => setDrafts(p => ({ ...p, [section.type]: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') handleAdd(section.type); }}
                  placeholder="Nuevo valor…"
                  className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground focus:ring-2 focus:ring-primary/30"
                  data-testid={`cat-input-${section.type}`}
                />
                <button
                  onClick={() => handleAdd(section.type)}
                  disabled={saving === section.type || !drafts[section.type]?.trim()}
                  className={`px-3 py-2 rounded-lg text-xs font-black uppercase tracking-widest flex items-center gap-1 transition-all disabled:opacity-40 ${section.bg} ${section.color}`}
                  data-testid={`cat-add-${section.type}`}
                >
                  {saving === section.type ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                  Agregar
                </button>
              </div>

              {/* List */}
              <div className="flex-1 overflow-auto max-h-[400px] custom-scrollbar">
                {items.length === 0 ? (
                  <div className="text-center py-10 text-xs text-muted-foreground/40 font-bold uppercase tracking-widest italic">
                    Sin valores curados
                  </div>
                ) : (
                  <ul className="divide-y divide-border/10">
                    {items.map(item => (
                      <li key={item.catalog_id} className="flex items-center justify-between px-4 py-2 hover:bg-secondary/30 transition-colors group">
                        <span className="text-sm font-bold text-foreground truncate">{item.value}</span>
                        <button
                          onClick={() => handleDelete(item.catalog_id, item.value)}
                          disabled={deleting === item.catalog_id}
                          className="p-1.5 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded transition-all"
                          data-testid={`cat-delete-${item.catalog_id}`}
                        >
                          {deleting === item.catalog_id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
