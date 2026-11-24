// Token Radar's plain dashboard, second telling. It reads window.RADAR (written
// beside dashboard/ by main.ts) and renders the ranked board, a filterable table,
// a per-protocol detail drawer with the model's own inputs and the protocol's
// farm plan. No network: every byte it shows is in data.js.
//
// The page recomputes each row from the snapshot figures with the same
// arithmetic main.ts used, so the number on screen and the number in
// board.json are visibly the same model — and the farm plan is derived in
// the page from the same category rules, so the plan a row shows is the plan
// board.json carries for it.
(() => {
  'use strict';

  const DATA = window.RADAR;
  if (!DATA) return;
  const app = document.getElementById('board');
  const state = { q: '', category: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  // -- formatting -----------------------------------------------------------

  const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  /** A dollar figure, shortened at the usual thresholds. */
  const fmtUsd = (n) => {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    const tiers = [
      [1e9, (v) => '$' + (v / 1e9).toFixed(2) + 'B'],
      [1e6, (v) => '$' + (v / 1e6).toFixed(1) + 'M'],
      [1e3, (v) => '$' + Math.round(v / 1e3) + 'K'],
    ];
    for (const [floor, render] of tiers) {
      if (Math.abs(n) >= floor) return render(n);
    }
    return usdFmt.format(n);
  };

  /** A percent with an explicit sign. */
  const fmtPct = (n) => {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  };

  /** An age in days, as years past a year. */
  const fmtAge = (days) => {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  };

  // -- the model, recomputed in the page ------------------------------------

  /** The model's three factors for one row, as main.ts computes them. */
  const factorsOf = (row, model) => {
    const pct = Math.min(model.growth_cap, Math.max(model.growth_floor, row.change_7d ?? 0));
    const growth = 1 + (pct / 100) * model.growth_weight;
    const age = row.age_days ?? model.unknown_age_days;
    const maturity = model.maturity_floor + (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    const chains = 1 + 0.03 * Math.min(Math.max((row.chains || []).length - 1, 0), 5);
    return { growth, maturity, chains };
  };

  /** The implied value of a row, recomputed from its snapshot figures. */
  const impliedOf = (row, model) => {
    const f = factorsOf(row, model);
    return Math.max(1, Math.round(row.tvl_usd * row.multiple * f.growth * f.maturity * f.chains));
  };

  // -- a tiny element builder -----------------------------------------------

  /** One element: `attrs` sets class/text/html/on* handlers/attributes, the rest are children. */
  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
      }
    }
    const push = (child) => {
      if (child === null || child === undefined || child === false) return;
      if (Array.isArray(child)) child.forEach(push);
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    };
    kids.forEach(push);
    return node;
  }

  // -- the farm plan, derived in the page ------------------------------------

  const firstChain = (p) => (p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain');

  const capitalFor = (p) => {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  };

  const holdDaysFor = (age) => {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  };

  /** One category rule: when the category matches, this is the action. First match wins. */
  const ACTION_RULES = [
    { test: (c) => c.includes('lend') || c.includes('cdp') || c.includes('collateral'), make: (name, capital, chain) => `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.` },
    { test: (c) => c.includes('dex') || c.includes('yield') || c.includes('leveraged farm'), make: (name, capital, chain) => `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.` },
    { test: (c) => c.includes('bridge'), make: (name, capital, chain) => `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.` },
    { test: (c) => c.includes('staking') || c.includes('restak'), make: (name, capital) => `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.` },
    { test: (c) => c.includes('perpetual') || c.includes('derivative'), make: (name, capital) => `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.` },
    { test: (c) => c.includes('prediction'), make: (name, capital) => `Fund $${capital} and place one market position on ${name}.` },
    { test: (c) => c.includes('curator') || c.includes('allocator'), make: (name, capital, chain) => `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.` },
    { test: (c) => c.includes('stable'), make: (name, capital, chain) => `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.` },
    { test: (c) => c.includes('rwa'), make: (name, capital, chain) => `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.` },
    { test: (c) => c.includes('insurance'), make: (name, capital, chain) => `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.` },
  ];

  /** The category's one action, in the words a farmer can follow. */
  const actionFor = (p, capital, chain) => {
    const c = (p.category || '').toLowerCase();
    const rule = ACTION_RULES.find((r) => r.test(c));
    return rule ? rule.make(p.name, capital, chain) : `Deposit $${capital} of USDC into ${p.name} on ${chain} and keep the position open.`;
  };

  /** One depth rule: when the category matches, this is the deeper action. First match wins. */
  const DEPTH_RULES = [
    { test: (c) => c.includes('lend') || c.includes('cdp') || c.includes('collateral'), make: (name) => `Borrow a small amount against the deposit on ${name}, hold it a few days, then repay in full so the wallet shows both sides of the market.` },
    { test: (c) => c.includes('dex'), make: (name, capital) => `Route at least $${capital} of swaps through ${name}'s main pool each week, in both directions, rather than one large trade.` },
    { test: (c) => c.includes('bridge'), make: (name, _capital, _chain, second) => `Bridge a smaller amount back through ${name} toward ${second} once a month, so the wallet is active in both directions.` },
    { test: (c) => c.includes('staking') || c.includes('restak'), make: (name) => `Put the staking receipt to work once — as collateral or in a restaking vault — so the position earns the second layer of points where ${name} offers one.` },
    { test: (c) => c.includes('perpetual') || c.includes('derivative'), make: (name) => `Keep one small hedged position open on ${name} and roll it weekly; steady open interest counts more than one big trade.` },
    { test: (c) => c.includes('curator') || c.includes('allocator'), make: (name, _capital, chain) => `Split the deposit across two of ${name}'s vaults on ${chain} instead of one, and rebalance once a month.` },
    { test: (c) => c.includes('rwa'), make: (name) => `Hold the position through one full yield distribution on ${name} before adding more; completed cycles are what its program records.` },
  ];

  /** The deeper action: its category's rule, else a second chain, else a second tranche. */
  const depthActionFor = (p, capital, chain) => {
    const c = (p.category || '').toLowerCase();
    const second = (p.chains || []).length > 1 ? p.chains[1] : chain;
    const rule = DEPTH_RULES.find((r) => r.test(c));
    if (rule) return rule.make(p.name, capital, chain, second);
    if ((p.chains || []).length > 1) {
      return `Repeat the core action on ${second}, where ${p.name} also runs, so the wallet is active on more than one chain.`;
    }
    return `Repeat the core action in a second, smaller tranche two weeks later, so the wallet's history is a pattern, not a single day.`;
  };

  /** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
  const stepText = (step) => {
    let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
    if (s.length > 600) s = `${s.slice(0, 596)}...`;
    if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
    return s;
  };

  /** A protocol's farm plan: seven steps from its own record, never from a hand-written list of names. */
  const farmSteps = (p) => {
    const chain = firstChain(p);
    const capital = capitalFor(p);
    const hold = holdDaysFor(p.age_days);
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: actionFor(p, capital, chain), cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`, time: '15 minutes to set up' },
      { text: depthActionFor(p, capital, chain), cost: 'about $3 of gas each time', time: '15 minutes to set up, then minutes a week' },
      { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', cost: 'about $2 of gas a week', time: '10 minutes a week' },
      { text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`, cost: `the $${capital} stays in the position`, time: `${hold} days` },
      { text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes. No token has been announced for ${p.name}: treat any 'official token' link from anywhere else as a scam.`, cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' },
    ].map(stepText);
  };

  // -- shareable state -------------------------------------------------------

  /** The chains a row names, up to two, or a neutral phrase when it names none. */
  const chainList = (r) => (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain');

  const readHash = () => {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    const params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
  };

  const writeHash = () => {
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.selected) params.set('p', state.selected);
    const next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  };

  // -- filtering and sorting -------------------------------------------------

  /** The board rows that pass the search and the category filter. */
  const visibleRows = () => {
    const q = state.q.trim().toLowerCase();
    return DATA.rows.filter((r) => {
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (!q) return true;
      const hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.includes(q);
    });
  };

  /** The sort key of a row under the current sort: nulls sort out of the way. */
  const sortValue = (r) => {
    if (state.sort === 'name') return r.name.toLowerCase();
    if (state.sort === 'tvl') return r.tvl_usd;
    if (state.sort === 'growth') return r.change_7d === null ? -Infinity : r.change_7d;
    if (state.sort === 'age') return r.age_days === null ? Infinity : r.age_days;
    return r.implied_value_usd;
  };

  const sortedRows = (list) =>
    list.slice().sort((a, b) => {
      const av = sortValue(a);
      const bv = sortValue(b);
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });

  // -- the page --------------------------------------------------------------

  const header = () =>
    el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'Token Radar' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: DATA.model_version + ' model' }),
      ),
    );

  const lede = () =>
    el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        el('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + DATA.early_size + ' pre-token protocols below that floor. Implied value is a model, not a promise.' }),
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Early rows below the floor' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token protocols set aside' }), el('b', { text: String(DATA.live_size) })),
      ),
    );

  const controls = () => {
    const categories = [...new Set(DATA.rows.map((r) => r.category || 'Other'))].sort();
    const search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', () => { state.q = search.value; writeHash(); render(); });
    const select = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map((c) => el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null })),
    );
    select.addEventListener('change', () => { state.category = select.value; writeHash(); render(); });
    const tabButton = (tab, label) =>
      el('button', {
        type: 'button',
        'aria-pressed': state.tab === tab ? 'true' : 'false',
        text: label,
        onclick: () => { state.tab = tab; render(); },
      });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), select),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, tabButton('pre-token', 'Pre-token'), tabButton('live', 'Live token'))),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? visibleRows().length + ' rows shown' : DATA.live.length + ' live-token protocols' }),
    );
  };

  const sortHeader = (key, label) =>
    el('th', { scope: 'col' },
      el('button', {
        type: 'button',
        onclick: () => {
          if (state.sort === key) state.dir = -state.dir;
          else { state.sort = key; state.dir = -1; }
          render();
        },
      },
      label,
      state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null,
      ),
    );

  /** One board row: rank, name, TVL, growth, age, implied value with its bar, token status. */
  const boardRowEl = (r, max) => {
    const growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
    const growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
    return el('tr', {
      'data-selected': state.selected === r.slug ? 'true' : 'false',
      tabindex: '0',
      onclick: () => openDetail(r.slug),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } },
    },
    el('td', { class: 'num', text: String(r.rank) }),
    el('td', null, el('div', { class: 'name' },
      el('b', { text: r.name }),
      el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + chainList(r) }),
    )),
    el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
    el('td', { class: 'num ' + growthClass, text: growth }),
    el('td', { class: 'num', text: fmtAge(r.age_days) }),
    el('td', null, el('div', { class: 'implied' },
      el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
      el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) }),
    )),
    el('td', null, el('span', { class: 'status', text: 'no token' })),
    );
  };

  const boardTable = () => {
    const list = sortedRows(visibleRows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: () => { state.q = ''; state.category = 'all'; writeHash(); render(); } }),
      ));
    }
    const max = list[0].implied_value_usd || 1;
    const tbody = el('tbody');
    list.forEach((r) => tbody.appendChild(boardRowEl(r, max)));
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Token' }),
          )),
          tbody,
        ),
      ),
    );
  };

  const liveTable = () => {
    const tbody = el('tbody');
    DATA.live.forEach((r) => {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + chainList(r) }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'status', text: 'already trades' })),
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody,
        ),
      ),
    );
  };

  const modelPanel = () => {
    const m = DATA.model;
    const multRows = (DATA.multiples || []).map((cm) =>
      el('tr', {},
        el('td', { text: cm.category }),
        el('td', { class: 'num', text: String(cm.peers) }),
        el('td', { class: 'num', text: 'x' + cm.multiple.toFixed(3) }),
      ),
    );
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked. The core of the model is a comparable multiple: what the market itself pays for a dollar of TVL in the same category, taken from the snapshot\'s own tokenised protocols.' }),
      el('div', { class: 'formula' },
        'implied = round( tvl_usd x category_multiple x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ') x (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' x ' + m.maturity_range + ') x (1 + 0.03 x min(chains - 1, 5)) )',
      ),
      el('p', { class: 'sub', text: 'A category multiple is the median market-cap/TVL of its tokenised peers (ratios winsorised to [0.01, 10], exchanges excluded). Categories with few peers are shrunk toward the global median of x' + DATA.global_multiple.toFixed(3) + ' in log space (weight 4), so one rich peer cannot make a whole category look rich; a category with no peers uses the global median. TVL, seven-day growth and age come from the snapshot; age is the time since first listing, the best record of how long a protocol has run with no token, and an unlisted age uses ' + m.unknown_age_days + ' days. The early radar is every pre-token protocol below the watchlist floor, by TVL, and the live-token protocols are set aside with their market caps shown.' }),
      el('table', { class: 'mults' },
        el('caption', { class: 'sub', text: 'Category multiples used on this board, from the snapshot\'s tokenised peers.' }),
        el('thead', {}, el('tr', {}, el('th', { text: 'Category' }), el('th', { class: 'num', text: 'Peers' }), el('th', { class: 'num', text: 'Multiple' }))),
        el('tbody', {}, multRows),
      ),
    );
  };

  const dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', () => { state.selected = null; writeHash(); });

  const openDetail = (slug) => {
    const row = DATA.rows.find((r) => r.slug === slug);
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    const steps = farmSteps(row);
    const recomputed = impliedOf(row, DATA.model);
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') }),
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: () => dialog.close() }),
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
        el('div', null, el('span', { text: 'Category multiple' }), el('b', { class: 'num', text: 'x' + row.multiple.toFixed(3) + ' (' + row.multiple_peers + ' peers)' })),
        el('div', null, el('span', { text: 'Growth multiplier' }), el('b', { class: 'num', text: String(row.growth_multiplier) })),
        el('div', null, el('span', { text: 'Maturity multiplier' }), el('b', { class: 'num', text: String(row.maturity_multiplier) })),
        el('div', null, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) })),
      ),
      el('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + fmtUsd(recomputed) + (recomputed === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price.' }),
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, steps.map((s) => {
        const at = s.indexOf(' Cost: ');
        const action = at >= 0 ? s.slice(0, at) : s;
        const tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      })),
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  };

  const render = () => {
    app.textContent = '';
    const shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') shell.appendChild(modelPanel());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  };

  readHash();
  render();
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
