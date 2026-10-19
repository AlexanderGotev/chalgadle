// Анализът върви във фонов поток, за да не „замръзва“ страницата
importScripts('analyze.js');
self.onmessage = (e) => {
  const { id, channels, sampleRate } = e.data;
  try {
    const r = SongAnalyzer.analyzeMono(SongAnalyzer.toMono(channels, sampleRate));
    self.postMessage({ id, result: r });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
