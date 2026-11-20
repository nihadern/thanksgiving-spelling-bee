(() => {
  'use strict';

  const BUILTIN = Array.isArray(window.SPELLING_WORDS) ? window.SPELLING_WORDS : [];
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const LEVELS = ['easy', 'medium', 'hard'];
  const FILTERS = ['all'].concat(LEVELS);
  const SOURCES = ['all', 'builtin', 'mine'];

  /* ---------- storage (always guarded) ---------- */
  const KEY = 'tg-spelling-bee.';
  const storageOk = (() => {
    try { localStorage.setItem(KEY + 'probe', '1'); localStorage.removeItem(KEY + 'probe'); return true; } catch (e) { return false; }
  })();
  const store = {
    get(k, d) {
      try { const v = localStorage.getItem(KEY + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set(k, v) {
      try { localStorage.setItem(KEY + k, JSON.stringify(v)); return true; } catch (e) { return false; }
    }
  };
  // A "session" is one browser tab session: a fresh shuffle happens once per session.
  const newSession = (() => {
    try {
      if (sessionStorage.getItem(KEY + 'session')) return false;
      sessionStorage.setItem(KEY + 'session', '1');
      return true;
    } catch (e) { return true; }
  })();

  const MIN_DUR = 5, MAX_DUR = 300;
  const clampDur = (n) => Math.max(MIN_DUR, Math.min(MAX_DUR, Math.round(Number(n) || 30)));
  const pick = (v, list, d) => (list.includes(v) ? v : d);

  /* ---------- custom words ---------- */
  const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
  function normalizeWord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const word = clean(raw.word, 40);
    if (!word) return null;
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 40) : newId(),
      word,
      definition: clean(raw.definition, 240),
      sentence: clean(raw.sentence, 240),
      level: pick(String(raw.level || '').toLowerCase(), LEVELS, 'medium')
    };
  }
  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function loadMine() {
    const arr = store.get('mywords', []);
    if (!Array.isArray(arr)) return [];
    const out = [];
    const seen = new Set();
    for (const r of arr) {
      const w = normalizeWord(r);
      if (w && !seen.has(w.word.toLowerCase())) { seen.add(w.word.toLowerCase()); out.push(w); }
    }
    return out;
  }

  const state = {
    duration: clampDur(store.get('duration', 30)),
    filter: pick(store.get('filter', 'all'), FILTERS, 'all'),
    source: pick(store.get('source', 'all'), SOURCES, 'all'),
    hideMode: !!store.get('hideMode', false),
    spellOut: !!store.get('spellOut', false),
    autoAdvance: !!store.get('autoAdvance', false),
    sound: !!store.get('sound', false),
    shuffleMode: store.get('shuffleMode', 'on') === 'off' ? 'off' : 'on',
    order: store.get('order', null),
    currentKey: store.get('currentKey', null),
    mine: loadMine(),
    deck: [],
    pos: 0,
    revealed: false,
    status: 'idle', // idle | running | paused | done
    remaining: 0,
    endAt: 0,
    raf: 0,
    timesUpTimer: 0,
    editingId: null
  };
  state.remaining = state.duration;
  if (!Array.isArray(state.order)) state.order = null;

  function save() {
    store.set('duration', state.duration);
    store.set('filter', state.filter);
    store.set('source', state.source);
    store.set('hideMode', state.hideMode);
    store.set('spellOut', state.spellOut);
    store.set('autoAdvance', state.autoAdvance);
    store.set('sound', state.sound);
    store.set('shuffleMode', state.shuffleMode);
    store.set('order', state.order);
    const w = state.deck[state.pos];
    store.set('currentKey', w ? w.key : null);
  }
  function saveMine() {
    const ok = store.set('mywords', state.mine);
    if (!ok && storageOk) toast("Couldn't save. Storage may be full.");
    return ok;
  }

  /* ---------- deck ---------- */
  function allEntries() {
    const out = [];
    if (state.source !== 'mine') {
      BUILTIN.forEach((w) => out.push({ key: 'b:' + w.word, word: w.word, definition: w.definition || '', sentence: w.sentence || '', level: w.level, custom: false }));
    }
    if (state.source !== 'builtin') {
      state.mine.forEach((w) => out.push({ key: 'm:' + w.id, word: w.word, definition: w.definition, sentence: w.sentence, level: w.level, custom: true }));
    }
    return out;
  }
  function allKeys() {
    return BUILTIN.map((w) => 'b:' + w.word).concat(state.mine.map((w) => 'm:' + w.id));
  }
  function shuffledKeys() {
    const all = allKeys();
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    return all;
  }
  function buildDeck(keepKey) {
    let list = allEntries().filter((w) => state.filter === 'all' || w.level === state.filter);
    if (state.order && state.order.length) {
      const rank = new Map(state.order.map((k, i) => [k, i]));
      const r = (w) => (rank.has(w.key) ? rank.get(w.key) : 1e6);
      list = list.slice().sort((a, b) => r(a) - r(b));
    }
    state.deck = list;
    const idx = keepKey ? list.findIndex((w) => w.key === keepKey) : -1;
    state.pos = idx >= 0 ? idx : Math.min(state.pos, Math.max(0, list.length - 1));
    if (!keepKey || idx < 0) { if (!keepKey) state.pos = 0; }
  }

  /* ---------- elements ---------- */
  const el = {
    stage: $('#stage'), word: $('#word'), wrap: $('#wordWrap'), def: $('#def'), sent: $('#sent'),
    cards: $('#cards'), defCard: $('#defCard'), sentCard: $('#sentCard'),
    chip: $('#chip'), badge: $('#mineBadge'), count: $('#count'),
    timer: $('#timer'), ring: $('#ringProg'), num: $('#timeNum'), label: $('#timeLabel'),
    play: $('#playBtn'), playIcon: $('#playIcon'),
    timesup: $('#timesup'), toast: $('#toast'), panel: $('#panel'), panelBtn: $('#panelBtn'),
    durVal: $('#durVal'), canvas: $('#confetti'), bg: $('#bg'), garland: $('#garland'),
    mwForm: $('#mwForm'), mwWord: $('#mwWord'), mwLevel: $('#mwLevel'), mwDef: $('#mwDef'), mwSent: $('#mwSent'),
    mwSubmit: $('#mwSubmit'), mwCancel: $('#mwCancel'), mwList: $('#mwList'), mwEmpty: $('#mwEmpty'),
    mineCount: $('#mineCount'), bulkText: $('#bulkText'), mwFile: $('#mwFile'),
    mwConfirm: $('#mwConfirm'), mwConfirmText: $('#mwConfirmText'), storageNote: $('#storageNote')
  };
  const RING_C = 2 * Math.PI * 52;
  el.ring.style.strokeDasharray = RING_C.toFixed(2);

  /* ---------- turkey mascot (static markup, no user data) ---------- */
  const FEATHERS = [[-72, '#ff4f9a'], [-48, '#ff8a2b'], [-24, '#ffc23d'], [0, '#e0245e'], [24, '#ffc23d'], [48, '#ff8a2b'], [72, '#ff4f9a']];
  const TURKEY = '<svg viewBox="-34 -6 268 212" aria-hidden="true">' +
    '<g class="tail">' + FEATHERS.map(([a, c]) =>
      '<g transform="rotate(' + a + ' 100 135)"><ellipse cx="100" cy="62" rx="19" ry="56" fill="' + c + '" stroke="#3a0b4a" stroke-width="4"/>' +
      '<ellipse cx="100" cy="46" rx="7" ry="26" fill="#fff" opacity=".35"/></g>').join('') + '</g>' +
    '<path d="M86 180v13M79 194h14M114 180v13M107 194h14" stroke="#ff8a2b" stroke-width="6" stroke-linecap="round"/>' +
    '<ellipse cx="100" cy="140" rx="50" ry="46" fill="#8b4a2b" stroke="#3a0b4a" stroke-width="5"/>' +
    '<ellipse cx="100" cy="153" rx="30" ry="25" fill="#c27b45"/>' +
    '<ellipse cx="57" cy="142" rx="13" ry="24" fill="#74391f" stroke="#3a0b4a" stroke-width="4" transform="rotate(18 57 142)"/>' +
    '<ellipse cx="143" cy="142" rx="13" ry="24" fill="#74391f" stroke="#3a0b4a" stroke-width="4" transform="rotate(-18 143 142)"/>' +
    '<ellipse cx="82" cy="122" rx="12" ry="7" fill="#fff" opacity=".22"/>' +
    '<circle cx="100" cy="86" r="32" fill="#a35a35" stroke="#3a0b4a" stroke-width="5"/>' +
    '<ellipse cx="87" cy="70" rx="10" ry="6" fill="#fff" opacity=".3"/>' +
    '<circle cx="88" cy="84" r="9" fill="#fff"/><circle cx="112" cy="84" r="9" fill="#fff"/>' +
    '<circle cx="89" cy="86" r="5.5" fill="#2a0a33"/><circle cx="113" cy="86" r="5.5" fill="#2a0a33"/>' +
    '<circle cx="91" cy="83" r="2" fill="#fff"/><circle cx="115" cy="83" r="2" fill="#fff"/>' +
    '<ellipse cx="77" cy="98" rx="7" ry="4.5" fill="#ff7ab8"/><ellipse cx="123" cy="98" rx="7" ry="4.5" fill="#ff7ab8"/>' +
    '<path d="M90 96Q100 90 110 96 100 112 90 96z" fill="#ffc23d" stroke="#3a0b4a" stroke-width="3" stroke-linejoin="round"/>' +
    '<path d="M104 102q10 4 6 18-8 5-10-6z" fill="#e0245e" stroke="#3a0b4a" stroke-width="3" stroke-linejoin="round"/>' +
    '<g transform="translate(100 55)"><path d="M0 0-22-12q-5 12 0 24z" fill="#ff4f9a" stroke="#3a0b4a" stroke-width="3.5" stroke-linejoin="round"/>' +
    '<path d="M0 0 22-12q5 12 0 24z" fill="#ff4f9a" stroke="#3a0b4a" stroke-width="3.5" stroke-linejoin="round"/>' +
    '<circle r="6" fill="#ff9ccf" stroke="#3a0b4a" stroke-width="3.5"/></g>' +
    '</svg>';
  $$('.mascot').forEach((m) => { m.innerHTML = TURKEY; });
  function mascots(cls) {
    if (reduceMotion) return;
    $$('.brand-mascot, .peek-turkey').forEach((m) => restartAnim(m, cls, ['hop', 'party']));
  }

  /* ---------- rendering ---------- */
  const isHidden = () => state.hideMode && !state.revealed;

  function letterSpans(text) {
    const frag = document.createDocumentFragment();
    Array.from(text).forEach((ch, i) => {
      const s = document.createElement('span');
      s.className = 'ltr';
      s.style.setProperty('--i', i);
      s.textContent = ch === ' ' ? ' ' : ch;
      frag.appendChild(s);
    });
    return frag;
  }

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function fillText(target, text, word, mask) {
    target.textContent = '';
    const span = document.createElement('span');
    let re = null;
    if (mask && word) {
      try { re = new RegExp('(^|[^\\p{L}\\p{N}])(' + escapeRe(word) + "(?:s|es|ed|ing|'s)?)(?=$|[^\\p{L}\\p{N}])", 'giu'); } catch (e) { re = null; }
    }
    if (!re) {
      span.textContent = text;
    } else {
      let last = 0, m;
      while ((m = re.exec(text))) {
        const start = m.index + m[1].length;
        span.appendChild(document.createTextNode(text.slice(last, start)));
        const b = document.createElement('span');
        b.className = 'blank';
        b.textContent = '_____';
        span.appendChild(b);
        last = start + m[2].length;
        if (m[0].length === 0) re.lastIndex++;
      }
      span.appendChild(document.createTextNode(text.slice(last)));
    }
    target.appendChild(span);
  }

  function restartAnim(node, cls, removeAlso) {
    (removeAlso || [cls]).forEach((c) => node.classList.remove(c));
    void node.offsetWidth; // reflow so the animation replays
    node.classList.add(cls);
  }

  let hintEl = null;
  function render(opts = {}) {
    const w = state.deck[state.pos];
    el.word.textContent = '';
    el.word.className = 'word';
    if (!w) {
      const empty = state.source === 'mine' ? 'No words yet' : 'No words';
      el.word.appendChild(letterSpans(empty));
      el.word.classList.add('pop');
      el.chip.hidden = true;
      el.badge.hidden = true;
      el.count.textContent = '0 / 0';
      el.stage.classList.remove('no-cards');
      el.cards.classList.add('one');
      el.defCard.hidden = false;
      el.sentCard.hidden = true;
      fillText(el.def, state.source === 'mine'
        ? 'Open settings, then the My words tab, to add your own words.'
        : 'No words match this filter. Try All in settings.', '', false);
      if (hintEl && hintEl.parentNode) hintEl.remove();
      fitAll();
      save();
      return;
    }
    el.chip.hidden = false;
    const hidden = isHidden();
    if (hidden) {
      el.word.appendChild(letterSpans('???'));
      el.word.classList.add('hidden-word');
    } else {
      el.word.appendChild(letterSpans(w.word));
    }
    el.word.setAttribute('aria-label', hidden ? 'Hidden word' : w.word);
    if (!opts.noAnim) {
      if (!hidden && state.spellOut) restartAnim(el.word, 'spell');
      else restartAnim(el.word, 'pop');
    }

    if (hidden) {
      if (!hintEl) { hintEl = document.createElement('div'); hintEl.className = 'hint'; }
      hintEl.textContent = 'Press R to reveal the word';
      el.wrap.appendChild(hintEl);
    } else if (hintEl && hintEl.parentNode) {
      hintEl.remove();
    }

    el.chip.className = 'chip ' + w.level;
    el.chip.textContent = w.level;
    el.badge.hidden = !w.custom;
    el.count.textContent = (state.pos + 1) + ' / ' + state.deck.length;

    const hasDef = !!w.definition, hasSent = !!w.sentence;
    el.defCard.hidden = !hasDef;
    el.sentCard.hidden = !hasSent;
    el.cards.classList.toggle('one', hasDef !== hasSent);
    el.stage.classList.toggle('no-cards', !hasDef && !hasSent);
    fillText(el.def, w.definition, w.word, hidden);
    fillText(el.sent, w.sentence, w.word, hidden);
    if (!opts.noAnim) { restartAnim(el.def, 'fade'); restartAnim(el.sent, 'fade'); }

    fitAll();
    save();
  }

  /* ---------- fitting text ---------- */
  function fitWord() {
    const box = el.wrap;
    const availW = box.clientWidth * 0.97;
    const availH = box.clientHeight;
    if (!availW || !availH) return;
    let size = Math.min(availH * 0.82, availW * 0.42);
    el.word.style.fontSize = size + 'px';
    const w = el.word.scrollWidth;
    if (w > availW) {
      size = size * availW / w;
      el.word.style.fontSize = size + 'px';
    }
  }

  function fitCard(p) {
    p.style.fontSize = '';
    if (p.closest('[hidden]') || el.stage.classList.contains('no-cards')) return;
    const inner = p.firstElementChild;
    if (!inner) return;
    let size = parseFloat(getComputedStyle(p).fontSize);
    let guard = 0;
    while (inner.scrollHeight > p.clientHeight && size > 12 && guard < 40) {
      size *= 0.93;
      p.style.fontSize = size + 'px';
      guard++;
    }
  }

  function fitAll() {
    fitWord();
    fitCard(el.def);
    fitCard(el.sent);
  }

  /* ---------- timer ---------- */
  function updateTimerUI() {
    const rem = Math.max(0, state.remaining);
    const frac = state.duration ? rem / state.duration : 0;
    el.ring.style.strokeDashoffset = (RING_C * (1 - Math.min(1, frac))).toFixed(2);
    el.num.textContent = String(Math.ceil(rem - 1e-6));
    let zone = 'ok';
    if (frac <= 0.25) zone = 'low';
    else if (frac <= 0.5) zone = 'warn';
    el.timer.classList.remove('ok', 'warn', 'low');
    el.timer.classList.add(zone);
    el.timer.classList.toggle('crit', state.status === 'running' && rem <= 5 && rem > 0);
    el.label.textContent = { idle: 'ready', running: 'seconds', paused: 'paused', done: "time's up" }[state.status];
    const running = state.status === 'running';
    el.playIcon.setAttribute('href', running ? '#i-pause' : '#i-play');
    el.play.setAttribute('aria-label', running ? 'Pause timer' : 'Start timer');
    el.durVal.textContent = state.duration + ' s';
    $$('#presets button').forEach((b) => b.classList.toggle('on', Number(b.dataset.preset) === state.duration));
  }

  function tick() {
    if (state.status !== 'running') return;
    state.remaining = (state.endAt - performance.now()) / 1000;
    if (state.remaining <= 0) {
      state.remaining = 0;
      timeUp();
      return;
    }
    updateTimerUI();
    state.raf = requestAnimationFrame(tick);
  }

  function startTimer() {
    if (state.status === 'done' || state.remaining <= 0) state.remaining = state.duration;
    hideTimesUp();
    state.status = 'running';
    state.endAt = performance.now() + state.remaining * 1000;
    cancelAnimationFrame(state.raf);
    state.raf = requestAnimationFrame(tick);
    updateTimerUI();
  }

  function pauseTimer() {
    if (state.status !== 'running') return;
    state.remaining = Math.max(0, (state.endAt - performance.now()) / 1000);
    state.status = 'paused';
    cancelAnimationFrame(state.raf);
    updateTimerUI();
  }

  function toggleTimer() {
    if (state.status === 'running') pauseTimer();
    else startTimer();
  }

  function resetTimer() {
    cancelAnimationFrame(state.raf);
    clearTimeout(state.timesUpTimer);
    hideTimesUp();
    state.status = 'idle';
    state.remaining = state.duration;
    updateTimerUI();
  }

  function setDuration(n, announce) {
    const old = state.duration;
    state.duration = clampDur(n);
    const delta = state.duration - old;
    if (state.status === 'idle' || state.status === 'done') {
      state.status = 'idle';
      hideTimesUp();
      state.remaining = state.duration;
    } else if (state.status === 'running') {
      state.remaining = Math.max(0.5, (state.endAt - performance.now()) / 1000 + delta);
      state.endAt = performance.now() + state.remaining * 1000;
    } else {
      state.remaining = Math.max(0.5, state.remaining + delta);
    }
    updateTimerUI();
    save();
    if (announce) toast('Timer: ' + state.duration + ' seconds');
  }

  function timeUp() {
    cancelAnimationFrame(state.raf);
    state.status = 'done';
    updateTimerUI();
    el.timesup.hidden = false;
    burst({ count: 170, spread: 'full' });
    if (state.sound) playChime();
    clearTimeout(state.timesUpTimer);
    state.timesUpTimer = setTimeout(() => {
      hideTimesUp();
      if (state.autoAdvance) go(1);
    }, 3200);
  }

  function hideTimesUp() { el.timesup.hidden = true; }

  /* optional sound, off by default; only created when the user turned it on */
  let audioCtx = null;
  function playChime() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      [880, 1108.73, 1318.51, 1760].forEach((f, i) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = 'triangle';
        o.frequency.value = f;
        const t = audioCtx.currentTime + i * 0.12;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        o.connect(g).connect(audioCtx.destination);
        o.start(t);
        o.stop(t + 0.4);
      });
    } catch (e) { /* no audio, no problem */ }
  }

  /* ---------- navigation ---------- */
  function go(step) {
    if (!state.deck.length) { render(); return; }
    state.pos = (state.pos + step + state.deck.length) % state.deck.length;
    state.revealed = false;
    resetTimer();
    render();
    if (step !== 0) mascots('hop');
    if (step > 0) burst({ count: 70 });
  }

  function reveal() {
    if (!state.deck.length) return;
    if (isHidden()) {
      state.revealed = true;
      render();
      burst({ count: 150 });
      mascots('party');
      return;
    }
    restartAnim(el.word, 'spell', ['spell', 'pop']);
    burst({ count: 60 });
    mascots('party');
  }

  function shuffle(quiet) {
    state.order = shuffledKeys();
    state.shuffleMode = 'on';
    buildDeck(null);
    state.revealed = false;
    resetTimer();
    render();
    if (!quiet) { burst({ count: 90 }); mascots('party'); toast('Shuffled!'); }
  }

  function inOrder() {
    state.order = null;
    state.shuffleMode = 'off';
    buildDeck(null);
    state.revealed = false;
    resetTimer();
    render();
    toast('Back in order');
  }

  function setFilter(f) {
    if (!FILTERS.includes(f)) return;
    state.filter = f;
    buildDeck(null);
    state.revealed = false;
    resetTimer();
    render();
    syncPanel();
    toast(f === 'all' ? 'All difficulties' : f.charAt(0).toUpperCase() + f.slice(1) + ' words only');
  }

  function setSource(s) {
    if (!SOURCES.includes(s)) return;
    state.source = s;
    buildDeck(null);
    state.revealed = false;
    resetTimer();
    render();
    syncPanel();
    toast({ all: 'Built-in + my words', builtin: 'Built-in words only', mine: 'Only my words' }[s]);
  }

  function toggleSetting(key) {
    state[key] = !state[key];
    if (key === 'hideMode') state.revealed = false;
    if (key === 'hideMode' || key === 'spellOut') render();
    save();
    syncPanel();
    const names = { hideMode: 'Hide the word', spellOut: 'Spell it out', autoAdvance: 'Auto-advance', sound: 'Sound' };
    toast(names[key] + (state[key] ? ': on' : ': off'));
  }

  function syncPanel() {
    $$('#filters button').forEach((b) => b.classList.toggle('on', b.dataset.filter === state.filter));
    $$('#sources button').forEach((b) => b.classList.toggle('on', b.dataset.source === state.source));
    $$('[data-toggle]').forEach((b) => b.setAttribute('aria-pressed', String(!!state[b.dataset.toggle])));
    updateTimerUI();
  }

  function toggleFullscreen() {
    try {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    } catch (e) { /* ignore */ }
  }

  function togglePanel(force) {
    const open = typeof force === 'boolean' ? force : el.panel.hidden;
    el.panel.hidden = !open;
    el.panelBtn.setAttribute('aria-expanded', String(open));
    wake();
  }

  function setTab(name) {
    $$('.tabs [data-tab]').forEach((b) => { const on = b.dataset.tab === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
    $$('.pane').forEach((p) => { p.hidden = p.dataset.pane !== name; });
  }

  /* ---------- My words ---------- */
  function isDuplicate(word, exceptId) {
    const k = word.toLowerCase();
    if (BUILTIN.some((w) => w.word.toLowerCase() === k)) return true;
    return state.mine.some((w) => w.id !== exceptId && w.word.toLowerCase() === k);
  }

  function addWords(raws) {
    let added = 0, dupes = 0, bad = 0;
    for (const r of raws) {
      const w = normalizeWord(Object.assign({}, r, { id: undefined }));
      if (!w) { bad++; continue; }
      if (isDuplicate(w.word)) { dupes++; continue; }
      state.mine.push(w);
      added++;
    }
    if (added) afterMineChange();
    return { added, dupes, bad };
  }

  function afterMineChange() {
    saveMine();
    const cur = state.deck[state.pos];
    buildDeck(cur ? cur.key : null);
    render({ noAnim: true });
    renderMineList();
  }

  function summary({ added, dupes, bad }) {
    const parts = [];
    parts.push(added === 1 ? 'Added 1 word' : 'Added ' + added + ' words');
    if (dupes) parts.push('skipped ' + dupes + (dupes === 1 ? ' duplicate' : ' duplicates'));
    if (bad) parts.push(bad + ' blank');
    return parts.join(', ');
  }

  function renderMineList() {
    el.mwList.textContent = '';
    el.mineCount.textContent = String(state.mine.length);
    el.mwEmpty.hidden = state.mine.length > 0;
    state.mine.forEach((w) => {
      const li = document.createElement('li');
      li.className = 'mw-item' + (w.id === state.editingId ? ' editing' : '');
      const main = document.createElement('div');
      main.className = 'mw-main';
      const name = document.createElement('span');
      name.className = 'mw-word';
      name.textContent = w.word;
      const sub = document.createElement('span');
      sub.className = 'mw-sub';
      sub.textContent = w.definition || w.sentence || 'No definition or sentence';
      main.append(name, sub);
      const lvl = document.createElement('span');
      lvl.className = 'mw-level ' + w.level;
      lvl.textContent = w.level;
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.textContent = 'Edit';
      edit.dataset.mwEdit = w.id;
      edit.setAttribute('aria-label', 'Edit ' + w.word);
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = 'Delete';
      del.className = 'danger';
      del.dataset.mwDelete = w.id;
      del.setAttribute('aria-label', 'Delete ' + w.word);
      li.append(main, lvl, edit, del);
      el.mwList.appendChild(li);
    });
    $('#mwClear').hidden = state.mine.length === 0;
    if (!state.mine.length) el.mwConfirm.hidden = true;
  }

  function resetForm() {
    state.editingId = null;
    el.mwForm.reset();
    el.mwLevel.value = 'medium';
    el.mwSubmit.textContent = 'Add word';
    el.mwCancel.hidden = true;
    renderMineList();
  }

  function startEdit(id) {
    const w = state.mine.find((x) => x.id === id);
    if (!w) return;
    state.editingId = id;
    el.mwWord.value = w.word;
    el.mwLevel.value = w.level;
    el.mwDef.value = w.definition;
    el.mwSent.value = w.sentence;
    el.mwSubmit.textContent = 'Save changes';
    el.mwCancel.hidden = false;
    renderMineList();
    el.mwWord.focus();
  }

  el.mwForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const word = clean(el.mwWord.value, 40);
    if (!word) { toast('Type a word first'); el.mwWord.focus(); return; }
    if (isDuplicate(word, state.editingId)) { toast('"' + word + '" is already in the list'); return; }
    const data = { word, level: el.mwLevel.value, definition: el.mwDef.value, sentence: el.mwSent.value };
    if (state.editingId) {
      const w = state.mine.find((x) => x.id === state.editingId);
      if (w) Object.assign(w, normalizeWord(Object.assign({ id: w.id }, data)));
      toast('Saved "' + word + '"');
      resetForm();
      afterMineChange();
    } else {
      addWords([data]);
      toast('Added "' + word + '"');
      resetForm();
      el.mwWord.focus();
    }
  });
  el.mwCancel.addEventListener('click', resetForm);

  el.mwList.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.mwEdit) startEdit(b.dataset.mwEdit);
    if (b.dataset.mwDelete) {
      const id = b.dataset.mwDelete;
      const w = state.mine.find((x) => x.id === id);
      state.mine = state.mine.filter((x) => x.id !== id);
      if (state.editingId === id) resetForm();
      if (state.order) state.order = state.order.filter((k) => k !== 'm:' + id);
      afterMineChange();
      if (w) toast('Deleted "' + w.word + '"');
    }
  });

  $('#bulkAdd').addEventListener('click', () => {
    const lines = el.bulkText.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) { toast('Paste some words first'); return; }
    const raws = lines.map((line) => {
      const [word, definition, sentence, level] = line.split('|').map((s) => s.trim());
      return { word, definition, sentence, level };
    });
    const res = addWords(raws);
    if (res.added) el.bulkText.value = '';
    toast(summary(res));
  });

  $('#mwExport').addEventListener('click', () => {
    if (!state.mine.length) { toast('No words to export yet'); return; }
    const data = { app: 'thanksgiving-spelling-bee', version: 1, words: state.mine.map(({ word, definition, sentence, level }) => ({ word, definition, sentence, level })) };
    try {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'my-spelling-words.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      toast('Exported ' + state.mine.length + (state.mine.length === 1 ? ' word' : ' words'));
    } catch (e) { toast("Couldn't export in this browser"); }
  });

  $('#mwImport').addEventListener('click', () => el.mwFile.click());
  el.mwFile.addEventListener('change', () => {
    const f = el.mwFile.files && el.mwFile.files[0];
    el.mwFile.value = '';
    if (!f) return;
    if (f.size > 2e6) { toast('That file is too big'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      let parsed;
      try { parsed = JSON.parse(String(reader.result)); } catch (e) { toast("That file doesn't look like a word list"); return; }
      const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.words) ? parsed.words : null);
      if (!arr) { toast("That file doesn't look like a word list"); return; }
      toast(summary(addWords(arr)));
    };
    reader.onerror = () => toast("Couldn't read that file");
    reader.readAsText(f);
  });

  $('#mwClear').addEventListener('click', () => {
    el.mwConfirmText.textContent = 'Delete all ' + state.mine.length + ' of your words? This cannot be undone.';
    el.mwConfirm.hidden = false;
  });
  $('#mwConfirmNo').addEventListener('click', () => { el.mwConfirm.hidden = true; });
  $('#mwConfirmYes').addEventListener('click', () => {
    const n = state.mine.length;
    state.mine = [];
    if (state.order) state.order = state.order.filter((k) => !k.startsWith('m:'));
    el.mwConfirm.hidden = true;
    resetForm();
    afterMineChange();
    toast('Cleared ' + n + (n === 1 ? ' word' : ' words'));
  });

  /* ---------- toast ---------- */
  let toastTimer = 0;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1800);
  }

  /* ---------- idle / TV mode ---------- */
  let idleTimer = 0;
  let overDock = false;
  function wake() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (overDock || !el.panel.hidden) return;
      document.body.classList.add('idle');
    }, 3500);
  }
  ['mousemove', 'pointerdown', 'touchstart', 'wheel'].forEach((t) => window.addEventListener(t, wake, { passive: true }));
  $('#dock').addEventListener('pointerenter', () => { overDock = true; });
  $('#dock').addEventListener('pointerleave', () => { overDock = false; wake(); });

  /* ---------- confetti ---------- */
  const ctx = el.canvas.getContext('2d');
  const COLORS = ['#ff4f9a', '#ff9ccf', '#ff8a2b', '#ffc23d', '#ffffff', '#e0245e', '#a66bff'];
  const MAPLE = typeof Path2D === 'function' ? new Path2D('M50 6 57 24 67 18 65 38 80 30 77 42 93 44 80 55 85 61 66 63 68 73 54 66 52 94 48 94 46 66 32 73 34 63 15 61 20 55 7 44 23 42 20 30 35 38 33 18 43 24z') : null;
  let parts = [];
  let confettiRaf = 0;
  let dpr = 1;

  function sizeCanvas() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.canvas.width = Math.round(window.innerWidth * dpr);
    el.canvas.height = Math.round(window.innerHeight * dpr);
  }

  function burst({ count = 80, spread = 'center' } = {}) {
    if (reduceMotion) count = Math.min(count, 20);
    const W = window.innerWidth, H = window.innerHeight;
    const scale = Math.max(0.6, Math.min(W, H * 16 / 9) / 1920);
    for (let i = 0; i < count; i++) {
      const full = spread === 'full';
      const x = full ? Math.random() * W : W / 2 + (Math.random() - 0.5) * W * 0.3;
      const y = full ? -20 - Math.random() * H * 0.3 : H * 0.42;
      const ang = full ? Math.PI / 2 + (Math.random() - 0.5) * 0.6 : Math.random() * Math.PI * 2;
      const sp = full ? 2 + Math.random() * 4 : 6 + Math.random() * 12;
      const r = Math.random();
      parts.push({
        x, y,
        vx: Math.cos(ang) * sp * scale,
        vy: (full ? Math.abs(Math.sin(ang) * sp) : Math.sin(ang) * sp - 6) * scale,
        size: (12 + Math.random() * 18) * scale,
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.3,
        shape: r < 0.4 ? 'maple' : r < 0.6 ? 'heart' : r < 0.75 ? 'star' : 'rect',
        color: COLORS[(Math.random() * COLORS.length) | 0],
        life: 0,
        max: 150 + Math.random() * 80
      });
    }
    if (!confettiRaf) confettiRaf = requestAnimationFrame(stepConfetti);
  }

  function drawShape(p) {
    const s = p.size;
    ctx.fillStyle = p.color;
    if (p.shape === 'maple' && MAPLE) {
      ctx.scale(s / 90, s / 90);
      ctx.translate(-50, -50);
      ctx.fill(MAPLE);
      return;
    }
    ctx.beginPath();
    if (p.shape === 'heart') {
      ctx.moveTo(0, s * 0.35);
      ctx.bezierCurveTo(-s * 0.8, -s * 0.15, -s * 0.35, -s * 0.75, 0, -s * 0.3);
      ctx.bezierCurveTo(s * 0.35, -s * 0.75, s * 0.8, -s * 0.15, 0, s * 0.35);
    } else if (p.shape === 'star') {
      for (let i = 0; i < 8; i++) {
        const rr = i % 2 ? s * 0.18 : s * 0.55;
        const a = i * Math.PI / 4;
        ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.closePath();
    } else {
      ctx.rect(-s * 0.3, -s * 0.15, s * 0.6, s * 0.3);
    }
    ctx.fill();
  }

  function stepConfetti() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
    const H = window.innerHeight;
    parts = parts.filter((p) => p.life < p.max && p.y < H + 60);
    for (const p of parts) {
      p.life++;
      p.vy += 0.22;
      p.vx *= 0.985;
      p.vy *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      const fade = p.life > p.max - 30 ? (p.max - p.life) / 30 : 1;
      ctx.globalAlpha = Math.max(0, fade);
      ctx.setTransform(dpr, 0, 0, dpr, p.x * dpr, p.y * dpr);
      ctx.rotate(p.rot);
      drawShape(p);
    }
    ctx.globalAlpha = 1;
    if (parts.length) confettiRaf = requestAnimationFrame(stepConfetti);
    else { confettiRaf = 0; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, el.canvas.width, el.canvas.height); }
  }

  /* ---------- falling leaves + twinkles ---------- */
  const SVGNS = 'http://www.w3.org/2000/svg';
  function useEl(id, attrs) {
    const svg = document.createElementNS(SVGNS, 'svg');
    const u = document.createElementNS(SVGNS, 'use');
    u.setAttribute('href', '#' + id);
    svg.appendChild(u);
    if (attrs) Object.keys(attrs).forEach((k) => svg.setAttribute(k, attrs[k]));
    return svg;
  }

  function buildBackground() {
    const leafColors = ['#ff8a2b', '#ffc23d', '#e0245e', '#ff4f9a', '#ffb3d1', '#d9562b', '#ff6f61', '#ffd75a'];
    const n = window.innerWidth < 700 ? 11 : 20;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const r = Math.random();
      const sym = r < 0.72 ? 's-maple' : r < 0.88 ? 's-oak' : 's-heart';
      const f = document.createElement('div');
      f.className = 'fall';
      const dur = 14 + Math.random() * 12;
      f.style.setProperty('--x', (Math.random() * 98).toFixed(1) + 'vw');
      f.style.setProperty('--y', (Math.random() * 90).toFixed(1) + 'vh');
      f.style.setProperty('--s', (2.6 + Math.random() * 3.2).toFixed(2) + 'vmin');
      f.style.setProperty('--d', dur.toFixed(1) + 's');
      f.style.setProperty('--f', (1.8 + Math.random() * 1.6).toFixed(2) + 's');
      f.style.setProperty('--delay', (-Math.random() * dur).toFixed(1) + 's');
      f.style.setProperty('--dx', ((Math.random() - 0.5) * 24).toFixed(1) + 'vw');
      f.style.setProperty('--r', ((Math.random() - 0.5) * 420).toFixed(0) + 'deg');
      f.style.setProperty('--r0', ((Math.random() - 0.5) * 80).toFixed(0) + 'deg');
      f.style.setProperty('--o', (0.7 + Math.random() * 0.3).toFixed(2));
      f.style.setProperty('--c', sym === 's-heart' ? '#fff' : leafColors[i % leafColors.length]);
      f.appendChild(useEl(sym, { viewBox: '0 0 100 100' }));
      frag.appendChild(f);
    }
    for (let i = 0; i < 10; i++) {
      const t = document.createElement('div');
      t.className = 'twinkle';
      t.style.setProperty('--x', (Math.random() * 96).toFixed(1) + 'vw');
      t.style.setProperty('--y', (Math.random() * 92).toFixed(1) + 'vh');
      t.style.setProperty('--s', (1.4 + Math.random() * 1.8).toFixed(2) + 'vmin');
      t.style.setProperty('--d', (2.4 + Math.random() * 2.4).toFixed(1) + 's');
      t.style.setProperty('--delay', (-Math.random() * 4).toFixed(1) + 's');
      t.appendChild(useEl('s-sparkle', { viewBox: '0 0 100 100' }));
      frag.appendChild(t);
    }
    el.bg.appendChild(frag);
  }

  /* ---------- garland: twine with leaves, acorns and mini pumpkins ---------- */
  function buildGarland() {
    const g = el.garland;
    g.textContent = '';
    const W = window.innerWidth;
    const H = g.clientHeight;
    if (!W || !H) return;
    const n = Math.max(3, Math.round(W / (H * 3.8)));
    const sw = W / n;
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    const top = H * 0.12, dip = H * 0.78;
    let d = 'M0 ' + top;
    for (let i = 0; i < n; i++) d += ' Q' + (i * sw + sw / 2) + ' ' + dip + ' ' + ((i + 1) * sw) + ' ' + top;
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#7a3f1a');
    path.setAttribute('stroke-width', Math.max(2, H * 0.06));
    svg.appendChild(path);
    const leafColors = ['#ff8a2b', '#e0245e', '#ffc23d', '#ff4f9a', '#d9562b'];
    const add = (id, x, y, w, h, rot, style) => {
      const u = document.createElementNS(SVGNS, 'use');
      u.setAttribute('href', '#' + id);
      u.setAttribute('x', x - w / 2);
      u.setAttribute('y', y);
      u.setAttribute('width', w);
      u.setAttribute('height', h);
      if (rot) u.setAttribute('transform', 'rotate(' + rot + ' ' + x + ' ' + (y + h / 2) + ')');
      if (style) u.setAttribute('style', style);
      svg.appendChild(u);
    };
    const midY = 0.25 * top + 0.5 * dip + 0.25 * top;
    for (let i = 0; i < n; i++) {
      const x = i * sw + sw / 2;
      const k = i % 3;
      if (k === 0) add('s-acorn', x, midY - H * 0.06, H * 0.42, H * 0.5, 0);
      else if (k === 1) add('s-pumpkin', x, midY - H * 0.12, H * 0.56, H * 0.56, 0, i % 2 ? '--pk1:#ff8fc0;--pk2:#ffb3d6' : '');
      else add('s-heart', x, midY - H * 0.02, H * 0.36, H * 0.36, 0, 'color:#fff');
    }
    for (let i = 0; i <= n; i++) {
      const x = i * sw;
      const s = H * 0.8;
      add('s-maple', x - s * 0.28, -H * 0.12, s, s, -28, 'color:' + leafColors[i % leafColors.length]);
      add('s-maple', x + s * 0.28, -H * 0.12, s * 0.85, s * 0.85, 30, 'color:' + leafColors[(i + 2) % leafColors.length]);
    }
    g.appendChild(svg);
  }

  /* ---------- input ---------- */
  const actions = {
    prev: () => go(-1),
    next: () => go(1),
    toggle: toggleTimer,
    reset: resetTimer,
    reveal,
    shuffle: () => shuffle(false),
    inorder: inOrder,
    fullscreen: toggleFullscreen,
    panel: () => togglePanel(),
    plus: () => setDuration(state.duration + 5),
    minus: () => setDuration(state.duration - 5)
  };

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act && actions[b.dataset.act]) actions[b.dataset.act]();
    else if (b.dataset.preset) { setDuration(Number(b.dataset.preset)); resetTimer(); }
    else if (b.dataset.filter) setFilter(b.dataset.filter);
    else if (b.dataset.source) setSource(b.dataset.source);
    else if (b.dataset.toggle) toggleSetting(b.dataset.toggle);
    else if (b.dataset.tab) setTab(b.dataset.tab);
    // drop focus so Space never re-triggers the last clicked button
    if (e.detail > 0 && !b.closest('#mwForm')) b.blur();
  });

  const isTyping = (t) => !!(t && t.closest && t.closest('input, textarea, select, [contenteditable="true"], summary'));

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    wake();
    if (isTyping(e.target)) return;
    switch (e.key) {
      case ' ': case 'Spacebar': case 'k': case 'K': e.preventDefault(); toggleTimer(); break;
      case 'ArrowRight': case 'PageDown': case 'n': case 'N': e.preventDefault(); go(1); break;
      case 'ArrowLeft': case 'PageUp': case 'p': case 'P': e.preventDefault(); go(-1); break;
      case 'ArrowUp': e.preventDefault(); setDuration(state.duration + 5, true); break;
      case 'ArrowDown': e.preventDefault(); setDuration(state.duration - 5, true); break;
      case 'r': case 'R': e.preventDefault(); reveal(); break;
      case 'f': case 'F': e.preventDefault(); toggleFullscreen(); break;
      case 's': case 'S': e.preventDefault(); shuffle(false); break;
      case 'h': case 'H': e.preventDefault(); toggleSetting('hideMode'); break;
      case '0': e.preventDefault(); resetTimer(); toast('Timer reset'); break;
      case 'Escape':
        if (!el.timesup.hidden) hideTimesUp();
        else togglePanel(false);
        break;
      default: break;
    }
  });

  el.timesup.addEventListener('click', hideTimesUp);

  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => { sizeCanvas(); buildGarland(); fitAll(); });
  });

  /* ---------- boot ---------- */
  el.storageNote.hidden = storageOk;
  sizeCanvas();
  buildBackground();
  buildGarland();
  if (state.shuffleMode === 'on' && (newSession || !state.order)) {
    state.order = shuffledKeys();
    state.currentKey = null;
  }
  buildDeck(state.currentKey);
  syncPanel();
  renderMineList();
  render();
  updateTimerUI();
  wake();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { buildGarland(); fitAll(); }).catch(() => {});

  // small hook for automated checks
  window.__bee = { state, go, reveal, startTimer, pauseTimer, resetTimer, setDuration, timeUp, fitAll, buildDeck, render };
})();
