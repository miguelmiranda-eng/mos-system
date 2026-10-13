// Un dashboard por etapa del proceso. Las reglas de qué orden cae en qué
// etapa viven en el backend (routers/executive.py); aquí sólo se pinta.
// "Listas para envío" tiene su propia vista: ListoView.
import React, { useMemo } from 'react';
import { Package, Layers, CalendarClock } from 'lucide-react';
import { useLang } from '../../contexts/LanguageContext';
import { Panel, KpiTile, BarList, AgingBars, OrdersTable, fmt } from './parts';

const StageView = ({ stage, meta }) => {
  const { t, lang } = useLang();
  const clients = useMemo(() => stage?.by_client || [], [stage]);
  if (!stage) return null;
  const statusField = stage.key === 'blanks' ? 'blank_status' : 'production_status';

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground max-w-3xl">{t(meta.descKey)}</p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiTile icon={Layers} label={t('exe_orders')} value={fmt(stage.count, lang)} />
        <KpiTile icon={Package} label={t('exe_pieces')} value={fmt(stage.pieces, lang)} />
        <KpiTile tone="alert" label={t('exe_late')} value={fmt(stage.late, lang)}
          hint={stage.late ? t('exe_late_pieces', { n: fmt(stage.late_pieces, lang) }) : t('exe_late_none')} />
        <KpiTile icon={CalendarClock} label={t('exe_due7')} value={fmt(stage.due_7d, lang)} hint={t('exe_due7_hint')} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Panel title={stage.key === 'blanks' ? t('exe_by_blank_status') : t('exe_by_status')} subtitle={t('exe_by_pieces')}>
          <BarList rows={stage.by_status} labelKey="status" />
        </Panel>
        <Panel title={t('exe_aging')} subtitle={t(stage.key === 'blanks' ? 'exe_aging_sub_blanks' : 'exe_aging_sub')}>
          <AgingBars aging={stage.aging} />
        </Panel>
        <Panel title={t('exe_top_clients')} subtitle={t('exe_by_pieces')}>
          <BarList rows={clients} labelKey="client" />
        </Panel>
      </div>
      <Panel title={t('exe_orders_in_stage')} subtitle={t('exe_orders_in_stage_sub')}>
        <OrdersTable rows={stage.orders} statusField={statusField} truncated={stage.truncated}
          daysLabel={t(stage.key === 'blanks' ? 'exe_col_days_open' : 'exe_col_days')} />
      </Panel>
    </div>
  );
};

export default StageView;
