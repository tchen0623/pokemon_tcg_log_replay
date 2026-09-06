// main.js — UI, playback, modals
import { parseLog } from './parser.js';
import { buildGame, hpOf, energyType } from './engine.js';
import { matchCards } from './matcher.js';

let cardDb = {};
let fullIndex = null;   // TCGdex 全量离线索引
let cachedDb = {};      // 本地精修缓存(含本地卡图)
let localImages = {};   // 卡名 -> 本地图片路径
let game = null;      // { playerNames, states, actions, stats, decklists, gameOver }
let idx = 0;          // current state index (0 = initial, states.length-1 = after last action)
let playing = false;
let speed = 1;
let timer = null;

const $ = (s) => document.querySelector(s);
const SPEEDS = [0.25, 0.5, 1, 2, 4];
const WIN_TEXT = { concede: '对手认输', prizes: '拿完全部奖品卡', no_bench: '对手备战区无宝可梦' };

// ---------- data ----------
async function loadDb() {
  const fetchJson = async (url) => {
    try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch { return null; }
  };
  cachedDb = (await fetchJson('data/cards-db.json')) || {};
  localImages = (await fetchJson('data/local-images.json')) || {};
  fullIndex = await fetchJson('data/cards-full.json');
  cardDb = cachedDb;
}

function cardImg(name, cls = '') {
  const c = name && cardDb[name];
  if (c && c._imageFile) {
    return `<div class="card ${cls}" data-name="${esc(name)}"><img src="${c._imageFile}" alt="${esc(name)}" loading="lazy"></div>`;
  }
  if (name) return `<div class="card placeholder ${cls}" data-name="${esc(name)}">${esc(name)}</div>`;
  return `<div class="card back ${cls}"></div>`;
}
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- load & build ----------
function resetUiState() {
  // 每次导入前彻底清掉上一份日志的 UI 残留，避免“重合”观感
  stopPlay();
  $('#modal-mask').classList.remove('show');
  $('#modal-body').innerHTML = '';
  const go = $('#gameover');
  go.className = ''; go.innerHTML = '';
  const tip = $('#tooltip');
  tip.style.display = 'none'; tip.innerHTML = '';
  const log = $('#log');
  log.innerHTML = ''; log.scrollTop = 0;
  $('#board').innerHTML = '';
  $('#center-band').innerHTML = '';
  $('#pos').textContent = '0 / 0';
  $('#log-count').textContent = '';
}

function loadLog(text, label) {
  resetUiState();
  const parsed = parseLog(text);
  // 指纹匹配: 缓存命中用本地精修卡图, 其余从全量离线索引精确匹配版本
  if (fullIndex) {
    const m = matchCards(parsed, fullIndex, cachedDb, localImages);
    cardDb = m.db;
    if (m.misses.length) console.warn('未收录卡牌:', m.misses);
    game = buildGame(parsed, cardDb);
    game.cardMisses = m.misses;
  } else {
    cardDb = cachedDb;
    game = buildGame(parsed, cardDb);
    game.cardMisses = [];
  }
  idx = 0;
  renderLog();
  renderFrame();
  const rawCount = game.actions.filter(a => a.unparsed).length +
    game.actions.reduce((n, a) => n + a.subs.filter(s => s.unparsed).length, 0);
  const pb = $('#parse-badge');
  pb.style.display = ''; pb.textContent = `${game.actions.length} 个动作 · ${game.totalTurns || parsed.totalTurns} 回合 · ${label}`;
  const rb = $('#raw-badge');
  const missNote = game.cardMisses.length ? ` · ${game.cardMisses.length} 张卡未收录` : '';
  if (rawCount > 0) { rb.style.display = ''; rb.textContent = `⚠ ${rawCount} 行未识别（已保留）${missNote}`; }
  else if (missNote) { rb.style.display = ''; rb.textContent = `⚠${missNote}`; }
  else rb.style.display = 'none';
  $('#welcome').classList.remove('show');
}

// ---------- board rendering ----------
function hpBar(stack, mini) {
  const { max, dmg, remaining } = hpOf(stack, cardDb);
  if (max == null) return dmg > 0 ? `<div class="hpbar ${mini ? 'mini' : ''}"><div class="txt">-${dmg}</div></div>` : '';
  const pct = Math.max(0, Math.min(100, (remaining / max) * 100));
  const color = pct > 50 ? 'var(--hp-hi)' : pct > 25 ? 'var(--hp-mid)' : 'var(--hp-lo)';
  return `<div class="hpbar ${mini ? 'mini' : ''}"><div class="fill" style="width:${pct}%;background:${color}"></div><div class="txt">${remaining} / ${max}</div></div>`;
}

