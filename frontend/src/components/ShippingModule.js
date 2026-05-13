import React, { useState, useEffect, useCallback } from "react";
import { 
  Package, 
  Upload, 
  FileText, 
  FileSpreadsheet, 
  Image as ImageIcon, 
  Trash2, 
  CheckCircle2, 
  Clock,
  ExternalLink,
  ChevronRight,
  Search,
  Camera,
  Layers
} from "lucide-react";
import { toast } from "sonner";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

const ShippingModule = () => {
  const [orderNumbers, setOrderNumbers] = useState("");
  const [notes, setNotes] = useState("");
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [records, setRecords] = useState([]);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [searchDate, setSearchDate] = useState(new Date().toISOString().split('T')[0]);
  const [selectedRecord, setSelectedRecord] = useState(null);
  
  const getFullUrl = (url) => {
    if (!url) return "";
    if (url.startsWith("http")) return url;
    const cleanBase = BACKEND_URL?.endsWith("/") ? BACKEND_URL.slice(0, -1) : BACKEND_URL;
    const cleanPath = url.startsWith("/") ? url : `/${url}`;
    return `${cleanBase}${cleanPath}`;
  };

  const fetchRecords = useCallback(async () => {
    setFetchLoading(true);
    try {
      const res = await fetch(`${API}/shipping?date=${searchDate}`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setRecords(data);
      }
    } catch (err) {
      console.error("Error fetching shipping records:", err);
    } finally {
      setFetchLoading(false);
    }
  }, [searchDate]);

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  const handleFileChange = (e) => {
    const selectedFiles = Array.from(e.target.files);
    setFiles(prev => [...prev, ...selectedFiles]);
  };

  const removeFile = (index) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!orderNumbers.trim()) return toast.error("Ingresa al menos un número de orden");

    setLoading(true);
    const formData = new FormData();
    formData.append("order_numbers", orderNumbers);
    formData.append("notes", notes);
    files.forEach(file => {
      formData.append("files", file);
    });

    try {
      const res = await fetch(`${API}/shipping`, {
        method: "POST",
        credentials: "include",
        body: formData
      });

      if (res.ok) {
        toast.success("Envío registrado exitosamente");
        setOrderNumbers("");
        setNotes("");
        setFiles([]);
        fetchRecords();
      } else {
        const err = await res.json();
        toast.error(err.detail || "Error al registrar envío");
      }
    } catch (err) {
      toast.error("Error de conexión");
    } finally {
      setLoading(false);
    }
  };

  const getFileIcon = (type) => {
    if (["jpg", "jpeg", "png"].includes(type)) return <ImageIcon className="w-5 h-5 text-blue-500" />;
    if (type === "pdf") return <FileText className="w-5 h-5 text-red-500" />;
    if (["xlsx", "xls", "csv"].includes(type)) return <FileSpreadsheet className="w-5 h-5 text-green-600" />;
    return <FileText className="w-5 h-5 text-slate-400" />;
  };

  return (
    <div className="min-h-screen bg-[#f1f5f9] p-4 md:p-8 space-y-8 font-barlow animate-in fade-in duration-700">
      
      {/* Header Container */}
      <header className="max-w-7xl mx-auto flex flex-col md:flex-row items-start md:items-center justify-between gap-6 bg-white p-6 rounded-[2rem] shadow-sm border border-slate-200">
        <div className="flex items-center gap-5">
          <div className="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-200 rotate-3 group-hover:rotate-0 transition-transform">
            <Package className="w-8 h-8 text-white" />
          </div>
          <div>
            <h1 className="text-2xl md:text-3xl font-black text-slate-800 tracking-tight leading-none mb-1">
              REGISTRO DE <span className="text-blue-600">ENVÍOS</span>
            </h1>
            <p className="text-slate-500 font-semibold text-sm">PROSPER MANUFACTURING SYSTEM</p>
          </div>
        </div>

        <div className="flex items-center gap-3 bg-slate-50 px-4 py-3 rounded-2xl border border-slate-200 w-full md:w-auto">
          <Search className="w-5 h-5 text-blue-600" />
          <input 
            type="date" 
            value={searchDate} 
            onChange={(e) => setSearchDate(e.target.value)}
            className="bg-transparent border-none text-slate-800 font-bold text-sm focus:ring-0 cursor-pointer w-full"
          />
        </div>
      </header>

      <main className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        
        {/* Left Column: Form */}
        <div className="lg:col-span-5">
          <form onSubmit={handleSubmit} className="bg-white rounded-[2.5rem] p-8 shadow-xl shadow-slate-200/50 border border-slate-100 space-y-8">
            
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-black uppercase tracking-[0.2em] text-blue-600 flex items-center gap-2">
                  <Layers className="w-4 h-4" />
                  Números de Órdenes
                </label>
                <span className="text-[10px] font-bold text-slate-400 bg-slate-100 px-2 py-1 rounded-md">
                  Separar por espacio
                </span>
              </div>
              <textarea 
                placeholder="Ej: 505050 505051"
                value={orderNumbers}
                onChange={(e) => setOrderNumbers(e.target.value)}
                className="w-full h-36 bg-slate-50 border-2 border-slate-100 rounded-[1.5rem] p-5 text-slate-900 text-lg placeholder:text-slate-300 focus:border-blue-600 focus:ring-4 focus:ring-blue-100 transition-all resize-none font-mono font-bold leading-relaxed"
              />
            </div>

            <div className="space-y-4">
              <label className="text-[11px] font-black uppercase tracking-[0.2em] text-blue-600">Notas Adicionales</label>
              <input 
                type="text"
                placeholder="Detalles del transportista, etc."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full bg-slate-50 border-2 border-slate-100 rounded-2xl p-4 text-slate-900 text-sm font-bold placeholder:text-slate-300 focus:border-blue-600 focus:ring-4 focus:ring-blue-100 transition-all"
              />
            </div>

            <div className="space-y-4">
              <label className="text-[11px] font-black uppercase tracking-[0.2em] text-blue-600">Adjuntar Evidencia</label>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="relative group h-28">
                  <input type="file" multiple onChange={handleFileChange} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" />
                  <div className="h-full border-2 border-dashed border-slate-200 rounded-2xl flex flex-col items-center justify-center gap-2 group-hover:border-blue-600 group-hover:bg-blue-50 transition-all">
                    <Upload className="w-6 h-6 text-blue-600" />
                    <span className="text-[10px] font-black text-slate-500 uppercase">Documentos</span>
                  </div>
                </div>

                <div className="relative group h-28">
                  <input type="file" accept="image/*" capture="environment" onChange={handleFileChange} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" />
                  <div className="h-full border-2 border-dashed border-blue-200 bg-blue-50/50 rounded-2xl flex flex-col items-center justify-center gap-2 group-hover:border-blue-600 group-hover:bg-blue-100 transition-all">
                    <Camera className="w-6 h-6 text-blue-600 animate-pulse" />
                    <span className="text-[10px] font-black text-blue-700 uppercase">Tomar Foto</span>
                  </div>
                </div>
              </div>

              {/* Selected Files Preview */}
              {files.length > 0 && (
                <div className="space-y-2 mt-4 max-h-40 overflow-y-auto pr-2 custom-scrollbar">
                  {files.map((file, i) => (
                    <div key={i} className="flex items-center justify-between bg-slate-50 p-3 rounded-xl border border-slate-200 animate-in slide-in-from-bottom-2 duration-300">
                      <div className="flex items-center gap-3">
                        {file.type.includes('image') ? <ImageIcon className="w-4 h-4 text-blue-600" /> : <FileText className="w-4 h-4 text-slate-600" />}
                        <span className="text-xs text-slate-800 font-bold truncate max-w-[140px]">{file.name}</span>
                      </div>
                      <button type="button" onClick={() => removeFile(i)} className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <button 
              type="submit"
              disabled={loading}
              className="w-full py-5 bg-blue-600 text-white rounded-[1.5rem] font-black uppercase tracking-[0.2em] text-sm shadow-xl shadow-blue-200 hover:bg-blue-700 hover:-translate-y-1 active:scale-95 transition-all disabled:opacity-50 disabled:translate-y-0 flex items-center justify-center gap-3"
            >
              {loading ? (
                <div className="w-6 h-6 border-3 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <>
                  <CheckCircle2 className="w-6 h-6" />
                  GUARDAR ENVÍO
                </>
              )}
            </button>
          </form>
        </div>

        {/* Right Column: History */}
        <div className="lg:col-span-7">
          <div className="bg-white rounded-[2.5rem] p-8 shadow-xl shadow-slate-200/50 border border-slate-100 min-h-[700px] flex flex-col">
            <div className="flex items-center justify-between mb-8">
              <h3 className="text-xl font-black text-slate-800 flex items-center gap-3">
                <Clock className="w-6 h-6 text-blue-600" />
                SALIDAS DEL DÍA
              </h3>
              <div className="px-3 py-1 bg-blue-50 text-blue-700 text-[10px] font-black rounded-full uppercase">
                {records.length} Registros
              </div>
            </div>

            {fetchLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="w-12 h-12 border-4 border-blue-100 border-t-blue-600 rounded-full animate-spin" />
              </div>
            ) : records.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-slate-300">
                <Package className="w-24 h-24 mb-4 opacity-20" />
                <p className="font-black uppercase tracking-widest text-slate-400">Sin movimientos</p>
              </div>
            ) : (
              <div className="space-y-6 overflow-y-auto pr-2 custom-scrollbar flex-1">
                {records.map((rec) => (
                  <div key={rec.shipping_id} className="bg-slate-50 border border-slate-100 rounded-3xl p-4 hover:border-blue-200 transition-all group">
                    <div className="flex justify-between items-center mb-3">
                      <div className="flex flex-wrap gap-1.5">
                        {rec.order_numbers.map(ono => (
                          <span key={ono} className="px-2 py-0.5 bg-blue-600 text-white text-[9px] font-black rounded-md shadow-sm">
                            #{ono}
                          </span>
                        ))}
                      </div>
                      <span className="text-[10px] text-blue-700 font-black uppercase">
                        {new Date(rec.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>

                    <div className="flex gap-4 items-center">
                      <p className="flex-1 text-sm text-slate-700 font-bold line-clamp-1">{rec.notes || "Envío sin notas"}</p>
                      
                      {rec.evidence?.length > 0 && (
                        <div className="flex -space-x-2">
                          {rec.evidence.slice(0, 3).map((ev) => (
                            <div key={ev.id} className="w-8 h-8 rounded-lg border-2 border-white shadow-sm overflow-hidden bg-white">
                              {["jpg", "jpeg", "png"].includes(ev.type) ? (
                                <img 
                                  src={getFullUrl(ev.url)} 
                                  alt="" 
                                  className="w-full h-full object-cover"
                                  onError={(e) => { e.target.src = ""; e.target.className = "hidden"; }} 
                                />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                  {getFileIcon(ev.type)}
                                </div>
                              )}
                            </div>
                          ))}
                          {rec.evidence.length > 3 && (
                            <div className="w-8 h-8 rounded-lg border-2 border-white bg-slate-200 flex items-center justify-center text-[8px] font-black text-slate-500 shadow-sm">
                              +{rec.evidence.length - 3}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center justify-between pt-3 border-t border-slate-200/50">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-lg bg-blue-100 flex items-center justify-center text-[10px] font-black text-blue-700">
                          {rec.created_by_name?.charAt(0).toUpperCase()}
                        </div>
                        <span className="text-[10px] text-slate-500 font-bold">{rec.created_by_name}</span>
                      </div>
                      <button 
                        onClick={() => setSelectedRecord(rec)}
                        className="flex items-center gap-1 text-[10px] font-black text-blue-600 hover:text-blue-700 transition-colors uppercase tracking-widest"
                      >
                        Detalles <ChevronRight className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Modal de Detalles */}
      {selectedRecord && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-in fade-in duration-300">
          <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={() => setSelectedRecord(null)}></div>
          <div className="relative bg-white w-full max-w-2xl rounded-[2.5rem] shadow-2xl overflow-hidden animate-in zoom-in-95 duration-300">
            <div className="p-8 space-y-6">
              <div className="flex justify-between items-start">
                <div>
                  <h2 className="text-2xl font-black text-slate-800 flex items-center gap-3">
                    <Package className="w-6 h-6 text-blue-600" />
                    DETALLES DEL ENVÍO
                  </h2>
                  <p className="text-slate-400 font-bold text-xs uppercase tracking-widest mt-1">
                    {new Date(selectedRecord.created_at).toLocaleString()}
                  </p>
                </div>
                <button 
                  onClick={() => setSelectedRecord(null)}
                  className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center text-slate-500 hover:bg-red-50 hover:text-red-500 transition-all"
                >
                  <Trash2 className="w-5 h-5 rotate-45" /> {/* Usando Trash rotado como X rápida */}
                </button>
              </div>

              <div className="space-y-4">
                <div className="bg-slate-50 p-4 rounded-2xl">
                  <span className="text-[10px] font-black text-blue-600 uppercase tracking-widest block mb-2">Órdenes Asociadas</span>
                  <div className="flex flex-wrap gap-2">
                    {selectedRecord.order_numbers.map(ono => (
                      <span key={ono} className="px-4 py-1.5 bg-blue-600 text-white text-xs font-black rounded-xl shadow-md">
                        #{ono}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="bg-slate-50 p-4 rounded-2xl">
                  <span className="text-[10px] font-black text-blue-600 uppercase tracking-widest block mb-2">Notas</span>
                  <p className="text-slate-800 font-bold leading-relaxed">
                    {selectedRecord.notes || "No se ingresaron notas para este envío."}
                  </p>
                </div>

                {selectedRecord.evidence?.length > 0 && (
                  <div className="space-y-2">
                    <span className="text-[10px] font-black text-blue-600 uppercase tracking-widest block px-1">Evidencia Multimedia</span>
                    <div className="grid grid-cols-2 gap-4">
                      {selectedRecord.evidence.map((ev) => (
                        <a 
                          key={ev.id}
                          href={getFullUrl(ev.url)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="relative aspect-video rounded-2xl overflow-hidden bg-slate-100 border-2 border-slate-100 hover:border-blue-600 transition-all group/modal-ev"
                        >
                          {["jpg", "jpeg", "png"].includes(ev.type) ? (
                            <img 
                              src={getFullUrl(ev.url)} 
                              alt="" 
                              className="w-full h-full object-cover" 
                              onError={(e) => { e.target.style.display = 'none'; }}
                            />
                          ) : (
                            <div className="w-full h-full flex flex-col items-center justify-center gap-2">
                              {getFileIcon(ev.type)}
                              <span className="text-xs font-black text-slate-500 uppercase">{ev.type}</span>
                            </div>
                          )}
                          <div className="absolute inset-0 bg-blue-600/20 opacity-0 group-hover/modal-ev:opacity-100 transition-opacity flex items-center justify-center">
                            <ExternalLink className="w-8 h-8 text-white" />
                          </div>
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="pt-6 border-t border-slate-100 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-blue-100 flex items-center justify-center text-sm font-black text-blue-700">
                    {selectedRecord.created_by_name?.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex flex-col">
                     <span className="text-[10px] text-slate-400 font-black uppercase leading-none">Registrado por</span>
                     <span className="text-sm text-slate-800 font-black">{selectedRecord.created_by_name}</span>
                  </div>
                </div>
                <button 
                  onClick={() => setSelectedRecord(null)}
                  className="px-8 py-3 bg-slate-900 text-white rounded-xl font-black text-xs uppercase tracking-widest hover:bg-slate-800 transition-all"
                >
                  Cerrar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ShippingModule;
