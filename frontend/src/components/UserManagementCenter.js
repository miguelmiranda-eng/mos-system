import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  UserPlus, Loader2, Shield, User, Trash2, ChevronDown, ChevronUp, 
  Eye, EyeOff, Pencil, Ban, Mail, Lock, KeyRound, Check, X, ClipboardCheck,
  ArrowLeft, Users, Search, RefreshCw, Smartphone, Activity, Clock
} from 'lucide-react';
import { useLang } from '../contexts/LanguageContext';
import { toast } from 'sonner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { API, BOARDS } from '../lib/constants';

const PERM_OPTIONS = [
  { value: 'edit', label: 'Editar', icon: Pencil, color: 'text-green-500' },
  { value: 'view', label: 'Solo ver', icon: Eye, color: 'text-blue-400' },
  { value: 'none', label: 'Sin acceso', icon: Ban, color: 'text-red-400' },
];

const UserManagementCenter = () => {
  const navigate = useNavigate();
  const { t } = useLang();
  
  const [users, setUsers] = useState([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('user');
  const [loading, setLoading] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [expandedUser, setExpandedUser] = useState(null);
  const [permissionsMap, setPermissionsMap] = useState({});
  const [savingPerms, setSavingPerms] = useState(null);
  const [createTab, setCreateTab] = useState('google'); // 'google' | 'email'
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('user');
  const [creating, setCreating] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [changingPwUser, setChangingPwUser] = useState(null);
  const [newPw, setNewPw] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPw, setSavingPw] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [showCreatePw, setShowCreatePw] = useState(false);
  const [showResetPw, setShowResetPw] = useState(false);
  const [customers, setCustomers] = useState([]);
  const [newCust, setNewCust] = useState('');
  const [inviteCust, setInviteCust] = useState('');

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/users`, { credentials: 'include' });
      if (res.ok) setUsers(await res.json());
    } catch { 
      toast.error('Error cargando usuarios');
    } finally { 
      setLoading(false); 
    }
  };

  const fetchCustomers = async () => {
    try {
      const res = await fetch(`${API}/wms/inventory/options`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setCustomers(data.customers || []);
      }
    } catch {}
  };

  useEffect(() => {
    fetchUsers();
    fetchCustomers();
  }, []);

  const handleCreateUser = async () => {
    if (!newEmail.trim() || !newPassword) { toast.error('Email y contraseña requeridos'); return; }
    setCreating(true);
    try {
      const res = await fetch(`${API}/auth/create-user`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ 
          email: newEmail.trim(), 
          password: newPassword, 
          name: newName.trim(), 
          role: newRole,
          associated_customer: newRole === 'customer' ? newCust : ''
        })
      });
      if (res.ok) {
        toast.success(`Usuario ${newEmail} creado`);
        setNewEmail(''); setNewPassword(''); setNewName(''); setNewRole('user');
        fetchUsers();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Error al crear usuario');
      }
    } catch { toast.error('Error de conexión'); }
    finally { setCreating(false); }
  };

  const handleSaveProfile = async (email) => {
    setSavingProfile(true);
    try {
      const res = await fetch(`${API}/users/${encodeURIComponent(email)}/profile`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ name: editName, email: editEmail })
      });
      if (res.ok) { toast.success('Usuario actualizado'); setEditingUser(null); fetchUsers(); }
      else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error'); }
    } catch { toast.error('Error de conexión'); }
    finally { setSavingProfile(false); }
  };

  const handleChangePassword = async (email) => {
    if (!newPw || newPw.length < 6) { toast.error('Mínimo 6 caracteres'); return; }
    setSavingPw(true);
    try {
      const res = await fetch(`${API}/users/${encodeURIComponent(email)}/password`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ password: newPw })
      });
      if (res.ok) { toast.success('Contraseña actualizada'); setChangingPwUser(null); setNewPw(''); }
      else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error'); }
    } catch { toast.error('Error de conexión'); }
    finally { setSavingPw(false); }
  };

  const fetchPermissions = async (email) => {
    try {
      const res = await fetch(`${API}/users/${encodeURIComponent(email)}/board-permissions`, { credentials: 'include' });
      if (res.ok) {
        const perms = await res.json();
        setPermissionsMap(prev => ({ ...prev, [email]: perms }));
      }
    } catch { /* silent */ }
  };

  const handleToggleExpand = (email) => {
    if (expandedUser === email) { setExpandedUser(null); return; }
    setExpandedUser(email);
    if (!permissionsMap[email]) fetchPermissions(email);
  };

  const handlePermChange = (email, board, perm) => {
    setPermissionsMap(prev => ({
      ...prev,
      [email]: { ...(prev[email] || {}), [board]: perm }
    }));
  };

  const handleSavePermissions = async (email) => {
    setSavingPerms(email);
    try {
      const perms = permissionsMap[email] || {};
      const res = await fetch(`${API}/users/${encodeURIComponent(email)}/board-permissions`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify(perms)
      });
      if (res.ok) toast.success('Permisos guardados');
      else toast.error('Error guardando permisos');
    } catch { toast.error('Error guardando permisos'); } finally { setSavingPerms(null); }
  };

  const handleInvite = async () => {
    if (!inviteEmail.trim() || !inviteEmail.includes('@')) { toast.error(t('valid_email')); return; }
    setInviting(true);
    try {
      const res = await fetch(`${API}/users/invite`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ 
          email: inviteEmail.trim(), 
          role: inviteRole,
          associated_customer: inviteRole === 'customer' ? inviteCust : ''
        })
      });
      if (res.ok) { toast.success(`${inviteEmail} invitado como ${inviteRole}`); setInviteEmail(''); setInviteRole('user'); fetchUsers(); }
      else { const data = await res.json(); toast.error(data.detail || t('invite_err')); }
    } catch { toast.error(t('invite_err')); } finally { setInviting(false); }
  };

  const handleRoleChange = async (userId, newRole, customer = '') => {
    if (!window.confirm(`¿Cambiar el rol a ${newRole}?`)) {
        fetchUsers();
        return;
    }
    
    setLoading(true);
    try {
      const res = await fetch(`${API}/users/${userId}/role`, { 
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', 
        body: JSON.stringify({ role: newRole, associated_customer: customer || undefined }) 
      });
      if (res.ok) { 
        toast.success('Rol actualizado con éxito'); 
        setTimeout(fetchUsers, 500); 
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Error al actualizar rol');
        fetchUsers();
      }
    } catch (err) { 
      toast.error('Error de conexión al actualizar rol'); 
      fetchUsers();
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveUser = async (userId) => {
    if (!window.confirm('¿Eliminar usuario definitivamente?')) return;
    try {
      const res = await fetch(`${API}/users/${userId}`, { method: 'DELETE', credentials: 'include' });
      if (res.ok) { toast.success('Usuario eliminado'); fetchUsers(); }
    } catch { toast.error('Error eliminando usuario'); }
  };

  const filteredBoards = BOARDS.filter(b => b !== 'MASTER' && b !== 'PAPELERA DE RECICLAJE');
  const filteredUsers = users.filter(u => 
    (u.name || '').toLowerCase().includes(searchTerm.toLowerCase()) || 
    u.email.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-background p-6 md:p-10 font-barlow relative overflow-y-auto">
      {/* Background patterns */}
      <div className="fixed top-0 right-0 w-1/2 h-1/2 bg-primary/5 blur-[120px] rounded-full -translate-y-1/2 translate-x-1/2 pointer-events-none z-0"></div>
      <div className="fixed bottom-0 left-0 w-1/3 h-1/3 bg-blue-500/5 blur-[100px] rounded-full translate-y-1/2 -translate-x-1/3 pointer-events-none z-0"></div>

      <header className="mb-8 relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <button onClick={() => navigate('/home')} className="mb-4 text-muted-foreground hover:text-foreground flex items-center text-sm transition-colors group">
            <ArrowLeft className="w-4 h-4 mr-1 group-hover:-translate-x-1 transition-transform" /> Volver al Home
          </button>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-primary/20 rounded-xl flex items-center justify-center border border-primary/30 shadow-[0_0_20px_rgba(var(--primary),0.3)]">
              <Users className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-3xl font-black uppercase tracking-tighter text-foreground">
                USER <span className="text-primary">MANAGEMENT</span>
              </h1>
              <p className="text-muted-foreground font-medium text-sm">
                Control de accesos, roles y permisos por tablero del equipo.
              </p>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
            <button onClick={fetchUsers} className="p-3 bg-secondary/50 hover:bg-secondary border border-border rounded-xl transition-all">
                <RefreshCw className={`w-5 h-5 text-muted-foreground ${loading ? 'animate-spin' : ''}`} />
            </button>
        </div>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 relative z-10">
        {/* Left Side: Create/Invite Panel */}
        <div className="xl:col-span-4 space-y-6">
          <div className="bg-card/40 backdrop-blur-xl border border-border/50 rounded-2xl p-6 shadow-xl sticky top-6">
            <h2 className="text-lg font-black uppercase tracking-widest text-foreground mb-6 flex items-center gap-2">
              <UserPlus className="w-5 h-5 text-primary" /> Nuevo Usuario
            </h2>
            
            <div className="flex gap-1 mb-6 bg-secondary/30 p-1 rounded-xl">
              <button onClick={() => setCreateTab('google')} className={`flex-1 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${createTab === 'google' ? 'bg-primary text-black shadow-lg' : 'text-muted-foreground hover:text-foreground'}`}>
                Invitar (Google)
              </button>
              <button onClick={() => setCreateTab('email')} className={`flex-1 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${createTab === 'email' ? 'bg-primary text-black shadow-lg' : 'text-muted-foreground hover:text-foreground'}`}>
                Crear con Email
              </button>
            </div>

            {createTab === 'google' ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground">Correo Gmail</label>
                  <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="ejemplo@gmail.com" className="w-full bg-secondary/50 border border-border rounded-xl px-4 py-3 text-sm text-foreground focus:ring-2 focus:ring-primary/50" />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground">Rol Inicial</label>
                  <Select value={inviteRole} onValueChange={setInviteRole}>
                    <SelectTrigger className="w-full h-12 bg-secondary/50 border-border rounded-xl">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-popover border-border z-[300]">
                      <SelectItem value="user">Usuario Estándar</SelectItem>
                      <SelectItem value="admin">Administrador</SelectItem>
                      <SelectItem value="picker">Picker / Almacén</SelectItem>
                      <SelectItem value="ceo">CEO / Ejecutivo</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {inviteRole === 'customer' && (
                  <div className="space-y-2 animate-in slide-in-from-top-2 flex flex-col">
                    <label className="text-[10px] font-black uppercase tracking-[0.2em] text-primary">Cliente Asociado</label>
                    <Select value={inviteCust} onValueChange={setInviteCust}>
                      <SelectTrigger className="w-full h-12 bg-secondary/70 border-primary/30 rounded-xl focus:ring-primary/50 text-xs">
                        <SelectValue placeholder="Seleccionar Cliente..." />
                      </SelectTrigger>
                      <SelectContent className="bg-popover border-border z-[300]">
                        {customers.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <button onClick={handleInvite} disabled={inviting || !inviteEmail.trim()}
                  className="w-full py-4 bg-primary text-black rounded-xl font-black uppercase tracking-widest text-xs hover:scale-[1.02] active:scale-95 transition-all shadow-lg shadow-primary/20 flex items-center justify-center gap-2 disabled:opacity-50 mt-4">
                  {inviting ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />} Enviar Invitación
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-2">
                   <label className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground">Nombre Completo</label>
                   <div className="relative">
                     <User className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                     <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
                        placeholder="Nombre del usuario" className="w-full pl-11 pr-4 py-3 bg-secondary/50 border border-border rounded-xl text-sm text-foreground focus:ring-2 focus:ring-primary/50" />
                   </div>
                </div>
                <div className="space-y-2">
                   <label className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground">Correo de Acceso</label>
                   <div className="relative">
                     <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                     <input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)}
                        placeholder="usuario@empresa.com" className="w-full pl-11 pr-4 py-3 bg-secondary/50 border border-border rounded-xl text-sm text-foreground focus:ring-2 focus:ring-primary/50" />
                   </div>
                </div>
                <div className="space-y-2">
                   <label className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground">Contraseña Temporal</label>
                    <div className="relative">
                      <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <input type={showCreatePw ? "text" : "password"} value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="Mínimo 6 caracteres" className="w-full pl-11 pr-12 py-3 bg-secondary/50 border border-border rounded-xl text-sm text-foreground focus:ring-2 focus:ring-primary/50" />
                      <button onClick={() => setShowCreatePw(!showCreatePw)} className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors p-1" type="button">
                        {showCreatePw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground">Rol</label>
                  <Select value={newRole} onValueChange={setNewRole}>
                    <SelectTrigger className="w-full h-12 bg-secondary/50 border-border rounded-xl">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-popover border-border z-[300]">
                      <SelectItem value="user">Usuario Estándar</SelectItem>
                      <SelectItem value="admin">Administrador</SelectItem>
                      <SelectItem value="picker">Picker / Almacén</SelectItem>
                      <SelectItem value="ceo">CEO / Ejecutivo</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {newRole === 'customer' && (
                   <div className="space-y-2 animate-in slide-in-from-top-2 flex flex-col">
                     <label className="text-[10px] font-black uppercase tracking-[0.2em] text-primary">Cliente Asociado</label>
                     <Select value={newCust} onValueChange={setNewCust}>
                       <SelectTrigger className="w-full h-12 bg-secondary/70 border-primary/30 rounded-xl focus:ring-primary/50 text-xs">
                         <SelectValue placeholder="Seleccionar Cliente..." />
                       </SelectTrigger>
                       <SelectContent className="bg-popover border-border z-[300]">
                         {customers.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                       </SelectContent>
                     </Select>
                   </div>
                )}
                <button onClick={handleCreateUser} disabled={creating || !newEmail.trim() || !newPassword}
                  className="w-full py-4 bg-primary text-black rounded-xl font-black uppercase tracking-widest text-xs hover:scale-[1.02] active:scale-95 transition-all shadow-lg shadow-primary/20 flex items-center justify-center gap-2 disabled:opacity-50 mt-4">
                  {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />} Crear Cuenta
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Right Side: Users List */}
        <div className="xl:col-span-8 space-y-6">
          <div className="bg-card/40 backdrop-blur-xl border border-border/50 rounded-2xl p-4 flex items-center gap-4">
            <Search className="w-5 h-5 text-muted-foreground" />
            <input 
              type="text" 
              placeholder="Filtrar por nombre o email..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="bg-transparent border-none focus:ring-0 text-foreground flex-1 text-sm font-medium"
            />
            <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground bg-secondary/50 px-3 py-1 rounded-full">
              {filteredUsers.length} Usuarios
            </div>
          </div>

          <div className="space-y-4">
            {loading ? (
              <div className="flex flex-col items-center justify-center py-20 gap-4">
                <Loader2 className="w-10 h-10 animate-spin text-primary" />
                <p className="text-muted-foreground font-bold uppercase tracking-[0.2em] text-[10px]">Cargando base de usuarios...</p>
              </div>
            ) : filteredUsers.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 gap-4 bg-card/20 border border-dashed border-border rounded-2xl italic text-muted-foreground">
                <Users className="w-12 h-12 opacity-20" /> No se encontraron usuarios
              </div>
            ) : filteredUsers.map(u => (
              <div key={u.user_id} className={`group bg-card/40 backdrop-blur-xl border border-border/50 rounded-2xl overflow-hidden transition-all hover:border-primary/30 ${expandedUser === u.email ? 'ring-1 ring-primary/20 shadow-2xl' : ''}`}>
                <div className="flex items-center gap-4 p-4">
                  <div className="relative">
                    {u.picture ? (
                      <img src={u.picture} alt="" className="w-12 h-12 rounded-full border-2 border-primary/20" />
                    ) : (
                      <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center border-2 border-primary/20">
                        <User className="w-6 h-6 text-primary" />
                      </div>
                    )}
                    {u.role === 'admin' && (
                      <div className="absolute -top-1 -right-1 bg-primary text-black p-1 rounded-full border-2 border-background shadow-lg" title="Admin">
                        <Shield className="w-3 h-3" />
                      </div>
                    )}
                  </div>
                  
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-black text-foreground truncate uppercase tracking-tight flex items-center gap-2">
                       {u.name || 'Sin Nombre'}
                       {u.auth_type === 'email' && <span className="text-[9px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20 font-black tracking-widest">EMAIL</span>}
                       {u.role === 'picker' && <span className="text-[9px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-black tracking-widest">PICKER</span>}
                       {u.role === 'customer' && <span className="text-[9px] px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400 border border-purple-500/20 font-black tracking-widest">CLIENTE: {u.associated_customer}</span>}
                    </h3>
                    <p className="text-xs text-muted-foreground font-mono truncate">{u.email}</p>
                    
                    {/* Advanced Metrics Row */}
                    <div className="flex flex-wrap items-center gap-3 mt-2">
                      <div className="flex items-center gap-1.5 text-[9px] font-black uppercase text-muted-foreground tracking-widest">
                        <Smartphone className="w-3 h-3 text-primary/70" />
                        <span>Sesiones: <span className="text-foreground">{u.login_count || 0}</span></span>
                      </div>
                      <div className="flex items-center gap-1.5 text-[9px] font-black uppercase text-muted-foreground tracking-widest">
                        <ClipboardCheck className="w-3 h-3 text-primary/70" />
                        <span>Proyectos: <span className="text-foreground">{u.projects_count || 0}</span></span>
                      </div>
                      <div className="flex items-center gap-1.5 text-[9px] font-black uppercase text-muted-foreground tracking-widest">
                        <Activity className="w-3 h-3 text-primary/70" />
                        <span>Tareas: <span className="text-foreground">{u.total_tasks || 0}</span></span>
                      </div>
                      <div className="flex items-center gap-1.5 text-[9px] font-black uppercase text-muted-foreground tracking-widest">
                        <Clock className="w-3 h-3 text-primary/70" />
                        <span>Actividad: <span className="text-foreground">{u.last_activity ? new Date(u.last_activity).toLocaleDateString() : 'N/D'}</span></span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Select value={u.role} onValueChange={(v) => handleRoleChange(u.user_id, v)}>
                      <SelectTrigger className="w-32 h-9 bg-secondary/50 border-border rounded-lg text-[10px] font-black uppercase tracking-widest transition-all hover:bg-secondary">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-popover border-border z-[300]">
                        <SelectItem value="user">Usuario</SelectItem>
                        <SelectItem value="admin">Administrador</SelectItem>
                        <SelectItem value="picker">Picker</SelectItem>
                        <SelectItem value="ceo">CEO</SelectItem>
                      </SelectContent>
                    </Select>

                    <div className="flex bg-secondary/30 rounded-lg p-1 border border-border">
                       {u.auth_type === 'email' && (
                         <>
                           <button onClick={() => { setEditingUser(editingUser === u.email ? null : u.email); setEditName(u.name || ''); setEditEmail(u.email); setChangingPwUser(null); }}
                              className={`p-1.5 rounded-md transition-all ${editingUser === u.email ? 'bg-primary text-black' : 'hover:bg-secondary text-muted-foreground hover:text-foreground'}`} title="Editar Perfil">
                              <Pencil className="w-4 h-4" />
                           </button>
                           <button onClick={() => { setChangingPwUser(changingPwUser === u.email ? null : u.email); setNewPw(''); setEditingUser(null); }}
                              className={`p-1.5 rounded-md transition-all ${changingPwUser === u.email ? 'bg-orange-500 text-white shadow-lg shadow-orange-500/20' : 'hover:bg-secondary text-muted-foreground hover:text-foreground'}`} title="Cambiar Contraseña">
                              <KeyRound className="w-4 h-4" />
                           </button>
                         </>
                       )}
                       {u.role !== 'admin' && (
                         <button onClick={() => handleToggleExpand(u.email)}
                            className={`p-1.5 rounded-md transition-all ${expandedUser === u.email ? 'bg-primary text-black shadow-lg shadow-primary/20' : 'hover:bg-secondary text-muted-foreground hover:text-foreground'}`} title="Permisos de Tablero">
                            <Smartphone className="w-4 h-4" />
                         </button>
                       )}
                       <button onClick={() => handleRemoveUser(u.user_id)} className="p-1.5 rounded-md hover:bg-destructive/20 text-muted-foreground hover:text-destructive group-hover:opacity-100 transition-all opacity-40">
                         <Trash2 className="w-4 h-4" />
                       </button>
                    </div>
                  </div>
                </div>

                {/* Expanded Panels */}
                {editingUser === u.email && (
                  <div className="px-4 pb-4 border-t border-border animate-in slide-in-from-top-2 duration-200">
                    <div className="pt-4 grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
                       <div className="space-y-1">
                         <span className="text-[9px] font-black uppercase text-muted-foreground ml-1">Nombre</span>
                         <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)}
                           className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground" />
                       </div>
                       <div className="space-y-1">
                         <span className="text-[9px] font-black uppercase text-muted-foreground ml-1">Email Actualizado</span>
                         <input type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)}
                           className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground" />
                       </div>
                       <div className="md:col-span-2 flex justify-end gap-2 pt-2">
                         <button onClick={() => setEditingUser(null)} className="px-4 py-2 text-xs font-bold uppercase text-muted-foreground hover:text-foreground">Cancelar</button>
                         <button onClick={() => handleSaveProfile(u.email)} disabled={savingProfile}
                           className="bg-primary text-black px-6 py-2 rounded-lg text-xs font-black uppercase flex items-center gap-2">
                           {savingProfile ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Guardar Perfil
                         </button>
                       </div>
                    </div>
                  </div>
                )}

                {changingPwUser === u.email && (
                  <div className="px-4 pb-4 border-t border-border animate-in slide-in-from-top-2 duration-200">
                    <div className="pt-4 flex flex-col md:flex-row gap-4 items-end">
                       <div className="flex-1 space-y-1 w-full">
                         <span className="text-[9px] font-black uppercase text-muted-foreground ml-1">Nueva Contraseña (mín. 6)</span>
                         <div className="relative">
                            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/50" />
                            <input type={showResetPw ? "text" : "password"} value={newPw} onChange={(e) => setNewPw(e.target.value)}
                              className="w-full bg-secondary border border-border rounded-lg pl-9 pr-12 py-2 text-sm text-foreground" placeholder="Escribe la nueva contraseña..." />
                            <button onClick={() => setShowResetPw(!showResetPw)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors p-1" type="button">
                              {showResetPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                            </button>
                         </div>
                       </div>
                       <div className="flex gap-2 w-full md:w-auto">
                         <button onClick={() => setChangingPwUser(null)} className="flex-1 px-4 py-2 text-xs font-bold uppercase text-muted-foreground hover:text-foreground">Cancelar</button>
                         <button onClick={() => handleChangePassword(u.email)} disabled={savingPw || !newPw}
                           className="flex-1 bg-orange-600 text-white px-6 py-2 rounded-lg text-xs font-black uppercase flex items-center gap-2 shadow-lg shadow-orange-600/30">
                           {savingPw ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Shield className="w-3.5 h-3.5" />} Actualizar Acceso
                         </button>
                       </div>
                    </div>
                  </div>
                )}

                {expandedUser === u.email && u.role !== 'admin' && (
                  <div className="px-4 pb-4 border-t border-border animate-in slide-in-from-top-4 duration-300">
                    <div className="pt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                       {filteredBoards.map(board => {
                         const perms = permissionsMap[u.email] || {};
                         const currentPerm = perms[board] || 'edit';
                         return (
                           <div key={board} className="bg-secondary/20 border border-border/50 p-3 rounded-xl space-y-3">
                             <div className="text-[10px] font-black uppercase tracking-widest text-primary truncate border-b border-primary/20 pb-2">{board}</div>
                             <div className="flex flex-col gap-1.5">
                               {PERM_OPTIONS.map(opt => {
                                 const Icon = opt.icon;
                                 const isActive = currentPerm === opt.value;
                                 return (
                                   <button key={opt.value} onClick={() => handlePermChange(u.email, board, opt.value)}
                                      className={`flex items-center justify-between px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase transition-all ${isActive ? 'bg-primary/20 text-primary border border-primary/30' : 'text-muted-foreground hover:bg-secondary/50'}`}>
                                      <span className="flex items-center gap-2"><Icon className="w-3 h-3" /> {opt.label}</span>
                                      {isActive && <Check className="w-3 h-3 animate-in zoom-in duration-300" />}
                                   </button>
                                 );
                               })}
                             </div>
                           </div>
                         );
                       })}
                    </div>
                    <div className="flex justify-end pt-6">
                       <button onClick={() => handleSavePermissions(u.email)} disabled={savingPerms === u.email}
                          className="bg-primary text-black px-8 py-3 rounded-xl text-[11px] font-black uppercase flex items-center gap-2 shadow-xl shadow-primary/20 hover:scale-[1.03] active:scale-95 transition-all">
                          {savingPerms === u.email ? <Loader2 className="w-4 h-4 animate-spin" /> : <Smartphone className="w-4 h-4" />} Guardar Todos los Permisos
                       </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

       <footer className="mt-20 pt-10 border-t border-border/20 text-center">
        <p className="text-[10px] font-black uppercase tracking-[0.5em] text-muted-foreground opacity-20 italic">Seguridad y Gestión de Activos Humanos - MOS CORE ENGINE v5.4.2</p>
      </footer>
    </div>
  );
};

export default UserManagementCenter;
