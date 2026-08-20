import { useState, useEffect, useCallback, useMemo } from "react";
import { Clock, Loader2, Download, Search, X } from "lucide-react";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import { fetcher, logLoadError } from "./lib";
import { Btn, cls, tableCls, EmptyState } from "./ui";

// Buckets de antigüedad — mismo orden y umbrales que el backend
// (d0_30 = 0-30 días, d31_60 = 31-60, d61_90 = 61-90, d90_plus = 90+).
const BUCKETS = [
  { key: 'd0_30', label: '0-30' },
  { key: 'd31_60', label: '31-60' },
  { key: 'd61_90', label: '61-90' },
  { key: 'd90_plus', label: '90+' },
];

// Rangos en español para la columna "Rango" del Excel.
const BUCKET_LABELS = {
  d0_30: '0-30 días',
  d31_60: '31-60 días',
  d61_90: '61-90 días',
  d90_plus: '90+ días',
  sin_fecha: 'Sin fecha',
};

// Color por antigüedad (días): verde ≤30, ámbar 31-60, naranja 61-90, rojo 90+.
// Mismos umbrales que la columna "Días en almacén" del módulo Inventory.
const agingColorCls = (days) => {
  if (days == null) return 'text-muted-foreground';
  if (days <= 30) return 'text-emerald-600 dark:text-emerald-400';
  if (days <= 60) return 'text-amber-600 dark:text-amber-400';
  if (days <= 90) return 'text-orange-600 dark:text-orange-400';
  return 'text-red-600 dark:text-red-400';
};

// Celda de un bucket: cajas (grande) + unidades (chico). Vacío → guion tenue.
const BucketCell = ({ bucket }) => {
  const boxes = bucket?.boxes || 0;
  const units = bucket?.units || 0;
  if (!boxes && !units) return <span className="text-muted-foreground/40">—</span>;
  return (
    <div className="tabular-nums leading-tight">
      <span className="font-medium text-foreground">{boxes.toLocaleString()}</span>
      <span className="text-muted-foreground/60 text-xs"> · {units.toLocaleString()}u</span>
    </div>
  );
};

