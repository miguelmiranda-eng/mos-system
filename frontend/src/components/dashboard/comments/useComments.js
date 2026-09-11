import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { API } from "../../../lib/constants";
import { mapPool } from "../../../lib/uploadPool";
import { useLang } from "../../../contexts/LanguageContext";

// Toda la capa de datos del modal de comentarios: estado (comments, links,
// users) + las mutaciones contra la API. Los sub-componentes solo consumen las
// acciones que devuelve este hook; nadie más hace fetch. Se refresca solo al
// abrir el modal sobre una orden.
export function useComments(order, isOpen) {
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
        toast.error(t('comment_upload_err', { name: img.name }));
      } catch {
        toast.error(t('comment_upload_conn_err', { name: img.name }));
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
        toast.success(t('comment_edited'));
        return true;
      }
      const err = await res.json();
      toast.error(err.detail || t('comment_edit_err_short'));
    } catch {
      toast.error(t('comment_edit_err'));
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
        toast.success(t('comment_deleted'));
      } else {
        const err = await res.json();
        toast.error(err.detail || t('rule_del_err'));
      }
    } catch {
      toast.error(t('comment_delete_err'));
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
        toast.success(data.action === "pinned" ? t('comment_pinned') : t('comment_unpinned'), {
          duration: 2000,
        });
      } else {
        const err = await res.json();
        toast.error(err.detail || t('comment_pin_err_short'));
        fetchComments(); // revierte
      }
    } catch {
      toast.error(t('comment_pin_err'));
      fetchComments();
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
        toast.success(t('comment_link_added'));
        return true;
      }
    } catch {
      toast.error(t('comment_link_add_err'));
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
        toast.success(t('comment_link_deleted'));
      }
    } catch {
      toast.error(t('comment_link_delete_err'));
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
    addLink,
    deleteLink,
  };
}
