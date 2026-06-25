import React from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import QCInspectionPoints from "./QCInspectionPoints";

// Standalone "module" page for QC inspection-point configuration, reachable as a
// tile from MOS Home (not buried inside the catalog center).
export default function QCSettingsPage() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <header className="sticky top-0 z-40 bg-card border-b border-border px-4 md:px-8 h-16 flex items-center gap-3 flex-shrink-0">
        <button onClick={() => navigate("/home")} className="p-2 rounded-lg hover:bg-secondary text-muted-foreground" title="Volver a MOS Home">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <ShieldCheck className="w-5 h-5 text-primary" />
        <div className="font-black uppercase tracking-tight">Configuración QC · Puntos de Inspección</div>
      </header>
      <div className="flex-1 flex flex-col overflow-hidden">
        <QCInspectionPoints />
      </div>
    </div>
  );
}
