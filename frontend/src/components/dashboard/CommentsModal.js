import { useState, useEffect, useRef } from "react";
import { useLang } from "../../contexts/LanguageContext";
import { X, MessageSquare, Send, Camera, Loader2, Link2, Plus, ExternalLink, Trash2, Pencil, Check, AtSign, FileText, File as FileIcon, FileSpreadsheet, Download } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { toast } from "sonner";
import { API } from "../../lib/constants";

export const CommentsModal = ({ order, isOpen, onClose, currentUser }) => {
  const { t } = useLang();
  const [comments, setComments] = useState([]);
  const [links, setLinks] = useState([]);
  const [newComment, setNewComment] = useState("");
  const [loading, setLoading] = useState(false);
  const [imagePreviews, setImagePreviews] = useState([]);
  const [showAddLink, setShowAddLink] = useState(false);
  const [newLinkUrl, setNewLinkUrl] = useState("");
  const [newLinkDesc, setNewLinkDesc] = useState("");
  const [linkLoading, setLinkLoading] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editContent, setEditContent] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [users, setUsers] = useState([]);
  const [mentionQuery, setMentionQuery] = useState(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null);
  const [reactionLoading, setReactionLoading] = useState(null);
  const [activeReactionId, setActiveReactionId] = useState(null);
  const reactionTimeoutRef = useRef(null);
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);
  const dropZoneRef = useRef(null);

  useEffect(() => {
    if (order && isOpen) { fetchComments(); fetchLinks(); fetchUsers(); }
  }, [order, isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClose = () => {
    if (newComment.trim() || imagePreviews.length > 0) {
      const confirmMsg = "Tienes un comentario o archivos sin enviar. ¿Estás seguro de que quieres salir?";
      if (!window.confirm(confirmMsg)) return;
    }
    setNewComment("");
    setImagePreviews([]);
    setReplyingTo(null);
    onClose();
  };

  const fetchComments = async () => {
    if (!order?.order_id) return;
    try {
      const res = await fetch(`${API}/orders/${order.order_id}/comments`, { credentials: 'include' });
      if (res.ok) setComments(await res.json());
    } catch (error) { console.error("Error fetching comments:", error); }
  };

  const fetchLinks = async () => {
    if (!order?.order_id) return;
    try {
      const res = await fetch(`${API}/orders/${order.order_id}/links`, { credentials: 'include' });
      if (res.ok) setLinks(await res.json());
    } catch (error) { console.error("Error fetching links:", error); }
  };

  const fetchUsers = async () => {
    try {
      const res = await fetch(`${API}/users/list`, { credentials: 'include' });
      if (res.ok) setUsers(await res.json());
    } catch { /* silent */ }
  };

  const handleAddLink = async () => {
    if (!newLinkUrl.trim()) return;
    setLinkLoading(true);
    try {
      const res = await fetch(`${API}/orders/${order.order_id}/links`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ url: newLinkUrl.trim(), description: newLinkDesc.trim() })
      });
      if (res.ok) { fetchLinks(); setNewLinkUrl(""); setNewLinkDesc(""); setShowAddLink(false); toast.success("Enlace agregado"); }
    } catch { toast.error("Error al agregar enlace"); } finally { setLinkLoading(false); }
  };

  const handleDeleteLink = async (index) => {
    try {
      const res = await fetch(`${API}/orders/${order.order_id}/links/${index}`, { method: 'DELETE', credentials: 'include' });
      if (res.ok) { fetchLinks(); toast.success("Enlace eliminado"); }
    } catch { toast.error("Error al eliminar enlace"); }
  };

  const handleAddComment = async () => {
    if (!newComment.trim() && imagePreviews.length === 0) return;
    setLoading(true);
    try {
      let finalContent = newComment.trim();
      for (const img of imagePreviews) {
        try {
          const body = img.isImage ? { image_data: img.data, filename: img.name } : { file_data: img.data, filename: img.name };
          const imgRes = await fetch(`${API}/orders/${order.order_id}/images`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
            body: JSON.stringify(body)
          });
          if (imgRes.ok) {
            const imgData = await imgRes.json();
            const key = imgData.storage_key || imgData.url;
            if (img.isImage) {
              finalContent = finalContent ? `${finalContent}\n[img]${key}[/img]` : `[img]${key}[/img]`;
            } else {
              finalContent = finalContent ? `${finalContent}\n[file]${img.name}|${key}[/file]` : `[file]${img.name}|${key}[/file]`;
            }
          } else {
            toast.error(`Error subiendo ${img.name}`);
          }
        } catch (uploadErr) {
          toast.error(`Error de conexion subiendo ${img.name}`);
        }
      }
      if (finalContent) {
        const res = await fetch(`${API}/orders/${order.order_id}/comments`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ content: finalContent, parent_id: replyingTo?.comment_id || null })
        });
        if (res.ok) { setNewComment(""); setImagePreviews([]); setMentionQuery(null); setReplyingTo(null); fetchComments(); toast.success(t('comment_sent')); }
      }
    } catch { toast.error(t('comment_err')); } finally { setLoading(false); }
  };

  const handleEditComment = async (commentId) => {
    if (!editContent.trim()) return;
    setEditLoading(true);
    try {
      const res = await fetch(`${API}/orders/${order.order_id}/comments/${commentId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ content: editContent.trim() })
      });
      if (res.ok) { setEditingId(null); setEditContent(""); fetchComments(); toast.success("Comentario editado"); }
      else { const err = await res.json(); toast.error(err.detail || "Error al editar"); }
    } catch { toast.error("Error al editar comentario"); } finally { setEditLoading(false); }
  };

  const handleDeleteComment = async (commentId) => {
    try {
      const res = await fetch(`${API}/orders/${order.order_id}/comments/${commentId}`, {
        method: 'DELETE', credentials: 'include'
      });
      if (res.ok) { fetchComments(); toast.success("Comentario eliminado"); }
      else { const err = await res.json(); toast.error(err.detail || "Error al eliminar"); }
    } catch { toast.error("Error al eliminar comentario"); }
  };

  const handleReact = async (commentId, emoji) => {
    if (!currentUser) return toast.error("Inicia sesión para reaccionar");
    
    // Optimistic update
    const userId = String(currentUser.user_id);
    setComments(prev => prev.map(c => {
      if (c.comment_id !== commentId) return c;
      const reactions = { ...(c.reactions || {}) };
      const users = (reactions[emoji] || []).map(id => String(id));
      if (users.includes(userId)) {
        reactions[emoji] = users.filter(id => id !== userId);
        if (reactions[emoji].length === 0) delete reactions[emoji];
      } else {
        reactions[emoji] = [...users, userId];
      }
      return { ...c, reactions };
    }));

    try {
      const res = await fetch(`${API}/orders/${order.order_id}/comments/${commentId}/react`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ emoji })
      });
      
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.detail || "Error en el servidor");
      }
      
      // Silently sync with server-confirmed data
      const data = await res.json();
      setComments(prev => prev.map(c => c.comment_id === commentId ? { ...c, reactions: data.reactions } : c));
      
      if (data.action === "added") {
        toast.success(`Reaccionaste con ${emoji}`, { icon: emoji, duration: 1500 });
      } else {
        toast.info(`Quitaste tu reacción ${emoji}`, { duration: 1500 });
      }
    } catch (err) {
      toast.error(err.message || "Error al reaccionar");
      fetchComments(); // Revert to server state
    }
  };

  // Key to force input recreation on iOS (prevents cached file bug)
  const [fileInputKey, setFileInputKey] = useState(0);

  const processFiles = (files) => {
    const fileList = Array.from(files);
    const imageFiles = fileList.filter(f => {
      if (f.type && f.type.startsWith('image/')) return true;
      const ext = (f.name || '').toLowerCase().split('.').pop();
      return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp'].includes(ext);
    });
    const docFiles = fileList.filter(f => {
      if (f.type && (f.type === 'application/pdf' || f.type.includes('spreadsheet') || f.type.includes('excel') || f.type.includes('word') || f.type.includes('officedocument'))) return true;
      const ext = (f.name || '').toLowerCase().split('.').pop();
      return ['pdf', 'xlsx', 'xls', 'doc', 'docx', 'csv', 'txt'].includes(ext);
    });

    if (imageFiles.length === 0 && docFiles.length === 0) {
      if (fileList.length > 0 && !fileList[0].type) {
        imageFiles.push(...fileList);
      } else { return; }
    }

    // Process Images
    imageFiles.forEach(file => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const rawDataUrl = event.target.result;
        if (file.size > 512 * 1024) {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            let { width, height } = img;
            const MAX_DIM = 1920;
            if (width > MAX_DIM || height > MAX_DIM) {
              const scale = MAX_DIM / Math.max(width, height);
              width = Math.round(width * scale);
              height = Math.round(height * scale);
            }
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
            const name = file.name ? file.name.replace(/\.[^.]+$/, '.jpg') : `camera_${Date.now()}.jpg`;
            setImagePreviews(prev => [...prev, { data: dataUrl, name, id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, isImage: true }]);
          };
          img.onerror = () => {
            const name = file.name || `camera_${Date.now()}.jpg`;
            setImagePreviews(prev => [...prev, { data: rawDataUrl, name, id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, isImage: true }]);
          };
          img.src = rawDataUrl;
        } else {
          const name = file.name || `camera_${Date.now()}.jpg`;
          setImagePreviews(prev => [...prev, { data: rawDataUrl, name, id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, isImage: true }]);
        }
      };
      reader.readAsDataURL(file);
    });

    // Process Documents
    docFiles.forEach(file => {
      if (file.size > 10 * 1024 * 1024) {
        toast.error(`${file.name} es demasiado grande (máx 10MB)`);
        return;
      }
      const reader = new FileReader();
      reader.onload = (event) => {
        const dataUrl = event.target.result;
        setImagePreviews(prev => [...prev, { 
          data: dataUrl, 
          name: file.name, 
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          isImage: false,
          type: file.type
        }]);
      };
      reader.readAsDataURL(file);
    });
  };

  const handleFileUpload = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files);
    }
    // Force destroy + recreate the input element (fixes iOS cache bug)
    setFileInputKey(prev => prev + 1);
  };

  const handleDragOver = (e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); };
  const handleDragLeave = (e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false); };
  const handleDrop = (e) => {
    e.preventDefault(); e.stopPropagation(); setIsDragging(false);
    if (e.dataTransfer.files?.length > 0) processFiles(e.dataTransfer.files);
  };

  const removeImage = (id) => { setImagePreviews(prev => prev.filter(img => img.id !== id)); };

  // @mention logic
  const handleCommentChange = (e) => {
    const val = e.target.value;
    setNewComment(val);
    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = val.substring(0, cursorPos);
    const atMatch = textBeforeCursor.match(/@(\w*)$/);
    if (atMatch) {
      setMentionQuery(atMatch[1].toLowerCase());
      setMentionIndex(0);
    } else {
      setMentionQuery(null);
    }
  };

  const filteredUsers = mentionQuery !== null
    ? users.filter(u => {
        const name = (u.name || '').toLowerCase();
        const email = (u.email || '').toLowerCase();
        return name.includes(mentionQuery) || email.includes(mentionQuery);
      }).slice(0, 6)
    : [];

  const insertMention = (user) => {
    const cursorPos = textareaRef.current?.selectionStart || newComment.length;
    const textBeforeCursor = newComment.substring(0, cursorPos);
    const textAfterCursor = newComment.substring(cursorPos);
    const atIdx = textBeforeCursor.lastIndexOf('@');
    const mentionName = user.name || user.email.split('@')[0];
    const newText = textBeforeCursor.substring(0, atIdx) + `@${mentionName} ` + textAfterCursor;
    setNewComment(newText);
    setMentionQuery(null);
    textareaRef.current?.focus();
  };

  const handleCommentKeyDown = (e) => {
    if (mentionQuery !== null && filteredUsers.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex(i => Math.min(i + 1, filteredUsers.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(filteredUsers[mentionIndex]); return; }
      if (e.key === 'Escape') { setMentionQuery(null); return; }
    }
    // Removed auto-send on Enter to allow multi-line comments on both PC and Tablet.
    // Use the Send button to submit.
  };

  const canModify = (comment) => {
    if (!currentUser) return false;
    return comment.user_id === currentUser.user_id || currentUser.role === "admin";
  };

  const renderContent = (content) => {
    if (!content) return null;
    
    // Split by [img] or [file] tags
    // [img]key[/img]
    // [file]name|key[/file]
    const parts = content.split(/(\[img\].*?\[\/img\]|\[file\].*?\[\/file\])/g);
    
    return parts.map((part, i) => {
      // Handle [img] tags
      if (part.startsWith('[img]')) {
        const key = part.replace('[img]', '').replace('[/img]', '');
        const src = (key.startsWith('http') || key.startsWith('/api/uploads/')) 
          ? key 
          : `${API}/uploads/${key}`;
        return <img key={i} src={src} alt="Imagen" className="max-w-full max-h-60 rounded-lg mt-1 cursor-pointer" onClick={() => window.open(src, '_blank')} data-testid="comment-image" />;
      }
      
      // Handle [file] tags
      if (part.startsWith('[file]')) {
        const fileInfo = part.replace('[file]', '').replace('[/file]', '');
        const [filename, key] = fileInfo.split('|');
        const src = (key.startsWith('http') || key.startsWith('/api/uploads/')) 
          ? key 
          : `${API}/uploads/${key}`;
        
        const isPdf = filename.toLowerCase().endsWith('.pdf');
        const isExcel = filename.toLowerCase().endsWith('.xlsx') || filename.toLowerCase().endsWith('.xls');
        
        return (
          <div key={i} className="mt-2 mb-1 p-2 bg-secondary/50 border border-border rounded-lg flex items-center gap-3 group max-w-sm">
            <div className="bg-background p-2 rounded border border-border">
              {isPdf ? <FileText className="w-5 h-5 text-primary" /> : 
               isExcel ? <FileSpreadsheet className="w-5 h-5 text-primary" /> : 
               <FileIcon className="w-5 h-5 text-primary" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium truncate text-foreground">{filename}</p>
              <p className="text-[10px] text-muted-foreground uppercase">Documento</p>
            </div>
            <a href={src} target="_blank" rel="noopener noreferrer" 
              className="p-1 px-2 flex items-center gap-1 text-[10px] bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors"
              title="Descargar">
              <Download className="w-3 h-3" /> Descargar
            </a>
          </div>
        );
      }

      // Handle normal text and mentions
      if (!part) return null;
      
      const mentionRegex = /@(\S+)/g;
      const segments = part.split(mentionRegex);
      if (segments.length > 1) {
        return segments.map((seg, idx) => idx % 2 === 1
          ? <span key={`${i}-${idx}`} className="text-primary font-semibold bg-primary/10 rounded px-0.5">@{seg}</span>
          : <span key={`${i}-${idx}`} style={{ whiteSpace: 'pre-wrap' }}>{seg}</span>
        );
      }
      return <span key={i} style={{ whiteSpace: 'pre-wrap' }}>{part}</span>;
    });
  };

  if (!order) return null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="max-w-[95vw] md:max-w-4xl max-h-[90vh] bg-card border-border overflow-hidden flex flex-col" data-testid="comments-modal">
        <DialogHeader>
          <DialogTitle className="font-barlow text-xl uppercase tracking-wide flex items-center gap-3">
            <MessageSquare className="w-5 h-5" /> {t('comments')} - {order.order_number}
          </DialogTitle>
        </DialogHeader>

        {/* Links Section */}
        <div className="border-b border-border pb-3" data-testid="links-section">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs uppercase tracking-wider font-bold text-muted-foreground flex items-center gap-1.5">
              <Link2 className="w-3.5 h-3.5" /> Enlaces
            </span>
            <button onClick={() => setShowAddLink(!showAddLink)}
              className="text-xs text-primary hover:underline flex items-center gap-1" data-testid="toggle-add-link">
              <Plus className="w-3.5 h-3.5" /> Agregar enlace
            </button>
          </div>
          {showAddLink && (
            <div className="bg-secondary/30 border border-border rounded-lg p-3 mb-2 space-y-2" data-testid="add-link-form">
              <input type="url" value={newLinkUrl} onChange={(e) => setNewLinkUrl(e.target.value)}
                placeholder="https://..." className="w-full bg-secondary border border-border rounded px-3 py-1.5 text-sm text-foreground" data-testid="link-url-input" />
              <input type="text" value={newLinkDesc} onChange={(e) => setNewLinkDesc(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddLink(); }}
                placeholder="Descripcion del enlace..." className="w-full bg-secondary border border-border rounded px-3 py-1.5 text-sm text-foreground" data-testid="link-desc-input" />
              <div className="flex justify-end gap-2">
                <button onClick={() => { setShowAddLink(false); setNewLinkUrl(''); setNewLinkDesc(''); }}
                  className="px-3 py-1 text-xs text-muted-foreground hover:text-foreground">Cancelar</button>
                <button onClick={handleAddLink} disabled={linkLoading || !newLinkUrl.trim()}
                  className="px-3 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1" data-testid="save-link-btn">
                  {linkLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} Guardar
                </button>
              </div>
            </div>
          )}
          {links.length > 0 ? (
            <div className="space-y-1">
              {links.map((link, idx) => (
                <div key={idx} className="flex items-center gap-2 group bg-secondary/30 rounded px-2.5 py-1.5" data-testid={`link-item-${idx}`}>
                  <ExternalLink className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                  <a href={link.url.startsWith('http') ? link.url : `https://${link.url}`} target="_blank" rel="noopener noreferrer"
                    className="text-sm text-primary hover:underline truncate flex-1" title={link.url}>
                    {link.description || link.url.replace(/^https?:\/\//, '').split('/')[0]}
                  </a>
                  {link.description && (
                    <span className="text-[10px] text-muted-foreground truncate max-w-[120px]" title={link.url}>
                      {link.url.replace(/^https?:\/\//, '').split('/')[0]}
                    </span>
                  )}
                  <button onClick={() => handleDeleteLink(idx)}
                    className="p-0.5 opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity" title="Eliminar" data-testid={`delete-link-${idx}`}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          ) : !showAddLink && (
            <p className="text-xs text-muted-foreground text-center py-1">Sin enlaces</p>
          )}
        </div>

        {/* Comments Section */}
        <div className="flex-1 overflow-y-auto py-3 space-y-4" data-testid="comments-list">
          {(() => {
            const rootComments = comments.filter(c => !c.parent_id);
            const repliesMap = comments.reduce((acc, c) => {
              if (c.parent_id) { (acc[c.parent_id] = acc[c.parent_id] || []).push(c); }
              return acc;
            }, {});

            const renderComment = (comment, isReply = false) => {
              const reactions = comment.reactions || {};
              const emojiList = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
              
              return (
                <div key={comment.comment_id} className={`group flex flex-col gap-1 ${isReply ? 'ml-10 border-l-2 border-border/30 pl-4 py-1' : 'bg-secondary/20 border border-border/30 rounded-xl p-4'}`} data-testid={`comment-${comment.comment_id}`}>
                  <div className="flex items-center gap-2 mb-1">
                    {comment.user_picture ? (
                      <img src={comment.user_picture} alt="" className="w-6 h-6 rounded-full border border-border/50" />
                    ) : (
                      <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center text-[10px] font-bold text-primary">{comment.user_name?.charAt(0)}</div>
                    )}
                    <span className="text-xs font-black text-foreground/80">{comment.user_name}</span>
                    <span className="text-[10px] text-muted-foreground">{new Date(comment.created_at).toLocaleString()}</span>
                    {comment.edited_at && <span className="text-[10px] text-muted-foreground italic">(editado)</span>}
                    
                    {canModify(comment) && editingId !== comment.comment_id && (
                      <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => { setEditingId(comment.comment_id); setEditContent(comment.content); }}
                          className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground"
                          title="Editar"><Pencil className="w-3 h-3" /></button>
                        <button onClick={() => { if (window.confirm('¿Eliminar?')) handleDeleteComment(comment.comment_id); }}
                          className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                          title="Eliminar"><Trash2 className="w-3 h-3" /></button>
                      </div>
                    )}
                  </div>
                  
                  {editingId === comment.comment_id ? (
                    <div className="space-y-2">
                      <textarea value={editContent} onChange={(e) => setEditContent(e.target.value)}
                        className="w-full bg-secondary border border-border rounded px-3 py-2 text-sm text-foreground resize-none" />
                      <div className="flex justify-end gap-2">
                        <button onClick={() => setEditingId(null)} className="px-2 py-1 text-[10px]">Cancelar</button>
                        <button onClick={() => handleEditComment(comment.comment_id)} className="px-3 py-1 text-[10px] bg-primary text-primary-foreground rounded">Guardar</button>
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-foreground leading-relaxed">{renderContent(comment.content)}</div>
                  )}

                  {/* Actions Bar */}
                  {!editingId && (
                    <div className="flex items-center gap-4 mt-2 border-t border-border/10 pt-2 relative">
                      <div className="flex items-center gap-1 h-8 relative"
                        onMouseEnter={() => {
                          if (reactionTimeoutRef.current) clearTimeout(reactionTimeoutRef.current);
                          setActiveReactionId(comment.comment_id);
                        }}
                        onMouseLeave={() => {
                          reactionTimeoutRef.current = setTimeout(() => setActiveReactionId(null), 200);
                        }}
                      >
                        <button className="text-[10px] font-bold text-muted-foreground hover:text-primary transition-colors flex items-center gap-1">
                          Reaccionar
                        </button>
                        
                        {activeReactionId === comment.comment_id && (
                          <div className="absolute bottom-full left-0 pb-3 flex animate-in fade-in slide-in-from-bottom-2 duration-200 z-50">
                            <div className="bg-popover border border-border rounded-full p-1.5 shadow-2xl flex gap-2 px-3">
                              {emojiList.map(emoji => (
                                <button key={emoji} onClick={() => { handleReact(comment.comment_id, emoji); setActiveReactionId(null); }}
                                  className="text-3xl hover:scale-125 transition-transform duration-200 p-1 grayscale-0 hover:grayscale-0 active:scale-95">
                                  {emoji}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                      
                      {!isReply && (
                        <button onClick={() => { setReplyingTo(comment); textareaRef.current?.focus(); }}
                          className="text-[10px] font-bold text-muted-foreground hover:text-primary transition-colors flex items-center gap-1">
                          Responder
                        </button>
                      )}

                      {/* Display Reactions - Professional sized, next to Responder */}
                      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
                        {Object.entries(comment.reactions || {}).map(([emoji, users]) => {
                          const hasReacted = users.map(id => String(id)).includes(String(currentUser?.user_id));
                          return (
                            <button key={emoji} onClick={() => handleReact(comment.comment_id, emoji)}
                              className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[11px] font-bold transition-all shadow-sm active:scale-95 ${hasReacted ? 'bg-primary/20 border-primary/40 text-primary' : 'bg-secondary/40 border-border/50 hover:border-border text-muted-foreground'}`}
                              title={users.length > 1 ? `${users.length} personas` : '1 persona'}>
                              <span className="text-sm">{emoji}</span>
                              {users.length > 0 && <span className="font-mono">{users.length}</span>}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Render Replies */}
                  {repliesMap[comment.comment_id]?.map(reply => renderComment(reply, true))}
                </div>
              );
            };

            return rootComments.length > 0 
              ? rootComments.map(c => renderComment(c)) 
              : <p className="text-center text-muted-foreground py-6">{t('no_data')}</p>;
          })()}
        </div>

        {/* Comment Input */}
        <div className="border-t border-border pt-3"
          ref={dropZoneRef} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
          {isDragging && (
            <div className="mb-3 border-2 border-dashed border-primary rounded-lg p-4 bg-primary/5 text-center" data-testid="drop-overlay">
              <Camera className="w-6 h-6 mx-auto mb-1 text-primary" />
              <p className="text-sm text-primary font-medium">Suelta las imagenes aqui</p>
            </div>
          )}
          {replyingTo && (
            <div className="mb-2 px-3 py-1.5 bg-primary/10 border-l-4 border-primary rounded flex items-center justify-between animate-in slide-in-from-bottom-2 duration-300">
              <div className="flex items-center gap-2">
                <AtSign className="w-3 h-3 text-primary" />
                <span className="text-[10px] font-black uppercase text-primary">Respondiendo a {replyingTo.user_name}</span>
              </div>
              <button onClick={() => setReplyingTo(null)} className="p-1 hover:bg-primary/20 rounded text-primary"><X className="w-3 h-3" /></button>
            </div>
          )}
          {imagePreviews.length > 0 && !isDragging && (
            <div className="mb-3 flex flex-wrap gap-2" data-testid="image-previews">
              {imagePreviews.map(img => (
                <div key={img.id} className="relative group">
                  {img.isImage ? (
                    <img src={img.data} alt={img.name} className="h-20 w-20 object-cover rounded border border-border" />
                  ) : (
                    <div className="h-20 w-20 rounded border border-border bg-secondary flex flex-col items-center justify-center p-2 text-center">
                      {img.type?.includes('pdf') ? <FileText className="w-8 h-8 text-primary" /> : 
                       img.name.toLowerCase().endsWith('.xlsx') || img.name.toLowerCase().endsWith('.xls') ? <FileSpreadsheet className="w-8 h-8 text-primary" /> :
                       <FileIcon className="w-8 h-8 text-primary" />}
                    </div>
                  )}
                  <button onClick={() => removeImage(img.id)}
                    className="absolute -top-2 -right-2 bg-destructive text-white rounded-full w-5 h-5 flex items-center justify-center text-xs opacity-80 group-hover:opacity-100"
                    data-testid={`remove-preview-${img.id}`}><X className="w-3 h-3" /></button>
                  <span className="absolute bottom-0 left-0 right-0 bg-black/60 text-[9px] text-white px-1 truncate rounded-b">{img.name}</span>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2 relative">
            <button onClick={() => fileInputRef.current?.click()} className="p-2 bg-secondary border border-border rounded hover:bg-secondary/80 transition-colors self-end" title={t('upload_file')} data-testid="upload-image-btn"><Link2 className="w-4 h-4" /></button>
            <input key={fileInputKey} ref={fileInputRef} type="file" accept="image/*,.heic,.heif,.pdf,.xlsx,.xls,.doc,.docx,.csv,.txt" multiple onChange={handleFileUpload} className="hidden" />
            <div className="flex-1 relative">
              <textarea ref={textareaRef} value={newComment} onChange={handleCommentChange} onKeyDown={handleCommentKeyDown}
                placeholder={`${t('write_comment')} (usa @ para mencionar)`}
                className="w-full bg-secondary border border-border rounded px-3 py-2 text-sm text-foreground resize-none h-16" data-testid="comment-input" />
              {/* @mention dropdown */}
              {mentionQuery !== null && filteredUsers.length > 0 && (
                <div className="absolute bottom-full left-0 mb-1 w-64 max-h-48 overflow-y-auto bg-popover border border-border rounded-lg shadow-xl z-50" data-testid="mention-dropdown">
                  {filteredUsers.map((u, i) => (
                    <button key={u.email || i} onClick={() => insertMention(u)}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-secondary/50 ${i === mentionIndex ? 'bg-primary/10 text-primary' : 'text-foreground'}`}
                      data-testid={`mention-user-${u.email}`}>
                      {u.picture ? <img src={u.picture} alt="" className="w-5 h-5 rounded-full" /> : <AtSign className="w-4 h-4 text-muted-foreground" />}
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{u.name}</div>
                        <div className="text-[10px] text-muted-foreground truncate">{u.email}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button onClick={handleAddComment} disabled={loading || (!newComment.trim() && imagePreviews.length === 0)} className="px-4 bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center self-end" data-testid="send-comment-btn">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
