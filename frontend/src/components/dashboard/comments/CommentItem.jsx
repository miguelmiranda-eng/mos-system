import { useState } from "react";
import { Pin, PinOff, Pencil, Trash2 } from "lucide-react";
import { CommentContent } from "./CommentContent";
import { canModifyComment } from "./roles";
import { useLang } from "../../../contexts/LanguageContext";

// Un comentario del hilo (y sus respuestas, recursivamente). Mantiene su propio
// estado de edición — antes vivía levantado en el modal, lo que hacía que
// editar uno ocultara la barra de acciones de TODOS. Las mutaciones llegan por
// callbacks del hook useComments. Las reacciones con emoji se retiraron
// (pedido 2026-09-11); las guardadas en comentarios viejos ya no se muestran.
export function CommentItem({ comment, repliesMap, isReply = false, currentUser, isAdmin, actions }) {
  const { t } = useLang();
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const isPinned = comment.pinned === true;
  const canModify = canModifyComment(comment, currentUser);
  const replies = repliesMap[comment.comment_id] || [];

  const startEdit = () => {
    setEditContent(comment.content);
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!editContent.trim()) return;
    setEditLoading(true);
    const ok = await actions.onEditSave(comment.comment_id, editContent);
    setEditLoading(false);
    if (ok) setEditing(false);
  };

  return (
    <div
      className={`group flex flex-col gap-1 transition-all ${
        isReply
          ? "ml-10 border-l-2 border-border/30 pl-4 py-1"
          : isPinned
            ? "bg-amber-500/10 border border-amber-400/40 rounded-xl p-4 shadow-sm"
            : "bg-secondary/20 border border-border/30 rounded-xl p-4"
      }`}
      data-testid={`comment-${comment.comment_id}`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        {comment.user_picture ? (
          <img
            src={comment.user_picture}
            alt=""
            loading="lazy"
            decoding="async"
            className="w-6 h-6 rounded-full border border-border/50"
          />
        ) : (
          <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center text-[10px] font-bold text-primary">
            {comment.user_name?.charAt(0)}
          </div>
        )}
        <span className="text-xs font-black text-foreground/80">{comment.user_name}</span>
        <span className="text-[10px] text-muted-foreground">{new Date(comment.created_at).toLocaleString()}</span>
        {comment.edited_at && <span className="text-[10px] text-muted-foreground italic">{t('comment_edited_mark')}</span>}
        {isPinned && (
          <span className="flex items-center gap-1 text-[10px] text-amber-500 font-bold ml-1">
            <Pin className="w-3 h-3" /> {t('comment_pinned_label')}
            {comment.pinned_by && <span className="text-muted-foreground font-normal">{t('comment_by')} {comment.pinned_by}</span>}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {isAdmin && !isReply && (
            <button
              onClick={() => actions.onPin(comment.comment_id, isPinned)}
              className={`p-1 rounded transition-all ${
                isPinned
                  ? "text-amber-500 hover:text-muted-foreground hover:bg-secondary"
                  : "text-muted-foreground hover:text-amber-500 hover:bg-amber-500/10"
              }`}
              title={isPinned ? t('comment_unpin') : t('comment_pin')}
              data-testid={`pin-comment-${comment.comment_id}`}
            >
              {isPinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
            </button>
          )}
          {canModify && !editing && (
            <>
              <button
                onClick={startEdit}
                className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground"
                title={t('edit')}
              >
                <Pencil className="w-3 h-3" />
              </button>
              <button
                onClick={() => {
                  if (window.confirm(t('comment_delete_confirm'))) actions.onDelete(comment.comment_id);
                }}
                className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                title={t('delete')}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Contenido / edición */}
      {editing ? (
        <div className="space-y-2">
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            style={{ backgroundColor: "hsl(var(--secondary))", color: "hsl(var(--foreground))" }}
            className="w-full border border-border rounded px-3 py-2 text-sm resize-none"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setEditing(false)} className="px-2 py-1 text-[10px]">
              {t('cancel')}
            </button>
            <button
              onClick={saveEdit}
              disabled={editLoading}
              className="px-3 py-1 text-[10px] bg-primary text-primary-foreground rounded disabled:opacity-50"
            >
              {t('save')}
            </button>
          </div>
        </div>
      ) : (
        <div className="text-sm text-foreground leading-relaxed">
          <CommentContent content={comment.content} />
        </div>
      )}

      {/* Barra de acciones */}
      {!editing && (
        <div className="flex items-center gap-4 mt-2 border-t border-border/10 pt-2 min-h-[32px]">
          {!isReply && (
            <button
              onClick={() => actions.onReply(comment)}
              className="text-[10px] font-bold text-muted-foreground hover:text-primary transition-colors"
            >
              {t('comment_reply')}
            </button>
          )}

        </div>
      )}

      {/* Respuestas (recursivo) */}
      {replies.map((reply) => (
        <CommentItem
          key={reply.comment_id}
          comment={reply}
          repliesMap={repliesMap}
          isReply
          currentUser={currentUser}
          isAdmin={isAdmin}
          actions={actions}
        />
      ))}
    </div>
  );
}
