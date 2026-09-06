// engine.js — replays parsed actions into per-step board states.
// Fixes vs ptcglreplay.com:
//  • damage tracked in COUNTERS (×10 for display), no unit confusion
//  • "Opponent conceded" and all other win conditions produce a game-over state
//  • owner mis-attribution in the log (e.g. Phantom Dive counter lines) is
//    corrected by board state (if the named owner has no such Pokémon, the
//    opponent's is used)
//  • every card stack tracks: evolution chain, attached energy, tools,
//    damage counters, status conditions → remaining HP is derivable

const MAX_BENCH = 5;

const clone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));

function newPlayer(name) {
  return { name, deckCount: 60, hand: [], prizeCount: 6, discard: [], active: null, bench: [], vstarUsed: false };
}
function newStack(card) {
  return { cards: [card], energy: [], tools: [], counters: 0, status: [] };
}

export function buildGame(parsed, cardDb) {
  const names = parsed.players.slice(0, 2);
  const state = {
    turn: 0,
    activePlayer: null,
    firstPlayer: null,
    stadium: null,
    lostZone: [],        // [{ card, owner }]
    players: names.map(newPlayer),
    gameOver: null,
  };
  let pendingStadiumDiscard = null; // stadium replaced this action; sub-line may consume it

  const stats = {}; const decklists = {};
  for (const n of names) {
    stats[n] = { drawn: 0, damageDealt: 0, kos: 0, prizesTaken: 0, supporters: 0 };
    decklists[n] = {};
  }

  const P = (name) => state.players.find(p => p.name === name) || null;
  const other = (name) => state.players.find(p => p.name !== name) || null;

  const isEnergy = (card) => /Energy$/i.test(card);
  const isPokemon = (card) => {
    const c = cardDb[card];
    return c ? c.category === 'Pokemon' : /(?:^| )(ex|V|VMAX|VSTAR|GX|EX)$/.test(card) || !!findAnyStackByName(card);
  };

  // ---- stack lookup with owner mis-attribution fix ----
  // NOTE: a card name always refers to the TOP of a stack (the current Pokémon).
  // Matching an evolution line's base card must never select the whole stack.
  function findStack(playerName, mon, zone) {
    const pl = P(playerName);
    if (!pl) return null;
    const inActive = pl.active && topName(pl.active) === mon;
    if (zone === 'Active Spot') return inActive ? { owner: pl, stack: pl.active, loc: 'active' } : null;
    if (zone === 'Bench') return findBench(pl, mon);
    if (inActive) return { owner: pl, stack: pl.active, loc: 'active' };
    return findBench(pl, mon);
  }
  function findBench(pl, mon) {
    // two passes: exact top-card match first, then (rare) base-card match;
    // within a pass prefer the least-developed copy
    for (const pass of [s => topName(s) === mon, s => s.cards.includes(mon)]) {
      let best = null;
      for (let i = 0; i < pl.bench.length; i++) {
        const s = pl.bench[i];
        if (pass(s)) {
          const score = s.energy.length * 10 + s.counters;
          if (!best || score < best.score) best = { owner: pl, stack: s, loc: 'bench', idx: i, score };
        }
      }
      if (best) return best;
    }
    return null;
  }
  function findAnyStackByName(mon) {
    for (const pl of state.players) {
      if (pl.active && topName(pl.active) === mon) return { owner: pl, stack: pl.active, loc: 'active' };
      const b = findBench(pl, mon);
      if (b) return b;
    }
    return null;
  }
  const topName = (stack) => stack.cards[stack.cards.length - 1];

  // resolve target owner: if claimed owner has no such mon but the other side does, swap
  function resolveMon(claimedOwner, mon, zone) {
    let hit = findStack(claimedOwner, mon, zone);
    if (hit) return hit;
    const alt = other(claimedOwner);
    if (alt) {
      hit = findStack(alt.name, mon, zone);
      if (hit) return { ...hit, corrected: true };
    }
    return null;
  }

  // ---- hand helpers ----
  function handRemove(pl, card) {
    if (!pl) return;
    if (card) {
      const i = pl.hand.findIndex(h => h === card);
      if (i >= 0) { pl.hand.splice(i, 1); return; }
    }
    const j = pl.hand.indexOf(null);
    if (j >= 0) pl.hand.splice(j, 1);
  }
  function handRemoveMany(pl, count, bullets) {
    for (const b of bullets || []) { handRemove(pl, b); count--; }
    while (count-- > 0) handRemove(pl, null);
  }
  const handAdd = (pl, card) => { if (pl) pl.hand.push(card || null); };

  function known(plName, card) {
    if (!card || !decklists[plName]) return;
    decklists[plName][card] = (decklists[plName][card] || 0) + 1;
  }

  function discardStack(pl, stack) {
    for (const c of [...stack.cards, ...stack.energy, ...stack.tools]) pl.discard.push(c);
  }

  function attachCard(pl, card, target, zone) {
    const hit = resolveMon(pl.name, target, zone) || (pl.active ? { owner: pl, stack: pl.active, loc: 'active' } : null);
    if (!hit) return;
    if (isEnergy(card)) hit.stack.energy.push(card); else hit.stack.tools.push(card);
    handRemove(pl, card);
    known(pl.name, card);
  }

  function evolveStack(pl, from, to, zone) {
    const hit = resolveMon(pl.name, from, zone);
    if (hit) { hit.stack.cards.push(to); hit.stack.status = []; }
    handRemove(pl, to);
    known(pl.name, to);
  }

  // 主视角(导出日志的玩家): 回合开始的具名抽牌只对该玩家可见
  let viewerName = null;

  // PTCGL 日志怪癖: 双人手牌效果(Iono/Judge/Unfair Stamp 等)的结算行署名是效果控制者,
  // 真正的归属要看子弹列表(明牌=主视角的牌)。无子弹且署名玩家本轮已结算过 → 归属另一位玩家。
  function mpReassign(a, s, statedName, category) {
    if (!a._mp || !viewerName || !statedName) return statedName;
    if (s.ownBullets && s.ownBullets.length) return viewerName;
    const done = category === 'draw' ? a._mp.drawDone : a._mp.emptyDone;
    if (done[statedName]) { const o = other(statedName); return o ? o.name : statedName; }
    return statedName;
  }

  function applySub(a, s) {
    const pl = s.player ? P(s.player) : (a.player ? P(a.player) : null);
    switch (s.kind) {
      case 'sub_draw': {
        const ownerName = mpReassign(a, s, s.player || a.player, 'draw');
        const dp = ownerName ? P(ownerName) : pl;
        if (dp) {
          if (a._mp) a._mp.drawDone[dp.name] = true;
          dp.deckCount = Math.max(0, dp.deckCount - s.count);
          const bullets = s.ownBullets || [];
          for (let i = 0; i < s.count; i++) {
            const named = bullets[i];
            handAdd(dp, named || null);
            if (named) known(dp.name, named);
          }
          stats[dp.name].drawn += s.count;
        }
        break;
      }
      case 'sub_draw_known':
        if (pl) { pl.deckCount = Math.max(0, pl.deckCount - 1); handAdd(pl, s.card); known(pl.name, s.card); stats[pl.name].drawn++; }
        break;
      case 'sub_draw_to_bench_multi': {
        if (!pl) break;
        pl.deckCount = Math.max(0, pl.deckCount - s.count);
        const bullets = s.ownBullets || [];
        for (let i = 0; i < s.count; i++) {
          const card = bullets[i];
          if (card && pl.bench.length < MAX_BENCH + 1) { pl.bench.push(newStack(card)); known(pl.name, card); }
        }
        break;
      }
      case 'sub_draw_to_bench': {
        if (!pl) break;
        pl.deckCount = Math.max(0, pl.deckCount - 1);
        if (s.zone === 'Bench' && pl.bench.length < MAX_BENCH + 1) pl.bench.push(newStack(s.card));
        else if (s.zone === 'Active Spot' && !pl.active) pl.active = newStack(s.card);
        known(pl.name, s.card);
        break;
      }
      case 'sub_shuffle_in': case 'sub_bottom_deck': {
        const ownerName = mpReassign(a, s, s.player || a.player, 'empty');
        const ep = ownerName ? P(ownerName) : pl;
        if (ep) {
          if (a._mp) a._mp.emptyDone[ep.name] = true;
          ep.deckCount += s.count; handRemoveMany(ep, s.count, s.ownBullets);
        }
        break;
      }
      case 'sub_move_to_deck_count': {
        const ownerName = mpReassign(a, s, s.owner || s.player || a.player, 'empty');
        const owner = P(ownerName) || pl;
        if (owner) {
          if (a._mp) a._mp.emptyDone[owner.name] = true;
          owner.deckCount += s.count; handRemoveMany(owner, s.count, s.ownBullets);
        }
        break;
      }
      case 'sub_move_to_hand_count': break; // count-neutral; bullets handled elsewhere
      case 'sub_move_card_to_hand': {
        const owner = P(s.owner);
        if (owner) {
          // Case A: card is on the board (Professor Turo's Scenario) — the WHOLE stack returns
          const hit = findStack(owner.name, s.card) ||
            (owner.active && owner.active.cards.includes(s.card) ? { stack: owner.active, loc: 'active' } : null) ||
            findBench(owner, s.card);
          if (hit) {
            for (const c of [...hit.stack.cards, ...hit.stack.energy, ...hit.stack.tools]) { handAdd(owner, c); known(owner.name, c); }
            if (hit.loc === 'active') owner.active = null;
            else owner.bench.splice(hit.idx, 1);
          } else {
            // Case B: card is in the discard pile (Night Stretcher) — move it back
            const di = owner.discard.indexOf(s.card);
            if (di >= 0) owner.discard.splice(di, 1);
            handAdd(owner, s.card); known(owner.name, s.card);
          }
        }
        break;
      }
      case 'sub_move_to_lostzone': {
        const owner = P(s.owner) || pl;
        if (owner) {
          // from hand, or the stadium in play
          const hi = owner.hand.indexOf(s.card);
          if (hi >= 0) owner.hand.splice(hi, 1);
          if (state.stadium && state.stadium.card === s.card) state.stadium = null;
          if (pendingStadiumDiscard && pendingStadiumDiscard.card === s.card) pendingStadiumDiscard = null;
          state.lostZone.push({ card: s.card, owner: owner.name });
          known(owner.name, s.card);
        }
        break;
      }
      case 'sub_discard_count':
        if (pl) {
          const bullets = s.ownBullets || [];
          for (const b of bullets) { handRemove(pl, b); pl.discard.push(b); known(pl.name, b); }
          let rest = s.count - bullets.length;
          while (rest-- > 0) { handRemove(pl, null); pl.discard.push(null); }
        }
        break;
      case 'sub_discard_known':
        if (pl) {
          // comma-separated multi-card discards ("discarded A, B")
          for (const part of s.card.split(',').map(x => x.trim()).filter(Boolean)) {
            // a stadium being replaced/destroyed?
            if (pendingStadiumDiscard && pendingStadiumDiscard.card === part) {
              const own = P(pendingStadiumDiscard.owner);
              if (own) own.discard.push(part);
              pendingStadiumDiscard = null;
              continue;
            }
            if (state.stadium && state.stadium.card === part) {
              const own = P(state.stadium.owner);
              if (own) own.discard.push(part);
              state.stadium = null;
              continue;
            }
            handRemove(pl, part); pl.discard.push(part); known(pl.name, part);
          }
        }
        break;
      case 'sub_put_counters': {
        // log bug workaround: splash-damage lines (e.g. Phantom Dive) are written
        // with the ATTACKER as the owner — real target is the defending side.
        let hit = null;
        if (a.player && s.targetOwner === a.player) {
          const def = other(a.player);
          if (def) hit = findStack(def.name, s.target);
        }
        if (!hit) hit = resolveMon(s.targetOwner, s.target);
        if (hit) {
          hit.stack.counters += s.counters;
          const attacker = a.player && P(a.player);
          if (attacker && hit.owner.name !== attacker.name) stats[attacker.name].damageDealt += s.counters * 10;
        }
        break;
      }
      case 'sub_move_counters': {
        // Adrena-Brain style: from attacker's own Pokémon to the opponent's
        const src = (a.player ? findStack(a.player, s.from) : null) || resolveMon(s.fromOwner, s.from);
        const dst = (a.player && other(a.player) ? findStack(other(a.player).name, s.to) : null) || resolveMon(s.toOwner, s.to);
        if (src && dst) {
          const mv = Math.min(src.stack.counters, s.counters);
          src.stack.counters -= mv; dst.stack.counters += mv;
        }
        break;
      }
      case 'sub_status_on': {
        const hit = resolveMon(s.player, s.mon);
        if (hit && !hit.stack.status.includes(s.status)) hit.stack.status.push(s.status);
        break;
      }
      case 'sub_status_off': {
        const hit = resolveMon(s.player, s.mon);
        if (hit) hit.stack.status = hit.stack.status.filter(x => x !== s.status);
        break;
      }
      case 'sub_status_damage': {
        const hit = resolveMon(s.player, s.mon);
        if (hit) hit.stack.counters += s.counters;
        break;
      }
      case 'sub_switch': {
        const owner = P(s.player);
        if (owner && owner.active) {
          const outStack = owner.active;
          const inn = findBench(owner, s.inn);
          if (inn) {
            owner.active = inn.stack;
            owner.bench.splice(inn.idx, 1);
            if (owner.bench.length < MAX_BENCH) owner.bench.push(outStack);
          }
        }
        break;
      }
      case 'sub_evolve': if (pl) evolveStack(pl, s.from, s.to, s.zone); break;
      case 'sub_attach': {
        // effect-driven attachment (e.g. Crispin) — card comes from the deck, not the hand
        if (pl) {
          const hit = resolveMon(pl.name, s.target, s.zone);
          if (hit) {
            if (isEnergy(s.card)) { hit.stack.energy.push(s.card); pl.deckCount = Math.max(0, pl.deckCount - 1); }
            else hit.stack.tools.push(s.card);
            known(pl.name, s.card);
          }
        }
        break;
      }
      case 'sub_heal': {
        const hit = resolveMon(s.player, s.mon);
        if (hit) hit.stack.counters = Math.max(0, hit.stack.counters - s.amount / 10);
        break;
      }
      case 'sub_devolve': {
        const hit = resolveMon(s.owner, s.from, s.zone);
        if (hit && hit.stack.cards.length > 1) {
          const popped = hit.stack.cards.pop();
          handAdd(hit.owner, popped); // devolved card returns to its owner's hand
          hit.stack.counters = hit.stack.counters; // damage persists
        }
        break;
      }
      case 'sub_discarded_from': {
        const hit = resolveMon(s.player, s.mon);
        if (hit) {
          for (const part of s.card.split(',').map(x => x.trim()).filter(Boolean)) {
            let i = hit.stack.tools.indexOf(part);
            if (i >= 0) { hit.stack.tools.splice(i, 1); hit.owner.discard.push(part); continue; }
            i = hit.stack.energy.indexOf(part);
            if (i >= 0) { hit.stack.energy.splice(i, 1); hit.owner.discard.push(part); }
          }
        }
        break;
      }
      case 'sub_ko_discard': break; // KO handler already moved the whole stack
      case 'sub_discard_from_stack': break; // informational echo of a KO's stack discard (already applied)
      case 'sub_shuffle_deck': case 'sub_shuffle_hand': break;
      case 'sub_draw_count': break;
      case 'sub_damage_breakdown': case 'sub_breakdown_base': case 'sub_breakdown_weak':
      case 'sub_breakdown_resist': case 'sub_breakdown_total': break; // display-only
      default: break;
    }
  }

  const states = [clone(state)];
  const meta = parsed.actions;

  // 推断主视角: 主行具名抽牌(回合开始抽的那张)只对导出日志的玩家可见
  const dkCount = {};
  for (const a of meta) if (a.kind === 'draw_known') dkCount[a.player] = (dkCount[a.player] || 0) + 1;
  viewerName = Object.entries(dkCount).sort((x, y) => y[1] - x[1])[0]?.[0] || null;

  const EMPTY_KINDS = new Set(['sub_shuffle_in', 'sub_bottom_deck', 'sub_move_to_deck_count']);
  for (const a of meta) {
    // 双人手牌效果(Iono/Judge/Unfair Stamp…)标记: 触发子弹归属重分配
    const empties = a.subs.filter(s => EMPTY_KINDS.has(s.kind)).length;
    const shuffleHands = a.subs.filter(s => s.kind === 'sub_shuffle_hand').length;
    const draws = a.subs.filter(s => s.kind === 'sub_draw').length;
    a._mp = viewerName && (empties >= 2 || (empties >= 1 && shuffleHands >= 2) || (empties >= 1 && draws >= 2))
      ? { emptyDone: {}, drawDone: {} } : null;

    const pl = a.player ? P(a.player) : null;

    switch (a.kind) {
      case 'coin_win': break;
      case 'first_choice':
        state.firstPlayer = a.choice === 'first' ? a.player : (other(a.player) || {}).name || null;
        break;
      case 'opening_hand': {
        if (pl) {
          pl.deckCount = Math.max(0, pl.deckCount - a.count);
          const bullets = a.bullets || [];
          for (let i = 0; i < a.count; i++) {
            const named = bullets[i];
            handAdd(pl, named || null);
            if (named) known(pl.name, named);
          }
          stats[pl.name].drawn += a.count;
        }
        break;
      }
      case 'mulligan': {
        // hand shuffled back, fresh 7 drawn; the reveal bullets name the new hand
        if (pl) {
          pl.deckCount += pl.hand.length;
          pl.hand = [];
          pl.deckCount = Math.max(0, pl.deckCount - 7);
          const bullets = a.bullets || [];
          for (let i = 0; i < 7; i++) {
            const named = bullets[i];
            handAdd(pl, named || null);
            if (named) known(pl.name, named);
          }
        }
        break;
      }
      case 'mulligan_draw': {
        // 随后通常跟一条具名/匿名抽牌子行(它已完整入账), 避免重复加牌
        const covered = a.subs.some(s => s.kind === 'sub_draw_known' || s.kind === 'sub_draw');
        if (pl && !covered) { pl.deckCount = Math.max(0, pl.deckCount - a.count); for (let i = 0; i < a.count; i++) handAdd(pl, null); stats[pl.name].drawn += a.count; }
        break;
      }
      case 'discarded_from': break; // informational echo of a KO's stack discard (already applied)
      case 'vstar_used': if (pl) pl.vstarUsed = true; break;
      case 'turn_header':
        state.turn = a.turnNumber; state.activePlayer = a.player;
        break;
      case 'draw':
        if (pl) { pl.deckCount = Math.max(0, pl.deckCount - 1); handAdd(pl, null); stats[pl.name].drawn++; }
        break;
      case 'draw_known':
        if (pl) { pl.deckCount = Math.max(0, pl.deckCount - 1); handAdd(pl, a.card); known(pl.name, a.card); stats[pl.name].drawn++; }
        break;
      case 'play_active':
        if (pl) { if (!pl.active) pl.active = newStack(a.card); handRemove(pl, a.card); known(pl.name, a.card); }
        break;
      case 'play_bench':
        if (pl) { if (pl.bench.length < MAX_BENCH + 1) pl.bench.push(newStack(a.card)); handRemove(pl, a.card); known(pl.name, a.card); }
        break;
      case 'play_stadium': {
        if (state.stadium && state.stadium.owner) {
          // defer: the following "- discarded X" sub-line may refer to the old stadium
          pendingStadiumDiscard = { card: state.stadium.card, owner: state.stadium.owner };
        }
        if (pl) { state.stadium = { card: a.card, owner: pl.name }; handRemove(pl, a.card); known(pl.name, a.card); }
        break;
      }
      case 'play_trainer':
        if (pl) {
          handRemove(pl, a.card); known(pl.name, a.card);
          const cd = cardDb[a.card];
          if (cd && cd.category === 'Trainer' && /Supporter/i.test(cd.trainerType || '')) stats[pl.name].supporters++;
          // trainer resolves then goes to discard (tools use 'attach' lines instead)
          if (!a.subs.some(s => s.kind === 'sub_discarded_from')) pl.discard.push(a.card);
        }
        break;
      case 'attach': if (pl) attachCard(pl, a.card, a.target, a.zone); break;
      case 'evolve': if (pl) evolveStack(pl, a.from, a.to, a.zone); break;
      case 'retreat': {
        if (pl && pl.active) {
          const st = pl.active;
          pl.active = null;
          // allow transient overflow: the promotion line that follows frees a slot
          pl.bench.push(st);
        }
        break;
      }
      case 'promote': {
        if (pl) {
          const hit = findBench(pl, a.card);
          if (hit) {
            pl.bench.splice(hit.idx, 1);
            if (pl.active && pl.bench.length < MAX_BENCH) pl.bench.push(pl.active);
            pl.active = hit.stack;
          }
        }
        break;
      }
      case 'attack': case 'attack_weak': {
        if (pl) {
          const hit = resolveMon(a.targetOwner, a.target);
          if (hit) { hit.stack.counters += a.damage / 10; stats[pl.name].damageDealt += a.damage; }
          if (a.extra) {
            const h2 = resolveMon(a.extra.owner, a.extra.mon);
            if (h2) { h2.stack.counters += a.extra.damage / 10; stats[pl.name].damageDealt += a.extra.damage; }
          }
        }
        break;
      }
      case 'damage_counter_passive': {
        const hit = resolveMon(a.player, a.mon);
        if (hit) hit.stack.counters += a.damage / 10;
        break;
      }
      case 'ability': break;
      case 'knockout': {
        const victim = P(a.player);
        if (victim) {
          let stack = null;
          // a KO always names the stack's TOP (current) Pokémon
          if (victim.active && topName(victim.active) === a.card) {
            stack = victim.active; victim.active = null;
          } else {
            // among same-named bench copies, the KO'd one is the most damaged
            let best = null;
            for (let i = 0; i < victim.bench.length; i++) {
              const s = victim.bench[i];
              if (topName(s) === a.card && (!best || s.counters > best.stack.counters))
                best = { stack: s, idx: i };
            }
            if (!best) {
              const hit = findBench(victim, a.card);
              if (hit) best = hit;
            }
            if (best) { stack = best.stack; victim.bench.splice(best.idx, 1); }
          }
          if (stack) discardStack(victim, stack);
          const opp = other(victim.name);
          if (opp) stats[opp.name].kos++;
        }
        break;
      }
      case 'prize':
        if (pl) { pl.prizeCount = Math.max(0, pl.prizeCount - a.count); stats[pl.name].prizesTaken += a.count; }
        break;
      case 'card_to_hand': {
        const target = P(a.player);
        if (target) {
          // "A card was added to X's hand." = unknown prize; named cards are known
          if (/^a card$/i.test(a.card)) handAdd(target, null);
          else { handAdd(target, a.card); known(target.name, a.card); }
        }
        break;
      }
      case 'activated': break;
      case 'win':
        state.gameOver = { winner: a.winner, reason: a.reason };
        break;
      default: break;
    }

    for (const s of a.subs) applySub(a, s);
    delete a._bulletQueue;
    if (pendingStadiumDiscard) {
      // old stadium replaced without an explicit discard line — still goes to its owner's discard
      const own = P(pendingStadiumDiscard.owner);
      if (own) own.discard.push(pendingStadiumDiscard.card);
      pendingStadiumDiscard = null;
    }
    states.push(clone(state));
  }

  return {
    playerNames: names,
    states,
    actions: meta,
    stats,
    decklists,
    gameOver: state.gameOver,
    firstPlayer: state.firstPlayer,
  };
}

// ---- display helpers ----
export function hpOf(stack, cardDb) {
  const top = stack.cards[stack.cards.length - 1];
  const max = (cardDb[top] && cardDb[top].hp) || null;
  const dmg = stack.counters * 10;
  return { max, dmg, remaining: max == null ? null : Math.max(0, max - dmg) };
}

export function energyType(card) {
  const m2 = card.match(/(Grass|Fire|Water|Lightning|Psychic|Fighting|Darkness|Metal|Fairy|Dragon|Colorless)/i);
  return m2 ? m2[1] : null;
}