function chipsHtml(stack) {
  const e = stack.energy.map(n => {
    const t = energyType(n);
    return `<span class="chip e-${t || 'none'}" title="${esc(n)}">⚡${t || esc(n)}</span>`;
  }).join('');
  const t = stack.tools.map(n => `<span class="chip tool" title="${esc(n)}">🔧${esc(n)}</span>`).join('');
  return (e || t) ? `<div class="chips">${e}${t}</div>` : '';
}

function statusHtml(stack) {
  return stack.status.length
    ? `<div class="status-row">${stack.status.map(s => `<span class="status ${s}">${s}</span>`).join('')}</div>` : '';
}

function stackHtml(stack, active) {
  if (!stack) return '';
  const top = stack.cards[stack.cards.length - 1];
  const evo = stack.cards.length > 1 ? `<div class="evo-label" title="${esc(stack.cards.join(' → '))}">▲${stack.cards.length}张 · ${esc(top)}</div>` : '';
  return `<div class="${active ? 'active-card' : ''}" style="position:relative">
    ${stack.counters > 0 ? `<div class="dmg-badge">${stack.counters * 10}</div>` : ''}
    ${cardImg(top)}
    ${evo}
    ${hpBar(stack, !active)}
    ${statusHtml(stack)}
    ${chipsHtml(stack)}
  </div>`;
}

function playerHtml(pl, isTurn, lostCount) {
  const bench = [];
  const slots = Math.max(5, pl.bench.length);
  for (let i = 0; i < slots; i++) {
    const s = pl.bench[i];
    bench.push(`<div class="bench-slot ${s ? '' : 'empty'}">${s ? stackHtml(s, false) : '<div class="card"></div>'}</div>`);
  }
  const handCards = pl.hand.map(h => cardImg(h, '')).join('');
  const discTop = pl.discard.length ? pl.discard[pl.discard.length - 1] : null;
  return `<div class="player ${isTurn ? 'turn' : ''}" data-player="${esc(pl.name)}">
    <div class="side">
      <div><div class="zone-label">牌库</div><div style="width:56px">${cardImg(null)}</div><div class="count" style="text-align:center">${pl.deckCount}</div></div>
      <div class="discard-zone" data-player="${esc(pl.name)}" style="cursor:pointer">
        <div class="zone-label">弃牌堆</div>
        <div style="width:56px">${discTop ? cardImg(discTop) : '<div class="card" style="border-style:dashed;opacity:.35"></div>'}</div>
        <div class="count" style="text-align:center">${pl.discard.length}</div>
      </div>
      <div class="lost-zone" data-player="${esc(pl.name)}" style="cursor:pointer;text-align:center">
        <div class="zone-label">放逐区</div>
        <div class="count" style="color:#c084fc">${lostCount}</div>
      </div>
    </div>
    <div>
      <div class="pname">${esc(pl.name)} ${isTurn ? '<span class="tag">◀ 当前回合</span>' : ''}</div>
      <div class="middle" style="margin-top:8px">
        <div>${pl.active ? stackHtml(pl.active, true) : '<div class="card" style="border-style:dashed;opacity:.3;width:122px"></div>'}</div>
        <div class="bench-row">${bench.join('')}</div>
      </div>
    </div>
    <div class="side">
      <div><div class="zone-label">奖品卡 ×${pl.prizeCount}</div>
        <div style="display:grid;grid-template-columns:repeat(3,26px);gap:3px">
          ${Array.from({ length: pl.prizeCount }).map(() => '<div class="card back" style="width:26px"></div>').join('')}
        </div></div>
      <div style="width:100%"><div class="zone-label">手牌 ×${pl.hand.length}（明牌 ${pl.hand.filter(Boolean).length}）</div>
        <div class="hand-row">${handCards || '<span class="sub">空</span>'}</div></div>
    </div>
  </div>`;
}

