// build-full-index.js — 把 tcgdex/cards-database 仓库的 .ts 数据编译成紧凑 JSON 索引
// 用法: node scripts/build-full-index.js <仓库data目录> <输出json>
const fs = require('fs');
const path = require('path');

const [,, dataDir, outFile] = process.argv;
if (!dataDir || !outFile) { console.error('usage: node build-full-index.js <dataDir> <out.json>'); process.exit(1); }

function extractObject(src, anchorRe) {
  const m = anchorRe.exec(src);
  if (!m) return null;
  const start = src.indexOf('{', m.index);
  if (start < 0) return null;
  let depth = 0, i = start, inStr = null, esc = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

// 批量编译: 一次 Function 编译 500 个字面量
function evalBatch(lits) {
  try { return (new Function('return [\n' + lits.join(',\n') + '\n])') )(); }
  catch (e) {
    // 批量失败则退化到逐个, 隔离坏文件
    return lits.map(l => { try { return (new Function('return (' + l + ')'))(); } catch { return null; } });
  }
}

const pickEn = (v) => (v && typeof v === 'object' ? (v.en || v.fr || Object.values(v)[0]) : v);

const sets = {};
const raw = []; // { lit, setDir, localId }
let bad = 0;

for (const series of fs.readdirSync(dataDir)) {
  const sDir = path.join(dataDir, series);
  if (!fs.statSync(sDir).isDirectory()) continue;
  for (const entry of fs.readdirSync(sDir)) {
    const full = path.join(sDir, entry);
    if (entry.endsWith('.ts')) {
      const src = fs.readFileSync(full, 'utf8');
      const lit = extractObject(src, /const \w+\s*:\s*Set\s*=/);
      const obj = lit && evalBatch([lit.replace(/serie\s*:\s*serie\s*,?/, '')])[0];
      if (obj && obj.id) sets[entry.slice(0, -3)] = { id: obj.id, name: pickEn(obj.name), releaseDate: obj.releaseDate || '' };
      continue;
    }
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith('.ts')) continue;
      const src = fs.readFileSync(path.join(full, f), 'utf8');
      let lit = extractObject(src, /const \w+\s*:\s*Card\s*=/);
      if (!lit) { bad++; continue; }
      lit = lit.replace(/set\s*:\s*Set\s*,?/, '');
      raw.push({ lit, setDir: entry, localId: f.slice(0, -3) });
    }
  }
}

console.log('collected', raw.length, 'cards,', Object.keys(sets).length, 'sets; evaluating in batches...');

const cards = [];
const B = 500;
for (let i = 0; i < raw.length; i += B) {
  const slice = raw.slice(i, i + B);
  const objs = evalBatch(slice.map(s => s.lit));
  for (let j = 0; j < slice.length; j++) {
    const c = objs[j], { setDir, localId } = slice[j];
    if (!c) { bad++; continue; }
    const name = pickEn(c.name);
    if (!name) continue;
    const setInfo = sets[setDir];
    const setId = (setInfo && setInfo.id) || null;
    const rec = {
      id: setId ? `${setId}-${localId}` : null,
      set: setId, setName: setInfo ? setInfo.name : setDir, localId,
      name,
      category: c.category || null,
      hp: c.hp || null,
      types: c.types || undefined,
      stage: c.stage || undefined,
      evolveFrom: pickEn(c.evolveFrom) || undefined,
      trainerType: c.trainerType || undefined,
      energyType: c.energyType || undefined,
      rarity: c.rarity || undefined,
      regulationMark: c.regulationMark || undefined,
      retreat: c.retreat ?? undefined,
      weaknesses: c.weaknesses, resistances: c.resistances,
      abilities: (c.abilities || []).map(a => ({ name: pickEn(a.name), effect: pickEn(a.effect), type: a.type })).filter(a => a.name),
      attacks: (c.attacks || []).map(a => ({ name: pickEn(a.name), cost: a.cost, damage: a.damage != null ? String(a.damage) : undefined, effect: pickEn(a.effect) })).filter(a => a.name),
      effect: pickEn(c.effect) || undefined,
      image: setId ? `https://assets.tcgdex.net/en/${setId}/${localId}/high.png` : undefined,
    };
    if (!rec.abilities.length) delete rec.abilities;
    if (!rec.attacks.length) delete rec.attacks;
    cards.push(rec);
  }
  if ((i / B) % 10 === 0) process.stdout.write(`\r  ${Math.min(i + B, raw.length)}/${raw.length}`);
}
console.log('');

// 按英文名分组前需要 setId -> releaseDate 反查表
const setsById = {};
for (const s of Object.values(sets)) setsById[s.id] = s;

const byName = {};
for (const c of cards) (byName[c.name] = byName[c.name] || []).push(c);

// 同分决胜: 发行日期新的在前; 同系列内按 localId 自然序(基础卡图在异画之前)
const nat = (s) => String(s).split(/(\d+)/).map((t, i) => (i % 2 ? +t : t));
const cmpNat = (a, b) => { const x = nat(a), y = nat(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if (x[i] === y[i]) continue; if (x[i] === undefined) return -1; if (y[i] === undefined) return 1; if (typeof x[i] === 'number' && typeof y[i] === 'number') return x[i] - y[i]; return String(x[i]) < String(y[i]) ? -1 : 1; } return 0; };
for (const arr of Object.values(byName)) {
  arr.sort((a, b) => {
    const da = (setsById[a.set] || {}).releaseDate || '', db = (setsById[b.set] || {}).releaseDate || '';
    if (da !== db) return da < db ? 1 : -1; // 新的在前
    return cmpNat(a.localId, b.localId);
  });
}

const meta = { generated: new Date().toISOString(), sets: Object.keys(sets).length, cards: cards.length, names: Object.keys(byName).length, failed: bad };
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({ meta, sets, cards: byName }));
console.log('OK', meta, 'sizeMB=', (fs.statSync(outFile).size / 1048576).toFixed(1));
