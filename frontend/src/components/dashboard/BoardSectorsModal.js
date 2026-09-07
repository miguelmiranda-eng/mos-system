import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Loader2, RotateCcw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { SECTOR_META, DEFAULT_SECTORS, boardKey } from "../../lib/boardSectors";
import { useLang } from "../../contexts/LanguageContext";

const SUELTO = '__suelto__';

/**
 * Editor de sectores del menú lateral. SOLO supersu.
 *
 * Un desplegable por tablero en vez de arrastrar y soltar: se usa desde el
 * teléfono en planta igual que desde el escritorio, y no hay forma de dejar un
 * tablero "a medio soltar" en ningún sitio.
 *
 * Ojo: esto cambia el menú de TODOS los usuarios, no el de quien lo edita.
 */
export const BoardSectorsModal = ({ isOpen, onClose, boards = [], sectors, onSave }) => {
  const { t } = useLang();
  // asignacion: { NOMBRE_TABLERO: sector_id | SUELTO }
  const [asignacion, setAsignacion] = useState({});
  const [saving, setSaving] = useState(false);

  // Las máquinas tienen su propio desplegable y no se reparten por sectores.
  const tableros = boards.filter(b => !b.startsWith('MAQUINA'));

  // Se rellena SOLO al abrir. Si dependiera también de `boards` o `sectors`,
  // un refresco de tableros en segundo plano reiniciaría las selecciones a
  // medio editar.
  useEffect(() => {
    if (!isOpen) return;
    const inicial = {};
    tableros.forEach(tablero => {
      const sector = SECTOR_META.find(meta =>
        (sectors?.[meta.id] || []).some(n => boardKey(n) === boardKey(tablero))
      );
      inicial[tablero] = sector ? sector.id : SUELTO;
    });
    setAsignacion(inicial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const aplicar = (nuevaAsignacion) => {
    // De {tablero: sector} a {sector: [tableros]}, respetando el orden en que
    // aparecen los tableros en la lista.
    const salida = {};
    SECTOR_META.forEach(meta => { salida[meta.id] = []; });
    tableros.forEach(tablero => {
      const sector = nuevaAsignacion[tablero];
      if (sector && sector !== SUELTO && salida[sector]) salida[sector].push(tablero);
    });
    return salida;
  };

  const guardar = async () => {
    setSaving(true);
    const resultado = await onSave(aplicar(asignacion));
    setSaving(false);
    if (resultado?.ok) {
      toast.success(t('dash_sectors_updated'));
      onClose();
    } else {
      toast.error(resultado?.error || t('dash_could_not_save'));
    }
  };

  const restaurar = () => {
    const inicial = {};
    tableros.forEach(tablero => {
      const sector = SECTOR_META.find(meta =>
        (DEFAULT_SECTORS[meta.id] || []).some(n => boardKey(n) === boardKey(tablero))
      );
      inicial[tablero] = sector ? sector.id : SUELTO;
    });
    setAsignacion(inicial);
  };

  const contarEn = (sectorId) =>
    Object.values(asignacion).filter(v => v === sectorId).length;

  return (
    <Dialog open={isOpen} onOpenChange={(abierto) => { if (!abierto) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('dash_menu_sectors')}</DialogTitle>
        </DialogHeader>

        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-700 dark:text-amber-400">
          <ShieldAlert size={15} className="mt-0.5 flex-shrink-0" />
          <span>{t('dash_sectors_warn_1')} <strong>{t('dash_all_users')}</strong>{t('dash_sectors_warn_2')}</span>
        </div>

        <div className="space-y-1 mt-2">
          {tableros.map(tablero => (
            <div key={tablero} className="flex items-center gap-3 py-1.5">
              <span className="flex-1 truncate text-[14px] font-medium">{tablero}</span>
              <select
                value={asignacion[tablero] ?? SUELTO}
                onChange={(e) => setAsignacion(prev => ({ ...prev, [tablero]: e.target.value }))}
                className="w-44 rounded-md border border-border bg-background px-2 py-1.5 text-[13px]"
              >
                <option value={SUELTO}>{t('dash_no_sector')}</option>
                {SECTOR_META.map(meta => (
                  <option key={meta.id} value={meta.id}>{t(meta.labelKey)}</option>
                ))}
              </select>
            </div>
          ))}
          {tableros.length === 0 && (
            <p className="py-4 text-center text-[13px] text-muted-foreground">{t('dash_no_boards_to_assign')}</p>
          )}
        </div>

        <p className="text-[12px] text-muted-foreground">
          {t('dash_sectors_hint')}
          {' '}
          {SECTOR_META.map(meta => `${t(meta.labelKey)}: ${contarEn(meta.id)}`).join(' · ')}
        </p>

        <div className="flex items-center justify-between gap-2 pt-2 border-t border-border">
          <button
            onClick={restaurar}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[13px] text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <RotateCcw size={14} />
            {t('restore')}
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="px-3 py-1.5 text-[13px] text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {t('cancel')}
            </button>
            <button
              onClick={guardar}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-md bg-royal px-4 py-1.5 text-[13px] font-semibold text-white disabled:opacity-50"
            >
              {saving && <Loader2 size={14} className="animate-spin" />}
              {t('save')}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default BoardSectorsModal;
