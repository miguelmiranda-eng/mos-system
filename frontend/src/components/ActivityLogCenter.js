import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { History, ArrowLeft, Search, CornerDownLeft } from 'lucide-react';
import OrderHistoryModal from './OrderHistoryModal';

const ActivityLogCenter = () => {
  const navigate = useNavigate();
  const [term, setTerm] = useState('');
  const [query, setQuery] = useState(null);
  const [open, setOpen] = useState(false);

  const submit = () => {
    const q = term.trim();
    if (!q) return;
    setQuery(q);
    setOpen(true);
  };

  return (
    <div className="relative min-h-screen bg-background text-foreground font-barlow overflow-y-auto">
      {/* Ambient glow */}
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_900px_500px_at_top,rgba(var(--primary),0.10),transparent_60%)]" />

      {/* Top bar */}
      <header className="relative z-10 px-6 md:px-10 pt-8">
        <button onClick={() => navigate('/home')} className="text-muted-foreground hover:text-foreground flex items-center text-sm transition-colors group mb-8">
          <ArrowLeft className="w-4 h-4 mr-1 group-hover:-translate-x-1 transition-transform" /> Volver al Home
        </button>
      </header>

      {/* Hero search */}
      <main className="relative z-10 max-w-2xl mx-auto px-6 pt-10 md:pt-20 text-center">
        <div className="w-16 h-16 mx-auto rounded-2xl bg-primary/15 border border-primary/30 flex items-center justify-center mb-6">
          <History className="w-8 h-8 text-primary" />
        </div>
        <h1 className="text-4xl font-black uppercase tracking-tighter">
          ACTIVITY <span className="text-primary">LOG</span>
        </h1>
        <p className="text-muted-foreground text-sm mt-2 mb-10">
          Escribe un número de orden para ver toda su historia: creación, movimientos, cambios de columna, comentarios y más.
        </p>

        <div className="relative">
          <Search className="absolute left-5 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
          <input
            autoFocus
            type="text"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            placeholder="Número de orden (ej. 1558 o #1558)…"
            className="w-full h-16 pl-14 pr-32 bg-card border-2 border-border rounded-2xl text-lg font-bold focus:outline-none focus:border-primary shadow-xl transition-all"
          />
          <button
            onClick={submit}
            disabled={!term.trim()}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 h-11 px-5 bg-primary text-black rounded-xl text-[11px] font-black uppercase tracking-widest flex items-center gap-2 disabled:opacity-40 hover:opacity-90 transition-all"
          >
            Buscar <CornerDownLeft className="w-4 h-4" />
          </button>
        </div>

        <p className="text-[11px] text-muted-foreground/60 mt-4 uppercase tracking-widest font-bold">
          Enter para abrir la historia completa
        </p>
      </main>

      <OrderHistoryModal query={query} isOpen={open} onClose={() => setOpen(false)} />
    </div>
  );
};

export default ActivityLogCenter;
