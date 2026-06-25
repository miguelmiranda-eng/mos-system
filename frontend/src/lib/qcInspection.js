// Whether an inspection item meets its requirement (mirror of the backend
// _point_satisfied — keep both in sync). Drives the completion lock + progress.
//   • "N/A" satisfies any point.
//   • PHOTO points need a photo.
//   • Value-bearing points need a value.
//   • Any point flagged photo_required (or PHOTO type) also needs a photo.
export const pointSatisfied = (it) => {
  const value = String(it.value || "").trim();
  if (value.toUpperCase() === "N/A") return true;
  const photoReq = it.action_type === "PHOTO" || !!it.photo_required;
  const hasPhoto = (it.photos || []).length >= 1;
  if (it.action_type === "PHOTO") return hasPhoto;
  if (["YESNO", "PASSFAIL", "CORRECT", "TEXT", "LIST"].includes(it.action_type) && !value) return false;
  if (photoReq && !hasPhoto) return false;
  return true;
};
