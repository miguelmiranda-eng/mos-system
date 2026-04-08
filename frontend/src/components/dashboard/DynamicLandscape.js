import React from 'react';

const DynamicLandscape = ({ timeOfDay }) => {
  const isMorning = timeOfDay === 'morning';
  const isAfternoon = timeOfDay === 'afternoon';
  const isNight = timeOfDay === 'night';

  const skyGradients = {
    morning: 'linear-gradient(to bottom, #FF9A8B, #FFBBBB)',
    afternoon: 'linear-gradient(to bottom, #f37335, #fdc830)',
    night: 'linear-gradient(to bottom, #0f2027, #2c5364)'
  };

  const mountainColors = {
    morning: ['#7c2d12', '#9a3412', '#c2410c'],
    afternoon: ['#431407', '#7c2d12', '#9a3412'],
    night: ['#020617', '#0f172a', '#1e293b']
  };

  const colors = mountainColors[timeOfDay] || mountainColors.night;

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none select-none z-0">
      {/* Background Sky */}
      <div 
        className="absolute inset-0 transition-opacity duration-1000"
        style={{ background: skyGradients[timeOfDay] }}
      />

      {/* Celestial Body (Sun/Moon) */}
      <div className={`absolute transition-all duration-[3000ms] ease-in-out ${
        isMorning ? 'left-[15%] bottom-[8%] scale-100 opacity-100 animate-pulse-slow' :
        isAfternoon ? 'right-[20%] bottom-[4%] scale-110 opacity-100' :
        'right-[15%] top-[15%] scale-90 opacity-100'
      } z-[5]`}>
        {isNight ? (
          /* Moon */
          <div className="relative">
            <div className="w-16 h-16 rounded-full bg-[#f1f5f9] shadow-[0_0_60px_rgba(255,255,255,0.3)] overflow-hidden">
               <div className="absolute top-2 left-4 w-3 h-3 rounded-full bg-slate-300 opacity-20"></div>
               <div className="absolute top-8 left-2 w-4 h-4 rounded-full bg-slate-300 opacity-20"></div>
            </div>
          </div>
        ) : (
          /* Sun */
          <div className={`w-36 h-36 rounded-full blur-2xl blur-3xl absolute -inset-6 opacity-40 bg-white`}></div>
        )}
        {!isNight && (
          <div className={`w-24 h-24 rounded-full shadow-[0_0_100px_rgba(255,255,255,0.8)] relative z-10 ${
            isMorning ? 'bg-[#ffedd5] shadow-orange-200/40' : 'bg-[#fff7ed] shadow-yellow-100/40'
          }`}>
            <div className="w-full h-full rounded-full animate-pulse-slow"></div>
          </div>
        )}
      </div>

      {/* Cloud Layer (Moving) */}
      <div className="absolute inset-0 opacity-10 z-[15]">
        <div className="absolute top-[20%] left-[-10%] w-32 h-12 bg-white rounded-full blur-2xl animate-float-slow"></div>
        <div className="absolute top-[40%] right-[-5%] w-48 h-16 bg-white rounded-full blur-[40px] animate-float-slower"></div>
      </div>

      {/* Mountains Layers (Minimalist Silhouettes with Gradients) */}
      <svg className="absolute bottom-0 w-full h-[90%] preserve-3d z-[10]" viewBox="0 0 1000 400" preserveAspectRatio="none">
        <defs>
          <linearGradient id="mnt-back" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={colors[2]} stopOpacity="0.4" />
            <stop offset="100%" stopColor={colors[2]} stopOpacity="0.8" />
          </linearGradient>
          <linearGradient id="mnt-mid" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={colors[1]} stopOpacity="0.7" />
            <stop offset="100%" stopColor={colors[1]} stopOpacity="0.9" />
          </linearGradient>
          <linearGradient id="mnt-front" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={colors[0]} stopOpacity="1" />
            <stop offset="100%" stopColor={colors[0]} stopOpacity="1" />
          </linearGradient>
        </defs>

        {/* Back Mountains */}
        <path 
          d="M0,400 L0,250 L150,100 L350,220 L550,80 L800,280 L1000,180 L1000,400 Z" 
          fill="url(#mnt-back)" 
          className="transition-all duration-1000"
        />
        {/* Mid Mountains */}
        <path 
          d="M0,400 L0,300 L250,180 L450,280 L650,150 L850,320 L1000,240 L1000,400 Z" 
          fill="url(#mnt-mid)" 
          className="transition-all duration-1000"
        />
        {/* Front Mountains */}
        <path 
          d="M0,400 L0,350 L200,260 L400,350 L600,220 L800,350 L1000,320 L1000,400 Z" 
          fill="url(#mnt-front)" 
          className="transition-all duration-1000"
        />
      </svg>

      {/* Atmospheric Mist/Shadow Overlay (Softer) */}
      <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/40 via-black/10 to-transparent pointer-events-none z-[12]"></div>
      <div className="absolute inset-0 backdrop-blur-[1px] pointer-events-none z-[2]"></div>
    </div>
  );
};

export default DynamicLandscape;
