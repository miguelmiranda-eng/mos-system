import { Loader2 } from "lucide-react";

export const LoadingOverlay = ({ isLoading, message = "Cargando..." }) => {
  if (!isLoading) return null;
  return (
    <div className="absolute inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center">
      <div className="bg-card border border-border rounded-lg p-6 flex items-center gap-4">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
        <span className="text-foreground font-medium">{message}</span>
      </div>
    </div>
  );
};
