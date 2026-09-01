import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { API } from "../../../lib/constants";
import { mapPool } from "../../../lib/uploadPool";
import { useLang } from "../../../contexts/LanguageContext";

// Toda la capa de datos del modal de comentarios: estado (comments, links,
// users) + las mutaciones contra la API. Los sub-componentes solo consumen las
// acciones que devuelve este hook; nadie más hace fetch. Se refresca solo al
// abrir el modal sobre una orden.
export function useComments(order, isOpen, currentUser) {
  const { t } = useLang();
  const [comments, setComments] = useState([]);
  const [links, setLinks] = useState([]);
  const [users, setUsers] = useState([]);

  const orderId = order?.order_id;

  const fetchComments = useCallback(async () => {
    if (!orderId) return;
    try {
      const res = await fetch(`${API}/orders/${orderId}/comments`, { credentials: "include" });
      if (res.ok) setComments(await res.json());
    } catch (error) {
      console.error("Error fetching comments:", error);
    }
  }, [orderId]);

  const fetchLinks = useCallback(async () => {
    if (!orderId) return;
    try {
      const res = await fetch(`${API}/orders/${orderId}/links`, { credentials: "include" });
      if (res.ok) setLinks(await res.json());
    } catch (error) {
      console.error("Error fetching links:", error);
    }
  }, [orderId]);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch(`${API}/users/list`, { credentials: "include" });
      if (res.ok) setUsers(await res.json());
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    if (orderId && isOpen) {
      fetchComments();
      fetchLinks();
      fetchUsers();
    }
  }, [orderId, isOpen, fetchComments, fetchLinks, fetchUsers]);

  // Sube adjuntos en paralelo (limitado) y devuelve las etiquetas [img]/[file]
  // que se anexan al contenido del comentario. Subir uno a uno era la causa de
  // la lentitud con 5+ fotos.
  const uploadAttachments = async (attachments) => {
    const tags = await mapPool(attachments, async (img) => {
      try {
        const body = img.isImage
          ? { image_data: img.data, filename: img.name }
          : { file_data: img.data, filename: img.name };
        const res = await fetch(`${API}/orders/${orderId}/images`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(body),
        });
        if (res.ok) {
          const data = await res.json();
          const key = data.storage_key || data.url;
          return img.isImage ? `[img]${key}[/img]` : `[file]${img.name}|${key}[/file]`;
        }
        toast.error(`Error subiendo ${img.name}`);
      } catch {
        toast.error(`Error de conexion subiendo ${img.name}`);
      }
      return null;
    });
    return tags.filter(Boolean);
  };

  // Publica un comentario (con adjuntos y/o respuesta). Devuelve true si se
  // envió, para que el composer limpie su estado local.
  const addComment = async ({ content, attachments = [], parentId = null }) => {
    try {
      let finalContent = (content || "").trim();
      const tags = await uploadAttachments(attachments);
      for (const tag of tags) {
        finalContent = finalContent ? `${finalContent}\n${tag}` : tag;
      }
      if (!finalContent) return false;
      const res = await fetch(`${API}/orders/${orderId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content: finalContent, parent_id: parentId }),
      });
      if (res.ok) {
        fetchComments();
        toast.success(t("comment_sent"));
        return true;
      }
      return false;
    } catch {
      toast.error(t("comment_err"));
      return false;
    }
  };

  const editComment = async (commentId, content) => {
    try {
      const res = await fetch(`${API}/orders/${orderId}/comments/${commentId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content: content.trim() }),
      });
      if (res.ok) {
        fetchComments();
        toast.success("Comentario editado");
        return true;
      }
      const err = await res.json();
      toast.error(err.detail || "Error al editar");
    } catch {
      toast.error("Error al editar comentario");
    }
    return false;
  };

  const deleteComment = async (commentId) => {
    try {
      const res = await fetch(`${API}/orders/${orderId}/comments/${commentId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        fetchComments();
        toast.success("Comentario eliminado");
      } else {
        const err = await res.json();
        toast.error(err.detail || "Error al eliminar");
      }
    } catch {
      toast.error("Error al eliminar comentario");
    }
  };

  const pinComment = async (commentId, currentlyPinned) => {
    try {
      // Optimista
      setComments((prev) =>
        prev.map((c) => (c.comment_id === commentId ? { ...c, pinned: !currentlyPinned } : c))
      );
      const res = await fetch(`${API}/orders/${orderId}/comments/${commentId}/pin`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        fetchComments();
        toast.success(data.action === "pinned" ? "📌 Comentario anclado" : "Comentario desanclado", {
          duration: 2000,
        });
      } else {
        const err = await res.json();
        toast.error(err.detail || "Error al anclar");
        fetchComments(); // revierte
      }
    } catch {
      toast.error("Error al anclar comentario");
      fetchComments();
    }
  };

  const reactToComment = async (commentId, emoji) => {
    if (!currentUser) return toast.error("Inicia sesión para reaccionar");

    // Optimista
    const userId = String(currentUser.user_id);
    setComments((prev) =>
      prev.map((c) => {
        if (c.comment_id !== commentId) return c;
        const reactions = { ...(c.reactions || {}) };
        const reacted = (reactions[emoji] || []).map((id) => String(id));
        if (reacted.includes(userId)) {
          reactions[emoji] = reacted.filter((id) => id !== userId);
          if (reactions[emoji].length === 0) delete reactions[emoji];
        } else {
          reactions[emoji] = [...reacted, userId];
        }
        return { ...c, reactions };
      })
    );

    try {
      const res = await fetch(`${API}/orders/${orderId}/comments/${commentId}/react`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ emoji }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.detail || "Error en el servidor");
      }
      // Sincroniza en silencio con lo confirmado por el servidor
      const data = await res.json();
      setComments((prev) =>
        prev.map((c) => (c.comment_id === commentId ? { ...c, reactions: data.reactions } : c))
      );
      if (data.action === "added") {
        toast.success(`Reaccionaste con ${emoji}`, { icon: emoji, duration: 1500 });
      } else {
        toast.info(`Quitaste tu reacción ${emoji}`, { duration: 1500 });
      }
    } catch (err) {
      toast.error(err.message || "Error al reaccionar");
      fetchComments(); // revierte al estado del servidor
    }
  };

  const addLink = async (url, description) => {
    if (!url.trim()) return false;
    try {
      const res = await fetch(`${API}/orders/${orderId}/links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ url: url.trim(), description: description.trim() }),
      });
      if (res.ok) {
        fetchLinks();
        toast.success("Enlace agregado");
        return true;
      }
    } catch {
      toast.error("Error al agregar enlace");
    }
    return false;
  };

  const deleteLink = async (index) => {
    try {
      const res = await fetch(`${API}/orders/${orderId}/links/${index}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        fetchLinks();
        toast.success("Enlace eliminado");
      }
    } catch {
      toast.error("Error al eliminar enlace");
    }
  };

  return {
    comments,
    links,
    users,
    addComment,
    editComment,
    deleteComment,
    pinComment,
    reactToComment,
    addLink,
    deleteLink,
  };
}
