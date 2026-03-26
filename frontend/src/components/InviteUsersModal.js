import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { UserPlus, Loader2, Shield, User, Trash2, ChevronDown, ChevronUp, Eye, Pencil, Ban, Mail, Lock, KeyRound, Check, X, ClipboardCheck } from "lucide-react";
import { useLang } from "../contexts/LanguageContext";
import { toast } from "sonner";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

const PERM_OPTIONS = [
  { value: 'edit', label: 'Editar', icon: Pencil, color: 'text-green-500' },
  { value: 'view', label: 'Solo ver', icon: Eye, color: 'text-blue-400' },
  { value: 'none', label: 'Sin acceso', icon: Ban, color: 'text-red-400' },
];

const InviteUsersModal = ({ isOpen, onClose, boards = [] }) => {
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
  const [editingUser, setEditingUser] = useState(null); // email of user being edited
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [changingPwUser, setChangingPwUser] = useState(null); // email of user whose password is being changed
  const [newPw, setNewPw] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPw, setSavingPw] = useState(false);

  const handleCreateUser = async () => {
    if (!newEmail.trim() || !newPassword) { toast.error('Email y contrasena requeridos'); return; }
    setCreating(true);
    try {
      const res = await fetch(`${API}/auth/create-user`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ email: newEmail.trim(), password: newPassword, name: newName.trim(), role: newRole })
      });
      if (res.ok) {
        toast.success('Usuario ' + newEmail + ' creado');
        setNewEmail(''); setNewPassword(''); setNewName(''); setNewRole('user');
        fetchUsers();
      } else {
        const err = await res.json().catch(function() { return {}; });
        toast.error(err.detail || 'Error al crear usuario');
      }
    } catch (e) { toast.error('Error de conexion'); }
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
      else { const err = await res.json().catch(function() { return {}; }); toast.error(err.detail || 'Error'); }
    } catch (e) { toast.error('Error de conexion'); }
    finally { setSavingProfile(false); }
  };

  const handleChangePassword = async (email) => {
    if (!newPw || newPw.length < 6) { toast.error('Minimo 6 caracteres'); return; }
    setSavingPw(true);
    try {
      const res = await fetch(`${API}/users/${encodeURIComponent(email)}/password`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ password: newPw })
      });
      if (res.ok) { toast.success('Contrasena actualizada'); setChangingPwUser(null); setNewPw(''); }
      else { const err = await res.json().catch(function() { return {}; }); toast.error(err.detail || 'Error'); }
    } catch (e) { toast.error('Error de conexion'); }
    finally { setSavingPw(false); }
  };

  useEffect(() => { if (isOpen) fetchUsers(); }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/users`, { credentials: 'include' });
      if (res.ok) setUsers(await res.json());
    } catch { /* silent */ } finally { setLoading(false); }
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
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole })
      });
      if (res.ok) { toast.success(`${inviteEmail} ${t('invited_as')} ${inviteRole}`); setInviteEmail(''); setInviteRole('user'); fetchUsers(); }
      else { const data = await res.json(); toast.error(data.detail || t('invite_err')); }
    } catch { toast.error(t('invite_err')); } finally { setInviting(false); }
  };

  const handleRoleChange = async (userId, newRole) => {
    try {
      const res = await fetch(`${API}/users/${userId}/role`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ role: newRole }) });
      if (res.ok) { toast.success(t('role_updated')); fetchUsers(); }
    } catch { toast.error(t('role_update_err')); }
  };

  const handleRemoveUser = async (userId) => {
    if (!window.confirm(t('del_user_confirm'))) return;
    try {
      const res = await fetch(`${API}/users/${userId}`, { method: 'DELETE', credentials: 'include' });
      if (res.ok) { toast.success(t('user_deleted')); fetchUsers(); }
    } catch { toast.error(t('del_user_err')); }
  };

  const getPermIcon = (perm) => {
    const opt = PERM_OPTIONS.find(o => o.value === perm) || PERM_OPTIONS[0];
    const Icon = opt.icon;
    return <Icon className={`w-3 h-3 ${opt.color}`} />;
  };

  const filteredBoards = boards.filter(b => b !== 'MASTER' && b !== 'PAPELERA DE RECICLAJE');

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] bg-card border-border overflow-hidden flex flex-col" data-testid="invite-users-modal">
        <DialogHeader>
          <DialogTitle className="font-barlow text-xl uppercase tracking-wide flex items-center gap-3">
            <UserPlus className="w-5 h-5" /> {t('manage_users')}
          </DialogTitle>
        </DialogHeader>

        {/* Invite / Create form */}
        <div className="border-b border-border pb-4 space-y-3">
          <div className="flex gap-1 mb-2">
            <button onClick={() => setCreateTab('google')} className={`px-3 py-1.5 rounded text-xs font-medium transition-all ${createTab === 'google' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'}`} data-testid="tab-google-invite">
              Invitar (Google)
            </button>
            <button onClick={() => setCreateTab('email')} className={`px-3 py-1.5 rounded text-xs font-medium transition-all flex items-center gap-1 ${createTab === 'email' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'}`} data-testid="tab-email-create">
              <KeyRound className="w-3 h-3" /> Crear con email
            </button>
          </div>

          {createTab === 'google' ? (
            <>
              <label className="text-xs uppercase tracking-wide text-muted-foreground font-bold">{t('invite_new_google')}</label>
              <div className="flex gap-2">
                <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleInvite()}
                  placeholder="email@gmail.com" className="flex-1 bg-secondary border border-border rounded px-3 py-2 text-sm text-foreground" data-testid="invite-email-input" />
                <Select value={inviteRole} onValueChange={setInviteRole}>
                  <SelectTrigger className="w-32 bg-secondary border-border" data-testid="invite-role-select"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-popover border-border z-[300]">
                    <SelectItem value="user">{t('user_role')}</SelectItem>
                    <SelectItem value="admin">{t('admin')}</SelectItem>
                    <SelectItem value="picker">Picker</SelectItem>
                  </SelectContent>
                </Select>
                <button onClick={handleInvite} disabled={inviting || !inviteEmail.trim()}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2" data-testid="invite-submit-btn">
                  {inviting ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />} {t('invite')}
                </button>
              </div>
            </>
          ) : (
            <>
              <label className="text-xs uppercase tracking-wide text-muted-foreground font-bold">Crear usuario con email y contrasena</label>
              <div className="grid grid-cols-2 gap-2">
                <div className="relative col-span-2 sm:col-span-1">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
                    placeholder="Nombre" className="w-full pl-9 pr-3 py-2 bg-secondary border border-border rounded text-sm text-foreground" data-testid="create-name-input" />
                </div>
                <div className="relative col-span-2 sm:col-span-1">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)}
                    placeholder="email@empresa.com" required className="w-full pl-9 pr-3 py-2 bg-secondary border border-border rounded text-sm text-foreground" data-testid="create-email-input" />
                </div>
                <div className="relative col-span-2 sm:col-span-1">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <input type="text" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Contrasena (min. 6)" required className="w-full pl-9 pr-3 py-2 bg-secondary border border-border rounded text-sm text-foreground" data-testid="create-password-input" />
                </div>
                <div className="col-span-2 sm:col-span-1 flex gap-2">
                  <Select value={newRole} onValueChange={setNewRole}>
                    <SelectTrigger className="flex-1 bg-secondary border-border" data-testid="create-role-select"><SelectValue /></SelectTrigger>
                    <SelectContent className="bg-popover border-border z-[300]">
                      <SelectItem value="user">{t('user_role')}</SelectItem>
                      <SelectItem value="admin">{t('admin')}</SelectItem>
                      <SelectItem value="picker">Picker</SelectItem>
                    </SelectContent>
                  </Select>
                  <button onClick={handleCreateUser} disabled={creating || !newEmail.trim() || !newPassword}
                    className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2" data-testid="create-user-submit-btn">
                    {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />} Crear
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Users list */}
        <div className="flex-1 overflow-y-auto py-4">
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin" /></div>
          ) : (
            <div className="space-y-2">
              {users.map(u => {
                const isExpanded = expandedUser === u.email;
                const perms = permissionsMap[u.email] || {};
                return (
                  <div key={u.user_id} className="border border-border rounded-lg overflow-hidden" data-testid={`user-row-${u.email}`}>
                    <div className="flex items-center gap-3 p-3 bg-secondary/30">
                      {u.picture ? (
                        <img src={u.picture} alt="" className="w-9 h-9 rounded-full" />
                      ) : (
                        <div className="w-9 h-9 rounded-full bg-primary/20 flex items-center justify-center"><User className="w-5 h-5 text-primary" /></div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-foreground truncate flex items-center gap-1.5">
                          {u.name || u.email}
                          {u.auth_type === 'email' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 font-medium" data-testid={`auth-badge-${u.email}`}>Email</span>}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">{u.email}</div>
                      </div>
                      <Select value={u.role} onValueChange={(v) => handleRoleChange(u.user_id, v)}>
                        <SelectTrigger className="w-28 h-8 text-xs bg-secondary border-border"><SelectValue /></SelectTrigger>
                        <SelectContent className="bg-popover border-border z-[300]">
                          <SelectItem value="user"><span className="flex items-center gap-1"><User className="w-3 h-3" /> {t('user_role')}</span></SelectItem>
                          <SelectItem value="admin"><span className="flex items-center gap-1"><Shield className="w-3 h-3" /> {t('admin')}</span></SelectItem>
                          <SelectItem value="picker"><span className="flex items-center gap-1"><ClipboardCheck className="w-3 h-3" /> Picker</span></SelectItem>
                        </SelectContent>
                      </Select>
                      {u.auth_type === 'email' && (
                        <>
                          <button onClick={() => { setEditingUser(editingUser === u.email ? null : u.email); setEditName(u.name || ''); setEditEmail(u.email); setChangingPwUser(null); }}
                            className={`p-1.5 rounded transition-colors ${editingUser === u.email ? 'bg-primary/20 text-primary' : 'hover:bg-secondary'}`}
                            title="Editar perfil" data-testid={`edit-user-${u.email}`}>
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button onClick={() => { setChangingPwUser(changingPwUser === u.email ? null : u.email); setNewPw(''); setEditingUser(null); }}
                            className={`p-1.5 rounded transition-colors ${changingPwUser === u.email ? 'bg-orange-500/20 text-orange-400' : 'hover:bg-secondary'}`}
                            title="Cambiar contrasena" data-testid={`change-pw-${u.email}`}>
                            <KeyRound className="w-4 h-4" />
                          </button>
                        </>
                      )}
                      {u.role !== 'admin' && filteredBoards.length > 0 && (
                        <button onClick={() => handleToggleExpand(u.email)}
                          className={`p-1.5 rounded transition-colors ${isExpanded ? 'bg-primary/20 text-primary' : 'hover:bg-secondary'}`}
                          title="Permisos por tablero" data-testid={`toggle-perms-${u.email}`}>
                          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                      )}
                      <button onClick={() => handleRemoveUser(u.user_id)} className="p-1.5 rounded hover:bg-destructive/20 transition-colors" title={t('del_user_btn')}>
                        <Trash2 className="w-4 h-4 text-muted-foreground hover:text-destructive" />
                      </button>
                    </div>
                    {/* Edit profile panel */}
                    {editingUser === u.email && u.auth_type === 'email' && (
                      <div className="border-t border-border bg-secondary/10 p-3 space-y-2" data-testid={`edit-panel-${u.email}`}>
                        <div className="text-xs uppercase tracking-wider text-muted-foreground font-medium mb-2">Editar perfil</div>
                        <div className="flex gap-2">
                          <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Nombre"
                            className="flex-1 bg-secondary border border-border rounded px-3 py-1.5 text-sm text-foreground" data-testid={`edit-name-${u.email}`} />
                          <input type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} placeholder="Email"
                            className="flex-1 bg-secondary border border-border rounded px-3 py-1.5 text-sm text-foreground" data-testid={`edit-email-${u.email}`} />
                          <button onClick={() => handleSaveProfile(u.email)} disabled={savingProfile}
                            className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1" data-testid={`save-profile-${u.email}`}>
                            {savingProfile ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Guardar
                          </button>
                          <button onClick={() => setEditingUser(null)} className="px-2 py-1.5 rounded text-muted-foreground hover:bg-secondary">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    )}
                    {/* Change password panel */}
                    {changingPwUser === u.email && u.auth_type === 'email' && (
                      <div className="border-t border-border bg-secondary/10 p-3 space-y-2" data-testid={`pw-panel-${u.email}`}>
                        <div className="text-xs uppercase tracking-wider text-muted-foreground font-medium mb-2">Cambiar contrasena</div>
                        <div className="flex gap-2">
                          <div className="relative flex-1">
                            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <input type="text" value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="Nueva contrasena (min. 6)"
                              className="w-full pl-9 pr-3 py-1.5 bg-secondary border border-border rounded text-sm text-foreground" data-testid={`new-pw-${u.email}`} />
                          </div>
                          <button onClick={() => handleChangePassword(u.email)} disabled={savingPw || !newPw}
                            className="px-3 py-1.5 bg-orange-600 text-white rounded text-sm hover:bg-orange-700 disabled:opacity-50 flex items-center gap-1" data-testid={`save-pw-${u.email}`}>
                            {savingPw ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Cambiar
                          </button>
                          <button onClick={() => { setChangingPwUser(null); setNewPw(''); }} className="px-2 py-1.5 rounded text-muted-foreground hover:bg-secondary">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    )}
                    {/* Board permissions panel */}
                    {isExpanded && u.role !== 'admin' && (
                      <div className="border-t border-border bg-secondary/10 p-3 space-y-2" data-testid={`perms-panel-${u.email}`}>
                        <div className="text-xs uppercase tracking-wider text-muted-foreground font-medium mb-2">Permisos por tablero</div>
                        <div className="grid gap-1.5">
                          {filteredBoards.map(board => {
                            const perm = perms[board] || 'edit';
                            return (
                              <div key={board} className="flex items-center gap-2 py-1">
                                <span className="text-sm flex-1 truncate">{board}</span>
                                <div className="flex gap-1">
                                  {PERM_OPTIONS.map(opt => {
                                    const Icon = opt.icon;
                                    const isActive = perm === opt.value;
                                    return (
                                      <button key={opt.value} onClick={() => handlePermChange(u.email, board, opt.value)}
                                        className={`px-2 py-1 rounded text-xs flex items-center gap-1 transition-all ${isActive ? `${opt.color} bg-secondary border border-border font-medium` : 'text-muted-foreground hover:bg-secondary/50'}`}
                                        title={opt.label} data-testid={`perm-${board}-${opt.value}`}>
                                        <Icon className="w-3 h-3" /> {opt.label}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        <div className="flex justify-end pt-2 border-t border-border">
                          <button onClick={() => handleSavePermissions(u.email)} disabled={savingPerms === u.email}
                            className="px-4 py-1.5 bg-primary text-primary-foreground rounded text-sm hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1" data-testid={`save-perms-${u.email}`}>
                            {savingPerms === u.email ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} Guardar permisos
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              {users.length === 0 && <p className="text-center text-muted-foreground py-8">{t('no_users')}</p>}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default InviteUsersModal;
