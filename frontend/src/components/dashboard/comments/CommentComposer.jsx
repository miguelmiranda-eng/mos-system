import { useState, useRef, useEffect } from "react";
import {
  X,
  Send,
  Camera,
  Loader2,
  Link2,
  AtSign,
  FileText,
  File as FileIcon,
  FileSpreadsheet,
} from "lucide-react";
import { useLang } from "../../../contexts/LanguageContext";
import { processFiles } from "./attachments";
import { useMentions } from "./useMentions";

// Caja inferior de redacción: banner de respuesta, previews de adjuntos,
// drag&drop, textarea con @menciones y botón de envío. El borrador (texto,
// adjuntos, a quién responde) es controlado por el modal para que su guardia de
// cierre pueda avisar de cambios sin enviar. onSend hace el POST y devuelve si
// tuvo éxito; el modal limpia el borrador al confirmarse.
export function CommentComposer({
  newComment,
  setNewComment,
  imagePreviews,
  setImagePreviews,
  replyingTo,
  onCancelReply,
  users,
  onSend,
}) {
  const { t } = useLang();
  const [loading, setLoading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [fileInputKey, setFileInputKey] = useState(0); // recrea el input (bug de caché en iOS)
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);
  const dropZoneRef = useRef(null);

  const mentions = useMentions(newComment, setNewComment, users, textareaRef);

  // Enfoca el textarea al empezar a responder a alguien.
  useEffect(() => {
    if (replyingTo) textareaRef.current?.focus();
  }, [replyingTo]);

  const addFiles = (files) => {
    processFiles(files).then((previews) => {
      if (previews.length) setImagePreviews((prev) => [...prev, ...previews]);
    });
  };

  const handleFileUpload = (e) => {
    if (e.target.files && e.target.files.length > 0) addFiles(e.target.files);
    setFileInputKey((k) => k + 1);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };
  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };
  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files?.length > 0) addFiles(e.dataTransfer.files);
  };

  const removeImage = (id) => setImagePreviews((prev) => prev.filter((img) => img.id !== id));

  const handleKeyDown = (e) => {
    if (mentions.handleKeyDown(e)) return;
    // Sin auto-envío con Enter: permite comentarios multilínea en PC y tablet.
    // El envío es por el botón.
  };

  const send = async () => {
    setLoading(true);
    await onSend();
    setLoading(false);
  };

  const disabled = loading || (!newComment.trim() && imagePreviews.length === 0);

  return (
    <div
      className="border-t border-border pt-3"
      ref={dropZoneRef}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div
          className="mb-3 border-2 border-dashed border-primary rounded-lg p-4 bg-primary/5 text-center"
          data-testid="drop-overlay"
        >
          <Camera className="w-6 h-6 mx-auto mb-1 text-primary" />
          <p className="text-sm text-primary font-medium">Suelta las imagenes aqui</p>
        </div>
      )}

      {replyingTo && (
        <div className="mb-2 px-3 py-1.5 bg-primary/10 border-l-4 border-primary rounded flex items-center justify-between animate-in slide-in-from-bottom-2 duration-300">
          <div className="flex items-center gap-2">
            <AtSign className="w-3 h-3 text-primary" />
            <span className="text-[10px] font-black uppercase text-primary">
              Respondiendo a {replyingTo.user_name}
            </span>
          </div>
          <button onClick={onCancelReply} className="p-1 hover:bg-primary/20 rounded text-primary">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {imagePreviews.length > 0 && !isDragging && (
        <div className="mb-3 flex flex-wrap gap-2" data-testid="image-previews">
          {imagePreviews.map((img) => (
            <div key={img.id} className="relative group">
              {img.isImage ? (
                <img src={img.data} alt={img.name} className="h-20 w-20 object-cover rounded border border-border" />
              ) : (
                <div className="h-20 w-20 rounded border border-border bg-secondary flex flex-col items-center justify-center p-2 text-center">
                  {img.type?.includes("pdf") ? (
                    <FileText className="w-8 h-8 text-primary" />
                  ) : img.name.toLowerCase().endsWith(".xlsx") || img.name.toLowerCase().endsWith(".xls") ? (
                    <FileSpreadsheet className="w-8 h-8 text-primary" />
                  ) : (
                    <FileIcon className="w-8 h-8 text-primary" />
                  )}
                </div>
              )}
              <button
                onClick={() => removeImage(img.id)}
                className="absolute -top-2 -right-2 bg-destructive text-white rounded-full w-5 h-5 flex items-center justify-center text-xs opacity-80 group-hover:opacity-100"
                data-testid={`remove-preview-${img.id}`}
              >
                <X className="w-3 h-3" />
              </button>
              <span className="absolute bottom-0 left-0 right-0 bg-black/60 text-[9px] text-white px-1 truncate rounded-b">
                {img.name}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 relative">
        <button
          onClick={() => fileInputRef.current?.click()}
          className="p-2 bg-secondary border border-border rounded hover:bg-secondary/80 transition-colors self-end"
          title={t("upload_file")}
          data-testid="upload-image-btn"
        >
          <Link2 className="w-4 h-4" />
        </button>
        <input
          key={fileInputKey}
          ref={fileInputRef}
          type="file"
          accept="image/*,.heic,.heif,.pdf,.xlsx,.xls,.doc,.docx,.csv,.txt"
          multiple
          onChange={handleFileUpload}
          className="hidden"
        />
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={newComment}
            onChange={mentions.handleChange}
            onKeyDown={handleKeyDown}
            placeholder={`${t("write_comment")} (usa @ para mencionar)`}
            style={{ backgroundColor: "hsl(var(--secondary))", color: "hsl(var(--foreground))" }}
            className="w-full border border-border rounded px-3 py-2 text-sm resize-none h-16"
            data-testid="comment-input"
          />
          {/* Dropdown de @menciones */}
          {mentions.query !== null && mentions.filtered.length > 0 && (
            <div
              className="absolute bottom-full left-0 mb-1 w-64 max-h-48 overflow-y-auto bg-popover border border-border rounded-lg shadow-xl z-50"
              data-testid="mention-dropdown"
            >
              {mentions.filtered.map((u, i) => (
                <button
                  key={u.email || i}
                  onClick={() => mentions.insert(u)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-secondary/50 ${
                    i === mentions.index ? "bg-primary/10 text-primary" : "text-foreground"
                  }`}
                  data-testid={`mention-user-${u.email}`}
                >
                  {u.picture ? (
                    <img src={u.picture} alt="" className="w-5 h-5 rounded-full" />
                  ) : (
                    <AtSign className="w-4 h-4 text-muted-foreground" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{u.name}</div>
                    <div className="text-[10px] text-muted-foreground truncate">{u.email}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={send}
          disabled={disabled}
          className="px-4 bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center self-end"
          data-testid="send-comment-btn"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}
