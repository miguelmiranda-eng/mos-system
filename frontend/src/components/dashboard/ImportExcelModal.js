import React, { useState, useEffect } from "react";
import * as XLSX from 'xlsx';
import { useLang } from "../../contexts/LanguageContext";
import { toast } from "sonner";
import { API } from "../../lib/constants";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { 
  FileDown, X, Upload, Loader2, AlertCircle, Check
} from "lucide-react";

export const ImportExcelModal = ({ isOpen, onClose, onImportSuccess }) => {
  const { t, lang } = useLang();
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [updateExisting, setUpdateExisting] = useState(false);
  const [step, setStep] = useState(1); // 1: Select File, 2: Map Columns
  const [excelHeaders, setExcelHeaders] = useState([]);
  const [mapping, setMapping] = useState({});
  const [savedMapping, setSavedMapping] = useState({});
  const [systemFields, setSystemFields] = useState([]);

  // Base list of fields that are always available
  const baseFields = [
    { key: 'order_number', label: t('order_number'), required: true },
    { key: 'customer_po', label: 'Customer PO' },
    { key: 'store_po', label: 'Store PO' },
    { key: 'client', label: t('client') },
    { key: 'branding', label: 'Branding' },
    { key: 'priority', label: t('priority') },
    { key: 'quantity', label: t('quantity') },
    { key: 'due_date', label: t('due_date') },
    { key: 'cancel_date', label: lang === 'es' ? 'Fecha Cancelado' : 'Cancel Date' },
    { key: 'color', label: lang === 'es' ? 'Color' : 'Color' },
    { key: 'design_#', label: lang === 'es' ? 'Diseño #' : 'Design #' },
    { key: 'notes', label: lang === 'es' ? 'Notas' : 'Notes' }
  ];

  // Fetch saved mapping AND current column configuration when modal opens
  useEffect(() => {
    if (isOpen) {
      // 1. Fetch saved mapping
      fetch(`${API}/config/import-mapping`, { credentials: 'include' })
        .then(res => res.ok ? res.json() : {})
        .then(data => setSavedMapping(data || {}))
        .catch(err => console.error("Error fetching saved mapping:", err));

      // 2. Fetch custom columns
      fetch(`${API}/config/columns`, { credentials: 'include' })
        .then(res => res.ok ? res.json() : { custom_columns: [] })
        .then(data => {
          const custom = (data.custom_columns || []).map(col => ({
            key: col.key,
            label: col.label,
            isCustom: true
          }));
          // Merge base fields with custom columns, avoiding duplicates
          const combined = [...baseFields];
          custom.forEach(c => {
             if (!combined.find(b => b.key === c.key)) combined.push(c);
          });
          setSystemFields(combined);
        })
        .catch(err => {
          console.error("Error fetching columns:", err);
          setSystemFields(baseFields);
        });
    }
  }, [isOpen]);

  const handleFileChange = async (e) => {
    const selectedFile = e.target.files[0];
    if (!selectedFile) return;

    if (!selectedFile.name.endsWith('.xlsx') && !selectedFile.name.endsWith('.xls')) {
      toast.error(lang === 'es' ? "Por favor selecciona un archivo Excel (.xlsx o .xls)" : "Please select an Excel file (.xlsx or .xls)");
      e.target.value = null;
      return;
    }

    setFile(selectedFile);
    setLoading(true);

    try {
      const data = await selectedFile.arrayBuffer();
      const workbook = XLSX.read(data);
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
      const headers = (jsonData[0] || []).map(h => String(h || '').trim()).filter(Boolean);
      
      setExcelHeaders(headers);

      // Mapping strategy: 
      // 1. Start with saved mapping (if column exists in current file)
      // 2. Fallback to common mapping rules
      const initialMapping = {};
      const commonMaps = {
        'order #': 'order_number', 'order_number': 'order_number', 'order number': 'order_number', 'nro orden': 'order_number', 'num orden': 'order_number',
        'po #': 'customer_po', 'customer po': 'customer_po', 'po cliente': 'customer_po',
        'store po': 'store_po', 'po tienda': 'store_po',
        'qty': 'quantity', 'quantity': 'quantity', 'cantidad': 'quantity', 'cant': 'quantity',
        'due date': 'due_date', 'fecha entrega': 'due_date', 'entrega': 'due_date',
        'cancel date': 'cancel_date', 'fecha cancelado': 'cancel_date', 'cancelado': 'cancel_date',
        'design #': 'design_num', 'design_#': 'design_num', 'diseño #': 'design_num', 'estilo': 'design_num',
        'client': 'client', 'cliente': 'client',
        'branding': 'branding', 'brand': 'branding',
        'priority': 'priority', 'prioridad': 'priority',
        'color': 'color',
        'notes': 'notes', 'notas': 'notes', 'comentarios': 'notes'
      };

      systemFields.forEach(field => {
        // Check if we have a saved mapping for this field that still exists in the file headers
        if (savedMapping[field.key] && headers.includes(savedMapping[field.key])) {
          initialMapping[field.key] = savedMapping[field.key];
        } else {
          // Otherwise use common mapping logic
          const match = headers.find(h => {
             const lowerH = h.toLowerCase();
             return commonMaps[lowerH] === field.key;
          });
          if (match) initialMapping[field.key] = match;
        }
      });

      setMapping(initialMapping);
      setStep(2);
    } catch (err) {
      console.error("Error reading headers:", err);
      toast.error(lang === 'es' ? "Error al leer las cabeceras del archivo" : "Error reading file headers");
    } finally {
      setLoading(false);
    }
  };

  const handleUpload = async () => {
    if (!file) return;

    // Validate order_number mapping
    if (!mapping.order_number) {
      toast.error(t('order_number_required'));
      return;
    }

    setLoading(true);

    try {
      // 1. Save the mapping to backend (memory)
      await fetch(`${API}/config/import-mapping`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapping })
      });

      // 2. Perform the actual import
      const formData = new FormData();
      formData.append("file", file);
      formData.append("column_mapping", JSON.stringify(mapping));
      
      const res = await fetch(`${API}/orders/import-excel?update_existing=${updateExisting}`, {
        method: 'POST',
        credentials: 'include',
        body: formData
      });

      if (res.ok) {
        const stats = await res.json();
        toast.success(
          `${t('import_success')}: ${stats.created} ${lang === 'es' ? 'creadas' : 'created'}, ${stats.updated} ${lang === 'es' ? 'actualizadas' : 'updated'}`,
          { duration: 5000 }
        );
        onImportSuccess();
        onClose();
        resetState();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || (lang === 'es' ? "Error al importar el archivo" : "Error importing file"));
      }
    } catch (error) {
      console.error("Import error:", error);
      toast.error(lang === 'es' ? "Error de conexión al importar" : "Connection error during import");
    } finally {
      setLoading(false);
    }
  };

  const resetState = () => {
    setFile(null);
    setStep(1);
    setExcelHeaders([]);
    setMapping({});
  };

  const downloadTemplate = () => {
    // Basic template data
    const headers = [
      "Order #", "Customer PO", "Store PO", "Client", "Branding", 
      "Priority", "Quantity", "Color", "Design #", "Notes"
    ];
    const csvContent = headers.join(",") + "\n";
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", "plantilla_importacion_mos.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open && !loading) { onClose(); resetState(); } }}>
      <DialogContent className="max-w-2xl bg-card border-border overflow-hidden flex flex-col p-0 shadow-2xl" data-testid="import-excel-modal">
        <DialogHeader className="px-6 py-5 border-b border-border/40 bg-secondary/10">
          <DialogTitle className="font-roboto text-xl uppercase tracking-widest flex items-center gap-3 text-glow-primary">
            <FileDown className="w-5 h-5 text-primary" />
            {step === 1 ? t('import_excel_title') : t('map_columns_title')}
          </DialogTitle>
          <button 
            onClick={() => { onClose(); resetState(); }} 
            disabled={loading}
            className="absolute right-6 top-5 p-2 rounded-full hover:bg-secondary/50 transition-colors disabled:opacity-30"
          >
            <X className="h-4 w-4" />
          </button>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 max-h-[60vh] scrollbar-red">
          {step === 1 ? (
            <div className="space-y-6">
              <div className="p-5 bg-primary/10 border border-primary/20 rounded-2xl space-y-3 shadow-inner">
                <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-primary flex items-center gap-2">
                  <AlertCircle className="w-4 h-4" />
                  {lang === 'es' ? 'Instrucciones Importantes' : 'Important Instructions'}
                </h4>
                <p className="text-xs text-foreground/80 leading-relaxed font-medium">
                  {lang === 'es' 
                    ? 'Selecciona un archivo Excel. En el siguiente paso podrás elegir qué columna de tu Excel corresponde a cada dato del sistema.' 
                    : 'Select an Excel file. In the next step you can choose which column from your Excel corresponds to each system field.'}
                </p>
                <button 
                  onClick={downloadTemplate}
                  className="px-3 py-1.5 bg-background/50 border border-border rounded-lg text-[10px] font-black text-primary hover:bg-background transition-all uppercase tracking-widest shadow-sm"
                >
                  {lang === 'es' ? 'Descargar plantilla (CSV)' : 'Download template (CSV)'}
                </button>
              </div>

              <div className="space-y-5">
                <div className="flex flex-col items-center justify-center border-2 border-dashed border-border/60 rounded-3xl p-12 hover:border-primary/50 transition-all bg-secondary/20 relative group overflow-hidden">
                  <div className="absolute inset-0 bg-primary/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                  <input 
                    type="file" 
                    accept=".xlsx, .xls" 
                    onChange={handleFileChange}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                    disabled={loading}
                  />
                  <div className={`p-4 rounded-full bg-secondary mb-4 group-hover:scale-110 transition-transform ${file ? 'text-primary shadow-lg shadow-primary/20 ring-2 ring-primary/30' : 'text-muted-foreground'}`}>
                    {loading ? <Loader2 className="w-10 h-10 animate-spin" /> : <Upload className="w-10 h-10" />}
                  </div>
                  <p className="text-sm font-black text-foreground uppercase tracking-tight">
                    {file ? file.name : (lang === 'es' ? "Haz clic o arrastra tu archivo aquí" : "Click or drag your file here")}
                  </p>
                  <p className="text-[10px] text-muted-foreground uppercase font-black tracking-widest mt-2 opacity-60">Formatos: .xlsx, .xls</p>
                </div>

                <div className="flex items-center gap-3 p-4 bg-secondary/10 rounded-2xl border border-border/50 group cursor-pointer hover:bg-secondary/20 transition-all">
                  <input 
                    type="checkbox" 
                    id="update-existing"
                    checked={updateExisting}
                    onChange={(e) => setUpdateExisting(e.target.checked)}
                    className="w-5 h-5 rounded-lg border-border text-primary focus:ring-primary bg-background cursor-pointer"
                    disabled={loading}
                  />
                  <label htmlFor="update-existing" className="text-sm font-bold text-foreground/80 cursor-pointer select-none">
                    {lang === 'es' ? 'Actualizar órdenes si el número de orden ya existe' : 'Update orders if order number already exists'}
                  </label>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="flex items-center justify-between px-2">
                <div>
                  <h3 className="text-sm font-black text-foreground uppercase tracking-tight">{t('mapping_config')}</h3>
                  <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-widest opacity-60">{t('mapping_desc')}</p>
                </div>
                <button 
                  onClick={() => setStep(1)} 
                  className="px-3 py-1.5 text-[10px] font-black text-muted-foreground hover:text-foreground uppercase tracking-widest transition-colors"
                >
                  {t('change_file')}
                </button>
              </div>

              <div className="grid grid-cols-1 gap-2 border border-border/40 rounded-2xl overflow-hidden bg-background/50">
                <div className="grid grid-cols-2 bg-secondary/50 py-2.5 px-4 text-[10px] font-black tracking-[0.2em] text-muted-foreground uppercase border-b border-border/40">
                  <span>{t('system_field')}</span>
                  <span>{t('excel_column')}</span>
                </div>
                <div className="divide-y divide-border/20">
                  {systemFields.map((field) => (
                    <div key={field.key} className="grid grid-cols-2 items-center py-3 px-4 hover:bg-secondary/30 transition-colors">
                      <div className="flex flex-col">
                        <span className={`text-xs font-black uppercase tracking-tight ${field.required ? 'text-primary' : 'text-foreground/80'}`}>
                          {field.label} {field.required && '*'}
                        </span>
                        {field.required && <span className="text-[9px] text-primary/60 font-bold uppercase">{lang === 'es' ? 'Requerido' : 'Required'}</span>}
                      </div>
                      <select
                        value={mapping[field.key] || ''}
                        onChange={(e) => setMapping(prev => ({ ...prev, [field.key]: e.target.value }))}
                        className="w-full bg-secondary/50 border border-border/50 rounded-xl px-3 py-2 text-xs font-bold focus:ring-2 focus:ring-primary/30 outline-none hover:border-primary/40 transition-all appearance-none cursor-pointer"
                        disabled={loading}
                      >
                        <option value="">{t('no_import')}</option>
                        {excelHeaders.map(h => (
                          <option key={h} value={h}>{h}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end items-center gap-4 py-6 border-t border-border/40 bg-secondary/5 px-6">
          <button 
            onClick={() => { onClose(); resetState(); }} 
            disabled={loading}
            className="px-4 py-2 text-xs font-black text-muted-foreground hover:text-foreground disabled:opacity-50 uppercase tracking-[0.2em] transition-all"
          >
            {t('cancel')}
          </button>
          
          {step === 2 && (
            <button 
              onClick={handleUpload}
              disabled={loading || !mapping.order_number}
              className="px-8 py-3 bg-primary text-primary-foreground rounded-2xl font-black tracking-[0.2em] text-xs hover:bg-primary/90 transition-all flex items-center gap-2 shadow-xl glow-primary disabled:opacity-50 disabled:grayscale"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              {t('confirm_import')}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
