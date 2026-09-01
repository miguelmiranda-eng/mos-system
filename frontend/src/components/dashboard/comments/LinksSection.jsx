import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Link2, Plus, ExternalLink, Trash2, Loader2, FileSpreadsheet } from "lucide-react";
import { esUrlGoogleSheets } from "../../../sheets/engine/gsheets";

// Sección de enlaces de la orden: lista + formulario para agregar. Los Google
// Sheets (packing lists) ofrecen además un atajo para abrirse dentro de MOS
// Sheet. onAddLink devuelve true si se guardó, para limpiar el formulario.
export function LinksSection({ links, onAddLink, onDeleteLink }) {
  const navigate = useNavigate();
  const [showAddLink, setShowAddLink] = useState(false);
  const [newLinkUrl, setNewLinkUrl] = useState("");
  const [newLinkDesc, setNewLinkDesc] = useState("");
  const [linkLoading, setLinkLoading] = useState(false);

  const handleAdd = async () => {
    if (!newLinkUrl.trim()) return;
    setLinkLoading(true);
    const ok = await onAddLink(newLinkUrl, newLinkDesc);
    setLinkLoading(false);
    if (ok) {
      setNewLinkUrl("");
      setNewLinkDesc("");
      setShowAddLink(false);
    }
  };

  const cancelAdd = () => {
    setShowAddLink(false);
    setNewLinkUrl("");
    setNewLinkDesc("");
  };

  return (
    <div className="border-b border-border pb-3" data-testid="links-section">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs uppercase tracking-wider font-bold text-muted-foreground flex items-center gap-1.5">
          <Link2 className="w-3.5 h-3.5" /> Enlaces
        </span>
        <button
          onClick={() => setShowAddLink(!showAddLink)}
          className="text-xs text-primary hover:underline flex items-center gap-1"
          data-testid="toggle-add-link"
        >
          <Plus className="w-3.5 h-3.5" /> Agregar enlace
        </button>
      </div>

      {showAddLink && (
        <div className="bg-secondary/30 border border-border rounded-lg p-3 mb-2 space-y-2" data-testid="add-link-form">
          <input
            type="url"
            value={newLinkUrl}
            onChange={(e) => setNewLinkUrl(e.target.value)}
            placeholder="https://..."
            style={{ backgroundColor: "hsl(var(--secondary))", color: "hsl(var(--foreground))" }}
            className="w-full border border-border rounded px-3 py-1.5 text-sm"
            data-testid="link-url-input"
          />
          <input
            type="text"
            value={newLinkDesc}
            onChange={(e) => setNewLinkDesc(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
            }}
            placeholder="Descripcion del enlace..."
            style={{ backgroundColor: "hsl(var(--secondary))", color: "hsl(var(--foreground))" }}
            className="w-full border border-border rounded px-3 py-1.5 text-sm"
            data-testid="link-desc-input"
          />
          <div className="flex justify-end gap-2">
            <button onClick={cancelAdd} className="px-3 py-1 text-xs text-muted-foreground hover:text-foreground">
              Cancelar
            </button>
            <button
              onClick={handleAdd}
              disabled={linkLoading || !newLinkUrl.trim()}
              className="px-3 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1"
              data-testid="save-link-btn"
            >
              {linkLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} Guardar
            </button>
          </div>
        </div>
      )}

      {links.length > 0 ? (
        <div className="space-y-1">
          {links.map((link, idx) => (
            <div
              key={idx}
              className="flex items-center gap-2 group bg-secondary/30 rounded px-2.5 py-1.5"
              data-testid={`link-item-${idx}`}
            >
              <ExternalLink className="w-3.5 h-3.5 text-primary flex-shrink-0" />
              <a
                href={link.url.startsWith("http") ? link.url : `https://${link.url}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline truncate flex-1"
                title={link.url}
              >
                {link.description || link.url.replace(/^https?:\/\//, "").split("/")[0]}
              </a>
              {link.description && (
                <span className="text-[10px] text-muted-foreground truncate max-w-[120px]" title={link.url}>
                  {link.url.replace(/^https?:\/\//, "").split("/")[0]}
                </span>
              )}
              {/* Si es un Google Sheet (packing list), abrirlo dentro de MOS Sheet. */}
              {esUrlGoogleSheets(link.url) && (
                <button
                  onClick={() =>
                    navigate(
                      `/sheets?gsheet=${encodeURIComponent(link.url.startsWith("http") ? link.url : `https://${link.url}`)}`
                    )
                  }
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-semibold hover:bg-primary/20 flex-shrink-0"
                  title="Abrir en MOS Sheet"
                >
                  <FileSpreadsheet className="w-3 h-3" /> MOS
                </button>
              )}
              <button
                onClick={() => onDeleteLink(idx)}
                className="p-0.5 opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity"
                title="Eliminar"
                data-testid={`delete-link-${idx}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        !showAddLink && <p className="text-xs text-muted-foreground text-center py-1">Sin enlaces</p>
      )}
    </div>
  );
}
