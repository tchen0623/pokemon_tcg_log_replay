// parser.js — PTCGL battle log → structured action list.
// Design rules:
//  1. Every input line maps to exactly one parsed node; anything unmatched
//     becomes { kind: 'raw', unparsed: true } and is NEVER silently dropped.
//  2. Player tags like "[fgh] Gzyyyyyy" are normalized (tag stripped).
//  3. Damage counters are stored in *counters* (1 counter = 10 damage);
//     display converts explicitly, avoiding the counter/damage unit mix-up.
//  4. All three win conditions are handled, including "Opponent conceded".

const APOS = "['’]";

export function normalizeLine(line) {
  return line
    .replace(/[’‘]/g, "'")          // curly → straight apostrophes
    .replace(/\[[^\]]{1,16}\]\s*/g, '') // strip team tags like [fgh]
    .trimEnd();
}

function m(line, re) { const r = line.match(re); return r || null; }

// Ordered matchers for "main" (non-dash) lines.
const MAIN = [
  { kind: 'setup', re: /^Setup$/ },
  { kind: 'coin_flip', re: new RegExp(`^(.+?) chose (heads|tails) for the opening coin flip\\.$`), f: r => ({ player: r[1], choice: r[2] }) },
  { kind: 'coin_win', re: /^(.+?) won the coin toss\.$/, f: r => ({ player: r[1] }) },
  { kind: 'first_choice', re: /^(.+?) decided to go (first|second)\.$/, f: r => ({ player: r[1], choice: r[2] }) },
  { kind: 'opening_hand', re: /^(.+?) drew (\d+) cards? for the opening hand\.$/, f: r => ({ player: r[1], count: +r[2] }) },
  { kind: 'mulligan', re: /^(.+?) took a mulligan\.$/, f: r => ({ player: r[1] }) },
  { kind: 'mulligan_draw', re: /^(.+?) drew (\d+) more cards? because .+? took at least \d+ mulligan/, f: r => ({ player: r[1], count: +r[2] }) },
  { kind: 'turn_header', re: new RegExp(`^(.+?)${APOS}s Turn$`), f: r => ({ player: r[1] }) },
  { kind: 'draw', re: /^(.+?) drew a card\.$/, f: r => ({ player: r[1], card: null }) },
  { kind: 'draw_known', re: /^(.+?) drew ([A-Z][^.]+?)\.$/, f: r => ({ player: r[1], card: r[2] }) },
  { kind: 'play_active', re: /^(.+?) played (.+?) to the Active Spot\.$/, f: r => ({ player: r[1], card: r[2] }) },
  { kind: 'play_bench', re: /^(.+?) played (.+?) to the Bench\.$/, f: r => ({ player: r[1], card: r[2] }) },
  { kind: 'play_stadium', re: /^(.+?) played (.+?) to the Stadium spot\.$/, f: r => ({ player: r[1], card: r[2] }) },
  { kind: 'play_trainer', re: /^(.+?) played (.+?)\.$/, f: r => ({ player: r[1], card: r[2] }) },
  { kind: 'attach', re: /^(.+?) attached (.+?) to (.+?) (?:in|on) the (Active Spot|Bench)\.$/, f: r => ({ player: r[1], card: r[2], target: r[3], zone: r[4] }) },
  { kind: 'evolve', re: /^(.+?) evolved (.+?) to (.+?) (?:in|on) the (Active Spot|Bench)\.$/, f: r => ({ player: r[1], from: r[2], to: r[3], zone: r[4] }) },
  { kind: 'retreat', re: /^(.+?) retreated (.+?) to the Bench\.$/, f: r => ({ player: r[1], card: r[2] }) },
  { kind: 'promote', re: new RegExp(`^(.+?)${APOS}s (.+?) is now in the Active Spot\\.$`), f: r => ({ player: r[1], card: r[2] }) },
  { kind: 'attack_weak', re: new RegExp(`^(.+?)${APOS}s (.+?) used (.+?) on (.+?)${APOS}s (.+?) for (\\d+) damage\\. (.+?)${APOS}s (.+?) took (\\d+) more damage because of (.+?) Weakness\\.$`),
    f: r => ({ player: r[1], mon: r[2], attack: r[3], targetOwner: r[4], target: r[5], damage: +r[6], extra: { owner: r[7], mon: r[8], damage: +r[9], weakness: r[10] } }) },
  { kind: 'attack', re: new RegExp(`^(.+?)${APOS}s (.+?) used (.+?) on (.+?)${APOS}s (.+?) for (\\d+) damage\\.?$`),
    f: r => ({ player: r[1], mon: r[2], attack: r[3], targetOwner: r[4], target: r[5], damage: +r[6] }) },
  { kind: 'ability', re: new RegExp(`^(.+?)${APOS}s (.+?) used (.+?)\\.$`), f: r => ({ player: r[1], mon: r[2], attack: r[3] }) },
  { kind: 'knockout', re: new RegExp(`^(.+?)${APOS}s (.+?) was Knocked Out!$`), f: r => ({ player: r[1], card: r[2] }) },
  { kind: 'prize', re: /^(.+?) took (?:a|(\d+)) Prize cards?\.$/, f: r => ({ player: r[1], count: r[2] ? +r[2] : 1 }) },
  { kind: 'card_to_hand', re: new RegExp(`^(.+?) was added to (.+?)${APOS}s hand\\.$`), f: r => ({ card: r[1], player: r[2] }) },
  { kind: 'end_turn', re: /^(.+?) ended their turn\.$/, f: r => ({ player: r[1] }) },
  { kind: 'win', re: /^Opponent conceded\. (.+?) wins\.$/, f: r => ({ winner: r[1], reason: 'concede' }) },
  { kind: 'win', re: /^Opponent took all of their Prize cards\. (.+?) wins\.$/, f: r => ({ winner: r[1], reason: 'prizes' }) },
  { kind: 'win', re: /^Knocked Out with no Benched Pokémon\. (.+?) wins\.$/, f: r => ({ winner: r[1], reason: 'no_bench' }) },
  { kind: 'activated', re: /^(.+?) was activated\.$/, f: r => ({ card: r[1] }) },
  { kind: 'discarded_from', re: new RegExp(`^(.+?) was discarded from (.+?)${APOS}s (.+?)\\.$`), f: r => ({ card: r[1], player: r[2], mon: r[3] }) },
  { kind: 'vstar_used', re: /^(.+?) can no longer use VSTAR Powers\.$/, f: r => ({ player: r[1] }) },
  { kind: 'damage_counter_passive', re: new RegExp(`^(.+?)${APOS}s (.+?) took (\\d+) damage \\((.+?)\\)\\.$`), f: r => ({ player: r[1], mon: r[2], damage: +r[3], cause: r[4] }) },
];

