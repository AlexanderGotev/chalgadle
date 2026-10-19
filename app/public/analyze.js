// Автоматично откриване на началото на откъса.
// Работи в браузъра (/admin) и в Node (за тестове).
//
// Идея:
//  1. Сила на звука във времето → къде песента наистина „влиза“ (след тихото интро).
//  2. Хармонично съдържание (хрома) → кои части се повтарят. Силна част, която се
//     повтаря, е почти винаги припевът.
//  3. Началото се избира в куплета преди първия припев, така че 16-те секунди да
//     свършат преди припева (там най-често се пее заглавието).
//  4. Точката се нагласява малко преди удар/начало на фраза, за да не започва по
//     средата на дума и за да има звук още в първите 0,1 сек.
(function (root) {
  'use strict';

  const SR = 11025;          // анализът върви на по-ниска честота — по-бързо, достатъчно точно
  const FRAME = 2048;        // ~186 мс прозорец
  const HOP = 1102;          // ~0,1 сек стъпка
  const HOP_S = HOP / SR;
  const BLOCK = 5;           // 5 стъпки = ~0,5 сек блок
  const BLOCK_S = HOP_S * BLOCK;
  const CLIP = 16;           // най-дългият откъс в играта

  // ---------- помощни ----------
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }

  function percentile(arr, p) {
    const s = Array.from(arr).filter(Number.isFinite).sort((a, b) => a - b);
    if (!s.length) return 0;
    return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
  }

  function smooth(arr, w) {
    const out = new Float32Array(arr.length);
    let sum = 0;
    const h = Math.floor(w / 2);
    for (let i = 0; i < arr.length + h; i++) {
      if (i < arr.length) sum += arr[i];
      if (i - w >= 0) sum -= arr[i - w];
      const c = i - h;
      if (c >= 0 && c < arr.length) out[c] = sum / Math.min(w, i + 1, arr.length - (i - w + 1));
    }
    return out;
  }

  // Смесва каналите и намалява честотата до SR
  function toMono(channels, sampleRate) {
    const len = channels[0].length;
    const ratio = sampleRate / SR;
    const outLen = Math.floor(len / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const a = Math.floor(i * ratio), b = Math.min(len, Math.floor((i + 1) * ratio));
      let s = 0;
      for (let c = 0; c < channels.length; c++) {
        const ch = channels[c];
        for (let k = a; k < b; k++) s += ch[k];
      }
      out[i] = s / ((b - a) * channels.length || 1);
    }
    return out;
  }

  // ---------- характеристики ----------
  function features(x) {
    const n = Math.max(0, Math.floor((x.length - FRAME) / HOP) + 1);
    const rms = new Float32Array(n);
    const flux = new Float32Array(n);
    const chroma = new Array(n);
    const win = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FRAME);

    // към кой тон (0–11) отива всеки честотен бин между 80 и 4000 Hz
    const binPc = new Int8Array(FRAME / 2).fill(-1);
    for (let k = 1; k < FRAME / 2; k++) {
      const f = k * SR / FRAME;
      if (f >= 80 && f <= 4000) binPc[k] = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12;
    }

    const re = new Float32Array(FRAME), im = new Float32Array(FRAME);
    let prevMag = new Float32Array(FRAME / 2);
    for (let f = 0; f < n; f++) {
      const off = f * HOP;
      let e = 0;
      for (let i = 0; i < FRAME; i++) { const v = x[off + i]; e += v * v; re[i] = v * win[i]; im[i] = 0; }
      rms[f] = Math.sqrt(e / FRAME);
      fft(re, im);
      const c = new Float32Array(12);
      const mag = new Float32Array(FRAME / 2);
      let fl = 0;
      for (let k = 1; k < FRAME / 2; k++) {
        const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        mag[k] = m;
        const lm = Math.log1p(m * 10), lp = Math.log1p(prevMag[k] * 10);
        if (lm > lp) fl += lm - lp;
        if (binPc[k] >= 0) c[binPc[k]] += m;
      }
      prevMag = mag;
      flux[f] = fl;
      chroma[f] = c;
    }
    return { n, rms, flux, chroma };
  }

  // ---------- анализ ----------
  function analyzeMono(x, debug) {
    const duration = x.length / SR;
    const F = features(x);
    const nb = Math.floor(F.n / BLOCK);
    if (nb < 40) return { start: 0, duration, entry: 0, choruses: [], reason: 'кратка песен' };

    // блокове от ~0,5 сек: средна сила и нормализиран хрома вектор
    const bRms = new Float32Array(nb);
    const bChroma = [];
    for (let b = 0; b < nb; b++) {
      const c = new Float32Array(12);
      let r = 0;
      for (let f = b * BLOCK; f < (b + 1) * BLOCK; f++) {
        r += F.rms[f];
        for (let k = 0; k < 12; k++) c[k] += F.chroma[f][k];
      }
      bRms[b] = r / BLOCK;
      const mx = Math.max(...c) || 1;
      for (let k = 0; k < 12; k++) c[k] /= mx;
      bChroma.push(c);
    }

    // „типична“ сила на звука в песента
    const loud = percentile(bRms, 0.6);
    const quiet = loud * 0.45;

    // къде песента влиза: първите ~3 сек поред над прага
    let entry = 0;
    for (let b = 0; b < nb - 6; b++) {
      let ok = true;
      for (let k = 0; k < 6; k++) if (bRms[b + k] < quiet) { ok = false; break; }
      if (ok) { entry = b; break; }
    }

    // прозорец от 4 блока (2 сек) → 48-мерен вектор, за по-сигурно сравнение.
    // Пазим и 12 транспонирани варианта: много песни сменят тоналността към края
    // (вдигат се с тон), а припевът пак трябва да се познае като повторение.
    const CTX = 4;
    const DIM = 12 * CTX;
    const norm = (v) => {
      let m = 0; for (let i = 0; i < v.length; i++) m += v[i]; m /= v.length;
      let s = 0; for (let i = 0; i < v.length; i++) { v[i] -= m; s += v[i] * v[i]; }
      s = Math.sqrt(s) || 1;
      for (let i = 0; i < v.length; i++) v[i] /= s;
      return v;
    };
    const vec = [];
    const vecT = [];                       // vecT[sh][b] = блок b, транспониран с sh полутона
    for (let sh = 0; sh < 12; sh++) vecT.push([]);
    for (let b = 0; b < nb; b++) {
      for (let sh = 0; sh < 12; sh++) {
        const v = new Float32Array(DIM);
        for (let j = 0; j < CTX; j++) {
          const src = bChroma[Math.min(nb - 1, b + j)];
          for (let k = 0; k < 12; k++) v[j * 12 + k] = src[(k + sh) % 12];
        }
        vecT[sh].push(norm(v));
      }
      vec.push(vecT[0][b]);
    }
    const dot = (va, vb) => { let s = 0; for (let i = 0; i < DIM; i++) s += va[i] * vb[i]; return s; };

    // повторение: за всеки блок — колко добре съвпада 8-секундна част с част поне 10 сек по-късно/по-рано
    const W = 16;                         // 8 сек
    const minLag = 20;                    // 10 сек
    const rep = new Float32Array(nb);
    const repLag = new Int32Array(nb);
    // Самата тоналност (sh = 0) се предпочита леко, за да не „намира“ повторения навсякъде.
    const d = new Float32Array(nb);
    for (let lag = minLag; lag < nb - W; lag++) {
      const len = nb - lag;
      const best = new Float32Array(len).fill(-1);
      for (let sh = 0; sh < 12; sh++) {
        const later = vecT[sh];
        for (let i = 0; i < len; i++) d[i] = dot(vec[i], later[i + lag]);
        const ds = smooth(d.subarray(0, len), W);
        const pen = sh === 0 ? 0 : 0.04;
        for (let i = 0; i < len; i++) if (ds[i] - pen > best[i]) best[i] = ds[i] - pen;
      }
      for (let i = 0; i < len; i++) {
        const v = best[i];
        if (v > rep[i]) { rep[i] = v; repLag[i] = lag; }
        if (v > rep[i + lag]) { rep[i + lag] = v; repLag[i + lag] = -lag; }
      }
    }

    // кандидат за припев = силно + повтаря се; повече тежест на силата
    const repHi = percentile(rep, 0.9), repLo = percentile(rep, 0.3);
    const rmsS = smooth(bRms, 8);
    const score = new Float32Array(nb);
    for (let b = 0; b < nb; b++) {
      const r = Math.max(0, Math.min(1, (rep[b] - repLo) / ((repHi - repLo) || 1)));
      const e = Math.max(0, Math.min(1.3, rmsS[b] / (loud || 1)));
      score[b] = r * 0.55 + e * 0.45;
    }
    const sc = smooth(score, 8);
    const thr = percentile(sc.slice(entry), 0.65);

    // участъци над прага, поне ~6 сек
    const choruses = [];
    for (let b = entry; b < nb;) {
      if (sc[b] >= thr) {
        let e = b;
        while (e < nb && sc[e] >= thr * 0.97) e++;
        if ((e - b) * BLOCK_S >= 6) choruses.push([b * BLOCK_S, e * BLOCK_S]);
        b = e;
      } else b++;
    }

    const entryS = entry * BLOCK_S;
    // първият припев трябва да е поне 8 сек след влизането (иначе е интро/куплет)
    const real = choruses.filter((c) => c[0] >= entryS + 8);
    const first = real[0];

    // Целта е първият куплет: ~22 сек след като песента влезе (там вече се пее,
    // но обикновено още не е припевът), и така, че 16-те сек да свършат преди
    // първия открит припев. Ограничението по време пази от погрешно открит
    // „първи припев“ далеч в песента.
    const PREFERRED = 22;
    let target, reason;
    const minStart = Math.max(entryS + 3, 6);
    const preferred = entryS + PREFERRED;
    const latest = first ? first[0] - CLIP - 0.5 : Infinity;   // 16-те сек свършват преди припева
    if (latest >= minStart) {
      target = Math.max(minStart, Math.min(preferred, latest));
      reason = latest < preferred ? 'куплет, преди първия припев' : 'първи куплет';
    } else if (real[1] && real[1][0] - CLIP - 0.5 >= first[1] + 2 && first[1] < entryS + 90) {
      target = Math.max(first[1] + 2, Math.min(first[1] + PREFERRED - 6, real[1][0] - CLIP - 0.5));
      reason = 'втори куплет (първият е кратък)';
    } else {
      target = minStart;
      reason = 'кратък куплет — точно след интрото';
    }
    target = Math.min(target, Math.max(0, duration - CLIP - 1));

    // да има звук още в началото: напред, докато блокът е достатъчно силен
    let tb = Math.floor(target / BLOCK_S);
    while (tb < nb - 4 && bRms[tb] < loud * 0.6) tb++;
    target = Math.max(target, tb * BLOCK_S);

    // нагласяне към удар/начало на фраза в [-1,5; +0,6] сек
    const fFrom = Math.max(0, Math.floor((target - 1.5) / HOP_S));
    const fTo = Math.min(F.n - 1, Math.ceil((target + 0.6) / HOP_S));
    const fluxThr = percentile(F.flux.slice(fFrom, fTo + 1), 0.5);
    let best = -1, bestV = -1;
    for (let f = fFrom; f <= fTo; f++) {
      const v = F.flux[f];
      const isPeak = v >= (F.flux[f - 1] || 0) && v >= (F.flux[f + 1] || 0) && v > fluxThr;
      // предпочитаме по-близо до целта
      const w = v / (1 + Math.abs(f * HOP_S - target) * 0.4);
      if (isPeak && w > bestV) { bestV = w; best = f; }
    }
    let start = best >= 0 ? best * HOP_S + FRAME / SR / 2 - 0.04 : target;
    start = Math.max(0, Math.round(start * 100) / 100);

    return {
      start,
      duration: Math.round(duration * 10) / 10,
      entry: Math.round(entryS * 10) / 10,
      choruses: choruses.map((c) => [Math.round(c[0] * 10) / 10, Math.round(c[1] * 10) / 10]),
      reason,
      _debug: debug ? { rep: Array.from(rep), sc: Array.from(sc), thr, rms: Array.from(bRms), loud } : undefined,
    };
  }

  // Браузър: AudioBuffer → резултат
  function analyzeBuffer(audioBuffer) {
    const ch = [];
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) ch.push(audioBuffer.getChannelData(c));
    return analyzeMono(toMono(ch, audioBuffer.sampleRate));
  }

  // Графика: максимуми на сигнала в `n` точки (0–1)
  function peaks(audioBuffer, n) {
    const d = audioBuffer.getChannelData(0);
    const d2 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : null;
    const step = Math.max(1, Math.floor(d.length / n));
    const out = new Float32Array(n);
    let mx = 0;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = i * step; k < Math.min(d.length, (i + 1) * step); k += 4) {
        const v = d2 ? (Math.abs(d[k]) + Math.abs(d2[k])) / 2 : Math.abs(d[k]);
        s += v * v;
      }
      out[i] = Math.sqrt(s / (step / 4));
      if (out[i] > mx) mx = out[i];
    }
    for (let i = 0; i < n; i++) out[i] /= mx || 1;
    return out;
  }

  const api = { analyzeMono, analyzeBuffer, toMono, peaks, SR, CLIP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SongAnalyzer = api;
})(typeof window !== 'undefined' ? window : globalThis);
