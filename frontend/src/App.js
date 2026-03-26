import { useState, useEffect, useRef, useCallback, createContext, useContext } from "react";
import "@/App.css";
import { BrowserRouter, Routes, Route, useNavigate, useLocation, Link } from "react-router-dom";
import { useLang } from "./contexts/LanguageContext";
import { Loader2, Mail, Lock, Eye, EyeOff, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { Toaster } from "./components/ui/sonner";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

// Auth Context
const AuthContext = createContext(null);

export const useAuth = () => useContext(AuthContext);

const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const checkAuth = useCallback(async () => {
    // CRITICAL: If returning from OAuth callback, skip the /me check.
    // AuthCallback will exchange the session_id and establish the session first.
    if (window.location.hash?.includes('session_id=')) {
      setLoading(false);
      return;
    }
    
    try {
      const response = await fetch(`${API}/auth/me`, { credentials: 'include' });
      if (response.ok) {
        const userData = await response.json();
        setUser(userData);
      }
    } catch (error) {
      console.error("Auth check failed:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const login = () => {
    // REMINDER: DO NOT HARDCODE THE URL, OR ADD ANY FALLBACKS OR REDIRECT URLS, THIS BREAKS THE AUTH
    const redirectUrl = window.location.origin + '/dashboard';
    window.location.href = `https://auth.emergentagent.com/?redirect=${encodeURIComponent(redirectUrl)}`;
  };

  const logout = async () => {
    try {
      await fetch(`${API}/auth/logout`, { method: 'POST', credentials: 'include' });
    } catch (error) {
      console.error("Logout error:", error);
    }
    setUser(null);
    window.location.href = '/';
  };

  return (
    <AuthContext.Provider value={{ user, setUser, loading, login, logout, checkAuth }}>
      {children}
    </AuthContext.Provider>
  );
};

// Auth Callback Component
const AuthCallback = () => {
  const { t } = useLang();
  const hasProcessed = useRef(false);
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const [error, setError] = useState(null);

  useEffect(() => {
    if (hasProcessed.current) return;
    hasProcessed.current = true;

    const processAuth = async () => {
      const hash = window.location.hash;
      const sessionIdMatch = hash.match(/session_id=([^&]+)/);
      
      if (sessionIdMatch) {
        const sessionId = sessionIdMatch[1];
        // Retry up to 3 times for network issues
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const response = await fetch(`${API}/auth/session`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ session_id: sessionId })
            });

            if (response.ok) {
              const userData = await response.json();
              // Set user in context FIRST, then wait for state to propagate
              setUser(userData);
              // Small delay to ensure React state propagates before navigation
              await new Promise(r => setTimeout(r, 100));
              navigate('/dashboard', { replace: true });
              return;
            } else {
              const errData = await response.json().catch(() => ({}));
              console.error(`Auth session failed (attempt ${attempt}):`, errData);
              if (attempt === 3) setError(errData.detail || 'Error de autenticación');
            }
          } catch (err) {
            console.error(`Auth callback network error (attempt ${attempt}):`, err);
            if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
            else setError('Error de conexión. Intenta de nuevo.');
          }
        }
      }
      // Only redirect to home if no session_id was found
      if (!sessionIdMatch) navigate('/', { replace: true });
    };

    processAuth();
  }, [navigate, setUser]);

  if (error) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="text-destructive font-barlow text-xl">{error}</div>
          <button onClick={() => window.location.href = '/'} 
            className="px-6 py-2 bg-primary text-primary-foreground rounded-lg font-semibold text-sm">
            Volver al inicio
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="text-foreground font-barlow text-xl">{t('processing_auth')}</div>
    </div>
  );
};

// Protected Route
const ProtectedRoute = ({ children }) => {
  const { t } = useLang();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [grace, setGrace] = useState(true);

  // Grace period: wait 1.5s before redirecting to allow setUser to propagate from AuthCallback
  useEffect(() => {
    const timer = setTimeout(() => setGrace(false), 1500);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!loading && !grace && !user) {
      navigate('/', { replace: true });
    }
  }, [user, loading, grace, navigate]);

  if (loading || (grace && !user)) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-foreground font-barlow text-xl">{t('loading')}</div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return children;
};

