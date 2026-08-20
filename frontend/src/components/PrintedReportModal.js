import { useState } from "react";
import { Dialog, DialogPortal, DialogOverlay, DialogHeader, DialogTitle } from "./ui/dialog";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Download, Loader2, CalendarDays } from "lucide-react";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { API } from "../lib/constants";

/* Reporte de órdenes pintadas.

   Lo pintado se deduce de `production_logs`: la orden no tiene un status
   "pintada". Como el piso captura VARIAS veces por orden (una por máquina,
   posición, talla o turno), el backend agrupa por número de orden y suma —
   si no, la misma orden saldría repetida tantas veces como capturas tenga.

   POR QUÉ ES UN MODAL Y NO UN RENGLÓN DEL MENÚ: el reporte necesita un rango
   de fechas antes de generarse, y un DropdownMenuItem se cierra al primer
   clic, así que no puede hospedar dos inputs y un botón. El renglón del menú
   sólo abre esto. */

const hoyLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const hace30 = () => {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const PrintedReportModal = ({ isOpen, onClose }) => {
  // Arranca en los últimos 30 días porque es el corte con el que se factura.
  const [desde, setDesde] = useState(hace30);
  const [hasta, setHasta] = useState(hoyLocal);
  const [busy, setBusy] = useState(false);

  const generar = async () => {
    if (!desde || !hasta) { toast.error("Elige el rango de fechas"); return; }
    if (desde > hasta) { toast.error("La fecha inicial es posterior a la final"); return; }
    setBusy(true);
    try {
      const qs = new URLSearchParams({ date_from: desde, date_to: hasta });
      const res = await fetch(`${API}/final-bill/printed-report?${qs}`, { credentials: "include" });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.detail || "error");
      }
      const out = await res.json();
      const rows = out.rows || [];
      if (!rows.length) {
        toast.error("No hay capturas de producción en ese rango");
        return;
      }

      // Una columna por posición impresa (FRENTE / ESPALDA / MANGA). Sin este
      // desglose, "1000 impresiones" en una orden de 500 parece un error de
      // captura, cuando en realidad es frente + espalda.
      const posiciones = out.posiciones || [];
      const sheet = rows.map((r) => {
        const fila = {
          "Order#": r.order_number,
          "Customer PO": r.customer_po,
          "Client": r.client,
          "Design": r.design,
          "Branding": r.branding,
          "Board": r.board,
          "Production Status": r.production_status,
          "Cancel Date": r.cancel_date,
          "Final Bill": r.final_bill,
          "Qty ordenada": r.qty_ordenada,
          "Impresiones en el rango": r.impresiones,
        };
        posiciones.forEach((p) => { fila[`Impresiones ${p}`] = r.por_posicion?.[p] ?? 0; });
        fila["Capturas"] = r.capturas;
        fila["Primera captura"] = r.primera_captura;
        fila["Última captura"] = r.ultima_captura;
        fila["Setup (min)"] = r.setup_min;
        fila["Máquinas"] = (r.maquinas || []).join(", ");
        fila["Operadores"] = (r.operadores || []).join(", ");
        fila["Turnos"] = (r.turnos || []).join(", ");
        fila["Total Amount"] = (r.total_amount === null || r.total_amount === undefined) ? "" : r.total_amount;
        fila["Revisada"] = r.revisada ? "Sí" : "No";
        // Banderas honestas: si la orden ya no está en MOS, o si el mismo
        // número trajo más de un order_id, el renglón lo dice en vez de
        // aparentar un dato limpio.
        fila["Orden en MOS"] = r.en_mos ? "Sí" : "NO ENCONTRADA";
        fila["IDs de orden"] = r.order_ids;
        return fila;
      });

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(sheet);
      ws["!cols"] = Object.keys(sheet[0]).map((k) => ({ wch: Math.max(12, Math.min(28, k.length + 4)) }));
      XLSX.utils.book_append_sheet(wb, ws, "Pintadas");
      XLSX.writeFile(wb, `Ordenes_pintadas_${desde}_a_${hasta}.xlsx`);
      toast.success(`${rows.length} órdenes exportadas`);
      onClose?.();
    } catch (e) {
      toast.error(e.message === "error" ? "No se pudo generar el reporte" : e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogPortal>
        <DialogOverlay className="backdrop-blur-sm bg-black/20" />
        <DialogPrimitive.Content
          className="fixed left-[50%] top-[50%] z-[901] w-full max-w-md translate-x-[-50%] translate-y-[-50%] transform-gpu bg-card border border-border p-6 shadow-2xl sm:rounded-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
          data-testid="printed-report-modal"
        >
          <DialogHeader>
            <DialogTitle className="font-barlow text-xl uppercase tracking-wide flex items-center gap-2">
              <CalendarDays className="w-5 h-5 text-amber-500" /> Órdenes pintadas
            </DialogTitle>
          </DialogHeader>

          <p className="text-xs text-muted-foreground leading-relaxed mt-1">
            Todo lo que registró producción en el rango, agrupado por número de orden:
            una orden con varias capturas sale en un solo renglón con la suma.
          </p>

          <div className="grid grid-cols-2 gap-3 mt-4">
            <label className="text-xs uppercase tracking-wider font-bold text-muted-foreground">
              Desde
              <input
                type="date"
                value={desde}
                max={hasta}
                onChange={(e) => setDesde(e.target.value)}
                className="mt-1 w-full h-9 px-2 text-sm bg-secondary border border-border rounded text-foreground normal-case tracking-normal font-normal"
                data-testid="printed-report-from"
              />
            </label>
            <label className="text-xs uppercase tracking-wider font-bold text-muted-foreground">
              Hasta
              <input
                type="date"
                value={hasta}
                min={desde}
                onChange={(e) => setHasta(e.target.value)}
                className="mt-1 w-full h-9 px-2 text-sm bg-secondary border border-border rounded text-foreground normal-case tracking-normal font-normal"
                data-testid="printed-report-to"
              />
            </label>
          </div>

          <button
            onClick={generar}
            disabled={busy}
            className="mt-4 w-full h-10 rounded-lg bg-royal text-white text-sm font-bold flex items-center justify-center gap-2 hover:bg-royal-hover disabled:opacity-60 transition-colors"
            data-testid="printed-report-run"
          >
            {busy
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Generando…</>
              : <><Download className="w-4 h-4" /> Generar Excel</>}
          </button>

          <p className="text-[11px] text-muted-foreground mt-3 leading-relaxed">
            Las cifras son <b>impresiones</b>, no prendas: una orden impresa por frente y
            espalda cuenta doble. El Excel trae el desglose por posición.
          </p>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
};

export default PrintedReportModal;