// Matchers for dash sub-lines ("- ...") and bullets ("• ...").
const SUB = [
  { kind: 'sub_draw_count', re: /^(\d+) drawn cards\.$/, f: r => ({ count: +r[1] }) },
  { kind: 'sub_mulligan_reveal', re: /^Cards revealed from Mulligan (\d+)$/, f: r => ({ n: +r[1] }) },
  { kind: 'sub_move_to_lostzone', re: new RegExp(`^(.+?) moved (.+?)${APOS}s (.+?) to the Lost Zone\\.$`), f: r => ({ player: r[1], owner: r[2], card: r[3] }) },
  { kind: 'sub_draw', re: /^(.+?) drew a card\.$/, f: r => ({ player: r[1], count: 1 }) },
  { kind: 'sub_draw', re: /^(.+?) drew (\d+) cards\.$/, f: r => ({ player: r[1], count: +r[2] }) },
  { kind: 'sub_attach', re: /^(.+?) attached (.+?) to (.+?) (?:in|on) the (Active Spot|Bench)\.$/, f: r => ({ player: r[1], card: r[2], target: r[3], zone: r[4] }) },
  { kind: 'sub_draw_to_bench_multi', re: /^(.+?) drew (\d+) cards? and played them to the Bench\.$/, f: r => ({ player: r[1], count: +r[2] }) },
  { kind: 'sub_draw_to_bench', re: /^(.+?) drew (.+?) and played it to the (Bench|Active Spot)\.$/, f: r => ({ player: r[1], card: r[2], zone: r[3] }) },
  { kind: 'sub_draw_known', re: /^(.+?) drew ([A-Z][^.]+?)\.$/, f: r => ({ player: r[1], card: r[2] }) },
  { kind: 'sub_shuffle_deck', re: /^(.+?) shuffled their deck\.$/, f: r => ({ player: r[1] }) },
  { kind: 'sub_shuffle_hand', re: /^(.+?) shuffled their hand\.$/, f: r => ({ player: r[1] }) },
  { kind: 'sub_shuffle_in', re: /^(.+?) shuffled (a|\d+) cards? into their deck\.$/, f: r => ({ player: r[1], count: r[2] === 'a' ? 1 : +r[2] }) },
  { kind: 'sub_discard_count', re: /^(.+?) discarded (\d+) cards\.$/, f: r => ({ player: r[1], count: +r[2] }) },
  { kind: 'sub_discard_from_stack', re: new RegExp(`^(\\d+) cards? (?:was|were) discarded from (.+?)${APOS}s (.+?)\\.$`), f: r => ({ count: +r[1], player: r[2], mon: r[3] }) },
  { kind: 'sub_discard_known', re: /^(.+?) discarded ([^.]+?)\.$/, f: r => ({ player: r[1], card: r[2] }) },
  { kind: 'sub_put_counters', re: new RegExp(`^(.+?) put (a|\\d+) damage counters? on (.+?)${APOS}s (.+?)\\.$`),
    f: r => ({ player: r[1], counters: r[2] === 'a' ? 1 : +r[2], targetOwner: r[3], target: r[4] }) },
  { kind: 'sub_move_counters', re: new RegExp(`^(.+?) moved (a|\\d+) damage counters? from (.+?)${APOS}s (.+?) to (.+?)${APOS}s (.+?)\\.$`),
    f: r => ({ player: r[1], counters: r[2] === 'a' ? 1 : +r[2], fromOwner: r[3], from: r[4], toOwner: r[5], to: r[6] }) },
  { kind: 'sub_status_on', re: new RegExp(`^(.+?)${APOS}s (.+?) is now (Poisoned|Burned|Asleep|Confused|Paralyzed)\\.$`), f: r => ({ player: r[1], mon: r[2], status: r[3] }) },
  { kind: 'sub_status_off', re: new RegExp(`^(.+?)${APOS}s (.+?) is no longer (Poisoned|Burned|Asleep|Confused|Paralyzed)\\.$`), f: r => ({ player: r[1], mon: r[2], status: r[3] }) },
  { kind: 'sub_status_damage', re: new RegExp(`^(a|\\d+) damage counters? (?:was|were) placed on (.+?)${APOS}s (.+?) for the Special Condition (.+?)\\.$`),
    f: r => ({ counters: r[1] === 'a' ? 1 : +r[1], player: r[2], mon: r[3], status: r[4] }) },
  { kind: 'sub_switch', re: new RegExp(`^(.+?)${APOS}s (.+?) was switched with (.+?)${APOS}s (.+?) to become the Active Pokémon\\.$`),
    f: r => ({ player: r[1], out: r[2], inOwner: r[3], inn: r[4] }) },
  { kind: 'sub_move_to_hand_count', re: new RegExp(`^(.+?) moved (.+?)${APOS}s (\\d+) cards? to their hand\\.$`), f: r => ({ player: r[1], owner: r[2], count: +r[3] }) },
  { kind: 'sub_move_to_deck_count', re: new RegExp(`^(.+?) moved (.+?)${APOS}s (\\d+) cards? to their deck\\.$`), f: r => ({ player: r[1], owner: r[2], count: +r[3] }) },
  { kind: 'sub_move_card_to_hand', re: new RegExp(`^(.+?) moved (.+?)${APOS}s (.+?) to their hand\\.$`), f: r => ({ player: r[1], owner: r[2], card: r[3] }) },
  { kind: 'sub_move_to_bench', re: new RegExp(`^(.+?) moved (.+?)${APOS}s (.+?) to the Bench\\.$`), f: r => ({ player: r[1], owner: r[2], card: r[3] }) },
  { kind: 'sub_move_to_discard', re: new RegExp(`^(.+?) moved (.+?)${APOS}s (.+?) to the discard pile\\.$`), f: r => ({ player: r[1], owner: r[2], card: r[3] }) },
  { kind: 'sub_bottom_deck', re: /^(.+?) put (a|\d+) cards? on the bottom of their deck\.$/, f: r => ({ player: r[1], count: r[2] === 'a' ? 1 : +r[2] }) },
  { kind: 'sub_ko_discard', re: new RegExp(`^(\\d+) cards? (?:was|were) discarded from (.+?)${APOS}s (.+?)\\.$`), f: r => ({ count: +r[1], player: r[2], mon: r[3] }) },
  { kind: 'sub_discarded_from', re: new RegExp(`^(.+?) (?:was|were) discarded from (.+?)${APOS}s (.+?)\\.$`), f: r => ({ card: r[1], player: r[2], mon: r[3] }) },
  { kind: 'sub_evolve', re: /^(.+?) evolved (.+?) to (.+?) (?:in|on) the (Active Spot|Bench)\.$/, f: r => ({ player: r[1], from: r[2], to: r[3], zone: r[4] }) },
  { kind: 'sub_heal', re: new RegExp(`^(.+?)${APOS}s (.+?) healed (\\d+) damage\\.$`), f: r => ({ player: r[1], mon: r[2], amount: +r[3] }) },
  { kind: 'sub_devolve', re: new RegExp(`^(.+?) devolved (.+?)${APOS}s (.+?) to (.+?) (?:in|on) the (Active Spot|Bench)\\.$`),
    f: r => ({ player: r[1], owner: r[2], from: r[3], to: r[4], zone: r[5] }) },
  { kind: 'sub_damage_breakdown', re: /^Damage breakdown:$/ },
  { kind: 'sub_breakdown_base', re: /^\s*Base damage: (\d+) damage$/, f: r => ({ base: +r[1] }) },
  { kind: 'sub_breakdown_weak', re: /^\s*Weakness to (.+): (\d+) damage$/, f: r => ({ type: r[1], amount: +r[2] }) },
  { kind: 'sub_breakdown_resist', re: /^\s*Resistance to (.+): -?(\d+) damage$/, f: r => ({ type: r[1], amount: +r[2] }) },
  { kind: 'sub_breakdown_total', re: /^\s*Total damage: (\d+) damage$/, f: r => ({ total: +r[1] }) },
];

