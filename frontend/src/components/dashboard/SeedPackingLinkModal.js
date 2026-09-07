import React, { useState, useMemo } from "react";
import { toast } from "sonner";
import { API } from "../../lib/constants";
import { useLang } from "../../contexts/LanguageContext";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Link2, Loader2, Check, AlertCircle, CircleSlash } from "lucide-react";

// Herramienta para sembrar el enlace de un packing list en el modal de comentarios
// de varias ordenes a la vez. El usuario pega los numeros de orden (columna A del
// packing), una etiqueta y el enlace; la herramienta los busca por order_number y
// agrega el comentario con el link clickeable. Idempotente en el backend.
export const SeedPackingLinkModal = ({ isOpen, onClose, onSeeded }) => {
  const { t } = useLang();
  const [numbersText, setNumbersText] = useState("");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  // Parseo tolerante: un numero por linea (como se pega la columna A de Excel);
  // toma el primer campo si pegaron varias columnas (tab), y separa por comas.
  // Deduplica preservando el orden.
  const numbers = useMemo(() => {
    const seen = new Set(), out = [];
    numbersText.split(/[\n\r]+/).forEach((line) => {
      const first = line.split(/\t/)[0];
      first.split(/[,;]/).forEach((tok) => {
        const s = tok.trim();
        if (s && !seen.has(s)) { seen.add(s); out.push(s); }
      });
    });
    return out;
  }, [numbersText]);

  const reset = () => { setNumbersText(""); setLabel(""); setUrl(""); setResult(null); };
  const close = () => { if (!loading) { reset(); onClose(); } };

  const seed = async () => {
    if (!url.trim()) { toast.error(t('ship_seed_paste_link')); return; }
    if (numbers.length === 0) { toast.error(t('ship_seed_paste_numbers')); return; }
    setLoading(true); setResult(null);
    try {
      const res = await fetch(`${API}/orders/seed-packing-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ order_numbers: numbers, label: label.trim(), url: url.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t('ship_seed_err'));
        return;
      }
      const data = await res.json();
      setResult(data);
      toast.success(t('ship_seed_ok', { n: data.seeded_count }));
      if (onSeeded) onSeeded();
    } catch { toast.error(t('ceo_err_connection')); }
    finally { setLoading(false); }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="w-5 h-5 text-indigo-500" /> {t('ship_seed_title')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label className="text-[11px] font-black uppercase tracking-widest text-muted-foreground block mb-1">
              {t('ship_seed_label')}
            </label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="PL GTS 07-26-0005 SHIPPING 07-14-2026"
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm"
              data-testid="seed-label"
            />
          </div>

          <div>
            <label className="text-[11px] font-black uppercase tracking-widest text-muted-foreground block mb-1">
              {t('ship_seed_url')}
            </label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono"
              data-testid="seed-url"
            />
          </div>

          <div>
            <label className="text-[11px] font-black uppercase tracking-widest text-muted-foreground block mb-1">
              {t('ship_seed_numbers')}
            </label>
            <textarea
              value={numbersText}
              onChange={(e) => setNumbersText(e.target.value)}
              placeholder={t('ship_seed_numbers_placeholder')}
              rows={6}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono resize-y"
              data-testid="seed-numbers"
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              {numbers.length > 0
                ? <>{t('ship_seed_detected_1')} <b>{numbers.length}</b> {t('ship_seed_detected_2')} <span className="font-mono">{numbers.slice(0, 12).join(", ")}{numbers.length > 12 ? "…" : ""}</span></>
                : t('ship_seed_hint')}
            </p>
          </div>

          {result && (
            <div className="rounded-lg border border-border/50 bg-secondary/20 p-3 space-y-1.5 text-xs" data-testid="seed-result">
              <div className="flex items-center gap-2 text-emerald-500 font-bold">
                <Check className="w-4 h-4" /> {t('ship_seed_result', { a: result.seeded_count, b: result.total })}
              </div>
              {result.skipped_count > 0 && (
                <div className="flex items-center gap-2 text-amber-500">
                  <CircleSlash className="w-3.5 h-3.5" /> {t('ship_seed_skipped', { n: result.skipped_count })}
                </div>
              )}
              {result.not_found_count > 0 && (
                <div className="flex items-start gap-2 text-red-500">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <span>{t('ship_seed_not_found', { n: result.not_found_count })} <span className="font-mono">{result.not_found.join(", ")}</span></span>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={close} disabled={loading} className="px-4 py-2 bg-secondary text-foreground rounded-lg text-sm font-bold disabled:opacity-50">
            {t('close')}
          </button>
          <button
            onClick={seed}
            disabled={loading || !url.trim() || numbers.length === 0}
            className="px-5 py-2 bg-indigo-500 hover:bg-indigo-400 text-white rounded-lg text-sm font-black uppercase tracking-wider flex items-center gap-2 disabled:opacity-50"
            data-testid="seed-submit"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
            {t('ship_seed_submit', { n: numbers.length || 0 })}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
