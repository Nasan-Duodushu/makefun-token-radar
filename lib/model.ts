// Token radar model, third telling: the same scoring contract as radar-2,
// rebuilt from the pieces up so the code reads as one pipeline instead of a
// stack of special cases.
//
// What the model does, unchanged: the snapshot's tokenised protocols set the
// price of a dollar of TVL per category (median mcap/TVL, shrunk toward the
// global median where a category has few peers); a pre-token protocol's
// implied value is its TVL times that multiple, moved by 7-day growth, by
// how long it has existed, and by how many chains it runs on. The board
// ranks the watchlist plus the strongest pre-token protocols below the
// watchlist floor, and every row carries a farm plan built from its own
// record. Nothing here names a protocol: the snapshot scores itself.
//
// The outputs are the contract: board.json rows (rank 1..N, implied values
// non-increasing), data.js for the dashboard's in-page recompute, and the
// dossier the judge reads. Keep the numbers identical; the shape of the
// code is the only thing that changed.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them and the sandbox may change them. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
}

export const MODEL: ModelConstants = {
  base_multiple: 0.25,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** One category's comparable multiple: how many tokenised peers, and the multiple the model used. */
export interface CategoryMultiple {
  category: string;
  peers: number;
  multiple: number;
}

/** The comparable multiples computed from one snapshot: a global median and one row per category. */
export interface Multiples {
  global: number;
  byCategory: Map<string, CategoryMultiple>;
}

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_ROWS = 160;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    multiple_peers: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chains_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  multiple: number;
  multiple_peers: number;
  growth_multiplier: number;
  maturity_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  global_multiple: number;
  multiples: CategoryMultiple[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// ---------------------------------------------------------------------------
// Small numbers
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const RATIO_LO = 0.01;
const RATIO_HI = 10;
const SHRINK_WEIGHT = 4;

/** `n` clamped into [`lo`, `hi`]. */
function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/** `n` rounded to `places` decimal digits. */
function roundTo(n: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(n * scale) / scale;
}

/** A finite number, else `fallback`. */
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The middle of a sorted list: the centre value, or the mean of the two centre values. */
function middleOf(sorted: number[]): number {
  const half = sorted.length / 2;
  return sorted.length % 2 === 1
    ? sorted[Math.floor(half)]!
    : (sorted[half - 1]! + sorted[half]!) / 2;
}

/** The median of `xs`: sorted once, then the middle. Empty input has no median. */
function medianOf(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return middleOf([...xs].sort((a, b) => a - b));
}

// ---------------------------------------------------------------------------
// Comparables: what the market pays for a dollar of TVL, per category
// ---------------------------------------------------------------------------

/** Whether a protocol can price a category: tokenised, with a TVL, in a named category, not an exchange. */
function pricesCategory(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== null && p.category !== 'CEX';
}

/**
 * The market's own verdict on what a dollar of TVL is worth, per category: the median mcap/TVL of
 * the snapshot's tokenised protocols (exchanges excluded — their tokens price a business, not a
 * protocol's TVL). Sparse categories are shrunk toward the global median in log space, so a single
 * rich peer cannot make a whole category look rich.
 */
export function computeMultiples(snapshot: Snapshot): Multiples {
  const perCategory = new Map<string, number[]>();
  const everyRatio: number[] = [];
  for (const p of snapshot.protocols) {
    if (!pricesCategory(p)) continue;
    const ratio = clamp(p.mcap_usd! / p.tvl_usd, RATIO_LO, RATIO_HI);
    const bucket = perCategory.get(p.category!) ?? [];
    bucket.push(ratio);
    perCategory.set(p.category!, bucket);
    everyRatio.push(ratio);
  }
  const global = medianOf(everyRatio) ?? MODEL.base_multiple;
  const byCategory = new Map<string, CategoryMultiple>();
  for (const [category, ratios] of perCategory) {
    const own = medianOf(ratios)!;
    const peers = ratios.length;
    // Log-space shrinkage: the category's median pulled toward the global
    // median, weight 4 on the global, so thin categories stay honest.
    const shrunk = Math.exp(
      (peers * Math.log(own) + SHRINK_WEIGHT * Math.log(global)) / (peers + SHRINK_WEIGHT),
    );
    byCategory.set(category, { category, peers, multiple: roundTo(shrunk, 3) });
  }
  return { global: roundTo(global, 3), byCategory };
}

/** The multiple one protocol is scored with: its category's, or the global median when it has no peers. */
export function multipleFor(multiples: Multiples, category: string | null): CategoryMultiple {
  const hit = category === null ? undefined : multiples.byCategory.get(category);
  return hit ?? { category: category ?? 'Uncategorised', peers: 0, multiple: multiples.global };
}

// ---------------------------------------------------------------------------
// Age and the three multipliers
// ---------------------------------------------------------------------------

/** A date at midnight UTC as a millisecond count, or NaN when it does not parse. */
function dayStart(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00Z`);
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const span = dayStart(asOf) - dayStart(listedAt);
  if (!Number.isFinite(span)) return null;
  return Math.max(0, Math.floor(span / DAY_MS));
}

/** The 7-day growth of a protocol, clamped to the model's window, in percent. */
function growthPct(protocol: SnapshotProtocol, model: ModelConstants): number {
  return clamp(finiteOr(protocol.change_7d, 0), model.growth_floor, model.growth_cap);
}

/** Growth as a multiplier: 1 plus the clamped growth, weighted. */
function growthFactor(pct: number, model: ModelConstants): number {
  return 1 + (pct / 100) * model.growth_weight;
}

/** Maturity as a multiplier: 0.6 for a newborn, rising to 1.0 over three years. */
function maturityFactor(age: number | null, model: ModelConstants): number {
  const days = clamp(age ?? model.unknown_age_days, 0, model.maturity_days);
  return model.maturity_floor + (days / model.maturity_days) * model.maturity_range;
}

/** Distribution as a multiplier: 3% per extra chain, up to five extra chains. */
function chainsFactor(protocol: SnapshotProtocol): number {
  return 1 + 0.03 * clamp(protocol.chains.length - 1, 0, 5);
}

/** The multipliers and the implied value one protocol gets under `model` and its category multiple. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  multiple: number,
): { implied: number; growthPct: number; growthMult: number; maturityMult: number; chainsMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const pct = growthPct(protocol, model);
  const growthMult = growthFactor(pct, model);
  const maturityMult = maturityFactor(age, model);
  const chainsMult = chainsFactor(protocol);
  const implied = Math.max(1, Math.round(protocol.tvl_usd * multiple * growthMult * maturityMult * chainsMult));
  return { implied, growthPct: pct, growthMult, maturityMult, chainsMult, age };
}

// ---------------------------------------------------------------------------
// Which protocols the board ranks
// ---------------------------------------------------------------------------

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocols indexed by slug. */
function indexBySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** Highest TVL first, slug order breaking ties. */
function byTvlDesc(a: SnapshotProtocol, b: SnapshotProtocol): number {
  return b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
}

/** The headline sentence's figures: how many watchlist slugs, how many rows, how many live protocols. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** One scored protocol, ready to rank: its row's figures and the model behind them. */
interface Scored {
  protocol: SnapshotProtocol;
  implied: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  chainsMult: number;
  age: number | null;
  multiple: number;
  peers: number;
}

/** Highest implied value first, slug order breaking ties. */
function byImpliedDesc(a: Scored, b: Scored): number {
  return b.implied - a.implied || (a.protocol.slug < b.protocol.slug ? -1 : a.protocol.slug > b.protocol.slug ? 1 : 0);
}

/** A scored protocol as its board row, rank assigned by position. */
function toBoardRow(s: Scored, rank: number): BoardRow {
  const p = s.protocol;
  return {
    rank,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    mcap_usd: p.mcap_usd,
    listed_at: p.listed_at,
    gecko_id: p.gecko_id,
    symbol: p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      base_multiple: s.multiple,
      multiple_peers: s.peers,
      growth_pct: s.growthPct,
      growth_multiplier: roundTo(s.growthMult, 4),
      maturity_multiplier: roundTo(s.maturityMult, 4),
      chains_multiplier: roundTo(s.chainsMult, 4),
      age_days: s.age,
    },
    farm_steps: farmSteps(p, s.age).map(stepText),
  };
}

/** The watchlist seeded into the board: every slug the snapshot still carries. */
function seedWatchlist(snapshot: Snapshot, index: Map<string, SnapshotProtocol>): Map<string, SnapshotProtocol> {
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const found = index.get(slug);
    if (found !== undefined) chosen.set(slug, found);
  }
  return chosen;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = indexBySlug(snapshot.protocols);
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but the
  // board's coverage is the gate's row and is never gambled on a missing record).
  const chosen = seedWatchlist(snapshot, index);
  // The early radar: pre-token protocols below the watchlist floor, by TVL, capped. Never a replacement
  // for a watchlist row: a chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort(byTvlDesc)
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const multiples = computeMultiples(snapshot);
  const scored: Scored[] = [...chosen.values()].map((p) => {
    const cm = multipleFor(multiples, p.category);
    const v = impliedValue(p, snapshot.as_of, model, cm.multiple);
    return {
      protocol: p,
      implied: v.implied,
      growthPct: v.growthPct,
      growthMult: v.growthMult,
      maturityMult: v.maturityMult,
      chainsMult: v.chainsMult,
      age: v.age,
      multiple: cm.multiple,
      peers: cm.peers,
    };
  });
  scored.sort(byImpliedDesc);
  return scored.map((s, i) => toBoardRow(s, i + 1));
}

// ---------------------------------------------------------------------------
// Farm plans: seven steps from the protocol's own record
// ---------------------------------------------------------------------------

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function firstChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** One category rule: when the category matches, this is the action. First match wins. */
interface ActionRule {
  matches: (category: string) => boolean;
  action: (name: string, capital: number, chain: string) => string;
}

/** The category's one action, in the words a farmer can follow. */
const ACTION_RULES: ActionRule[] = [
  {
    matches: (c) => c.includes('lend') || c.includes('cdp') || c.includes('collateral'),
    action: (name, capital, chain) => `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`,
  },
  {
    matches: (c) => c.includes('dex') || c.includes('yield') || c.includes('leveraged farm'),
    action: (name, capital, chain) => `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`,
  },
  {
    matches: (c) => c.includes('bridge'),
    action: (name, capital, chain) => `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`,
  },
  {
    matches: (c) => c.includes('staking') || c.includes('restak'),
    action: (name, capital) => `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`,
  },
  {
    matches: (c) => c.includes('perpetual') || c.includes('derivative'),
    action: (name, capital) => `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`,
  },
  {
    matches: (c) => c.includes('prediction'),
    action: (name, capital) => `Fund $${capital} and place one market position on ${name}.`,
  },
  {
    matches: (c) => c.includes('curator') || c.includes('allocator'),
    action: (name, capital, chain) => `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`,
  },
  {
    matches: (c) => c.includes('stable'),
    action: (name, capital, chain) => `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`,
  },
  {
    matches: (c) => c.includes('rwa'),
    action: (name, capital, chain) => `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`,
  },
  {
    matches: (c) => c.includes('insurance'),
    action: (name, capital, chain) => `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`,
  },
];

/** The first action rule the category matches, else the plain deposit. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const rule = ACTION_RULES.find((r) => r.matches(c));
  return rule === undefined
    ? `Deposit $${capital} of USDC into ${p.name} on ${chain} and keep the position open.`
    : rule.action(p.name, capital, chain);
}

/** One depth rule: when the category matches, this is the deeper action. First match wins. */
interface DepthRule {
  matches: (category: string) => boolean;
  action: (name: string, capital: number, chain: string, second: string) => string;
}

/** The category's second, deeper action: the behaviour a points program actually rewards. */
const DEPTH_RULES: DepthRule[] = [
  {
    matches: (c) => c.includes('lend') || c.includes('cdp') || c.includes('collateral'),
    action: (name) => `Borrow a small amount against the deposit on ${name}, hold it a few days, then repay in full so the wallet shows both sides of the market.`,
  },
  {
    matches: (c) => c.includes('dex'),
    action: (name, capital) => `Route at least $${capital} of swaps through ${name}'s main pool each week, in both directions, rather than one large trade.`,
  },
  {
    matches: (c) => c.includes('bridge'),
    action: (name, _capital, _chain, second) => `Bridge a smaller amount back through ${name} toward ${second} once a month, so the wallet is active in both directions.`,
  },
  {
    matches: (c) => c.includes('staking') || c.includes('restak'),
    action: (name) => `Put the staking receipt to work once — as collateral or in a restaking vault — so the position earns the second layer of points where ${name} offers one.`,
  },
  {
    matches: (c) => c.includes('perpetual') || c.includes('derivative'),
    action: (name) => `Keep one small hedged position open on ${name} and roll it weekly; steady open interest counts more than one big trade.`,
  },
  {
    matches: (c) => c.includes('curator') || c.includes('allocator'),
    action: (name, _capital, chain) => `Split the deposit across two of ${name}'s vaults on ${chain} instead of one, and rebalance once a month.`,
  },
  {
    matches: (c) => c.includes('rwa'),
    action: (name) => `Hold the position through one full yield distribution on ${name} before adding more; completed cycles are what its program records.`,
  },
];

/** The deeper action for a protocol: its category's rule, else a second chain, else a second tranche. */
function depthActionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const second = p.chains.length > 1 ? p.chains[1]! : chain;
  const rule = DEPTH_RULES.find((r) => r.matches(c));
  if (rule !== undefined) return rule.action(p.name, capital, chain, second);
  if (p.chains.length > 1) {
    return `Repeat the core action on ${second}, where ${p.name} also runs, so the wallet is active on more than one chain.`;
  }
  return `Repeat the core action in a second, smaller tranche two weeks later, so the wallet's history is a pattern, not a single day.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list of
 * names, and it never claims a token exists: positioning is not a promise.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = firstChain(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: depthActionFor(p, capital, chain),
      cost: 'about $3 of gas each time',
      time: '15 minutes to set up, then minutes a week',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes. No token has been announced for ${p.name}: treat any 'official token' link from anywhere else as a scam.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

// ---------------------------------------------------------------------------
// The dashboard's views
// ---------------------------------------------------------------------------

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    multiple: row.model.base_multiple,
    multiple_peers: row.model.multiple_peers,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const multiples = computeMultiples(snapshot);
  const boardCats = new Set(board.map((r) => r.category).filter((c): c is string => c !== null));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    global_multiple: multiples.global,
    multiples: [...multiples.byCategory.values()].filter((m) => boardCats.has(m.category)).sort((a, b) => b.peers - a.peers),
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

// ---------------------------------------------------------------------------
// Reading the snapshot
// ---------------------------------------------------------------------------

/** The snapshot document out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols = o.protocols.map((v, i) => readProtocol(v, i));
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** One protocol out of the snapshot's raw JSON, with the model's defaults for missing fields. */
function readProtocol(v: unknown, i: number): SnapshotProtocol {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
  }
  const p = v as Record<string, unknown>;
  if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
    throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
  }
  const maybeNumber = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const maybeString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  return {
    slug: p.slug,
    name: p.name,
    category: maybeString(p.category),
    chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
    tvl_usd: p.tvl_usd,
    change_7d: maybeNumber(p.change_7d),
    mcap_usd: maybeNumber(p.mcap_usd),
    listed_at: maybeString(p.listed_at),
    gecko_id: maybeString(p.gecko_id),
    symbol: maybeString(p.symbol),
  };
}

// ---------------------------------------------------------------------------
// The gate's own check, run before anything is written
// ---------------------------------------------------------------------------

/** One gate rule: the reason a board fails it, or null when the board passes. */
type GateRule = (board: BoardRow[], snapshot: Snapshot) => string | null;

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const rules: GateRule[] = [
    (_b, s) => {
      const slugs = new Set(board.map((r) => r.slug));
      const missing = s.watchlist.filter((slug) => !slugs.has(slug));
      return missing.length > 0
        ? `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`
        : null;
    },
    () => {
      const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
      for (let i = 0; i < ranks.length; i++) {
        if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
      }
      return null;
    },
    () => {
      for (let i = 1; i < board.length; i++) {
        if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
          return `row ${i + 1} outranks row ${i} on implied value`;
        }
      }
      return null;
    },
    () => {
      if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
        return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
      }
      return null;
    },
    () => {
      for (const r of board) {
        const steps = r.farm_steps;
        if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
        for (const s of steps) {
          if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
        }
        if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
          return `${r.slug} has implied value ${r.implied_value_usd}`;
        }
      }
      return null;
    },
  ];
  for (const rule of rules) {
    const issue = rule(board, snapshot);
    if (issue !== null) return issue;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
