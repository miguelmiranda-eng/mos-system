// Sonido de notificación (menciones). WebAudio, sin archivos: campanita de 3
// tonos ascendentes, repetida, a volumen alto y con compresor para que se
// escuche en el piso. Los navegadores bloquean el audio hasta que la persona
// interactúa con la página: el contexto se "desbloquea" con el primer clic o
// tecla, y desde ahí suena aunque la pestaña esté en segundo plano.

const KEY = 'mos_notif_sound';           // 'off' = silenciado
const NOTES = [880, 1175, 1568];         // A5 · D6 · G6
const REPEAT = 2;

let ctx = null;
const getCtx = () => {
  if (ctx) return ctx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  ctx = new Ctx();
  return ctx;
};

const unlock = () => {
  const c = getCtx();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
};
if (typeof window !== 'undefined') {
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) =>
    window.addEventListener(ev, unlock, { passive: true }));
}

export const isNotifySoundOn = () => {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
};
export const setNotifySoundOn = (on) => {
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* sin storage */ }
};

export const playNotifySound = ({ force = false } = {}) => {
  if (!force && !isNotifySoundOn()) return;
  try {
    const c = getCtx();
    if (!c) return;
    if (c.state === 'suspended') c.resume().catch(() => {});
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.ratio.value = 4;
    const master = c.createGain();
    master.gain.value = 0.9;
    master.connect(comp);
    comp.connect(c.destination);
    let at = c.currentTime + 0.02;
    for (let r = 0; r < REPEAT; r += 1) {
      NOTES.forEach((hz) => {
        // Dos osciladores (fundamental + octava suave) para un timbre de campana.
        [[hz, 'triangle', 1], [hz * 2, 'sine', 0.35]].forEach(([f, type, level]) => {
          const osc = c.createOscillator();
          const g = c.createGain();
          osc.type = type;
          osc.frequency.value = f;
          g.gain.setValueAtTime(0.0001, at);
          g.gain.exponentialRampToValueAtTime(level, at + 0.01);
          g.gain.exponentialRampToValueAtTime(0.0001, at + 0.32);
          osc.connect(g);
          g.connect(master);
          osc.start(at);
          osc.stop(at + 0.34);
        });
        at += 0.16;
      });
      at += 0.25;
    }
  } catch { /* sin audio no pasa nada */ }
  try { if (navigator.vibrate) navigator.vibrate([150, 80, 150]); } catch { /* idem */ }
};
