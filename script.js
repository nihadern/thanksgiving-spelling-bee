(() => {
  'use strict';

  const WORDS = Array.isArray(window.SPELLING_WORDS) ? window.SPELLING_WORDS : [];
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- storage (always guarded) ---------- */
  const KEY = 'tg-spelling-bee.';
  const store = {
    get(k, d) {
      try { const v = localStorage.getItem(KEY + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set(k, v) {
      try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) { /* ignore */ }
    }
  };

  const MIN_DUR = 5, MAX_DUR = 300;
  const clampDur = (n) => Math.max(MIN_DUR, Math.min(MAX_DUR, Math.round(Number(n) || 30)));
  const LEVELS = ['all', 'easy', 'medium', 'hard'];

  const state = {
    duration: clampDur(store.get('duration', 30)),
    filter: LEVELS.includes(store.get('filter', 'all')) ? store.get('filter', 'all') : 'all',
    hideMode: !!store.get('hideMode', false),
    spellOut: !!store.get('spellOut', false),
    autoAdvance: !!store.get('autoAdvance', false),
    sound: !!store.get('sound', false),
    order: store.get('order', null),
    current: store.get('current', null),
    deck: [],
    pos: 0,
    revealed: false,
    status: 'idle', // idle | running | paused | done
    remaining: 0,
    endAt: 0,
    raf: 0,
    timesUpTimer: 0
  };
  state.remaining = state.duration;

  function save() {
    store.set('duration', state.duration);
    store.set('filter', state.filter);
    store.set('hideMode', state.hideMode);
    store.set('spellOut', state.spellOut);
    store.set('autoAdvance', state.autoAdvance);
    store.set('sound', state.sound);
    store.set('order', state.order);
    const w = state.deck[state.pos];
    store.set('current', w ? w.word : null);
  }

  /* ---------- deck ---------- */
  function buildDeck(keepWord) {
    let list = WORDS.filter((w) => state.filter === 'all' || w.level === state.filter);
    if (Array.isArray(state.order) && state.order.length) {
      const rank = new Map(state.order.map((w, i) => [w, i]));
      list = list.slice().sort((a, b) => (rank.has(a.word) ? rank.get(a.word) : 1e6) - (rank.has(b.word) ? rank.get(b.word) : 1e6));
    }
    state.deck = list;
    const idx = keepWord ? list.findIndex((w) => w.word === keepWord) : -1;
    state.pos = idx >= 0 ? idx : 0;
  }

  /* ---------- elements ---------- */
  const el = {
    word: $('#word'), wrap: $('#wordWrap'), def: $('#def'), sent: $('#sent'),
    chip: $('#chip'), count: $('#count'),
    timer: $('#timer'), ring: $('#ringProg'), num: $('#timeNum'), label: $('#timeLabel'),
    play: $('#playBtn'), playIcon: $('#playIcon'),
    timesup: $('#timesup'), toast: $('#toast'), panel: $('#panel'), panelBtn: $('#panelBtn'),
    durVal: $('#durVal'), canvas: $('#confetti'), bg: $('#bg')
  };
  const RING_C = 2 * Math.PI * 52;
  el.ring.style.strokeDasharray = RING_C.toFixed(2);

  /* ---------- rendering ---------- */
  const isHidden = () => state.hideMode && !state.revealed;

  function letterSpans(text) {
    const frag = document.createDocumentFragment();
    Array.from(text).forEach((ch, i) => {
      const s = document.createElement('span');
      s.className = 'ltr';
      s.style.setProperty('--i', i);
      s.textContent = ch;
      frag.appendChild(s);
    });
    return frag;
  }

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function fillSentence(target, sentence, word, mask) {
    target.textContent = '';
    const span = document.createElement('span');
    if (!mask) {
      span.textContent = sentence;
    } else {
      const re = new RegExp('\\b' + escapeRe(word) + "(?:s|es|ed|ing|'s)?\\b", 'gi');
      let last = 0, m;
      while ((m = re.exec(sentence))) {
        span.appendChild(document.createTextNode(sentence.slice(last, m.index)));
        const b = document.createElement('span');
        b.className = 'blank';
        b.textContent = '_____';
        span.appendChild(b);
        last = m.index + m[0].length;
      }
      span.appendChild(document.createTextNode(sentence.slice(last)));
    }
    target.appendChild(span);
  }

  function restartAnim(node, cls) {
    node.classList.remove(cls);
    void node.offsetWidth; // reflow so the animation replays
    node.classList.add(cls);
  }

  let hintEl = null;
  function render(opts = {}) {
    const w = state.deck[state.pos];
    if (!w) {
      el.word.textContent = 'No words';
      el.def.textContent = 'Add some words to words.js';
      el.sent.textContent = '';
      return;
    }
    const hidden = isHidden();
    el.word.textContent = '';
    el.word.className = 'word';
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
    el.count.textContent = (state.pos + 1) + ' / ' + state.deck.length;

    el.def.textContent = '';
    const d = document.createElement('span');
    d.textContent = w.definition;
    el.def.appendChild(d);
    fillSentence(el.sent, w.sentence, w.word, hidden);
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
    const base = parseFloat(getComputedStyle(p).fontSize);
    let size = base;
    let guard = 0;
    const inner = p.firstElementChild;
    if (!inner) return;
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
    const secs = Math.ceil(rem - 1e-6);
    el.num.textContent = String(secs);
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
      state.endAt += delta * 1000;
      state.remaining = Math.max(0.5, (state.endAt - performance.now()) / 1000);
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
    restartAnim(el.timesup.querySelector('.timesup-inner'), 'go');
    burst({ count: 160, spread: 'full' });
    if (state.sound) playChime();
    clearTimeout(state.timesUpTimer);
    state.timesUpTimer = setTimeout(() => {
      hideTimesUp();
      if (state.autoAdvance) go(1);
    }, 2800);
  }

  function hideTimesUp() {
    el.timesup.hidden = true;
  }

  /* optional sound, off by default; only created when the user turned it on */
  let audioCtx = null;
  function playChime() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const notes = [880, 1108.73, 1318.51, 1760];
      notes.forEach((f, i) => {
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
    if (!state.deck.length) return;
    state.pos = (state.pos + step + state.deck.length) % state.deck.length;
    state.revealed = false;
    resetTimer();
    render();
    if (step > 0) burst({ count: 70 });
  }

  function reveal() {
    if (isHidden()) {
      state.revealed = true;
      render();
      burst({ count: 140 });
      return;
    }
    // already showing: replay the letter-by-letter spell out
    restartAnim(el.word, 'spell');
    burst({ count: 60 });
  }

  function shuffle() {
    const all = WORDS.map((w) => w.word);
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    state.order = all;
    buildDeck(null);
    state.revealed = false;
    resetTimer();
    render();
    burst({ count: 90 });
    toast('Shuffled!');
  }

  function inOrder() {
    state.order = null;
    buildDeck(null);
    state.revealed = false;
    resetTimer();
    render();
    toast('Back in order');
  }

  function setFilter(f) {
    if (!LEVELS.includes(f)) return;
    state.filter = f;
    buildDeck(null);
    state.revealed = false;
    resetTimer();
    render();
    syncPanel();
    toast(f === 'all' ? 'All words' : f.charAt(0).toUpperCase() + f.slice(1) + ' words only');
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

  /* ---------- toast ---------- */
  let toastTimer = 0;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1500);
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
  const COLORS = ['#ff3d9a', '#ff9ccf', '#b98bff', '#ffcf4d', '#ffffff', '#ff8a2b', '#ecdcff'];
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
    const scale = Math.max(0.6, Math.min(W, H * 16 / 9) / 1920) * 1.0;
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
        size: (10 + Math.random() * 16) * scale,
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.3,
        shape: r < 0.3 ? 'heart' : r < 0.5 ? 'star' : r < 0.65 ? 'leaf' : 'rect',
        color: COLORS[(Math.random() * COLORS.length) | 0],
        life: 0,
        max: 140 + Math.random() * 80
      });
    }
    if (!confettiRaf) confettiRaf = requestAnimationFrame(stepConfetti);
  }

  function drawShape(p) {
    const s = p.size;
    ctx.fillStyle = p.color;
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
    } else if (p.shape === 'leaf') {
      ctx.ellipse(0, 0, s * 0.22, s * 0.5, 0, 0, Math.PI * 2);
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

  /* ---------- floating background ---------- */
  function buildBackground() {
    const kinds = [
      ['s-heart', '#ffffff'], ['s-heart', '#ffd3ea'], ['s-heart', '#ff1f8e'],
      ['s-sparkle', '#fff6c2'], ['s-sparkle', '#ffffff'], ['s-sparkle', '#ffcf4d'],
      ['s-leaf', '#ff8a2b'], ['s-leaf', '#ffcf4d'], ['s-leaf', '#e8457a'],
      ['s-pumpkin', ''], ['s-pie', ''], ['s-turkey', '']
    ];
    const n = window.innerWidth < 700 ? 12 : 22;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const [sym, color] = kinds[i % kinds.length];
      const f = document.createElement('div');
      f.className = 'floater';
      const big = sym === 's-pumpkin' || sym === 's-pie' || sym === 's-turkey';
      const dur = 18 + Math.random() * 16;
      f.style.setProperty('--x', (Math.random() * 96).toFixed(1) + 'vw');
      f.style.setProperty('--y', (Math.random() * 85).toFixed(1) + 'vh');
      f.style.setProperty('--s', (big ? 5 + Math.random() * 3 : 2.2 + Math.random() * 3).toFixed(2) + 'vmin');
      f.style.setProperty('--d', dur.toFixed(1) + 's');
      f.style.setProperty('--delay', (-Math.random() * dur).toFixed(1) + 's');
      f.style.setProperty('--dx', ((Math.random() - 0.5) * 20).toFixed(1) + 'vw');
      f.style.setProperty('--r', ((Math.random() - 0.5) * 540).toFixed(0) + 'deg');
      f.style.setProperty('--o', big ? '0.5' : (0.45 + Math.random() * 0.4).toFixed(2));
      if (color) f.style.setProperty('--c', color);
      f.innerHTML = '<svg aria-hidden="true"><use href="#' + sym + '"/></svg>';
      frag.appendChild(f);
    }
    el.bg.appendChild(frag);
  }

  /* ---------- input ---------- */
  const actions = {
    prev: () => go(-1),
    next: () => go(1),
    toggle: toggleTimer,
    reset: resetTimer,
    reveal,
    shuffle,
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
    else if (b.dataset.toggle) toggleSetting(b.dataset.toggle);
    // drop focus so Space never re-triggers the last clicked button
    if (e.detail > 0) b.blur();
  });

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target && e.target.matches && e.target.matches('input, textarea, select')) return;
    wake();
    switch (e.key) {
      case ' ': case 'Spacebar': case 'k': case 'K': e.preventDefault(); toggleTimer(); break;
      case 'ArrowRight': case 'PageDown': case 'n': case 'N': e.preventDefault(); go(1); break;
      case 'ArrowLeft': case 'PageUp': case 'p': case 'P': e.preventDefault(); go(-1); break;
      case 'ArrowUp': e.preventDefault(); setDuration(state.duration + 5, true); break;
      case 'ArrowDown': e.preventDefault(); setDuration(state.duration - 5, true); break;
      case 'r': case 'R': e.preventDefault(); reveal(); break;
      case 'f': case 'F': e.preventDefault(); toggleFullscreen(); break;
      case 's': case 'S': e.preventDefault(); shuffle(); break;
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
    resizeRaf = requestAnimationFrame(() => { sizeCanvas(); fitAll(); });
  });

  /* ---------- boot ---------- */
  sizeCanvas();
  buildBackground();
  buildDeck(state.current);
  syncPanel();
  render();
  updateTimerUI();
  wake();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitAll).catch(() => {});

  // small hook for automated checks
  window.__bee = { state, go, reveal, startTimer, pauseTimer, resetTimer, setDuration, timeUp, fitAll };
})();
