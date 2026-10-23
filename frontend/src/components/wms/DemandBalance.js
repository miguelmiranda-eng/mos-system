import { useState, useEffect, useMemo, useCallback } from "react";
import { Scale, RefreshCw, Loader2, Download, Search, AlertTriangle } from "lucide-react";
import * as XLSX from "xlsx";
import { saveAs } from "file-saver";
import { toast } from "sonner";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher } from "./lib";
import { Card, StatCard, Btn, Th, tableCls, EmptyState } from "./ui";

// Balance DEMANDA vs EXISTENCIA por SKU de blank (Fase 0 del "pool"):
//   Demanda = tallas pendientes de los pick tickets ABIERTOS.
//   Disponible = on_hand − allocated. Balance = Disponible − Demanda.
// Ordenado por el más corto. NO incluye tránsito desde proveedor (el ASN trae
// part_number, no style, así que aún no se mapea a SKU).
export const DemandBalanceModule = () => {
  const { t } = useLang();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [onlyShort, setOnlyShort] = useState(true);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetcher(`/inventory/demand-balance?only_short=${onlyShort ? "true" : "false"}`));
    } catch {
      toast.error(t("wms_conn_err"));
    } finally {
      setLoading(false);
    }
  }, [onlyShort, t]);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    const all = data?.rows || [];
    const term = q.trim().toUpperCase();
    if (!term) return all;
    return all.filter((r) => `${r.style} ${r.color} ${r.size}`.toUpperCase().includes(term));
  }, [data, q]);

  const shortUnits = useMemo(
    () => (data?.rows || []).reduce((s, r) => s + (r.balance < 0 ? -r.balance : 0), 0),
    [data]);

  const exportExcel = () => {
    const out = rows.map((r) => ({
      "Estilo": r.style, "Color": r.color, "Talla": r.size,
      "On hand": r.on_hand, "Disponible": r.available, "Demanda": r.demand,
      "Balance": r.balance, "# Órdenes": r.order_count, "Órdenes": (r.orders || []).join(", "),
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(out.length ? out : [{ "Estilo": "(sin datos)" }]), "Balance");
    const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    saveAs(new Blob([buf], { type: "application/octet-stream" }),
      `Balance_Demanda_${new Date().toISOString().split("T")[0]}.xlsx`);
    toast.success(t("wms_excel_exported"));
  };

  const fmt = (n) => Number(n || 0).toLocaleString();

  return (
    <div className="space-y-4" data-testid="wms-demand-balance">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
            <Scale className="w-5 h-5 text-fuchsia-400" /> {t("wms_dbal_title")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("wms_dbal_subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Btn variant="ghost" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} {t("comment_refresh")}
          </Btn>
          <Btn onClick={exportExcel} disabled={!rows.length}>
            <Download className="w-4 h-4" /> {t("export_excel")}
          </Btn>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <StatCard label={t("wms_dbal_skus")} value={fmt(data?.count)} />
        <StatCard label={t("wms_dbal_short_skus")} value={fmt(data?.short_count)} />
        <StatCard label={t("wms_dbal_short_units")} value={fmt(shortUnits)} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("wms_dbal_search_ph")}
            className="w-full pl-9 pr-3 py-2 bg-card border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring/25" />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
          <input type="checkbox" checked={onlyShort} onChange={(e) => setOnlyShort(e.target.checked)} className="accent-fuchsia-500" />
          {t("wms_dbal_only_short")}
        </label>
      </div>

      <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-500" /> {t("wms_dbal_transit_note")}
      </p>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto max-h-[62vh]">
          <table className="w-full text-sm">
            <thead className={tableCls.thead}>
              <tr>
                <Th>{t("wms_label_style")}</Th>
                <Th>{t("wms_label_color")}</Th>
                <Th>{t("wms_label_size")}</Th>
                <Th right>{t("wms_dbal_on_hand")}</Th>
                <Th right>{t("wms_dbal_available")}</Th>
                <Th right>{t("wms_dbal_demand")}</Th>
                <Th right>{t("wms_dbal_balance")}</Th>
                <Th right>{t("wms_dbal_orders")}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.style}|${r.color}|${r.size}|${i}`} className={tableCls.row}>
                  <td className="px-3 py-1.5 font-semibold text-foreground">{r.style}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{r.color}</td>
                  <td className="px-3 py-1.5">{r.size}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">{fmt(r.on_hand)}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">{fmt(r.available)}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">{fmt(r.demand)}</td>
                  <td className={`px-3 py-1.5 text-right font-mono tabular-nums font-bold ${r.balance < 0 ? "text-red-500" : "text-emerald-500"}`}>
                    {r.balance > 0 ? "+" : ""}{fmt(r.balance)}
                  </td>
                  <td className="px-3 py-1.5 text-right text-muted-foreground tabular-nums"
                    title={(r.orders || []).join(", ")}>{r.order_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && rows.length === 0 && (
            <EmptyState title={t("wms_dbal_empty")} hint={t("wms_dbal_empty_hint")} />
          )}
          {loading && (
            <div className="flex items-center justify-center py-8 text-muted-foreground text-sm gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> {t("loading")}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};

export default DemandBalanceModule;