function renderFrame() {
  if (!game) return;
  const st = game.states[idx];
  const board = $('#board');
  // opponent first (top), then player
  board.innerHTML = [st.players[1], st.players[0]]
    .filter(Boolean)
    .map(pl => playerHtml(pl, st.activePlayer === pl.name && !st.gameOver, st.lostZone.filter(l => l.owner === pl.name).length))
    .join('');

  const band = $('#center-band');
  band.innerHTML = `
    <span>回合 <span class="turn-no">${st.turn || '-'}</span></span>
    <span class="stadium">${st.stadium ? `🏟️ <span class="mini-card" style="display:inline-block;width:34px;vertical-align:middle">${cardImg(st.stadium.card)}</span> ${esc(st.stadium.card)} <span class="sub">(${esc(st.stadium.owner)})</span>` : '🏟️ 无场地'}</span>
    <span>${st.activePlayer ? `行动方：${esc(st.activePlayer)}` : ''}</span>`;

  const go = $('#gameover');
  if (st.gameOver) {
    go.className = 'show';
    go.innerHTML = `🏆 ${esc(st.gameOver.winner)} 获胜 — ${WIN_TEXT[st.gameOver.reason] || st.gameOver.reason}`;
  } else go.className = '';

  $('#pos').textContent = `${idx} / ${game.states.length - 1}`;
  $('#scrub').max = game.states.length - 1;
  $('#scrub').value = idx;

  // highlight current log entry
  document.querySelectorAll('.la.current').forEach(e => e.classList.remove('current'));
  const cur = document.querySelector(`.la[data-i="${idx - 1}"]`);
  if (cur) { cur.classList.add('current'); cur.scrollIntoView({ block: 'nearest' }); }

  // discard / lost-zone click
  board.querySelectorAll('.discard-zone').forEach(z => {
    z.onclick = () => openDiscard(z.dataset.player);
  });
  board.querySelectorAll('.lost-zone').forEach(z => {
    z.onclick = () => openLostZone(z.dataset.player);
  });
}

// ---------- action log ----------
function actionClass(a) {
  if (a.unparsed) return 'k-raw';
  switch (a.kind) {
    case 'play_trainer': {
      const cd = cardDb[a.card];
      return cd && /Supporter/i.test(cd.trainerType || '') ? 'k-supporter' : 'k-item';
    }
    case 'attach': return /Energy$/i.test(a.card || '') ? 'k-energy' : 'k-item';
    case 'attack': case 'attack_weak': case 'damage_counter_passive': return 'k-combat';
    case 'knockout': return 'k-ko';
    case 'win': return 'k-win';
    default: return '';
  }
}

function subText(s) {
  return s.unparsed ? s.text : s.text;
}

function renderLog() {
  const log = $('#log');
  let html = '';
  let lastTurn = -1;
  game.actions.forEach((a, i) => {
    if (a.turn !== lastTurn) {
      lastTurn = a.turn;
      html += `<div class="turn-group" data-turn="${a.turn}"><div class="turn-title">${a.turn === 0 ? '准备阶段' : `第 ${a.turn} 回合`}</div>`;
    }
    const bullets = (a.bullets && a.bullets.length)
      ? `<div class="cards-inline">${a.bullets.map(b => `<span class="cc" data-name="${esc(b)}">${esc(b)}</span>`).join('')}</div>` : '';
    const breakdownSubs = a.subs.filter(s => s.kind.startsWith('sub_breakdown'));
    const breakdown = breakdownSubs.length
      ? `<div class="breakdown">🧮 ${breakdownSubs.map(s => {
          if (s.kind === 'sub_breakdown_base') return `基础 ${s.base}`;
          if (s.kind === 'sub_breakdown_weak') return `弱点 +${s.amount}`;
          if (s.kind === 'sub_breakdown_resist') return `抵抗 -${s.amount}`;
          return `合计 ${s.total}`;
        }).join(' · ')}</div>` : '';
    const subs = a.subs.filter(s => !s.kind.startsWith('sub_breakdown') && s.kind !== 'sub_damage_breakdown');
    const subsHtml = subs.length
      ? `<div class="subs">${subs.map(s => `<div class="${s.unparsed ? 'raw' : ''}">${s.unparsed ? '⚠ ' : '· '}${esc(subText(s))}</div>`).join('')}</div>` : '';
    html += `<div class="la ${actionClass(a)}" data-i="${i}"><span class="n">${i + 1}</span>${esc(a.text)}${bullets}${breakdown}${subsHtml}</div>`;
    // close turn group if next action has different turn
    const next = game.actions[i + 1];
    if (!next || next.turn !== a.turn) html += '</div>';
  });
  log.innerHTML = html;
  $('#log-count').textContent = `${game.actions.length} 个动作`;
  log.querySelectorAll('.la').forEach(el => {
    el.onclick = () => { stopPlay(); seek(+el.dataset.i + 1); };
  });
}

