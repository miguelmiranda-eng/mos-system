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
  const [user, setUser] = useState(() => {
    try {
      const stored = localStorage.getItem("mos_user");
      return stored ? JSON.parse(stored) : null;
    } catch { return null; }
  });
  const [loading, setLoading] = useState(!user);

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

  // Persistent user sync
  useEffect(() => {
    if (user) {
      localStorage.setItem("mos_user", JSON.stringify(user));
    } else {
      localStorage.removeItem("mos_user");
    }
  }, [user]);

  // Global tab-close guard
  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (user) {
        e.preventDefault();
        e.returnValue = ""; // Standard browser requirement
        return "";
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [user]);

  const login = () => {
    window.location.href = `${BACKEND_URL}/api/auth/google`;
  };

  const logout = async () => {
    try {
      await fetch(`${API}/auth/logout`, { method: 'POST', credentials: 'include' });
    } catch (error) {
      console.error("Logout error:", error);
    }
    setUser(null);
    localStorage.removeItem("mos_user");
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

// Admin Route
const AdminRoute = ({ children }) => {
  const { t } = useLang();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [grace, setGrace] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setGrace(false), 1500);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!loading && !grace) {
      if (!user) {
        navigate('/', { replace: true });
      } else if (user.role !== 'admin') {
        navigate('/dashboard', { replace: true });
      }
    }
  }, [user, loading, grace, navigate]);

  if (loading || (grace && !user)) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-foreground font-barlow text-xl">{t('loading')}</div>
      </div>
    );
  }

  if (!user || user.role !== 'admin') {
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
    <div className="min-h-screen relative flex flex-col overflow-hidden bg-background">
      <Toaster position="bottom-right" theme="dark" />
      
      {/* Background Image with Overlay */}
      <div className="absolute inset-0 z-0">
        <img src="/tech_bg.png" alt="Tech Background" className="w-full h-full object-cover opacity-80 mix-blend-screen" />
        <div className="absolute inset-0 bg-gradient-to-tr from-background via-background/95 to-transparent"></div>
      </div>

      <div className="relative z-10 w-full max-w-7xl mx-auto px-4 md:px-6 py-6 md:py-12 flex flex-col flex-1">
        {/* Header */}
        <header className="flex justify-between items-center mb-10 md:mb-16">
          <div className="flex items-center gap-4 md:gap-6">
            <div className="w-16 h-16 md:w-20 md:h-20 flex items-center justify-center transform hover:scale-105 transition-transform group cursor-default drop-shadow-[0_5px_15px_rgba(0,0,0,0.6)]">
              <svg viewBox="0 0 100 100" className="w-full h-full transform group-hover:rotate-45 transition-transform duration-1000 ease-in-out">
                {/* Tech Petals (Crimson/Silver) */}
                <g fill="var(--primary)" className="drop-shadow-[0_0_5px_rgba(255,193,7,0.7)]">
                  {[...Array(12)].map((_, i) => (
                    <polygon 
                      key={i} 
                      points="50,4 56,22 50,40 44,22" 
                      transform={`rotate(${i * 30} 50 50)`} 
                    />
                  ))}
                </g>
                
                {/* Microchip / Spiral Abstract Center */}
                <circle cx="50" cy="50" r="20" fill="#000" />
                <circle cx="50" cy="50" r="16" fill="none" stroke="#fff" strokeWidth="2.5" strokeDasharray="6 4" className="drop-shadow-[0_0_2px_#fff]" />
                <circle cx="50" cy="50" r="10" fill="none" stroke="#fff" strokeWidth="2" strokeDasharray="3 3" />
                <circle cx="50" cy="50" r="4" fill="#fff" className="drop-shadow-[0_0_5px_#fff] animate-pulse" />
                
                {/* Circuit Nodes */}
                <g fill="#fff" className="drop-shadow-[0_0_2px_#fff]">
                  {[...Array(6)].map((_, i) => (
                    <circle key={i} cx="50" cy="34" r="1.5" transform={`rotate(${i * 60 + 15} 50 50)`} />
                  ))}
                </g>
              </svg>
            </div>
            <h1 className="font-barlow font-bold text-3xl md:text-4xl text-foreground tracking-widest uppercase drop-shadow-lg">
              MOS <span className="text-primary font-medium">SYSTEM</span>
            </h1>
          </div>
        </header>

        {/* Hero & Form Container */}
        <div className="flex flex-col lg:flex-row gap-12 lg:gap-16 items-center justify-between flex-1">
          {/* Text Content */}
          <div className="flex-1 text-center lg:text-left z-10 w-full">
            <h2 className="font-barlow font-bold text-4xl md:text-5xl lg:text-7xl text-foreground leading-tight mb-4 md:mb-6 uppercase tracking-wide drop-shadow-md">
              {t('landing_hero_1')}<br />
              <span className="text-primary">{t('landing_hero_2')}</span>
            </h2>
            <p className="text-muted-foreground text-base md:text-lg lg:text-xl mb-6 max-w-2xl mx-auto lg:mx-0 font-medium">
              {t('landing_desc')}
            </p>

            {/* Dynamic System Badge */}
            <div className="mt-8 mb-10 md:mb-12 inline-block">
              <div className="flex items-center gap-4 px-6 py-4 bg-card/80 backdrop-blur-xl rounded-2xl border border-primary/30 shadow-[0_0_40px_rgba(255,193,7,0.15)] relative overflow-hidden group hover:border-primary/60 transition-colors cursor-default">
                <div className="absolute inset-0 bg-gradient-to-r from-primary/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
                <div className="w-1.5 h-8 bg-primary rounded-full shadow-[0_0_15px_rgba(255,193,7,0.9)] animate-pulse"></div>
                <div className="flex flex-col text-left">
                  <span className="text-[11px] uppercase tracking-[0.25em] text-primary font-bold">Arquitectura Inteligente</span>
                  <span className="text-xl md:text-2xl font-black tracking-widest text-foreground font-barlow drop-shadow-md">
                    CRM INDUSTRIAL
                  </span>
                </div>
              </div>
            </div>

            <div className="hidden xl:grid grid-cols-3 gap-6 mt-4">
              {[
                { title: t('landing_feature_1_title'), desc: t('landing_feature_1_desc') },
                { title: t('landing_feature_2_title'), desc: t('landing_feature_2_desc') },
                { title: t('landing_feature_3_title'), desc: t('landing_feature_3_desc') }
              ].map((feature, i) => (
                <div key={feature.title} className="bg-card/40 backdrop-blur-md border border-white/5 rounded-xl p-6 hover:bg-card/60 hover:border-primary/30 transition-all group">
                  <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                    {i === 0 ? <div className="w-4 h-4 bg-primary rounded-sm shadow-[0_0_15px_rgba(220,38,38,0.8)]" /> :
                     i === 1 ? <div className="w-4 h-4 border-2 border-primary rounded-full shadow-[0_0_15px_rgba(220,38,38,0.8)]" /> :
                     <div className="w-4 h-1 bg-primary rounded shadow-[0_0_15px_rgba(220,38,38,0.8)]" />}
                  </div>
                  <h3 className="font-barlow font-bold text-lg text-foreground mb-2 uppercase tracking-wider">{feature.title}</h3>
                  <p className="text-muted-foreground text-sm leading-relaxed">{feature.desc}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Login Card (Glassmorphism) */}
          <div className="w-full max-w-md z-10">
            <div className="bg-black/60 backdrop-blur-3xl border border-primary/40 rounded-3xl p-8 md:p-10 shadow-[0_0_50px_rgba(255,193,7,0.2)] relative overflow-hidden group">
              <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-transparent via-primary to-transparent opacity-80"></div>
              <div className="absolute top-0 right-0 w-32 h-32 bg-primary/30 blur-3xl rounded-full translate-x-1/2 -translate-y-1/2"></div>
              
              <h3 className="text-2xl font-bold font-barlow text-foreground mb-8 text-center drop-shadow-sm">Acceso al Sistema</h3>

              {showForgot ? (
                <div className="space-y-4 relative z-10">
                  <button onClick={() => { setShowForgot(false); setForgotSent(false); }} className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors" data-testid="back-to-login">
                    <ArrowLeft className="w-4 h-4" /> Volver
                  </button>
                  <h3 className="font-barlow font-bold text-xl text-foreground">Recuperar contraseña</h3>
                  {forgotSent ? (
                    <div className="bg-primary/20 border border-primary/40 rounded-lg p-4 text-sm text-foreground backdrop-blur-sm" data-testid="forgot-success-msg">
                      Si el email existe en el sistema, recibirás un enlace para restablecer tu contraseña.
                    </div>
                  ) : (
                    <form onSubmit={handleForgotPassword} className="space-y-4">
                      <div className="relative">
                        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <input type="email" value={forgotEmail} onChange={(e) => setForgotEmail(e.target.value)}
                          placeholder="tu@email.com" required
                          className="w-full pl-10 pr-4 py-3.5 bg-black/50 backdrop-blur-lg border border-white/20 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-500/80 focus:border-red-500/50 transition-all placeholder:text-white/40 font-medium selection:bg-red-500/30"
                          data-testid="forgot-email-input" />
                      </div>
                      <button type="submit" disabled={forgotLoading}
                        className="w-full py-4 bg-gradient-to-r from-red-600 to-zinc-700 hover:from-red-500 hover:to-zinc-600 text-white rounded-xl font-black tracking-widest text-sm transition-all hover:-translate-y-0.5 shadow-[0_0_20px_rgba(220,38,38,0.4)] hover:shadow-[0_0_30px_rgba(220,38,38,0.6)] border border-red-500/50 flex items-center justify-center gap-2 disabled:opacity-50 mt-4"
                        data-testid="forgot-submit-btn">
                        {forgotLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                        Enviar enlace de recuperación
                      </button>
                    </form>
                  )}
                </div>
              ) : showEmailLogin ? (
                <div className="space-y-5 relative z-10">
                  <form onSubmit={handleEmailLogin} className="space-y-4">
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                        placeholder="Correo electrónico" required autoComplete="email"
                        className="w-full pl-10 pr-4 py-3.5 bg-black/50 backdrop-blur-lg border border-white/20 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-500/80 focus:border-red-500/50 transition-all placeholder:text-white/40 font-medium selection:bg-red-500/30"
                        data-testid="login-email-input" />
                    </div>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <input type={showPass ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)}
                        placeholder="Contraseña" required autoComplete="current-password"
                        className="w-full pl-10 pr-10 py-3.5 bg-black/50 backdrop-blur-lg border border-white/20 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-500/80 focus:border-red-500/50 transition-all placeholder:text-white/40 font-medium selection:bg-red-500/30"
                        data-testid="login-password-input" />
                      <button type="button" onClick={() => setShowPass(!showPass)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
                        {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                    
                    <div className="flex justify-end">
                       <button type="button" onClick={() => setShowForgot(true)} className="text-sm font-medium text-primary hover:text-primary/80 hover:underline transition-colors" data-testid="forgot-password-link">
                         ¿Olvidaste tu contraseña?
                       </button>
                    </div>

                    <button type="submit" disabled={loginLoading}
                      className="w-full py-4 bg-gradient-to-r from-red-600 to-zinc-700 hover:from-red-500 hover:to-zinc-600 text-white rounded-xl font-black tracking-widest text-sm transition-all hover:-translate-y-0.5 shadow-[0_0_20px_rgba(220,38,38,0.4)] hover:shadow-[0_0_30px_rgba(220,38,38,0.6)] border border-red-500/50 flex items-center justify-center gap-2 disabled:opacity-50 mt-4 relative overflow-hidden"
                      data-testid="login-email-submit-btn">
                      <div className="absolute inset-0 bg-white/20 translate-y-full hover:translate-y-0 transition-transform duration-300"></div>
                      <span className="relative flex items-center gap-2">
                        {loginLoading && <Loader2 className="w-5 h-5 animate-spin" />}
                        {loginLoading ? t('processing_auth') : 'INICIAR SESIÓN'}
                      </span>
                    </button>
                  </form>
                  
                  <div className="flex items-center gap-3 text-muted-foreground text-xs py-2">
                    <div className="flex-1 border-t border-white/10"></div>
                    <span className="uppercase tracking-widest font-semibold text-muted-foreground/70">O INVENTARIO CON</span>
                    <div className="flex-1 border-t border-white/10"></div>
                  </div>
                  
                  <button onClick={login} data-testid="login-google-btn-alt"
                    className="w-full py-3.5 bg-secondary/60 backdrop-blur-md border border-white/10 rounded-xl text-foreground text-sm font-semibold hover:bg-secondary/80 transition-all flex items-center justify-center gap-3 hover:border-white/20">
                    <svg className="w-5 h-5" viewBox="0 0 24 24">
                      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                    </svg>
                    Google
                  </button>
                  <button onClick={() => setShowEmailLogin(false)} className="mx-auto flex items-center text-xs text-muted-foreground hover:text-foreground transition-colors mt-4" data-testid="back-to-landing">
                    <ArrowLeft className="w-3 h-3 inline mr-1" /> Volver a opciones
                  </button>
                </div>
              ) : (
                <div className="space-y-4 relative z-10 w-full flex flex-col items-center">
                  <button data-testid="login-google-btn" onClick={login}
                    className="w-full bg-gradient-to-r from-white to-gray-100 hover:from-red-600 hover:to-zinc-700 hover:text-white text-black px-8 py-4 rounded-xl font-black tracking-widest text-lg transition-all hover:-translate-y-1 flex items-center justify-center gap-3 border border-white/40 shadow-[0_0_20px_rgba(255,255,255,0.15)] hover:shadow-[0_0_40px_rgba(220,38,38,0.4)] group">
                    <svg className="w-7 h-7 bg-white rounded-full p-1" viewBox="0 0 24 24">
                      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                    </svg>
                    {t('landing_login')}
                  </button>
                  <button onClick={() => setShowEmailLogin(true)} data-testid="show-email-login-btn"
                    className="w-full py-4 bg-secondary/50 backdrop-blur-md border border-white/10 rounded-xl font-semibold tracking-wide text-sm text-foreground hover:bg-secondary/80 hover:border-white/20 transition-all flex items-center justify-center gap-2 group">
                    <Mail className="w-5 h-5 text-muted-foreground group-hover:text-foreground transition-colors" />
                    Ingresar con Email
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// Import Dashboard component
import Dashboard from "./components/Dashboard";
import WMS from "./components/WMS";
import OperatorView from "./components/OperatorView";
import HomeDashboard from "./components/HomeDashboard";
import AutomationCenter from "./components/AutomationCenter";
import ActivityLogCenter from "./components/ActivityLogCenter";
import UserManagementCenter from "./components/UserManagementCenter";

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
      <Route path="/home" element={
        <ProtectedRoute>
          <HomeDashboard />
        </ProtectedRoute>
      } />
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
      <Route path="/automation-center" element={
        <AdminRoute>
          <AutomationCenter />
        </AdminRoute>
      } />
      <Route path="/activity-log" element={
        <AdminRoute>
          <ActivityLogCenter />
        </AdminRoute>
      } />
      <Route path="/users" element={
        <AdminRoute>
          <UserManagementCenter />
        </AdminRoute>
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
