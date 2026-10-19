'use strict';
// Преглед на обложките в /admin: одобри, махни грешна или качи своя.
// Отделен файл, затворен във функция, за да не се бие с имената в admin.js.
(() => {
  const box = document.getElementById('coverList');
  const info = document.getElementById('coverInfo');
  const tabs = document.getElementById('coverTabs');
  const allBtn = document.getElementById('coverApproveAll');
  let show = 'review';
  let pending = [];   // id-тата в списъка „За преглед“, които още не са решени

  const escH = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SRC = { deezer: 'Deezer', itunes: 'iTunes', 'deezer-artist': 'снимка на изпълнителя', embedded: 'от файла', none: 'не е намерена', rejected: 'махната от теб' };

  async function call(method, url, body, type) {
    const opts = { method, headers: {} };
    if (body !== undefined) { opts.body = body; opts.headers['Content-Type'] = type || 'application/json'; }
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Грешка от сървъра');
    return data;
  }

  function card(it) {
    const img = it.has
      ? `<img src="/covers/${it.id}.jpg?v=${Date.now()}" alt="">`
      : `<div class="cv-empty">няма</div>`;
    const why = it.has
      ? `${escH(SRC[it.source] || it.source)} · намерено: <b>${escH(it.matched || '—')}</b>${it.score != null ? ` · ${Math.round(it.score * 100)}%` : ''}`
      : `${escH(SRC[it.source] || 'не е търсена')}${it.nearest ? ` · най-близко: ${escH(it.nearest)}` : ''}`;
    return `<div class="cv-card" data-id="${it.id}">
      <div class="cv-img">${img}</div>
      <div class="cv-text"><b>${escH(it.artist)} – ${escH(it.title)}</b><span class="muted small">${why}</span></div>
      <div class="cv-actions">
        ${it.has ? '<button class="btn sm" data-act="approve">✓ Добра</button><button class="btn sm danger" data-act="reject">✕ Грешна</button>' : ''}
        <label class="btn sm">Качи JPG<input type="file" accept="image/jpeg" data-act="upload" hidden></label>
      </div>
    </div>`;
  }

  async function load() {
    box.innerHTML = '<p class="muted">Зарежда…</p>';
    try {
      const d = await call('GET', '/api/admin/covers?show=' + show);
      info.textContent = show === 'review'
        ? `${d.items.length} за преглед — обложки, за които скриптът не е напълно сигурен.`
        : `${d.items.length} без обложка — в играта показват инициали. Можеш да им качиш картинка.`;
      box.innerHTML = d.items.length ? d.items.map(card).join('') : '<p class="muted">Няма нищо тук. 🎉</p>';
      pending = show === 'review' ? d.items.map((it) => it.id) : [];
      syncAllBtn();
    } catch (e) {
      box.innerHTML = `<p class="msg err">${escH(e.message)}</p>`;
    }
  }

  function syncAllBtn() {
    allBtn.hidden = !pending.length;
    allBtn.textContent = `✓ Одобри всички (${pending.length})`;
  }

  function done(cardEl, text) {
    pending = pending.filter((id) => String(id) !== cardEl.dataset.id);
    syncAllBtn();
    cardEl.classList.add('cv-done');
    cardEl.querySelector('.cv-actions').innerHTML = `<span class="muted small">${escH(text)}</span>`;
  }

  box.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const cardEl = b.closest('.cv-card');
    const id = cardEl.dataset.id;
    b.disabled = true;
    try {
      await call('POST', `/api/admin/covers/${id}/${b.dataset.act}`);
      done(cardEl, b.dataset.act === 'approve' ? 'Одобрена' : 'Махната — ще показва инициали');
      if (b.dataset.act === 'reject') cardEl.querySelector('.cv-img').innerHTML = '<div class="cv-empty">няма</div>';
    } catch (err) { alert(err.message); b.disabled = false; }
  });

  box.addEventListener('change', async (e) => {
    const input = e.target.closest('input[data-act="upload"]');
    if (!input || !input.files[0]) return;
    const cardEl = input.closest('.cv-card');
    const file = input.files[0];
    if (file.size > 1024 * 1024) { alert('Файлът е над 1 MB — намали го.'); return; }
    try {
      await call('PUT', `/api/admin/covers/${cardEl.dataset.id}`, file, 'image/jpeg');
      cardEl.querySelector('.cv-img').innerHTML = `<img src="/covers/${cardEl.dataset.id}.jpg?v=${Date.now()}" alt="">`;
      done(cardEl, 'Качена твоя обложка');
    } catch (err) { alert(err.message); }
  });

  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-show]');
    if (!b) return;
    show = b.dataset.show;
    tabs.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    load();
  });
  document.getElementById('coverReload').addEventListener('click', load);

  allBtn.addEventListener('click', async () => {
    if (!pending.length) return;
    if (!confirm(`Да одобря всички ${pending.length} обложки в списъка? Грешните първо махни с „✕ Грешна“.`)) return;
    allBtn.disabled = true;
    try {
      const ids = pending.slice();
      const r = await call('POST', '/api/admin/covers/approve', JSON.stringify({ ids }));
      for (const id of ids) {
        const cardEl = box.querySelector(`.cv-card[data-id="${id}"]`);
        if (cardEl) done(cardEl, 'Одобрена');
      }
      info.textContent = `Одобрени: ${r.approved}.`;
    } catch (err) { alert(err.message); }
    allBtn.disabled = false;
  });

  load();
})();
