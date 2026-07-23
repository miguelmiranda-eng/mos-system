import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';

const ThemeSwitch = () => {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  return (
    <button
      onClick={toggleTheme}
      className={`relative w-20 h-10 rounded-full p-1 transition-all duration-500 ease-in-out backdrop-blur-md border ${
        isDark 
          ? 'bg-black/40 border-white/10 shadow-[inner_0_2px_4px_rgba(0,0,0,0.4)]' 
          : 'bg-emerald-500/10 border-emerald-500/20 shadow-[inner_0_2px_4px_rgba(0,0,0,0.05)]'
      } group hover:scale-105 active:scale-95`}
    >
      <div className={`absolute inset-0 rounded-full overflow-hidden`}>
        <div className={`absolute inset-0 bg-gradient-to-tr from-emerald-500/20 to-transparent transition-opacity duration-500 ${isDark ? 'opacity-0' : 'opacity-100'}`} />
      </div>
      
      <div
        className={`relative w-8 h-8 rounded-full flex items-center justify-center transition-all duration-500 transform ${
          isDark 
            ? 'translate-x-10 bg-gradient-to-br from-zinc-700 to-zinc-900 shadow-[0_0_15px_rgba(0,0,0,0.5)]' 
            : 'translate-x-0 bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-[0_0_15px_rgba(16,185,129,0.4)]'
        }`}
      >
        {isDark ? (
          <Moon className="w-4 h-4 text-emerald-400 animate-pulse" />
        ) : (
          <Sun className="w-4 h-4 text-white animate-spin-slow" />
        )}
      </div>
      
      <span className={`absolute ${isDark ? 'left-3' : 'right-3'} top-1/2 -translate-y-1/2 text-[9px] font-black uppercase tracking-widest transition-all duration-500 ${
        isDark ? 'text-white/20' : 'text-emerald-700/40'
      }`}>
        {isDark ? 'Dark' : 'Light'}
      </span>
    </button>
  );
};

export default ThemeSwitch;
