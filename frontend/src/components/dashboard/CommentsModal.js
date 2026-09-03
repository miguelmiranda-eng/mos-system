import { useState, useMemo } from "react";
import { useLang } from "../../contexts/LanguageContext";
import { X, MessageSquare, Pin, Boxes, Scissors } from "lucide-react";
import { Dialog, DialogPortal, DialogOverlay } from "../ui/dialog";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useComments } from "./comments/useComments";
import { canModerate } from "./comments/roles";
import { PackingBanner } from "./comments/PackingBanner";
import { SurtidoTable } from "./comments/SurtidoTable";
import { NeckTable } from "./comments/NeckTable";
import { LinksSection } from "./comments/LinksSection";
import { CommentItem } from "./comments/CommentItem";
import { CommentComposer } from "./comments/CommentComposer";

// Modal de comentarios del CRM. Orquesta las piezas de ./comments: el hook de
// datos (useComments) y los sub-componentes de UI. Se reutiliza tal cual en
// Dashboard, OperatorView, MachineOperatorView, QCDashboard y PdaPicker; la
// superficie pública es { order, isOpen, onClose, currentUser } — no cambiar.
export const CommentsModal = ({ order, isOpen, onClose, currentUser }) => {
  const { t } = useLang();
  const {
    comments,
    links,
    addComment,
    editComment,
    deleteComment,
    pinComment,
    reactToComment,
    addLink,
    deleteLink,
    users,
  } = useComments(order, isOpen, currentUser);

  // Borrador controlado aquí para que la guardia de cierre pueda avisar de
  // texto/adjuntos sin enviar.
  const [newComment, setNewComment] = useState("");
  const [imagePreviews, setImagePreviews] = useState([]);
  const [replyingTo, setReplyingTo] = useState(null);
  const [showSurtido, setShowSurtido] = useState(false);
  const [showNeck, setShowNeck] = useState(false);

  const handleClose = () => {
    if (newComment.trim() || imagePreviews.length > 0) {
      if (!window.confirm("Tienes un comentario o archivos sin enviar. ¿Estás seguro de que quieres salir?")) return;
    }
    setNewComment("");
    setImagePreviews([]);
    setReplyingTo(null);
    onClose();
  };

  const handleSend = async () => {
    const ok = await addComment({
      content: newComment,
      attachments: imagePreviews,
      parentId: replyingTo?.comment_id || null,
    });
    if (ok) {
      setNewComment("");
      setImagePreviews([]);
      setReplyingTo(null);
    }
  };

  // Packing list — SIEMPRE hasta arriba. Dos fuentes, gana la más fresca:
  //   1. Los campos packing_link* de la orden (los escribe el sembrador), que
  //      pueden venir rancios del grid si se sembró después de cargarlo.
  //   2. El último comentario source=packing_link_seed, que el modal fetchea
  //      recién al abrir.
  const packing = useMemo(() => {
    let label = order?.packing_link_label,
      url = order?.packing_link,
      at = order?.packing_link_at || "";
    const seeds = comments.filter((c) => c.source === "packing_link_seed");
    const last = seeds[seeds.length - 1]; // llegan en orden cronológico
    if (last) {
      const m = (last.content || "").match(/\[file\](.*?)\|(.*?)\[\/file\]/);
      if (m && (!url || (last.created_at || "") >= at)) {
        label = m[1];
        url = m[2];
        at = last.created_at;
      }
    }
    return url ? { label: label || "Packing list", url, at } : null;
  }, [order, comments]);

  const { pinnedComments, unpinnedComments, repliesMap } = useMemo(() => {
    const roots = comments.filter((c) => !c.parent_id);
    const map = comments.reduce((acc, c) => {
      if (c.parent_id) (acc[c.parent_id] = acc[c.parent_id] || []).push(c);
      return acc;
    }, {});
    return {
      pinnedComments: roots.filter((c) => c.pinned),
      unpinnedComments: roots.filter((c) => !c.pinned),
      repliesMap: map,
    };
  }, [comments]);

  if (!order) return null;

  const isAdmin = canModerate(currentUser);
  const actions = {
    onReply: (c) => setReplyingTo(c),
    onReact: reactToComment,
    onPin: pinComment,
    onEditSave: editComment,
    onDelete: deleteComment,
  };
  const renderComment = (c) => (
    <CommentItem
      key={c.comment_id}
      comment={c}
      repliesMap={repliesMap}
      currentUser={currentUser}
      isAdmin={isAdmin}
      actions={actions}
    />
  );

  return (
    <>
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogPortal>
        <DialogOverlay className="backdrop-blur-sm bg-black/20 z-[190]" />
        <DialogPrimitive.Content
          className="fixed left-[50%] top-[50%] z-[200] w-full max-w-[95vw] md:max-w-4xl max-h-[90vh] translate-x-[-50%] translate-y-[-50%] bg-card border border-border overflow-hidden flex flex-col shadow-lg sm:rounded-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
          data-testid="comments-modal"
        >
          <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
            <div className="font-barlow text-xl uppercase tracking-wide flex items-center gap-3 font-bold">
              <MessageSquare className="w-5 h-5" /> {t("comments")} - {order.order_number}
              {order.requires_sample === true && (
                <span
                  className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 tracking-wide normal-case"
                  title={order.sample_spec ? `Sample: ${order.sample_spec}` : "Requiere sample (Printavo)"}
                >
                  REQUIERE SAMPLE
                </span>
              )}
              {order.requires_sample === false && (
                <span
                  className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-secondary text-muted-foreground tracking-wide normal-case"
                  title="Printavo: SAMPLES N/A"
                >
                  SIN SAMPLE
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowSurtido(true)}
                className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg bg-indigo-500/15 text-indigo-400 hover:bg-indigo-500/25 transition-colors"
                data-testid="open-surtido"
              >
                <Boxes className="w-4 h-4" /> Surtido WMS
              </button>
              <button
                onClick={() => setShowNeck(true)}
                className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg bg-pink-500/15 text-pink-400 hover:bg-pink-500/25 transition-colors"
                data-testid="open-neck"
              >
                <Scissors className="w-4 h-4" /> Neck
              </button>
              <button
                onClick={handleClose}
                className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
                aria-label="Cerrar"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          <PackingBanner packing={packing} />

          <LinksSection links={links} onAddLink={addLink} onDeleteLink={deleteLink} />

          {/* Lista de comentarios */}
          <div className="flex-1 overflow-y-auto py-3 space-y-3" data-testid="comments-list">
            {comments.length === 0 ? (
              <p className="text-center text-muted-foreground py-6">{t("no_data")}</p>
            ) : (
              <>
                {pinnedComments.length > 0 && (
                  <div className="mb-2">
                    <div className="flex items-center gap-2 mb-2 px-1">
                      <Pin className="w-3.5 h-3.5 text-amber-500" />
                      <span className="text-[10px] font-black uppercase tracking-widest text-amber-500">
                        Anclados ({pinnedComments.length})
                      </span>
                      <div className="flex-1 h-px bg-amber-500/20" />
                    </div>
                    <div className="space-y-3">{pinnedComments.map(renderComment)}</div>
                    {unpinnedComments.length > 0 && (
                      <div className="flex items-center gap-2 mt-4 mb-2 px-1">
                        <MessageSquare className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                          Todos los comentarios
                        </span>
                        <div className="flex-1 h-px bg-border/50" />
                      </div>
                    )}
                  </div>
                )}
                <div className="space-y-3">{unpinnedComments.map(renderComment)}</div>
              </>
            )}
          </div>

          <CommentComposer
            newComment={newComment}
            setNewComment={setNewComment}
            imagePreviews={imagePreviews}
            setImagePreviews={setImagePreviews}
            replyingTo={replyingTo}
            onCancelReply={() => setReplyingTo(null)}
            users={users}
            onSend={handleSend}
          />
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>

    {/* Surtido (WMS) — Dialog ANIDADO de Radix (maneja layering + pointer-events;
        un div flotante dentro del portal del modal padre queda bloqueado). */}
    <Dialog open={showSurtido} onOpenChange={setShowSurtido}>
      <DialogPortal>
        <DialogOverlay className="backdrop-blur-sm bg-black/60 z-[210]" />
        <DialogPrimitive.Content className="fixed left-[50%] top-[50%] z-[220] w-full max-w-[95vw] md:max-w-3xl max-h-[85vh] translate-x-[-50%] translate-y-[-50%] overflow-y-auto bg-card border border-border rounded-2xl shadow-2xl">
          <div className="flex items-center justify-between px-5 py-3 border-b border-border sticky top-0 bg-card z-10">
            <div className="font-bold text-base flex items-center gap-2">
              <Boxes className="w-5 h-5 text-indigo-400" /> Surtido (WMS) - {order.order_number}
            </div>
            <button onClick={() => setShowSurtido(false)} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground" aria-label="Cerrar">
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="pb-4">
            <SurtidoTable order={order} isOpen={showSurtido} />
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>

    {/* Neck (captura manual) — Dialog anidado. */}
    <Dialog open={showNeck} onOpenChange={setShowNeck}>
      <DialogPortal>
        <DialogOverlay className="backdrop-blur-sm bg-black/60 z-[210]" />
        <DialogPrimitive.Content className="fixed left-[50%] top-[50%] z-[220] w-full max-w-[95vw] md:max-w-3xl max-h-[85vh] translate-x-[-50%] translate-y-[-50%] overflow-y-auto bg-card border border-border rounded-2xl shadow-2xl">
          <div className="flex items-center justify-between px-5 py-3 border-b border-border sticky top-0 bg-card z-10">
            <div className="font-bold text-base flex items-center gap-2">
              <Scissors className="w-5 h-5 text-pink-400" /> Neck - {order.order_number}
            </div>
            <button onClick={() => setShowNeck(false)} className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground" aria-label="Cerrar">
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="pb-4">
            <NeckTable order={order} isOpen={showNeck} />
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
    </>
  );
};
