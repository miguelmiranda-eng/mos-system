import { toast } from "sonner";

// Extensiones que tratamos como imagen aunque el navegador no reporte el mime
// (típico en HEIC de iPhone o archivos de cámara sin type).
const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp"];
const DOC_EXTS = ["pdf", "xlsx", "xls", "doc", "docx", "csv", "txt"];

const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10MB
const COMPRESS_THRESHOLD = 512 * 1024; // solo comprimimos imágenes >512KB
const MAX_DIM = 1920; // lado mayor tras comprimir

const extOf = (name) => (name || "").toLowerCase().split(".").pop();
const newId = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const isImageFile = (f) => {
  if (f.type && f.type.startsWith("image/")) return true;
  return IMAGE_EXTS.includes(extOf(f.name));
};

const isDocFile = (f) => {
  if (
    f.type &&
    (f.type === "application/pdf" ||
      f.type.includes("spreadsheet") ||
      f.type.includes("excel") ||
      f.type.includes("word") ||
      f.type.includes("officedocument"))
  )
    return true;
  return DOC_EXTS.includes(extOf(f.name));
};

const readDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

// Comprime imágenes grandes a JPEG (lado máx 1920px, calidad 0.8). Si algo
// falla, cae de vuelta al data-url original sin comprimir. Devuelve el preview.
const buildImagePreview = async (file) => {
  const rawDataUrl = await readDataUrl(file);
  if (file.size <= COMPRESS_THRESHOLD) {
    const name = file.name || `camera_${Date.now()}.jpg`;
    return { data: rawDataUrl, name, id: newId(), isImage: true };
  }
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      let { width, height } = img;
      if (width > MAX_DIM || height > MAX_DIM) {
        const scale = MAX_DIM / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      const data = canvas.toDataURL("image/jpeg", 0.8);
      const name = file.name ? file.name.replace(/\.[^.]+$/, ".jpg") : `camera_${Date.now()}.jpg`;
      resolve({ data, name, id: newId(), isImage: true });
    };
    img.onerror = () => {
      const name = file.name || `camera_${Date.now()}.jpg`;
      resolve({ data: rawDataUrl, name, id: newId(), isImage: true });
    };
    img.src = rawDataUrl;
  });
};

const buildDocPreview = async (file) => {
  if (file.size > MAX_DOC_BYTES) {
    toast.error(`${file.name} es demasiado grande (máx 10MB)`);
    return null;
  }
  const data = await readDataUrl(file);
  return { data, name: file.name, id: newId(), isImage: false, type: file.type };
};

// Clasifica y procesa una FileList (o array) en previews listos para la UI.
// Devuelve una promesa con el array de previews (imágenes comprimidas + docs
// validados). Los docs demasiado grandes se descartan con un toast.
export async function processFiles(files) {
  const fileList = Array.from(files);
  let imageFiles = fileList.filter(isImageFile);
  const docFiles = fileList.filter(isDocFile);

  if (imageFiles.length === 0 && docFiles.length === 0) {
    // Archivos sin type (cámara en algunos navegadores) → tratarlos como imagen.
    if (fileList.length > 0 && !fileList[0].type) {
      imageFiles = fileList;
    } else {
      return [];
    }
  }

  const previews = await Promise.all([
    ...imageFiles.map(buildImagePreview),
    ...docFiles.map(buildDocPreview),
  ]);
  return previews.filter(Boolean);
}
