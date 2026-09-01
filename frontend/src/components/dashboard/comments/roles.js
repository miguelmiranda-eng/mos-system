// Roles con permiso de moderar comentarios (anclar / editar / borrar el de
// otro). Debe coincidir con el backend (routers/orders.py: pin/update/delete
// de comentarios permiten admin, supersu, inspector_qc, qc). Antes el front
// solo mostraba editar/borrar a admin y supersu, así que QC podía moderar por
// API pero no veía los botones — inconsistencia corregida al centralizar aquí.
export const MODERATOR_ROLES = ["admin", "supersu", "inspector_qc", "qc"];

// ¿Puede el usuario anclar comentarios? (solo moderadores)
export const canModerate = (user) => MODERATOR_ROLES.includes(user?.role);

// ¿Puede el usuario editar/borrar ESTE comentario? Autor propio o moderador.
export const canModifyComment = (comment, user) => {
  if (!user) return false;
  return comment.user_id === user.user_id || MODERATOR_ROLES.includes(user.role);
};
