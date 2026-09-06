// matcher.js — 浏览器端指纹匹配: 用日志证据(招式/特性/进化链)从全量离线索引中选出确切印刷版本
// 数据: cards-full.json = { meta, sets: {dirName: {id,name,releaseDate}}, cards: {name: [printings]} }

const ROTATION = ['G', 'H', 'I', 'J'];

// 从解析后的动作列表收集证据
export function collectEvidence(actions) {
  const evidence = new Map(); // name -> { used: Set, evolveFrom: Set }
  const names = new Set();
  const ev = (n) => {
    if (!evidence.has(n)) evidence.set(n, { used: new Set(), evolveFrom: new Set() });
    return evidence.get(n);
  };
  const add = (n) => {
    if (!n || typeof n !== 'string') return;
    n = n.trim().replace(/\.+$/, '');
    if (!n || /^a card$/i.test(n) || /^from\s/i.test(n) || /^\d/.test(n) || n.length >= 45) return;
    names.add(n);
  };
  const addList = (s) => String(s).split(/,(?![^()]*\))/).forEach(add);

  for (const a of actions) {
    switch (a.kind) {
      case 'attack': case 'attack_weak': case 'ability':
        add(a.mon); ev(a.mon).used.add(a.attack);
        if (a.target) add(a.target);
        if (a.extra && a.extra.mon) add(a.extra.mon);
        break;
      case 'evolve':
        add(a.from); add(a.to); ev(a.to).evolveFrom.add(a.from);
        break;
      case 'play_active': case 'play_bench': case 'play_stadium': case 'play_trainer':
      case 'retreat': case 'promote': case 'knockout': case 'draw_known': case 'activated':
        add(a.card);
        break;
      case 'attach':
        add(a.card); add(a.target);
        break;
      case 'card_to_hand': add(a.card); break;
      case 'discarded_from': add(a.card); add(a.mon); break;
      case 'damage_counter_passive': add(a.mon); break;
    }
    if (a.bullets) for (const b of a.bullets) add(b);
    for (const s of a.subs || []) {
      if (s.card) add(s.card);
      if (s.mon) add(s.mon);
      if (s.target) add(s.target);
      if (s.from) add(s.from);
      if (s.to) add(s.to);
    }
  }
  return { names, evidence };
}

function scorePrinting(card, e) {
  let s = 0;
  const used = e && e.used.size ? e.used : null;
  if (used) {
    if (card.category !== 'Pokemon') return -999;
    const moves = new Set([
      ...(card.attacks || []).map(a => a.name),
      ...(card.abilities || []).map(a => a.name),
    ]);
    let matched = 0;
    for (const u of used) if (moves.has(u)) matched++;
    if (matched === 0) return -500; // 观测到的招式不在这个版本上
    s += matched * 10;
  }
  if (e && e.evolveFrom.size) {
    const ce = card.evolveFrom;
    if (ce && e.evolveFrom.has(ce)) s += 6;
    else if (ce && !e.evolveFrom.has(ce)) s -= 4;
  }
  if (ROTATION.includes(card.regulationMark || '')) s += 2;
  return s;
}

// 把索引记录转成应用内的 cardDb 条目
function toEntry(card, localImages, name) {
  return {
    id: card.id,
    category: card.category,
    hp: card.hp,
    types: card.types,
    trainerType: card.trainerType,
    rarity: card.rarity,
    regulationMark: card.regulationMark,
    evolveFrom: card.evolveFrom,
    attacks: card.attacks,
    abilities: card.abilities,
    effect: card.effect,
    weaknesses: card.weaknesses,
    resistances: card.resistances,
    retreat: card.retreat,
    _imageFile: localImages[name] || card.image, // 本地缓存优先, 否则 TCGdex CDN
    _setName: card.setName,
  };
}

// 对一份解析后的日志执行匹配; cachedDb 中的已有条目(本地精修缓存)优先
export function matchCards(parsed, fullIndex, cachedDb, localImages) {
  const { names, evidence } = collectEvidence(parsed.actions);
  const db = {};
  const misses = [];
  for (const name of names) {
    if (cachedDb && cachedDb[name]) { db[name] = cachedDb[name]; continue; }
    const cands = fullIndex.cards[name];
    if (!cands || !cands.length) { misses.push(name); continue; }
    const e = evidence.get(name);
    let best = cands[0], bestS = -1e9;
    for (const c of cands) {
      const sc = scorePrinting(c, e);
      if (sc > bestS) { best = c; bestS = sc; } // 同分保持靠前的(已按日期/编号排序)
    }
    db[name] = toEntry(best, localImages || {}, name);
  }
  return { db, misses };
}
