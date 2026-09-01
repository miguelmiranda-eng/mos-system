import { FileText, FileSpreadsheet, File as FileIcon, Download } from "lucide-react";
import { API } from "../../../lib/constants";

// Resuelve una clave de adjunto a una URL absoluta servible.
const srcFor = (key) =>
  key.startsWith("http") || key.startsWith("/api/uploads/") ? key : `${API}/uploads/${key}`;

// Renderiza el contenido de un comentario: texto plano, @menciones resaltadas,
// imágenes [img]clave[/img] y documentos [file]nombre|clave[/file].
export function CommentContent({ content }) {
  if (!content) return null;

  const parts = content.split(/(\[img\].*?\[\/img\]|\[file\].*?\[\/file\])/g);

  return parts.map((part, i) => {
    // Imágenes
    if (part.startsWith("[img]")) {
      const key = part.replace("[img]", "").replace("[/img]", "");
      const src = srcFor(key);
      return (
        <img
          key={i}
          src={src}
          alt="Imagen"
          loading="lazy"
          decoding="async"
          className="max-w-full max-h-60 rounded-lg mt-1 cursor-pointer"
          onClick={() => window.open(src, "_blank")}
          data-testid="comment-image"
        />
      );
    }

    // Documentos
    if (part.startsWith("[file]")) {
      const fileInfo = part.replace("[file]", "").replace("[/file]", "");
      const [filename, key] = fileInfo.split("|");
      const src = srcFor(key);
      const lower = filename.toLowerCase();
      const isPdf = lower.endsWith(".pdf");
      const isExcel = lower.endsWith(".xlsx") || lower.endsWith(".xls");
      return (
        <div
          key={i}
          className="mt-2 mb-1 p-2 bg-secondary/50 border border-border rounded-lg flex items-center gap-3 group max-w-sm"
        >
          <div className="bg-background p-2 rounded border border-border">
            {isPdf ? (
              <FileText className="w-5 h-5 text-primary" />
            ) : isExcel ? (
              <FileSpreadsheet className="w-5 h-5 text-primary" />
            ) : (
              <FileIcon className="w-5 h-5 text-primary" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium truncate text-foreground">{filename}</p>
            <p className="text-[10px] text-muted-foreground uppercase">Documento</p>
          </div>
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1 px-2 flex items-center gap-1 text-[10px] bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors"
            title="Descargar"
          >
            <Download className="w-3 h-3" /> Descargar
          </a>
        </div>
      );
    }

    // Texto normal + menciones
    if (!part) return null;
    const segments = part.split(/@(\S+)/g);
    if (segments.length > 1) {
      return segments.map((seg, idx) =>
        idx % 2 === 1 ? (
          <span key={`${i}-${idx}`} className="text-primary font-semibold bg-primary/10 rounded px-0.5">
            @{seg}
          </span>
        ) : (
          <span key={`${i}-${idx}`} style={{ whiteSpace: "pre-wrap" }}>
            {seg}
          </span>
        )
      );
    }
    return (
      <span key={i} style={{ whiteSpace: "pre-wrap" }}>
        {part}
      </span>
    );
  });
}
