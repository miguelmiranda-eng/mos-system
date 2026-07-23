import React, { createContext, useContext, useState, useEffect } from 'react';

const ThemeContext = createContext();

export const ThemeProvider = ({ children }) => {
  const [theme, setTheme] = useState(() => {
    // Support both keys for backwards compatibility.
    // Default CLARO (rediseño minimalista 2026-07): quien ya eligió tema
    // conserva su preferencia guardada; solo cambia el arranque en frío.
    return localStorage.getItem('mos_theme') || localStorage.getItem('theme') || 'light';
  });

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark', 'light-theme');
    root.classList.add(theme);
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
