import React from 'react';

/**
 * Premium BallNumber component for high-level metrics.
 * Features a gradient background and subtle animation.
 */
const BallNumber = ({ value }) => {
  return (
    <div className="flex flex-col items-center justify-center p-10 bg-gradient-to-br from-indigo-600 via-blue-600 to-cyan-500 text-white rounded-3xl shadow-2xl transform transition-all hover:scale-105 duration-300">
      <h3 className="text-sm font-semibold opacity-70 uppercase tracking-widest mb-2">Proyección a 3-5 Semanas</h3>
      <div className="relative">
        <span className="text-7xl font-black tracking-tighter drop-shadow-lg">{value}</span>
        <div className="absolute -top-2 -right-4 w-4 h-4 bg-green-400 rounded-full animate-ping"></div>
      </div>
      <p className="text-xs mt-6 font-medium opacity-50 bg-white/10 px-4 py-1 rounded-full backdrop-blur-sm">
        Basado en el histórico de producción
      </p>
    </div>
  );
};

export default BallNumber;