// Landing Page
const LandingPage = () => {
  const { t } = useLang();
  const { login, user, setUser } = useAuth();
  const navigate = useNavigate();
  const [showEmailLogin, setShowEmailLogin] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  useEffect(() => {
    if (user) {
      if (user.role === 'operator' || user.role === 'picker') {
        navigate('/operator');
      } else {
        navigate('/dashboard');
      }
    }
  }, [user, navigate]);

  const handleEmailLogin = async (e) => {
    e.preventDefault();
    if (!email || !password) return;
    setLoginLoading(true);
    try {
      const res = await fetch(`${API}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ email, password })
      });
      if (res.ok) {
        const userData = await res.json();
        setUser(userData);
        navigate('/dashboard');
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Error al iniciar sesion');
      }
    } catch { toast.error('Error de conexion'); }
    finally { setLoginLoading(false); }
  };

  const handleForgotPassword = async (e) => {
    e.preventDefault();
    if (!forgotEmail) return;
    setForgotLoading(true);
    try {
      const res = await fetch(`${API}/auth/forgot-password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail })
      });
      const data = await res.json();
      setForgotSent(true);
      toast.success(data.message || 'Email enviado');
      if (data.reset_link) {
        console.log('Reset link (dev):', data.reset_link);
      }
    } catch { toast.error('Error de conexion'); }
    finally { setForgotLoading(false); }
  };

  return (
    <div className="min-h-screen bg-background">
      <Toaster position="bottom-right" theme="dark" />
      <div className="max-w-7xl mx-auto px-4 md:px-6 py-6 md:py-12">
        {/* Header */}
        <header className="flex justify-between items-center mb-10 md:mb-20">
          <h1 className="font-barlow font-bold text-2xl md:text-3xl text-foreground tracking-tight">
            CRM<span className="text-primary">PROD</span>
          </h1>
        </header>

        {/* Hero */}
        <div className="grid lg:grid-cols-2 gap-8 md:gap-16 items-center">
          <div>
            <h2 className="font-barlow font-bold text-3xl md:text-5xl lg:text-6xl text-foreground leading-tight mb-4 md:mb-6 uppercase tracking-wide">
              {t('landing_hero_1')}<br />
              <span className="text-primary">{t('landing_hero_2')}</span>
            </h2>
            <p className="text-muted-foreground text-base md:text-lg mb-6 md:mb-8 max-w-md">
              {t('landing_desc')}
            </p>

            {showForgot ? (
              <div className="max-w-sm space-y-4">
                <button onClick={() => { setShowForgot(false); setForgotSent(false); }} className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1" data-testid="back-to-login">
                  <ArrowLeft className="w-4 h-4" /> Volver
                </button>
                <h3 className="font-barlow font-bold text-xl text-foreground">Recuperar contrasena</h3>
                {forgotSent ? (
                  <div className="bg-primary/10 border border-primary/30 rounded-lg p-4 text-sm text-foreground" data-testid="forgot-success-msg">
                    Si el email existe en el sistema, recibiras un enlace para restablecer tu contrasena.
                  </div>
                ) : (
                  <form onSubmit={handleForgotPassword} className="space-y-3">
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <input type="email" value={forgotEmail} onChange={(e) => setForgotEmail(e.target.value)}
                        placeholder="tu@email.com" required
                        className="w-full pl-10 pr-4 py-3 bg-secondary border border-border rounded-lg text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                        data-testid="forgot-email-input" />
                    </div>
                    <button type="submit" disabled={forgotLoading}
                      className="w-full py-3 bg-primary text-primary-foreground rounded-lg font-semibold text-sm hover:bg-primary/90 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                      data-testid="forgot-submit-btn">
                      {forgotLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                      Enviar enlace de recuperacion
                    </button>
                  </form>
                )}
              </div>
            ) : showEmailLogin ? (
              <div className="max-w-sm space-y-4">
                <form onSubmit={handleEmailLogin} className="space-y-3">
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                      placeholder="tu@email.com" required autoComplete="email"
                      className="w-full pl-10 pr-4 py-3 bg-secondary border border-border rounded-lg text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                      data-testid="login-email-input" />
                  </div>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <input type={showPass ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)}
                      placeholder="Contrasena" required autoComplete="current-password"
                      className="w-full pl-10 pr-10 py-3 bg-secondary border border-border rounded-lg text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                      data-testid="login-password-input" />
                    <button type="button" onClick={() => setShowPass(!showPass)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                      {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <button type="submit" disabled={loginLoading}
                    className="w-full py-3 bg-primary text-primary-foreground rounded-lg font-semibold text-sm hover:bg-primary/90 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                    data-testid="login-email-submit-btn">
                    {loginLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                    Iniciar sesion
                  </button>
                </form>
                <button onClick={() => setShowForgot(true)} className="text-xs text-primary hover:underline" data-testid="forgot-password-link">
                  Olvidaste tu contrasena?
                </button>
                <div className="flex items-center gap-3 text-muted-foreground text-xs">
                  <div className="flex-1 border-t border-border"></div>
                  <span>o</span>
                  <div className="flex-1 border-t border-border"></div>
                </div>
                <button onClick={login} data-testid="login-google-btn-alt"
                  className="w-full py-3 bg-secondary border border-border rounded-lg text-foreground text-sm font-medium hover:bg-secondary/80 transition-all flex items-center justify-center gap-3">
                  <svg className="w-5 h-5" viewBox="0 0 24 24">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                  </svg>
                  Iniciar con Google
                </button>
                <button onClick={() => setShowEmailLogin(false)} className="text-xs text-muted-foreground hover:text-foreground" data-testid="back-to-landing">
                  <ArrowLeft className="w-3 h-3 inline mr-1" />Volver
                </button>
              </div>
            ) : (
              <div className="space-y-3 max-w-sm">
                <button data-testid="login-google-btn" onClick={login}
                  className="w-full bg-primary hover:bg-primary/90 text-primary-foreground px-8 py-4 rounded font-semibold text-lg transition-all hover:scale-105 flex items-center justify-center gap-3">
                  <svg className="w-6 h-6" viewBox="0 0 24 24">
                    <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                    <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                  </svg>
                  {t('landing_login')}
                </button>
                <button onClick={() => setShowEmailLogin(true)} data-testid="show-email-login-btn"
                  className="w-full py-3 bg-secondary border border-border rounded font-medium text-sm text-foreground hover:bg-secondary/80 transition-all flex items-center justify-center gap-2">
                  <Mail className="w-4 h-4" />
                  Iniciar con email y contrasena
                </button>
              </div>
            )}
          </div>

          <div className="hidden lg:block">
            <div className="bg-card border border-border rounded-lg p-6">
              <div className="flex gap-2 mb-4">
                <div className="w-3 h-3 rounded-full bg-rush"></div>
                <div className="w-3 h-3 rounded-full bg-priority"></div>
                <div className="w-3 h-3 rounded-full bg-done"></div>
              </div>
              <div className="space-y-3">
                {['SCHEDULING', 'PRODUCCIÓN', 'COMPLETOS'].map((board, i) => (
                  <div key={board} className="bg-secondary/50 rounded p-3">
                    <div className="font-barlow font-semibold text-sm text-muted-foreground uppercase tracking-wider mb-2">{board}</div>
                    <div className="space-y-2">
                      {[1, 2].map((n) => (
                        <div key={n} className="bg-card border border-border rounded p-2">
                          <div className="flex justify-between items-center">
                            <span className="font-mono text-xs text-muted-foreground">ORD-{1000 + i * 10 + n}</span>
                            <span className={`text-xs px-2 py-0.5 rounded ${i === 0 ? 'bg-rush/20 text-rush' : i === 1 ? 'bg-priority/20 text-priority' : 'bg-done/20 text-done'}`}>
                              {i === 0 ? 'RUSH' : i === 1 ? 'PRIORITY' : 'DONE'}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Features */}
        <div className="grid md:grid-cols-3 gap-8 mt-24">
          {[
            { title: t('landing_feature_1_title'), desc: t('landing_feature_1_desc') },
            { title: t('landing_feature_2_title'), desc: t('landing_feature_2_desc') },
            { title: t('landing_feature_3_title'), desc: t('landing_feature_3_desc') }
          ].map((feature) => (
            <div key={feature.title} className="bg-card border border-border rounded-lg p-6">
              <h3 className="font-barlow font-bold text-xl text-foreground mb-2 uppercase">{feature.title}</h3>
              <p className="text-muted-foreground">{feature.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// Import Dashboard component
import Dashboard from "./components/Dashboard";
import WMS from "./components/WMS";
import OperatorView from "./components/OperatorView";

// Reset Password Page
const ResetPasswordPage = () => {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const token = new URLSearchParams(window.location.search).get('token');

  const handleReset = async (e) => {
    e.preventDefault();
    if (password !== confirmPass) { toast.error('Las contrasenas no coinciden'); return; }
    if (password.length < 6) { toast.error('Minimo 6 caracteres'); return; }
    setLoading(true);
    try {
      const res = await fetch(`${API}/auth/reset-password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password })
      });
      if (res.ok) { setDone(true); toast.success('Contrasena actualizada'); }
      else { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Error'); }
    } catch { toast.error('Error de conexion'); }
    finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <Toaster position="bottom-right" theme="dark" />
      <div className="w-full max-w-sm space-y-6">
        <h1 className="font-barlow font-bold text-3xl text-foreground text-center">
          CRM<span className="text-primary">PROD</span>
        </h1>
        {done ? (
          <div className="text-center space-y-4" data-testid="reset-success">
            <p className="text-foreground">Contrasena actualizada exitosamente.</p>
            <button onClick={() => navigate('/')} className="px-6 py-2 bg-primary text-primary-foreground rounded-lg font-semibold text-sm hover:bg-primary/90" data-testid="go-to-login-btn">
              Ir a iniciar sesion
            </button>
          </div>
        ) : !token ? (
          <div className="text-center text-destructive" data-testid="reset-no-token">Token invalido o faltante.</div>
        ) : (
          <form onSubmit={handleReset} className="space-y-4">
            <h2 className="text-lg font-semibold text-foreground text-center">Nueva contrasena</h2>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input type={showPass ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="Nueva contrasena (min. 6)" required
                className="w-full pl-10 pr-10 py-3 bg-secondary border border-border rounded-lg text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                data-testid="reset-password-input" />
              <button type="button" onClick={() => setShowPass(!showPass)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input type={showPass ? 'text' : 'password'} value={confirmPass} onChange={(e) => setConfirmPass(e.target.value)}
                placeholder="Confirmar contrasena" required
                className="w-full pl-10 pr-4 py-3 bg-secondary border border-border rounded-lg text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                data-testid="reset-confirm-input" />
            </div>
            <button type="submit" disabled={loading}
              className="w-full py-3 bg-primary text-primary-foreground rounded-lg font-semibold text-sm hover:bg-primary/90 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
              data-testid="reset-submit-btn">
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              Restablecer contrasena
            </button>
          </form>
        )}
      </div>
    </div>
  );
};

function AppRouter() {
  const location = useLocation();
  
  // Check URL fragment for session_id - CRITICAL: detect during render, NOT in useEffect
  if (location.hash?.includes('session_id=')) {
    return <AuthCallback />;
  }

  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/dashboard" element={
        <ProtectedRoute>
          <Dashboard />
        </ProtectedRoute>
      } />
      <Route path="/wms" element={
        <ProtectedRoute>
          <WMS />
        </ProtectedRoute>
      } />
      <Route path="/operator" element={
        <ProtectedRoute>
          <OperatorView />
        </ProtectedRoute>
      } />
    </Routes>
  );
}

import { LanguageProvider } from "./contexts/LanguageContext";

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <LanguageProvider>
          <AppRouter />
        </LanguageProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
