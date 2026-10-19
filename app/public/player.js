'use strict';
// Плейър с точна дължина на откъсите (Web Audio) + пауза/продължаване и местене (seek).
// „limit" е докъде е разрешено слушане (отключеното ниво). Може да се пуска/паузира
// и да се мести на произволна позиция, но само в [0, limit].

const Player = (() => {
  const CLIP = 16;
  let ctx = null;
  let master = null;      // обща сила на звука
  let vol = 1;

  let buf = null;         // текущият откъс (AudioBuffer)
  let src = null;         // активният източник
  let startedCtx = 0;     // ctx.currentTime при старта на текущия сегмент
  let segFrom = 0;        // позиция в буфера при старта на сегмента (сек)
  let paused = 0;         // последна позиция (сек), когато НЕ свири
  let limit = 0;          // докъде е разрешено (сек)
  let playing = false;
  let rafId = null;
  let fTick = null, fEnd = null;

  function getCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = vol;
      master.connect(ctx.destination);
    }
    return ctx;
  }
  function setVolume(v) { vol = Math.max(0, Math.min(1, Number(v) || 0)); if (master) master.gain.value = vol; }
  function getVolume() { return vol; }

  // Изрязва [from, from+len] в нов малък AudioBuffer
  function slice(buf, from, len) {
    const c = getCtx();
    const sr = buf.sampleRate;
    const a = Math.max(0, Math.floor(from * sr));
    const b = Math.min(buf.length, a + Math.ceil(len * sr));
    const out = c.createBuffer(buf.numberOfChannels, Math.max(1, b - a), sr);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) out.copyToChannel(buf.getChannelData(ch).subarray(a, b), ch);
    return out;
  }

  // Зарежда песента на рунда → { id, clip }. Аудиото се тегли по кода на рунда, а не по номера на песента.
  async function load(song, signal) {
    const res = await fetch('/audio/r/' + encodeURIComponent(song.round), { signal });
    if (!res.ok) throw new Error('http-' + res.status);
    const data = await res.arrayBuffer();
    const full = await getCtx().decodeAudioData(data);
    let start = Number(song.start) || 0;
    if (start > full.duration - 1) start = Math.max(0, full.duration - CLIP);
    return { id: song.round, clip: slice(full, start, CLIP + 0.3) };
  }

  function setClip(clip) { stopSrc(); buf = clip; paused = 0; playing = false; }
  function setLimit(sec) { limit = buf ? Math.min(sec, buf.duration) : sec; if (paused > limit) paused = limit; }
  function setCallbacks(onTick, onEnd) { fTick = onTick; fEnd = onEnd; }

  function position() {
    if (playing) return Math.min(segFrom + (getCtx().currentTime - startedCtx), limit);
    return paused;
  }

  function stopSrc() {
    if (src) { try { src.onended = null; src.stop(); } catch (e) { /* вече спрял */ } src = null; }
    cancelAnimationFrame(rafId);
  }

  function startSeg(from) {
    const c = getCtx(); c.resume();
    stopSrc();
    const dur = Math.max(0, limit - from);
    if (dur <= 0.005) { playing = false; paused = limit; fTick && fTick(limit); fEnd && fEnd(); return; }
    src = c.createBufferSource();
    const gain = c.createGain();
    src.buffer = buf;
    src.connect(gain).connect(master);
    const t0 = c.currentTime + 0.02;
    const fade = Math.min(0.012, dur / 4);
    gain.gain.setValueAtTime(1, t0);
    gain.gain.setValueAtTime(1, t0 + dur - fade);
    gain.gain.linearRampToValueAtTime(0, t0 + dur);
    segFrom = from; startedCtx = t0; playing = true;
    src.start(t0, from, dur);
    src.onended = () => {
      if (!playing || !src) return;
      playing = false; paused = limit; stopSrc();
      fTick && fTick(limit); fEnd && fEnd();
    };
    tick();
  }

  function tick() {
    if (!playing) return;
    fTick && fTick(position());
    rafId = requestAnimationFrame(tick);
  }

  // Пуска от позиция (по подразбиране — оттам, докъдето е паузирано; ако е в края — от 0)
  function play(from) {
    if (!buf) return;
    let start = (from == null) ? paused : from;
    if (start >= limit - 0.005) start = 0;
    startSeg(Math.max(0, Math.min(start, limit)));
  }
  function pause() {
    if (!playing) return;
    paused = position();
    playing = false;
    stopSrc();
    fTick && fTick(paused);
  }
  function toggle() { playing ? pause() : play(); }

  // Мести на позиция (в [0, limit]); ако свири — продължава оттам, иначе само мести маркера
  function seek(to) {
    const t = Math.max(0, Math.min(to, limit));
    if (playing) startSeg(t);
    else { paused = t; fTick && fTick(t); }
  }

  function stop(reset) { stopSrc(); playing = false; if (reset) paused = 0; }

  const isPlaying = () => playing;
  return { load, setClip, setLimit, setCallbacks, play, pause, toggle, seek, position, stop, isPlaying, getCtx, setVolume, getVolume, CLIP };
})();
