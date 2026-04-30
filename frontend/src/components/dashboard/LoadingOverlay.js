import { Loader2 } from "lucide-react";

export const LoadingOverlay = ({ isLoading, message = "Cargando..." }) => {
  if (!isLoading) return null;
  return (
    <div className="absolute inset-0 z-[200] bg-background/80 backdrop-blur-md flex flex-col items-center justify-center animate-in fade-in duration-300">
      <div className="relative">
        {/* Outer Glow Effect */}
        <div className="absolute inset-0 bg-primary/20 blur-3xl animate-pulse rounded-full" />
        
        {/* Premium Spinner */}
        <div className="relative z-10 flex flex-col items-center">
          <Loader2 className="w-12 h-12 animate-spin text-primary" strokeWidth={2.5} />
          <div className="mt-6 flex flex-col items-center gap-2">
            <span className="text-[10px] font-black uppercase tracking-[0.5em] text-foreground animate-pulse pl-[0.5em]">
              {message}
            </span>
            {/* Minimalist Progress Bar */}
            <div className="w-48 h-[2px] bg-secondary overflow-hidden rounded-full mt-2">
              <div className="w-full h-full bg-primary origin-left animate-loading-bar-fast" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