// ---------- playback ----------
function seek(i) {
  idx = Math.max(0, Math.min(game.states.length - 1, i));
  renderFrame();
}
function stopPlay() { playing = false; $('#ctl-play').textContent = '▶'; clearInterval(timer); }
function startPlay() {
  if (!game) return;
  playing = true; $('#ctl-play').textContent = '⏸';
  clearInterval(timer);
  timer = setInterval(() => {
    if (idx >= game.states.length - 1) { stopPlay(); return; }
    seek(idx + 1);
  }, 1400 / speed);
}
function turnBoundary(dir) {
  const targetTurn = game.states[idx].turn + dir;
  if (targetTurn < 0) return 0;
  for (let i = 0; i < game.actions.length; i++) {
    if (game.actions[i].kind === 'turn_header' && game.actions[i].turnNumber === targetTurn) return i + 1;
  }
  return dir > 0 ? game.states.length - 1 : 0;
}

// ---------- modals ----------
function openModal(html) { $('#modal-body').innerHTML = html; $('#modal-mask').classList.add('show'); }
$('#modal-close').onclick = () => $('#modal-mask').classList.remove('show');
$('#modal-mask').onclick = (e) => { if (e.target.id === 'modal-mask') $('#modal-mask').classList.remove('show'); };

function openDiscard(playerName) {
  const pl = game.states[idx].players.find(p => p.name === playerName);
  const items = pl.discard.map(c => `<div>${cardImg(c)}<div class="nm">${esc(c || '未知卡')}</div></div>`).join('');
  openModal(`<h3>${esc(playerName)} 的弃牌堆（${pl.discard.length}）</h3><div class="card-grid">${items || '空'}</div>`);
}

function openLostZone(playerName) {
  const st = game.states[idx];
  const cards = st.lostZone.filter(l => l.owner === playerName);
  const items = cards.map(l => `<div>${cardImg(l.card)}<div class="nm">${esc(l.card)}</div></div>`).join('');
  openModal(`<h3>${esc(playerName)} 的放逐区（${cards.length}）</h3><div class="card-grid">${items || '空'}</div>`);
}

function openDecklist() {
  if (!game) return;
  const col = (name) => {
    const entries = Object.entries(game.decklists[name] || {}).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((n, [, c]) => n + c, 0);
    return `<div><h4>${esc(name)} — 记录 ${total} 次</h4>
      <table>${entries.map(([c, n]) => `<tr><td>${n}×</td><td data-name="${esc(c)}" class="tt">${esc(c)}</td></tr>`).join('')}</table></div>`;
  };
  openModal(`<h3>📋 卡牌出现记录</h3><p style="color:var(--dim);font-size:12px;margin-bottom:10px">按日志中出现名称的次数统计；洗回牌库后再抽到会重复计数，因此总数可能超过 60。</p>
    <div class="decklist-cols">${game.playerNames.map(col).join('')}</div>`);
}

function openStats() {
  if (!game) return;
  const rows = (name) => {
    const s = game.stats[name];
    return `<h4 style="margin:8px 0 4px;color:var(--accent)">${esc(name)}</h4><table>
      <tr><td>抽牌总数</td><td>${s.drawn}</td></tr>
      <tr><td>造成总伤害</td><td>${s.damageDealt}</td></tr>
      <tr><td>击倒次数</td><td>${s.kos}</td></tr>
      <tr><td>拿到奖品卡</td><td>${s.prizesTaken}</td></tr>
      <tr><td>支援者使用</td><td>${s.supporters}</td></tr></table>`;
  };
  openModal(`<h3>📊 对局统计</h3><div class="stats-grid">${game.playerNames.map(rows).join('')}</div>`);
}

function openPaste() {
  openModal(`<h3>📋 粘贴战斗日志</h3><textarea id="paste-area" placeholder="把 PTCGL 结算界面复制的 battle log 粘贴到这里…"></textarea>
    <div style="margin-top:12px;text-align:right"><button class="primary" id="paste-go">载入回放</button></div>`);
  $('#paste-go').onclick = () => {
    const t = $('#paste-area').value.trim();
    if (t) { $('#modal-mask').classList.remove('show'); loadLog(t, '粘贴导入'); }
  };
}

