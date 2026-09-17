/* Sistema → Configuración: un solo lugar para lo que antes estaba regado.
   Pestañas: Permisos (por acción + por módulo, solo quien reparte permisos),
   Catálogos (lo que era "Configuración WMS"), Catálogo UPC. Fase 3 traerá
   aquí Número de parte / IMMEX, columnas de entradas y notificaciones. */
import { useState } from "react";
import { ShieldCheck, BookOpen, ScanLine } from "lucide-react";
import { useLang } from "../../contexts/LanguageContext";
import { useWms } from "./lib";
import { HomeModule } from "./Home";
import { UpcCatalog } from "./UpcCatalog";
import { PermissionsPanel } from "./PermissionsPanel";

const TAB_KEY = 'mos_wms_settings_tab';

export const SettingsModule = () => {
  const { t } = useLang();
  const { can } = useWms();
  const canPerms = can('config.permissions');
  // El catálogo UPC lo administra quien corrige UPCs (misma acción del backend).
  const isManager = can('upc.correct');
  const tabs = [
    ...(canPerms ? [{ id: 'permissions', label: t('wms_settings_tab_permissions'), icon: ShieldCheck }] : []),
    { id: 'catalogs', label: t('wms_settings_tab_catalogs'), icon: BookOpen },
    { id: 'upc', label: t('wms_settings_tab_upc'), icon: ScanLine },
  ];
  // Sin pestaña guardada, `tab` queda null y la activa es la primera visible:
  // así el supersu cae en Permisos aunque can() cargue después del montaje.
  const [tab, setTab] = useState(() => { try { return localStorage.getItem(TAB_KEY) || null; } catch { return null; } });
  const active = tabs.some(x => x.id === tab) ? tab : tabs[0].id;
  const pick = (id) => { setTab(id); try { localStorage.setItem(TAB_KEY, id); } catch { /* sin storage */ } };

  return (
    <div className="space-y-6">
      <div className="inline-flex flex-wrap gap-1 bg-muted/40 border border-border rounded-lg p-1" data-testid="wms-settings-tabs">
        {tabs.map(x => {
          const Icon = x.icon;
          const on = x.id === active;
          return (
            <button key={x.id} onClick={() => pick(x.id)} data-testid={`settings-tab-${x.id}`}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-xs font-bold uppercase tracking-wider transition-colors
                ${on ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
              <Icon className="w-4 h-4" /> {x.label}
            </button>
          );
        })}
      </div>
      {active === 'permissions' && canPerms && <PermissionsPanel />}
      {active === 'catalogs' && <HomeModule />}
      {active === 'upc' && <UpcCatalog isManager={isManager} />}
    </div>
  );
};

export default SettingsModule;
