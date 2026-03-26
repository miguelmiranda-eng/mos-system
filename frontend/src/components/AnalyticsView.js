import { useState, useMemo, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Download, BarChart3, PieChart as PieIcon, Filter, FileText, Loader2 } from "lucide-react";
import { BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from "recharts";
import { useLang } from "../contexts/LanguageContext";
import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';

const CHART_COLORS = [
  '#3d85c6', '#e94560', '#38761d', '#f1c232', '#674ea7',
  '#e066cc', '#e69138', '#b44253', '#20124d', '#6fa8dc',
  '#cf0000', '#16c79a', '#b4a7d6', '#cc0000', '#25a18e'
];

const AnalyticsView = ({ isOpen, onClose, allOrders, options }) => {
  const { t } = useLang();
  const [chartFilter, setChartFilter] = useState('all');
  const [exportingPdf, setExportingPdf] = useState(false);
  const chartsRef = useRef(null);

  const filteredOrders = useMemo(() => {
    if (chartFilter === 'all') return allOrders;
    return allOrders.filter(o => o.board === chartFilter);
  }, [allOrders, chartFilter]);

  const productionData = useMemo(() => {
    const counts = {};
    filteredOrders.forEach(o => {
      const status = o.production_status || t('no_status');
      counts[status] = (counts[status] || 0) + 1;
    });
    return Object.entries(counts).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [filteredOrders, t]);

  const boardData = useMemo(() => {
    const counts = {};
    filteredOrders.forEach(o => { counts[o.board] = (counts[o.board] || 0) + 1; });
    return Object.entries(counts).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [filteredOrders]);

  const priorityData = useMemo(() => {
    const counts = {};
    filteredOrders.forEach(o => {
      const p = o.priority || t('no_priority');
      counts[p] = (counts[p] || 0) + 1;
    });
    return Object.entries(counts).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [filteredOrders, t]);

  const clientData = useMemo(() => {
    const counts = {};
    filteredOrders.forEach(o => {
      const c = o.client || t('no_client');
      counts[c] = (counts[c] || 0) + 1;
    });
    return Object.entries(counts).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 15);
  }, [filteredOrders, t]);

  const artworkData = useMemo(() => {
    const counts = {};
    filteredOrders.forEach(o => {
      const s = o.artwork_status || t('no_status');
      counts[s] = (counts[s] || 0) + 1;
    });
    return Object.entries(counts).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [filteredOrders, t]);

  const blankData = useMemo(() => {
    const counts = {};
    filteredOrders.forEach(o => {
      const s = o.blank_status || t('no_status');
      counts[s] = (counts[s] || 0) + 1;
    });
    return Object.entries(counts).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [filteredOrders, t]);

  const totalPieces = useMemo(() => {
    return filteredOrders.reduce((acc, o) => acc + (parseInt(o.quantity) || 0), 0);
  }, [filteredOrders]);

  const piecesByBoardData = useMemo(() => {
    const counts = {};
    filteredOrders.forEach(o => {
      counts[o.board] = (counts[o.board] || 0) + (parseInt(o.quantity) || 0);
    });
    return Object.entries(counts).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [filteredOrders]);

  const piecesByProductionData = useMemo(() => {
    const counts = {};
    filteredOrders.forEach(o => {
      const status = o.production_status || t('no_status');
      counts[status] = (counts[status] || 0) + (parseInt(o.quantity) || 0);
    });
    return Object.entries(counts).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [filteredOrders, t]);

  const BOARDS = [
    "MASTER", "SCHEDULING", "BLANKS", "SCREENS", "NECK", "EJEMPLOS", "COMPLETOS",
    "MAQUINA1", "MAQUINA2", "MAQUINA3", "MAQUINA4", "MAQUINA5", "MAQUINA6", "MAQUINA7",
    "MAQUINA8", "MAQUINA9", "MAQUINA10", "MAQUINA11", "MAQUINA12", "MAQUINA13", "MAQUINA14"
  ];

  const handleExportExcel = () => {
    const exportData = filteredOrders.map(o => ({
      [t('excel_order')]: o.order_number || '',
      [t('excel_board')]: o.board || '',
      [t('excel_client')]: o.client || '',
      [t('excel_branding')]: o.branding || '',
      [t('excel_priority')]: o.priority || '',
      [t('excel_quantity')]: o.quantity || 0,
      [t('excel_due_date')]: o.due_date || '',
      'Blank Source': o.blank_source || '',
      'Blank Status': o.blank_status || '',
      'Production Status': o.production_status || '',
      'Trim Status': o.trim_status || '',
      'Artwork Status': o.artwork_status || '',
      'Betty Column': o.betty_column || '',
      'Shipping': o.shipping || '',
    }));
    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Dashboard");

    const summary = [
      { [t('excel_metric')]: t('total_orders'), [t('excel_value')]: filteredOrders.length },
      { [t('excel_metric')]: t('total_pieces_label'), [t('excel_value')]: totalPieces },
      { [t('excel_metric')]: t('filter'), [t('excel_value')]: chartFilter === 'all' ? t('all_boards_filter') : chartFilter },
      ...piecesByBoardData.map(d => ({ [t('excel_metric')]: `${t('excel_pieces_in')}: ${d.name}`, [t('excel_value')]: d.value })),
      ...piecesByProductionData.map(d => ({ [t('excel_metric')]: `${t('excel_pieces_dash')} ${d.name}`, [t('excel_value')]: d.value })),
      ...productionData.map(d => ({ [t('excel_metric')]: `${t('excel_production')}: ${d.name}`, [t('excel_value')]: d.value })),
      ...priorityData.map(d => ({ [t('excel_metric')]: `${t('excel_priority_label')}: ${d.name}`, [t('excel_value')]: d.value })),
    ];
    const ws2 = XLSX.utils.json_to_sheet(summary);
    XLSX.utils.book_append_sheet(wb, ws2, t('excel_summary'));

    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    try {
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dashboard_${new Date().toISOString().split('T')[0]}.xlsx`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    } catch (e) { console.error('Export error:', e); }
  };

  const handleExportPdf = async () => {
    setExportingPdf(true);
    try {
      const { default: jsPDF } = await import('jspdf');
      const { default: html2canvas } = await import('html2canvas');
      const el = chartsRef.current;
      if (!el) return;
      const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#1a1a2e', useCORS: true });
      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF('l', 'mm', 'a4');
      const pW = pdf.internal.pageSize.getWidth();
      const pH = pdf.internal.pageSize.getHeight();
      pdf.setFillColor(26, 26, 46);
      pdf.rect(0, 0, pW, pH, 'F');
      pdf.setTextColor(255, 255, 255);
      pdf.setFontSize(22);
      pdf.text(t('pdf_title'), 14, 18);
      pdf.setFontSize(10);
      pdf.text(`${t('pdf_generated')}: ${new Date().toLocaleString()} | ${t('pdf_filter')}: ${chartFilter === 'all' ? t('pdf_all_boards') : chartFilter} | Total: ${filteredOrders.length} ${t('orders_unit')}`, 14, 26);
      const imgW = pW - 20;
      const imgH = (canvas.height / canvas.width) * imgW;
      pdf.addImage(imgData, 'PNG', 10, 32, imgW, Math.min(imgH, pH - 40));
      pdf.save(`dashboard_${new Date().toISOString().split('T')[0]}.pdf`);
    } catch (err) {
      console.error('PDF export error:', err);
    } finally {
      setExportingPdf(false);
    }
  };

  const CustomTooltip = ({ active, payload, unit }) => {
    if (active && payload?.length) {
      return (
        <div className="bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-white text-sm">
          <p className="font-bold">{payload[0].name || payload[0].payload?.name}</p>
          <p>{payload[0].value.toLocaleString()} {unit || t('orders_unit')}</p>
        </div>
      );
    }
    return null;
  };

  const renderPieLabel = ({ name, percent }) => percent > 0.05 ? `${name} (${(percent * 100).toFixed(0)}%)` : '';

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-[95vw] max-h-[92vh] bg-card border-border overflow-hidden flex flex-col" data-testid="analytics-modal">
        <DialogHeader>
          <DialogTitle className="font-barlow text-xl uppercase tracking-wide flex items-center gap-3">
            <BarChart3 className="w-5 h-5" />
            {t('analytics_dashboard')}
            <span className="text-sm font-normal text-muted-foreground ml-2">({filteredOrders.length} {t('orders_unit')})</span>
          </DialogTitle>
        </DialogHeader>

        {/* Toolbar */}
        <div className="flex items-center gap-3 border-b border-border pb-3">
          <Filter className="w-4 h-4 text-muted-foreground" />
          <Select value={chartFilter} onValueChange={setChartFilter}>
            <SelectTrigger className="w-48 bg-secondary border-border" data-testid="analytics-board-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-popover border-border z-[300]">
              <SelectItem value="all">{t('all_boards_filter')}</SelectItem>
              {BOARDS.map(b => <SelectItem key={b} value={b}>{b}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={handleExportExcel} className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600/20 text-green-500 rounded text-sm hover:bg-green-600/30 transition-colors" data-testid="export-dashboard-excel">
              <Download className="w-4 h-4" /> Excel
            </button>
            <button onClick={handleExportPdf} disabled={exportingPdf} className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600/20 text-red-400 rounded text-sm hover:bg-red-600/30 transition-colors disabled:opacity-50" data-testid="export-dashboard-pdf">
              {exportingPdf ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />} PDF
            </button>
          </div>
        </div>

        {/* Charts */}
        <div ref={chartsRef} className="flex-1 overflow-y-auto py-4 space-y-6">
          {/* Summary cards */}
          <div className="grid grid-cols-5 gap-4">
            {[
              { label: t('total_orders'), value: filteredOrders.length, color: '#3d85c6' },
              { label: t('total_pieces_label'), value: totalPieces.toLocaleString(), color: '#674ea7' },
              { label: t('in_production'), value: filteredOrders.filter(o => ['EN PRODUCCION', 'EN PROCESO DE EMPAQUE', 'NECESITA LABEL', 'NECESITA EMPACAR'].includes(o.production_status)).length, color: '#38761d' },
              { label: t('on_hold'), value: filteredOrders.filter(o => ['EN ESPERA', 'HOLD', 'WAITING ON INFO'].includes(o.production_status || o.blank_status)).length, color: '#e69138' },
              { label: t('done'), value: filteredOrders.filter(o => ['LISTO PARA ENVIO', 'LISTO PARA FULFILLMENT', 'LISTO PARA INVENTARIO'].includes(o.production_status)).length, color: '#16c79a' },
            ].map(card => (
              <div key={card.label} className="bg-secondary/50 border border-border rounded-lg p-4" data-testid={`summary-card-${card.label.toLowerCase().replace(/\s/g, '-')}`}>
                <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">{card.label}</div>
                <div className="text-3xl font-barlow font-bold" style={{ color: card.color }}>{card.value}</div>
              </div>
            ))}
          </div>

          {/* Pieces by Board + Pieces by Production Status */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-secondary/30 border border-border rounded-lg p-4">
              <h3 className="font-barlow font-bold text-base uppercase tracking-wide mb-4 flex items-center gap-2">
                <BarChart3 className="w-4 h-4" /> {t('pieces_by_board')}
              </h3>
              {piecesByBoardData.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={piecesByBoardData} margin={{ left: 10, right: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                    <XAxis dataKey="name" stroke="#888" tick={{ fontSize: 10, angle: -30, textAnchor: 'end' }} height={80} />
                    <YAxis stroke="#888" />
                    <Tooltip content={<CustomTooltip unit={t('pieces_unit')} />} />
                    <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                      {piecesByBoardData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : <p className="text-muted-foreground text-center py-8">{t('no_data')}</p>}
            </div>
            <div className="bg-secondary/30 border border-border rounded-lg p-4">
              <h3 className="font-barlow font-bold text-base uppercase tracking-wide mb-4 flex items-center gap-2">
                <BarChart3 className="w-4 h-4" /> {t('pieces_by_status')}
              </h3>
              {piecesByProductionData.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={piecesByProductionData} layout="vertical" margin={{ left: 160, right: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                    <XAxis type="number" stroke="#888" />
                    <YAxis type="category" dataKey="name" stroke="#888" tick={{ fontSize: 11 }} width={155} />
                    <Tooltip content={<CustomTooltip unit={t('pieces_unit')} />} />
                    <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                      {piecesByProductionData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : <p className="text-muted-foreground text-center py-8">{t('no_data')}</p>}
            </div>
          </div>

          {/* Production Status Bar Chart */}
          <div className="bg-secondary/30 border border-border rounded-lg p-4">
            <h3 className="font-barlow font-bold text-base uppercase tracking-wide mb-4 flex items-center gap-2">
              <BarChart3 className="w-4 h-4" /> {t('production_status')}
            </h3>
            {productionData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={productionData} layout="vertical" margin={{ left: 160, right: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                  <XAxis type="number" stroke="#888" />
                  <YAxis type="category" dataKey="name" stroke="#888" tick={{ fontSize: 11 }} width={155} />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                    {productionData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : <p className="text-muted-foreground text-center py-8">{t('no_data')}</p>}
          </div>

          {/* Two column charts */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-secondary/30 border border-border rounded-lg p-4">
              <h3 className="font-barlow font-bold text-base uppercase tracking-wide mb-4 flex items-center gap-2">
                <PieIcon className="w-4 h-4" /> {t('priority_dist')}
              </h3>
              {priorityData.length > 0 ? (
                <ResponsiveContainer width="100%" height={280}>
                  <PieChart>
                    <Pie data={priorityData} cx="50%" cy="50%" outerRadius={100} dataKey="value" label={renderPieLabel} labelLine={false}>
                      {priorityData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                    </Pie>
                    <Tooltip content={<CustomTooltip />} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              ) : <p className="text-muted-foreground text-center py-8">{t('no_data')}</p>}
            </div>

            <div className="bg-secondary/30 border border-border rounded-lg p-4">
              <h3 className="font-barlow font-bold text-base uppercase tracking-wide mb-4 flex items-center gap-2">
                <PieIcon className="w-4 h-4" /> {t('orders_by_board')}
              </h3>
              {boardData.length > 0 ? (
                <ResponsiveContainer width="100%" height={280}>
                  <PieChart>
                    <Pie data={boardData} cx="50%" cy="50%" outerRadius={100} dataKey="value" label={renderPieLabel} labelLine={false}>
                      {boardData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                    </Pie>
                    <Tooltip content={<CustomTooltip />} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              ) : <p className="text-muted-foreground text-center py-8">{t('no_data')}</p>}
            </div>
          </div>

          {/* Top Clients Bar */}
          <div className="bg-secondary/30 border border-border rounded-lg p-4">
            <h3 className="font-barlow font-bold text-base uppercase tracking-wide mb-4 flex items-center gap-2">
              <BarChart3 className="w-4 h-4" /> {t('top_clients')}
            </h3>
            {clientData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={clientData} margin={{ left: 10, right: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                  <XAxis dataKey="name" stroke="#888" tick={{ fontSize: 10, angle: -30, textAnchor: 'end' }} height={80} />
                  <YAxis stroke="#888" />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                    {clientData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : <p className="text-muted-foreground text-center py-8">{t('no_data')}</p>}
          </div>

          {/* Artwork + Blank Status */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-secondary/30 border border-border rounded-lg p-4">
              <h3 className="font-barlow font-bold text-base uppercase tracking-wide mb-4">{t('artwork_status_label')}</h3>
              {artworkData.length > 0 ? (
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={artworkData} layout="vertical" margin={{ left: 140, right: 20 }}>
                    <XAxis type="number" stroke="#888" />
                    <YAxis type="category" dataKey="name" stroke="#888" tick={{ fontSize: 11 }} width={135} />
                    <Tooltip content={<CustomTooltip />} />
                    <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                      {artworkData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : <p className="text-muted-foreground text-center py-8">{t('no_data')}</p>}
            </div>
            <div className="bg-secondary/30 border border-border rounded-lg p-4">
              <h3 className="font-barlow font-bold text-base uppercase tracking-wide mb-4">{t('blank_status_label')}</h3>
              {blankData.length > 0 ? (
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={blankData} layout="vertical" margin={{ left: 140, right: 20 }}>
                    <XAxis type="number" stroke="#888" />
                    <YAxis type="category" dataKey="name" stroke="#888" tick={{ fontSize: 11 }} width={135} />
                    <Tooltip content={<CustomTooltip />} />
                    <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                      {blankData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : <p className="text-muted-foreground text-center py-8">{t('no_data')}</p>}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default AnalyticsView;