function parseSub(raw) {
  for (const { kind, re, f } of SUB) {
    const r = m(raw, re);
    if (r) return { kind, text: raw, ...(f ? f(r) : {}) };
  }
  return { kind: 'raw', text: raw, unparsed: true };
}

export function parseLog(text) {
  const rawLines = text.split(/\r?\n/);
  const actions = [];
  let players = [];
  let turn = 0;
  let current = null; // current main action collecting subs
  let pendingBulletsFor = null;

  const notePlayer = (name) => {
    if (name && !players.includes(name) && players.length < 2) players.push(name);
  };

  for (let li = 0; li < rawLines.length; li++) {
    const line = normalizeLine(rawLines[li]);
    if (!line.trim()) continue;

    // bullet list: attach to most recent action (aggregate, for UI) AND to the
    // specific line it follows (ownBullets, for engine ownership semantics)
    const bullet = line.match(/^\s*•\s+(.+)$/);
    if (bullet && !/^(Base damage|Weakness to|Resistance to|Total damage)/.test(bullet[1])) {
      const cards = bullet[1].split(',').map(s => s.trim()).filter(Boolean);
      if (current) {
        current.bullets = (current.bullets || []).concat(cards);
        const target = current.subs.length ? current.subs[current.subs.length - 1] : current;
        target.ownBullets = (target.ownBullets || []).concat(cards);
      }
      continue;
    }
    // breakdown bullets (no leading dash)
    const bb = line.match(/^\s*•\s+(Base damage|Weakness to|Resistance to|Total damage)(.+)$/);
    if (bb) {
      const sub = parseSub(`${bb[1]}${bb[2]}`);
      if (current) current.subs.push(sub);
      continue;
    }

    // dash sub-line
    const dash = line.match(/^\s*-\s+(.+)$/);
    if (dash) {
      const sub = parseSub(dash[1]);
      if (current) current.subs.push(sub);
      else actions.push({ i: actions.length, kind: 'raw', text: dash[1], subs: [], unparsed: true, turn });
      continue;
    }

    // main line
    let node = null;
    for (const { kind, re, f } of MAIN) {
      const r = m(line, re);
      if (r) { node = { kind, ...(f ? f(r) : {}) }; break; }
    }
    if (!node) node = { kind: 'raw', unparsed: true };

    if (node.player) notePlayer(node.player);
    if (node.winner) notePlayer(node.winner);
    if (node.kind === 'turn_header') { turn += 1; node.turnNumber = turn; }

    current = { i: actions.length, turn, text: line, subs: [], ...node };
    actions.push(current);
  }

  return { players, actions, totalTurns: turn };
}
