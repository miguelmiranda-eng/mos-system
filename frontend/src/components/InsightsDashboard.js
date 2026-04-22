import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { 
  Sparkles, Loader2, ArrowLeft, Key, Lock, Settings, Activity, ShieldCheck, 
  Lightbulb, TrendingUp, AlertTriangle
} from 'lucide-react';
import { toast } from 'sonner';
import { API } from '../lib/constants';

// We rely on React Markdown if available, otherwise just basic rendering
// In this project we might not have react-markdown installed. We'll use simple text rendering.

const InsightsDashboard = ({ isAdmin }) => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [insights, setInsights] = useState("");
  const [isConfigured, setIsConfigured] = useState(false);
  
  const [apiKey, setApiKey] = useState("");
  const [showConfig, setShowConfig] = useState(false);

  useEffect(() => {
    checkConfig();
  }, []);

  const checkConfig = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/insights/config`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setIsConfigured(data.is_configured);
        if (!data.is_configured && isAdmin) {
          setShowConfig(true);
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveConfig = async () => {
    if (!apiKey.trim()) {
      toast.error('La clave API no puede estar vacía');
      return;
    }
    try {
      const res = await fetch(`${API}/insights/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ gemini_api_key: apiKey.trim() })
      });
      if (res.ok) {
        toast.success('Clave API guardada exitosamente de forma encriptada.');
        setApiKey("");
        setIsConfigured(true);
        setShowConfig(false);
      } else {
        const err = await res.json();
        toast.error(err.detail || 'Error al guardar la clave API');
      }
    } catch (err) {
      toast.error('Error de conexión');
    }
  };

  const runAnalysis = async () => {
    setAnalyzing(true);
    setInsights("");
    try {
      const res = await fetch(`${API}/insights/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
      if (res.ok) {
        const data = await res.json();
        setInsights(data.insights);
        toast.success("Análisis completado");
      } else {
        const err = await res.json();
        toast.error(err.detail || 'Error durante el análisis');
      }
    } catch (err) {
      toast.error('Error de comunicación con el servidor');
    } finally {
      setAnalyzing(false);
    }
  };

  // Removed formatInsights function since we now use ReactMarkdown

  return (
    <div className="min-h-screen bg-background p-6 md:p-10 font-barlow relative overflow-y-auto">
      {/* Background patterns */}
      <div className="fixed top-0 right-0 w-1/2 h-1/2 bg-primary/5 blur-[120px] rounded-full -translate-y-1/2 translate-x-1/2 pointer-events-none z-0"></div>
      
      <header className="mb-8 relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <button onClick={() => navigate('/home')} className="mb-4 text-muted-foreground hover:text-foreground flex items-center text-sm transition-colors group">
             <ArrowLeft className="w-4 h-4 mr-1 group-hover:-translate-x-1 transition-transform" /> Volver al Home
          </button>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-primary/20 rounded-xl flex items-center justify-center border border-primary/30 shadow-[0_0_20px_rgba(220,38,38,0.3)]">
              <Sparkles className="w-6 h-6 text-primary" />
            </div>
            <div>
               <h1 className="text-3xl font-black uppercase tracking-tighter text-foreground">
                 AI <span className="text-primary">INSIGHTS</span>
               </h1>
               <p className="text-muted-foreground font-medium text-sm">
                 Análisis inteligente de rendimiento, cuellos de botella y métricas de usuarios.
               </p>
            </div>
          </div>
        </div>
        
        {isAdmin && (
          <button 
             onClick={() => setShowConfig(!showConfig)}
             className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2 ${showConfig ? 'bg-secondary text-foreground' : 'bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground border border-border'}`}>
             <Settings className="w-4 h-4" /> Configuración API
          </button>
        )}
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 relative z-10">
        
        {/* Main Analysis Panel */}
        <div className={`${showConfig ? 'xl:col-span-8' : 'xl:col-span-12'} space-y-6 transition-all duration-300`}>
          <div className="bg-card/40 backdrop-blur-xl border border-border/50 rounded-2xl p-6 shadow-xl min-h-[500px] flex flex-col items-center justify-center">
            
            {loading ? (
              <div className="flex flex-col items-center gap-4">
                <Loader2 className="w-10 h-10 animate-spin text-primary" />
                <p className="text-muted-foreground font-bold uppercase tracking-widest text-[10px]">Cargando estado...</p>
              </div>
            ) : !isConfigured ? (
              <div className="text-center space-y-4 max-w-sm">
                <div className="w-20 h-20 bg-secondary/50 rounded-full flex items-center justify-center mx-auto border border-border">
                  <Lock className="w-8 h-8 text-muted-foreground opacity-50" />
                </div>
                <h3 className="text-xl font-black uppercase text-foreground">Módulo Bloqueado</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Para utilizar el motor de inteligencia artificial, un administrador debe configurar una clave de API válida.
                </p>
                {isAdmin && (
                  <button onClick={() => setShowConfig(true)} className="mt-4 bg-primary text-primary-foreground px-6 py-2 rounded-xl text-xs font-black uppercase tracking-widest shadow-lg shadow-primary/20">
                    Configurar Ahora
                  </button>
                )}
              </div>
            ) : (
              <div className={`w-full h-full flex flex-col ${insights ? 'items-start justify-start' : 'items-center justify-center'}`}>
                {!insights && !analyzing && (
                  <div className="text-center space-y-6 max-w-lg mx-auto py-20">
                    <div className="w-24 h-24 bg-primary/10 rounded-full flex items-center justify-center mx-auto border border-primary/20 relative group">
                      <div className="absolute inset-0 bg-primary/20 rounded-full blur-xl group-hover:blur-2xl transition-all duration-500" />
                      <Sparkles className="w-10 h-10 text-primary relative z-10" />
                    </div>
                    <div>
                      <h2 className="text-2xl font-black uppercase text-foreground mb-2">Motor de Análisis Listo</h2>
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        El sistema recopilará datos de la actividad reciente, cuellos de botella en tableros y participación de usuarios para generar un reporte inteligente.
                      </p>
                    </div>
                    <button 
                      onClick={runAnalysis}
                      className="bg-primary hover:bg-primary/90 text-primary-foreground px-8 py-4 rounded-xl text-sm font-black uppercase tracking-[0.2em] shadow-xl shadow-primary/30 hover:scale-[1.02] active:scale-95 transition-all flex items-center justify-center gap-3 w-full max-w-xs mx-auto">
                      <Activity className="w-5 h-5" /> Iniciar Análisis
                    </button>
                  </div>
                )}

                {analyzing && (
                   <div className="w-full py-32 flex flex-col items-center justify-center space-y-8">
                     <div className="relative">
                       <div className="w-20 h-20 border-4 border-secondary rounded-full"></div>
                       <div className="w-20 h-20 border-4 border-primary rounded-full border-t-transparent animate-spin absolute top-0 left-0"></div>
                       <Sparkles className="w-8 h-8 text-primary absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 animate-pulse" />
                     </div>
                     <div className="text-center space-y-2">
                       <h3 className="text-lg font-black uppercase text-foreground tracking-widest">Analizando Base de Datos</h3>
                       <p className="text-xs text-muted-foreground uppercase font-bold tracking-[0.3em] animate-pulse">Procesando cuellos de botella y métricas...</p>
                     </div>
                   </div>
                )}

                {insights && !analyzing && (
                  <div className="w-full animate-in fade-in slide-in-from-bottom-4 duration-500">
                    <div className="flex items-center justify-between border-b border-border/50 pb-4 mb-6">
                      <h2 className="text-xl font-black uppercase tracking-widest text-foreground flex items-center gap-3">
                        <LineChart className="w-6 h-6 text-primary" /> Resultados del Análisis
                      </h2>
                      <button onClick={runAnalysis} className="px-4 py-2 bg-secondary/50 hover:bg-secondary rounded-lg text-[10px] font-black uppercase tracking-widest text-muted-foreground transition-all flex items-center gap-2">
                        <RefreshCw className="w-3 h-3" /> Actualizar
                      </button>
                    </div>
                    
                    <div className="prose dark:prose-invert prose-primary prose-headings:font-black prose-headings:tracking-widest prose-h2:text-primary prose-h2:border-b prose-h2:border-primary/20 prose-h2:pb-2 prose-h2:mt-8 prose-p:leading-relaxed prose-li:marker:text-primary prose-strong:text-primary/90 prose-code:text-primary prose-code:bg-primary/10 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none max-w-none text-[15px] text-foreground/80 font-medium tracking-wide">
                       <div className="bg-secondary/20 p-8 rounded-xl border border-border/50">
                         <ReactMarkdown>{insights}</ReactMarkdown>
                       </div>
                    </div>
                  </div>
                )}
              </div>
            )}
            
          </div>
        </div>

        {/* Right Side: Config Panel (Admin Only) */}
        {showConfig && isAdmin && (
          <div className="xl:col-span-4 space-y-6 animate-in slide-in-from-right-4 duration-300">
            <div className="bg-card/40 backdrop-blur-xl border border-border/50 rounded-2xl p-6 shadow-xl sticky top-6">
               <h2 className="text-sm font-black uppercase tracking-widest text-foreground mb-6 flex items-center gap-2">
                 <ShieldCheck className="w-5 h-5 text-primary" /> Seguridad de API
               </h2>

               <div className="space-y-6">
                 <div className="bg-primary/10 border border-primary/20 p-4 rounded-xl flex gap-3">
                    <Lock className="w-5 h-5 text-primary flex-shrink-0" />
                    <p className="text-[10px] text-primary/80 font-bold uppercase leading-relaxed tracking-widest">
                      Tu clave de Gemini se almacenará utilizando encriptación Fernet AES de 128-bit. Nunca será visible ni expuesta en texto plano.
                    </p>
                 </div>

                 <div className="space-y-2">
                   <label className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground">Clave de API de Gemini</label>
                   <div className="relative">
                     <Key className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                     <input 
                       type="password" 
                       value={apiKey} 
                       onChange={(e) => setApiKey(e.target.value)}
                       placeholder="AIzaSy..." 
                       className="w-full pl-11 pr-4 py-3 bg-secondary/50 border border-border rounded-xl text-sm text-foreground focus:ring-2 focus:ring-primary/50 outline-none transition-all font-mono" 
                     />
                   </div>
                 </div>

                 <button 
                   onClick={handleSaveConfig} 
                   disabled={!apiKey.trim()}
                   className="w-full py-4 bg-primary text-primary-foreground rounded-xl font-black uppercase tracking-widest text-xs hover:scale-[1.02] active:scale-95 transition-all shadow-lg shadow-primary/20 flex items-center justify-center gap-2 disabled:opacity-50">
                   Guardar Clave Encriptada
                 </button>
               </div>
            </div>
            
            {/* Legend / Info Box */}
            <div className="bg-secondary/30 border border-border/50 rounded-2xl p-6">
               <h3 className="text-xs font-black uppercase tracking-widest text-foreground mb-4">¿Qué analiza este módulo?</h3>
               <ul className="space-y-3">
                 <li className="flex gap-3 text-xs text-muted-foreground">
                   <TrendingUp className="w-4 h-4 text-green-500 flex-shrink-0" /> Evaluamos la productividad del equipo basándonos en la velocidad de cierre de tareas.
                 </li>
                 <li className="flex gap-3 text-xs text-muted-foreground">
                   <AlertTriangle className="w-4 h-4 text-yellow-500 flex-shrink-0" /> Detectamos cuellos de botella comparando la distribución de órdenes en cada tablero.
                 </li>
                 <li className="flex gap-3 text-xs text-muted-foreground">
                   <Lightbulb className="w-4 h-4 text-primary flex-shrink-0" /> Generamos recomendaciones accionables fundamentadas en datos reales.
                 </li>
               </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// Add missing icon simple exports at bottom for inline convenience
const LineChart = (props) => <svg {...props} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>
const RefreshCw = (props) => <svg {...props} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>

export default InsightsDashboard;
