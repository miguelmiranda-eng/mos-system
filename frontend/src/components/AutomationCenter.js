import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Zap, Settings, Plus, ArrowLeft, Trash2, Edit2, 
  ChevronRight, Check, CheckCircle2, Factory, X, Play, Loader2
} from 'lucide-react';
import { API, BOARDS } from '../lib/constants';


const TRIGGER_LABELS = {
  create: 'Nueva Orden',
  move: 'Movimiento de Tablero',
  update: 'Actualización',
  status_change: 'Cambio de Estado'
};

const ACTION_LABELS = {
  move_board: 'Mover Tablero',
  send_email: 'Enviar Email',
  assign_field: 'Asignar Campo',
  notify_slack: 'Notificar Slack'
};

const CONDITION_FIELDS = [
  "priority", "client", "branding", "blank_status", "production_status", 
  "trim_status", "sample", "artwork_status", "board", "betty_column", "shipping"
];

const AutomationCenter = () => {
  const navigate = useNavigate();

  const OPTIONS_MAPPING = { 
    'blank_status': 'blank_statuses', 
    'production_status': 'production_statuses', 
    'trim_status': 'trim_statuses', 
    'artwork_status': 'artwork_statuses', 
    'client': 'clients', 
    'priority': 'priorities',
    'sample': 'samples',
    'screens': 'screens',
    'board': 'boards'
  };
  
  const [automations, setAutomations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [options, setOptions] = useState({});
  
  // Wizard State
  const [showWizard, setShowWizard] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [isEditing, setIsEditing] = useState(false);
  const [currentAuto, setCurrentAuto] = useState({
    name: '',
    trigger_type: 'update',
    trigger_conditions: { watch_field: '', watch_value: '' },
    action_type: 'move_board',
    action_params: {},
    is_active: true,
    boards: []
  });
  
  // Helper to safely get the trigger condition string
  const getTriggerCondString = (conds) => {
    if (!conds) return 'Cualquier cambio';
    if (conds.watch_field && conds.watch_value) {
      if (conds.watch_value === 'date_updated') return `Cualquier cambio en ${conds.watch_field}`;
      if (conds.watch_value === 'is_empty') return `Si ${conds.watch_field} queda vacío`;
      if (conds.watch_value === 'not_empty') return `Si ${conds.watch_field} es asignado`;
      return `Si ${conds.watch_field} = ${conds.watch_value}`;
    }
    const keys = Object.keys(conds).filter(k => k !== 'watch_field' && k !== 'watch_value');
    if (keys.length > 0) return keys.map(k => `${k} = ${conds[k]}`).join(' y ');
    return 'Al ejecutarse el disparador';
  };

  const getActionParamString = (type, params) => {
    if (!params) return '';
    if (type === 'move_board') return `A tablero: ${params.target_board || '?'}`;
    if (type === 'send_email') return `A: ${params.to_email || '?'}`;
    if (type === 'assign_field') return `${params.field || '?'} = ${params.value || '?'}`;
    if (type === 'notify_slack') return `Mensaje a Slack`;
    return JSON.stringify(params);
  };

  const fetchAutomations = async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API}/automations`, { credentials: 'include' });
      if (res.ok) {
        setAutomations(await res.json());
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const fetchOptions = async () => {
    try {
      const res = await fetch(`${API}/config/options`, { credentials: 'include' });
      if (res.ok) {
        setOptions(await res.json());
      }
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchAutomations();
    fetchOptions();
  }, []);

  const handleToggleActive = async (auto) => {
    try {
      const updated = { ...auto, is_active: !auto.is_active };
      const res = await fetch(`${API}/automations/${auto.automation_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(updated)
      });
      if (res.ok) fetchAutomations();
    } catch (e) { console.error(e); }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('¿Eliminar automatización?')) return;
    try {
      await fetch(`${API}/automations/${id}`, { method: 'DELETE', credentials: 'include' });
      fetchAutomations();
    } catch (e) { console.error(e); }
  };

  const openNewWizard = () => {
    setCurrentAuto({
      name: '',
      trigger_type: 'update',
      trigger_conditions: { watch_field: 'production_status', watch_value: '' },
      action_type: 'move_board',
      action_params: { target_board: 'COMPLETOS' },
      is_active: true,
      boards: []
    });
    setIsEditing(false);
    setWizardStep(1);
    setShowWizard(true);
  };

  const openEditWizard = (auto) => {
    setCurrentAuto({ ...auto });
    setIsEditing(true);
    setWizardStep(1);
    setShowWizard(true);
  };

  const closeWizard = () => {
    setShowWizard(false);
  };

  const saveAutomation = async () => {
    try {
      if (!currentAuto.name) {
        alert("El nombre es requerido");
        return;
      }
      const url = isEditing ? `${API}/automations/${currentAuto.automation_id}` : `${API}/automations`;
      const method = isEditing ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(currentAuto)
      });
      if (res.ok) {
        closeWizard();
        fetchAutomations();
      } else {
        alert("Error al guardar");
      }
    } catch (e) {
      console.error(e);
    }
  };

  // UI renderers
  const renderWizard = () => (
    <div className="bg-card/80 backdrop-blur-xl border border-border/50 rounded-2xl shadow-2xl p-6 md:p-8 max-w-4xl mx-auto animate-in fade-in zoom-in-95 duration-200">
      <div className="flex justify-between items-center mb-8 border-b border-border/50 pb-4">
        <h2 className="text-2xl font-black uppercase text-foreground">
          {isEditing ? 'Editar Regla' : 'Nueva Regla'}
        </h2>
        <button onClick={closeWizard} className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors">
          <X className="w-6 h-6" />
        </button>
      </div>

      {/* Stepper */}
      <div className="flex items-center justify-between mb-10 relative">
        <div className="absolute left-0 top-1/2 w-full h-1 bg-secondary/50 -z-10 -translate-y-1/2 rounded-full"></div>
        <div className={`absolute left-0 top-1/2 h-1 bg-primary -z-10 -translate-y-1/2 rounded-full transition-all duration-500`} style={{ width: ((wizardStep - 1) * 50) + '%' }}></div>
        
        {[1, 2, 3].map((step) => (
          <div key={step} className="flex flex-col items-center">
            <div className={`w-12 h-12 rounded-full flex items-center justify-center font-black text-lg transition-colors duration-300 border-4 border-background ${wizardStep >= step ? 'bg-primary text-black shadow-[0_0_20px_rgba(255,193,7,0.5)]' : 'bg-secondary text-muted-foreground'}`}>
              {step < wizardStep ? <Check className="w-6 h-6" /> : step}
            </div>
            <span className={`mt-2 font-bold uppercase text-[10px] md:text-xs tracking-wider ${wizardStep >= step ? 'text-primary' : 'text-muted-foreground'}`}>
              {step === 1 ? 'Disparador' : step === 2 ? 'Acción' : 'Revisión'}
            </span>
          </div>
        ))}
      </div>

      {/* Step 1: Trigger */}
      {wizardStep === 1 && (
        <div className="space-y-6 animate-in slide-in-from-right-8 duration-300 flex flex-col items-center">
          <div className="text-center mb-4">
            <div className="inline-flex items-center justify-center p-4 bg-yellow-500/10 rounded-full mb-4">
              <Zap className="w-12 h-12 text-yellow-500" />
            </div>
            <h3 className="text-xl font-bold uppercase tracking-wide">¿Qué evento debe ocurrir? (SI)</h3>
          </div>

          <div className="w-full max-w-lg space-y-4">
            <label className="block text-sm font-bold text-muted-foreground uppercase tracking-widest">Tipo de Disparador</label>
            <select 
              value={currentAuto.trigger_type}
              onChange={e => setCurrentAuto({...currentAuto, trigger_type: e.target.value})}
              className="w-full bg-secondary/50 border border-border p-3 rounded-xl text-foreground"
            >
              {Object.entries(TRIGGER_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>

            {(currentAuto.trigger_type === 'update' || currentAuto.trigger_type === 'status_change') && (
              <div className="p-4 border border-yellow-500/20 bg-yellow-500/5 rounded-xl space-y-4">
                <label className="block text-sm font-bold text-muted-foreground uppercase tracking-widest">Condición del Cambio</label>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <span className="text-xs text-muted-foreground mb-1 block">Campo a observar</span>
                    <select 
                      value={currentAuto.trigger_conditions.watch_field || ''}
                      onChange={e => setCurrentAuto({...currentAuto, trigger_conditions: {...currentAuto.trigger_conditions, watch_field: e.target.value}})}
                      className="w-full bg-secondary/50 border border-border p-2 rounded-lg text-sm text-foreground"
                    >
                      <option value="">-- Seleccionar --</option>
                      {CONDITION_FIELDS.map(f => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground mb-1 block">Nuevo valor esperado</span>
                    {(currentAuto.trigger_conditions.watch_field && OPTIONS_MAPPING[currentAuto.trigger_conditions.watch_field] && options && options[OPTIONS_MAPPING[currentAuto.trigger_conditions.watch_field]]) ? (
                      <select 
                        value={currentAuto.trigger_conditions.watch_value || ''}
                        onChange={e => setCurrentAuto({...currentAuto, trigger_conditions: {...currentAuto.trigger_conditions, watch_value: e.target.value}})}
                        className="w-full bg-secondary/50 border border-border p-2 rounded-lg text-sm text-foreground"
                      >
                        <option value="">-- Seleccionar --</option>
                        {options[OPTIONS_MAPPING[currentAuto.trigger_conditions.watch_field]].map(v => (
                          <option key={v} value={v}>{v}</option>
                        ))}
                      </select>
                    ) : (
                      <input 
                        type="text" 
                        value={currentAuto.trigger_conditions.watch_value || ''}
                        onChange={e => setCurrentAuto({...currentAuto, trigger_conditions: {...currentAuto.trigger_conditions, watch_value: e.target.value}})}
                        className="w-full bg-secondary/50 border border-border p-2 rounded-lg text-sm text-foreground"
                        placeholder="Ej. LISTO PARA ENVIO"
                      />
                    )}
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground italic">Use 'date_updated', 'is_empty', 'not_empty' para condiciones especiales.</p>
              </div>
            )}

            <label className="block text-sm font-bold text-muted-foreground uppercase tracking-widest pt-4">Tableros que aplican (Opcional)</label>
            <select 
              multiple
              value={currentAuto.boards || []}
              onChange={e => {
                const opts = [...e.target.options];
                const selected = opts.filter(o => o.selected).map(o => o.value);
                setCurrentAuto({...currentAuto, boards: selected});
              }}
              className="w-full bg-secondary/50 border border-border p-3 rounded-xl text-foreground text-sm min-h-[100px]"
            >
              {(options.boards || BOARDS).map(b => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">Si no seleccionas nada, aplicará a todos los tableros.</p>

            <div className="flex justify-end pt-6">
              <button onClick={() => setWizardStep(2)} className="bg-primary text-black px-6 py-2 rounded-xl font-bold flex items-center">
                Siguiente <ChevronRight className="w-5 h-5 ml-1" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Step 2: Action */}
      {wizardStep === 2 && (
        <div className="space-y-6 animate-in slide-in-from-right-8 duration-300 flex flex-col items-center">
          <div className="text-center mb-4">
            <div className="inline-flex items-center justify-center p-4 bg-cyan-500/10 rounded-full mb-4">
              <Settings className="w-12 h-12 text-cyan-500" />
            </div>
            <h3 className="text-xl font-bold uppercase tracking-wide">¿Qué acción se ejecutará? (ENTONCES)</h3>
          </div>

          <div className="w-full max-w-lg space-y-4">
            <label className="block text-sm font-bold text-muted-foreground uppercase tracking-widest">Tipo de Acción</label>
            <select 
              value={currentAuto.action_type}
              onChange={e => setCurrentAuto({...currentAuto, action_type: e.target.value})}
              className="w-full bg-secondary/50 border border-border p-3 rounded-xl text-foreground"
            >
              {Object.entries(ACTION_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>

            <div className="p-4 border border-cyan-500/20 bg-cyan-500/5 rounded-xl space-y-4">
              <label className="block text-sm font-bold text-muted-foreground uppercase tracking-widest">Configuración de la acción</label>
              
              {currentAuto.action_type === 'move_board' && (
                <div>
                  <span className="text-xs text-muted-foreground mb-1 block">Tablero Destino</span>
                  <select 
                    value={currentAuto.action_params.target_board || ''}
                    onChange={e => setCurrentAuto({...currentAuto, action_params: {...currentAuto.action_params, target_board: e.target.value}})}
                    className="w-full bg-secondary/50 border border-border p-2 rounded-lg text-sm text-foreground"
                  >
                     <option value="">-- Seleccionar --</option>
                     {(options.boards || BOARDS).map(b => <option key={b} value={b}>{b}</option>)}
                  </select>
                </div>
              )}
              
              {currentAuto.action_type === 'send_email' && (
                <div className="space-y-3">
                  <input type="email" placeholder="Email destino" value={currentAuto.action_params.to_email || ''} onChange={e => setCurrentAuto({...currentAuto, action_params: {...currentAuto.action_params, to_email: e.target.value}})} className="w-full bg-secondary/50 border border-border p-2 rounded-lg text-sm text-foreground"/>
                  <input type="text" placeholder="Asunto" value={currentAuto.action_params.subject || ''} onChange={e => setCurrentAuto({...currentAuto, action_params: {...currentAuto.action_params, subject: e.target.value}})} className="w-full bg-secondary/50 border border-border p-2 rounded-lg text-sm text-foreground"/>
                  <textarea placeholder="Contenido HTML" value={currentAuto.action_params.html_content || ''} onChange={e => setCurrentAuto({...currentAuto, action_params: {...currentAuto.action_params, html_content: e.target.value}})} className="w-full bg-secondary/50 border border-border p-2 rounded-lg text-sm text-foreground min-h-[100px]"></textarea>
                </div>
              )}
              
              {currentAuto.action_type === 'assign_field' && (
                <div className="grid grid-cols-2 gap-4">
                  <input type="text" placeholder="Campo" value={currentAuto.action_params.field || ''} onChange={e => setCurrentAuto({...currentAuto, action_params: {...currentAuto.action_params, field: e.target.value}})} className="w-full bg-secondary/50 border border-border p-2 rounded-lg text-sm text-foreground"/>
                  <input type="text" placeholder="Valor" value={currentAuto.action_params.value || ''} onChange={e => setCurrentAuto({...currentAuto, action_params: {...currentAuto.action_params, value: e.target.value}})} className="w-full bg-secondary/50 border border-border p-2 rounded-lg text-sm text-foreground"/>
                </div>
              )}

              {currentAuto.action_type === 'notify_slack' && (
                 <div className="space-y-3">
                  <input type="text" placeholder="Webhook URL (opcional si hay global)" value={currentAuto.action_params.webhook_url || ''} onChange={e => setCurrentAuto({...currentAuto, action_params: {...currentAuto.action_params, webhook_url: e.target.value}})} className="w-full bg-secondary/50 border border-border p-2 rounded-lg text-sm text-foreground"/>
                  <input type="text" placeholder="Mensaje" value={currentAuto.action_params.message || ''} onChange={e => setCurrentAuto({...currentAuto, action_params: {...currentAuto.action_params, message: e.target.value}})} className="w-full bg-secondary/50 border border-border p-2 rounded-lg text-sm text-foreground"/>
                </div>
              )}
            </div>

            <div className="flex justify-between pt-6">
              <button onClick={() => setWizardStep(1)} className="bg-secondary text-foreground px-6 py-2 rounded-xl font-bold flex items-center hover:bg-secondary/80">
                Atrás
              </button>
              <button onClick={() => setWizardStep(3)} className="bg-primary text-black px-6 py-2 rounded-xl font-bold flex items-center">
                Revisar <ChevronRight className="w-5 h-5 ml-1" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Step 3: Review */}
      {wizardStep === 3 && (
        <div className="space-y-6 animate-in slide-in-from-right-8 duration-300 flex flex-col items-center">
           <div className="text-center mb-4">
            <div className="inline-flex items-center justify-center p-4 bg-primary/20 rounded-full mb-4 text-primary">
              <CheckCircle2 className="w-12 h-12" />
            </div>
            <h3 className="text-xl font-bold uppercase tracking-wide">Revisión Final</h3>
          </div>

          <div className="w-full max-w-lg space-y-6">
            
            <div className="bg-background rounded-xl p-6 border border-border relative overflow-hidden">
              {/* Visual flow */}
              <div className="flex flex-col gap-4">
                <div className="flex gap-4">
                  <div className="mt-1 w-8 h-8 rounded-full bg-yellow-500/20 text-yellow-500 flex items-center justify-center shrink-0">
                    <Zap className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="text-xs font-black uppercase tracking-wider text-yellow-500 mb-1">SI Ocurre: {TRIGGER_LABELS[currentAuto.trigger_type]}</div>
                    <div className="text-sm font-medium text-foreground">{getTriggerCondString(currentAuto.trigger_conditions)}</div>
                    {currentAuto.boards && currentAuto.boards.length > 0 && (
                      <div className="text-xs text-muted-foreground mt-1">En tableros: {currentAuto.boards.join(', ')}</div>
                    )}
                  </div>
                </div>
                
                <div className="w-1 h-6 bg-border ml-4 border-l-2 border-dashed border-border/50"></div>

                <div className="flex gap-4">
                  <div className="mt-1 w-8 h-8 rounded-full bg-cyan-500/20 text-cyan-500 flex items-center justify-center shrink-0">
                    <Settings className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="text-xs font-black uppercase tracking-wider text-cyan-500 mb-1">ENTONCES Ejecuta: {ACTION_LABELS[currentAuto.action_type]}</div>
                    <div className="text-sm font-medium text-foreground">{getActionParamString(currentAuto.action_type, currentAuto.action_params)}</div>
                  </div>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-sm font-bold text-muted-foreground uppercase tracking-widest mb-2">Nombre de la Regla</label>
              <input 
                type="text" 
                value={currentAuto.name}
                onChange={e => setCurrentAuto({...currentAuto, name: e.target.value})}
                className="w-full bg-secondary/50 border border-border p-4 rounded-xl text-lg font-bold text-foreground focus:ring-2 focus:ring-primary focus:border-primary transition-all shadow-inner"
                placeholder="Ej. Mover a Completados"
              />
            </div>

            <div className="flex items-center gap-3 p-4 border border-border rounded-xl">
              <input type="checkbox" id="isActiveCheck" checked={currentAuto.is_active} onChange={e => setCurrentAuto({...currentAuto, is_active: e.target.checked})} className="w-5 h-5 accent-primary" />
              <label htmlFor="isActiveCheck" className="font-bold cursor-pointer">Activar inmediatamente al guardar</label>
            </div>

            <div className="flex justify-between pt-6">
              <button onClick={() => setWizardStep(2)} className="bg-secondary text-foreground px-6 py-2 rounded-xl font-bold flex items-center hover:bg-secondary/80">
                Atrás
              </button>
              <button onClick={saveAutomation} className="bg-primary text-black px-8 py-3 rounded-xl font-bold flex items-center shadow-[0_0_20px_rgba(255,193,7,0.4)] hover:shadow-[0_0_30px_rgba(255,193,7,0.6)] hover:scale-105 transition-all text-lg">
                {isEditing ? 'Actualizar Regla' : 'Crear Regla'} <Check className="w-5 h-5 ml-2" />
              </button>
            </div>
          </div>

        </div>
      )}
    </div>
  );

  const renderCards = () => {
    if (loading) {
      return <div className="flex justify-center py-20"><Loader2 className="w-10 h-10 animate-spin text-primary" /></div>;
    }
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
        {automations.map(auto => (
          <div key={auto.automation_id} className={`bg-card/60 backdrop-blur-xl border ${auto.is_active ? 'border-primary/30 shadow-[0_5px_30px_rgba(255,193,7,0.05)]' : 'border-border opacity-70'} rounded-2xl p-6 transition-all hover:-translate-y-1 hover:border-primary/50 relative overflow-hidden group`}>
            {auto.is_active && <div className="absolute top-0 right-0 w-32 h-32 bg-primary/10 blur-[50px] rounded-full translate-x-1/2 -translate-y-1/2 pointer-events-none"></div>}
            
            <div className="flex justify-between items-start mb-4">
              <h3 className="text-xl font-black uppercase tracking-tight text-foreground pr-4 break-words">
                {auto.name}
              </h3>
              {/* Toggle */}
              <button 
                onClick={() => handleToggleActive(auto)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full shrink-0 transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background ${auto.is_active ? 'bg-green-500' : 'bg-secondary'}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${auto.is_active ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>

            <div className="space-y-4 mb-6 relative z-10">
              <div>
                <div className="flex items-center text-xs font-black uppercase text-yellow-500 mb-1 tracking-wider"><Zap className="w-3.5 h-3.5 mr-1" /> {TRIGGER_LABELS[auto.trigger_type]}</div>
                <p className="text-sm font-bold text-foreground bg-black/20 p-2 rounded-lg border border-white/5">{getTriggerCondString(auto.trigger_conditions)}</p>
              </div>
              <div>
                <div className="flex items-center text-xs font-black uppercase text-cyan-500 mb-1 tracking-wider"><Settings className="w-3.5 h-3.5 mr-1" /> {ACTION_LABELS[auto.action_type]}</div>
                <p className="text-sm font-medium text-muted-foreground break-words">{getActionParamString(auto.action_type, auto.action_params)}</p>
              </div>
            </div>

            <div className="flex items-center justify-between pt-4 border-t border-border/50">
              <div className="text-[10px] font-bold uppercase text-muted-foreground/60 tracking-widest flex items-center">
                {auto.boards && auto.boards.length > 0 ? (
                  <><Factory className="w-3 h-3 mr-1" /> {auto.boards.length} Boards</>
                ) : 'Global'}
              </div>
              <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={() => openEditWizard(auto)} className="p-2 bg-secondary text-foreground hover:bg-primary/20 hover:text-primary rounded-lg transition-colors" title="Editar">
                  <Edit2 className="w-4 h-4" />
                </button>
                <button onClick={() => handleDelete(auto.automation_id)} className="p-2 bg-secondary text-foreground hover:bg-destructive/20 hover:text-destructive rounded-lg transition-colors" title="Eliminar">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        ))}
        
        {/* Add New Card Slot */}
        <div onClick={openNewWizard} className="bg-card/20 backdrop-blur-xl border-2 border-dashed border-border/50 rounded-2xl p-6 flex flex-col justify-center items-center text-muted-foreground hover:bg-card/40 hover:border-primary/50 hover:text-primary cursor-pointer transition-all min-h-[300px]">
          <div className="w-16 h-16 rounded-full bg-secondary flex items-center justify-center mb-4"><Plus className="w-8 h-8" /></div>
          <span className="font-bold uppercase tracking-widest">Crear Nueva Regla</span>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-background p-6 md:p-10 font-barlow relative overflow-y-auto">
      {/* Background patterns */}
      <div className="fixed top-0 right-0 w-1/2 h-1/2 bg-yellow-500/5 blur-[120px] rounded-full -translate-y-1/2 translate-x-1/2 pointer-events-none z-0"></div>
      <div className="fixed bottom-0 left-0 w-1/3 h-1/3 bg-cyan-500/5 blur-[100px] rounded-full translate-y-1/2 -translate-x-1/3 pointer-events-none z-0"></div>

      <header className="mb-8 relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <button onClick={() => navigate('/dashboard')} className="mb-4 text-muted-foreground hover:text-foreground flex items-center text-sm transition-colors group">
            <ArrowLeft className="w-4 h-4 mr-1 group-hover:-translate-x-1 transition-transform" /> Volver al Dashboard
          </button>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-primary/20 rounded-xl flex items-center justify-center border border-primary/30 shadow-[0_0_20px_rgba(255,193,7,0.3)]">
              <Zap className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-3xl font-black uppercase tracking-tighter text-foreground">
                AUTOMATION <span className="text-primary">CENTER</span>
              </h1>
              <p className="text-muted-foreground font-medium text-sm">
                Panel de control de reglas lógicas de la fábrica. {automations.filter(a => a.is_active).length} activas.
              </p>
            </div>
          </div>
        </div>
        {!showWizard && (
          <button onClick={openNewWizard} className="bg-primary text-black px-6 py-3 rounded-xl font-bold uppercase tracking-wider text-sm hover:scale-105 transition-all shadow-[0_0_20px_rgba(255,193,7,0.4)] hover:shadow-[0_0_30px_rgba(255,193,7,0.6)] flex items-center gap-2">
            <Plus className="w-5 h-5" /> Nueva Regla
          </button>
        )}
      </header>

      {/* Main Content */}
      <div className="relative z-10">
        {showWizard ? renderWizard() : renderCards()}
      </div>
    </div>
  );
};

export default AutomationCenter;