// ---------- tooltip ----------
const tip = $('#tooltip');
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest('[data-name]');
  if (!el) { tip.style.display = 'none'; return; }
  const name = el.dataset.name;
  const c = cardDb[name];
  if (!c) { tip.style.display = 'none'; return; }
  const atks = (c.attacks || []).map(a =>
    `<div class="t-atk"><b>${esc(a.name)}</b> ${a.damage ? `— ${a.damage}` : ''}<br><span class="t-meta">${esc(a.effect || '')}</span></div>`).join('');
  const ab = (c.abilities || []).map(a =>
    `<div class="t-atk">✦ <b>${esc(a.name)}</b><br><span class="t-meta">${esc(a.effect || '')}</span></div>`).join('');
  tip.innerHTML = `${c._imageFile ? `<img src="${c._imageFile}">` : ''}
    <div class="t-name">${esc(name)}</div>
    <div class="t-meta">${esc(c.category || '')}${c.hp ? ` · HP ${c.hp}` : ''}${(c.types || []).length ? ' · ' + c.types.join('/') : ''}${c.trainerType ? ' · ' + esc(c.trainerType) : ''}</div>
    ${ab}${atks}${c.effect ? `<div class="t-atk"><span class="t-meta">${esc(c.effect)}</span></div>` : ''}`;
  tip.style.display = 'block';
});
document.addEventListener('mousemove', (e) => {
  if (tip.style.display !== 'block') return;
  const x = Math.min(e.clientX + 18, innerWidth - 260);
  const y = Math.min(e.clientY + 18, innerHeight - tip.offsetHeight - 10);
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
});

// ---------- wiring ----------
$('#ctl-play').onclick = () => (playing ? stopPlay() : startPlay());
$('#ctl-prev').onclick = () => { stopPlay(); seek(idx - 1); };
$('#ctl-next').onclick = () => { stopPlay(); seek(idx + 1); };
$('#ctl-start').onclick = () => { stopPlay(); seek(0); };
$('#ctl-end').onclick = () => { stopPlay(); seek(game ? game.states.length - 1 : 0); };
$('#ctl-turn-prev').onclick = () => { stopPlay(); seek(turnBoundary(-1)); };
$('#ctl-turn-next').onclick = () => { stopPlay(); seek(turnBoundary(1)); };
$('#scrub').oninput = (e) => { stopPlay(); seek(+e.target.value); };
$('#btn-file').onclick = () => $('#file-input').click();
$('#file-input').onchange = async (e) => {
  const f = e.target.files[0];
  if (f) loadLog(await f.text(), f.name);
  e.target.value = '';
};
$('#btn-paste').onclick = openPaste;
$('#btn-decklist').onclick = openDecklist;
$('#btn-stats').onclick = openStats;
$('#w-demo').onclick = () => loadDemo();
$('#w-file').onclick = () => $('#file-input').click();
$('#w-paste').onclick = () => { $('#welcome').classList.remove('show'); openPaste(); };

const spdBox = $('#speeds');
SPEEDS.forEach(v => {
  const b = document.createElement('button');
  b.textContent = v + 'x';
  if (v === 1) b.classList.add('active-spd');
  b.onclick = () => {
    speed = v;
    spdBox.querySelectorAll('button').forEach(x => x.classList.remove('active-spd'));
    b.classList.add('active-spd');
    if (playing) startPlay();
  };
  spdBox.appendChild(b);
});

document.addEventListener('keydown', (e) => {
  if (!game || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  const k = e.key;
  if (k === ' ') { e.preventDefault(); playing ? stopPlay() : startPlay(); }
  else if (k === 'ArrowLeft') { stopPlay(); e.shiftKey ? seek(turnBoundary(-1)) : seek(idx - 1); }
  else if (k === 'ArrowRight') { stopPlay(); e.shiftKey ? seek(turnBoundary(1)) : seek(idx + 1); }
  else if (k === 'Home') { stopPlay(); seek(0); }
  else if (k === 'End') { stopPlay(); seek(game.states.length - 1); }
  else if (k === 'ArrowUp') { e.preventDefault(); const i = SPEEDS.indexOf(speed); if (i < SPEEDS.length - 1) spdBox.children[i + 1].click(); }
  else if (k === 'ArrowDown') { e.preventDefault(); const i = SPEEDS.indexOf(speed); if (i > 0) spdBox.children[i - 1].click(); }
});

async function loadDemo() {
  try {
    const t = await (await fetch('sample-log.txt')).text();
    loadLog(t, '演示对局');
  } catch {
    $('#welcome').classList.add('show');
  }
}

(async function init() {
  await loadDb();
  $('#welcome').classList.add('show'); // 默认空白落地页, 不预载任何对局
})();