export const AgingModule = ({ initialCustomer = '' }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [customerFilter, setCustomerFilter] = useState(initialCustomer || '');
  const [debouncedCustomer, setDebouncedCustomer] = useState((initialCustomer || '').trim());

  useEffect(() => {
    const id = setTimeout(() => setDebouncedCustomer(customerFilter.trim()), 300);
    return () => clearTimeout(id);
  }, [customerFilter]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (debouncedCustomer) params.set('customer', debouncedCustomer);
      const qs = params.toString();
      const res = await fetcher(`/inventory/aging${qs ? `?${qs}` : ''}`);
      setData(res);
    } catch (err) {
      logLoadError('aging')(err);
    } finally {
      setLoading(false);
    }
  }, [debouncedCustomer]);

  useEffect(() => { load(); }, [load]);

  const customers = useMemo(() => (Array.isArray(data?.customers) ? data.customers : []), [data]);

  // Mostrar la columna "Sin fecha" solo si algún cliente tiene cajas/unidades sin
  // una fecha de entrada legible.
  const hasSinFecha = useMemo(
    () => customers.some(c => (c.buckets?.sin_fecha?.boxes || 0) > 0 || (c.buckets?.sin_fecha?.units || 0) > 0),
    [customers],
  );

  // Totales por bucket (para la fila de totales), sumados sobre los clientes.
  const bucketTotals = useMemo(() => {
    const acc = {};
    for (const b of [...BUCKETS.map(x => x.key), 'sin_fecha']) acc[b] = { boxes: 0, units: 0 };
    for (const c of customers) {
      for (const key of Object.keys(acc)) {
        acc[key].boxes += c.buckets?.[key]?.boxes || 0;
        acc[key].units += c.buckets?.[key]?.units || 0;
      }
    }
    return acc;
  }, [customers]);

  const exportExcel = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams({ detail: 'true' });
      if (debouncedCustomer) params.set('customer', debouncedCustomer);
      const res = await fetcher(`/inventory/aging?${params.toString()}`);
      const rows = Array.isArray(res?.rows) ? res.rows : [];
      if (rows.length === 0) {
        toast.error('No hay material para exportar');
        return;
      }
      const sheet = rows.map(r => ({
        'Cliente': r.customer || '',
        'LPN': r.lpn || '',
        'Style': r.style || '',
        'SKU': r.sku || '',
        'Color': r.color || '',
        'Talla': r.size || '',
        'País origen': r.country_of_origin || '',
        'Descripción': r.description || '',
        'Ubicación': r.location || '',
        'ASN': r.asn_reference || '',
        'Unidades': Number(r.units) || 0,
        'Fecha entrada': r.received_at ? new Date(r.received_at).toLocaleDateString() : '',
        'Días en almacén': Number.isFinite(r.days_in_warehouse) ? r.days_in_warehouse : '',
        'Rango': BUCKET_LABELS[r.bucket] || r.bucket || '',
      }));
      const ws = XLSX.utils.json_to_sheet(sheet);
      ws['!cols'] = [
        { wch: 18 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 12 }, { wch: 8 },
        { wch: 12 }, { wch: 28 }, { wch: 14 }, { wch: 14 }, { wch: 10 }, { wch: 14 },
        { wch: 14 }, { wch: 12 },
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Antiguedad');
      XLSX.writeFile(wb, `antiguedad_inventario_${new Date().toISOString().split('T')[0]}.xlsx`);
      toast.success(`${rows.length.toLocaleString()} caja(s) exportada(s)`);
    } catch (err) {
      logLoadError('export antigüedad')(err);
      toast.error('No se pudo exportar');
    } finally {
      setExporting(false);
    }
  };

  const colCount = 4 + BUCKETS.length + (hasSinFecha ? 1 : 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={customerFilter}
            onChange={e => setCustomerFilter(e.target.value)}
            placeholder="Filtrar por cliente…"
            className={`${cls.input} pl-9 pr-9`}
            data-testid="aging-customer-filter"
          />
          {customerFilter && (
            <button onClick={() => setCustomerFilter('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs font-mono tabular-nums text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-amber-500" />
            {(data?.total_boxes || 0).toLocaleString()} cajas · {(data?.total_units || 0).toLocaleString()} u
          </span>
        </div>
        <Btn onClick={exportExcel} disabled={exporting} data-testid="aging-export-btn">
          {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Exportar Excel
        </Btn>
      </div>

      <div className="border border-border rounded-lg bg-card overflow-hidden">
        <div className="overflow-auto max-h-[600px] custom-scrollbar">
          <table className="w-full text-sm">
            <thead className={tableCls.thead}>
              <tr>
                <th className={cls.th}>Cliente</th>
                <th className={`${cls.th} text-right`}>Cajas</th>
                <th className={`${cls.th} text-right`}>Unidades</th>
                <th className={`${cls.th} text-right`}>Más viejo</th>
                {BUCKETS.map(b => (
                  <th key={b.key} className={`${cls.th} text-right`}>{b.label} días</th>
                ))}
                {hasSinFecha && <th className={`${cls.th} text-right`}>Sin fecha</th>}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={colCount} className="py-16 text-center text-muted-foreground">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto" />
                  </td>
                </tr>
              ) : customers.length === 0 ? (
                <tr>
                  <td colSpan={colCount}>
                    <EmptyState art="boxes" title="Sin inventario para mostrar"
                      hint={`No hay cajas en stock${debouncedCustomer ? ` para “${debouncedCustomer}”` : ''}.`} />
                  </td>
                </tr>
              ) : (
                <>
                  {/* Fila de totales */}
                  <tr className="bg-muted/40 border-b border-border font-medium">
                    <td className="px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Total ({customers.length})</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{(data?.total_boxes || 0).toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{(data?.total_units || 0).toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right text-muted-foreground/50">—</td>
                    {BUCKETS.map(b => (
                      <td key={b.key} className="px-3 py-2.5 text-right"><BucketCell bucket={bucketTotals[b.key]} /></td>
                    ))}
                    {hasSinFecha && <td className="px-3 py-2.5 text-right"><BucketCell bucket={bucketTotals.sin_fecha} /></td>}
                  </tr>
                  {customers.map((c, i) => (
                    <tr key={c.customer || i} className="border-b border-border/60 hover:bg-muted/40 transition-colors">
                      <td className="px-3 py-2.5 text-xs font-medium text-foreground truncate max-w-[220px]" title={c.customer}>{c.customer || '—'}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-medium">{(c.total_boxes || 0).toLocaleString()}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{(c.total_units || 0).toLocaleString()}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {c.oldest_days == null ? (
                          <span className="text-muted-foreground/50">—</span>
                        ) : (
                          <span className={`font-semibold ${agingColorCls(c.oldest_days)}`}>
                            {c.oldest_days.toLocaleString()}<span className="text-muted-foreground/60 font-normal"> d</span>
                          </span>
                        )}
                      </td>
                      {BUCKETS.map(b => (
                        <td key={b.key} className="px-3 py-2.5 text-right"><BucketCell bucket={c.buckets?.[b.key]} /></td>
                      ))}
                      {hasSinFecha && <td className="px-3 py-2.5 text-right"><BucketCell bucket={c.buckets?.sin_fecha} /></td>}
                    </tr>
                  ))}
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {data?.generated_at && (
        <p className="text-xs text-muted-foreground/70 text-right">
          Generado {new Date(data.generated_at).toLocaleString()}
        </p>
      )}
    </div>
  );
};
