import React, { createContext, useContext, useState, useEffect } from 'react';

const ThemeContext = createContext();

/* Temas (aclarado por el usuario 2026-07-23):
   · CRM: conserva su switch claro/oscuro — este contexto vuelve a ser
     funcional. El oscuro global es la paleta azulada (index.css .dark);
     el claro es la paleta zinc de siempre (:root).
   · WMS: NO tiene switch y NO obedece este contexto — su raíz lleva la clase
     `dark` fija (WMS.js), así siempre pinta el tema azulado con detalles
     claros aunque el CRM esté en claro. */
export const ThemeProvider = ({ children }) => {
  const [theme, setTheme] = useState(() => {
    // Support both keys for backwards compatibility
    return localStorage.getItem('mos_theme') || localStorage.getItem('theme') || 'dark';
  });

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark', 'light-theme');
    // WMS/PDA clavados en azulado: la clase en <html> también gobierna los
    // portales (modales al body, popovers Radix) que se salen de la raíz del
    // WMS. La PREFERENCIA guardada no se pisa — al volver al CRM se respeta.
    const forzado = /^\/(wms|pda)/.test(window.location.pathname);
    root.classList.add(forzado ? 'dark' : theme);
    // Keep both keys in sync for any legacy components
    localStorage.setItem('mos_theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => (prev === 'dark' ? 'light' : 'dark'));
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within a ThemeProvider');
  return context;
};
