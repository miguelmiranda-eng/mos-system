import React, { useState } from "react";
import { Sparkles, Loader2, Send, Search, AlertTriangle } from "lucide-react";
import { API } from "../../lib/constants";

const EXAMPLES = [
  "¿Dónde está el SKU 1001?",
  "¿Qué hay en la locación RCV-STG-01?",
  "Historial de movimientos de la caja BOX-000001",
  "¿Cuándo se recibió el SKU 1001 y quién?",
  "Unidades en mano del style 1001",
];

export function WmsQueryModule() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const ask = async (q) => {
    const text = (q ?? question).trim();
    if (!text) return;
    setQuestion(text);
    setLoading(true); setError(null); setResult(null);
    try {
      const res = await fetch(`${API}/wms/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ question: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Error en la consulta");
      setResult(data);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const cols = result?.rows?.length ? Object.keys(result.rows[0]) : [];

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary/15 flex items-center justify-center text-primary">
          <Sparkles className="w-5 h-5" />
        </div>
        <div>
          <h2 className="text-lg font-black uppercase tracking-widest text-foreground">Rastreabilidad IA</h2>
          <p className="text-xs text-muted-foreground">Pregunta en lenguaje natural: ubicación de cajas/SKU, historial, ASN, inventario.</p>
        </div>
      </div>

      {/* Input */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") ask(); }}
            placeholder="Ej: ¿dónde está el SKU 1001?"
            className="w-full bg-secondary/50 border border-border rounded-xl pl-10 pr-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <button onClick={() => ask()} disabled={loading || !question.trim()}
          className="px-6 py-3 bg-primary text-black rounded-xl font-black text-xs uppercase tracking-widest hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Consultar
        </button>
      </div>

      {/* Examples */}
      <div className="flex flex-wrap gap-2">
        {EXAMPLES.map((ex) => (
          <button key={ex} onClick={() => ask(ex)} disabled={loading}
            className="text-[11px] px-3 py-1.5 rounded-full bg-secondary/40 border border-border/40 text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors">
            {ex}
          </button>
        ))}
      </div>

      {error && (
        <div className="flex items-center gap-2 px-4 py-3 bg-destructive/10 border border-destructive/30 rounded-xl text-sm text-destructive">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {/* Answer */}
      {result && (
        <div className="space-y-4">
          <div className="bg-card/60 border border-primary/20 rounded-2xl p-5">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="w-4 h-4 text-primary" />
              <span className="text-[10px] uppercase font-black tracking-widest text-muted-foreground">Respuesta</span>
              <span className="text-[10px] text-muted-foreground/60 ml-auto">{result.tool} · {result.count} resultados</span>
            </div>
            <p className="text-sm text-foreground leading-relaxed whitespace-pre-line">{result.answer}</p>
          </div>

          {/* Table */}
          {result.rows?.length > 0 && (
            <div className="bg-card/40 border border-border rounded-2xl overflow-hidden">
              <div className="overflow-x-auto max-h-[420px]">
                <table className="w-full text-xs">
                  <thead className="bg-secondary/60 sticky top-0">
                    <tr>{cols.map((c) => <th key={c} className="text-left font-black uppercase tracking-wide px-3 py-2 text-muted-foreground">{c}</th>)}</tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, i) => (
                      <tr key={i} className="border-t border-border/30 hover:bg-secondary/20">
                        {cols.map((c) => (
                          <td key={c} className="px-3 py-1.5 text-foreground/90 whitespace-nowrap max-w-[220px] truncate" title={fmt(row[c])}>{fmt(row[c])}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const fmt = (v) => {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

export default WmsQueryModule;
