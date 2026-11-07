// DoubleEarn Telegram bot - Cloudflare Worker + D1 (SQLite). No dependencies.
// Bindings: DB (D1). Secrets: BOT_TOKEN, WEBHOOK_SECRET.
// Variables: ADMIN_ID, CHANNELS (e.g. @channel1,@channel2), MIN_WITHDRAW (optional).

const VERSION = '2026-11-08 admin-panel-promotions (auto-setup)';
const DEFAULT_SETTINGS = { welcome: 50, referral: 20, unlock: 100, minWithdraw: 50 };
const SETTING_KEYS = { welcome: 'welcome_bonus', referral: 'referral_bonus', unlock: 'unlock_earnings', minWithdraw: 'min_withdraw' };
let settingsCache = null;
let settingsAt = 0;

// Admins edit these from Telegram (see /settings). Order: value saved in D1, then the optional
// REFERRAL_BONUS / MIN_WITHDRAW variables, then the defaults above.
async function getSettings(env) {
  if (settingsCache && Date.now() - settingsAt < 10000) return settingsCache;
  const raw = {};
  try {
    for (const r of await qa(env, 'SELECT key, value FROM settings')) raw[r.key] = String(r.value);
  } catch (e) {
    // The settings table is created by /setup.
  }
  const fromEnv = (v) => (v !== undefined && String(v).trim() !== '' && Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  const pick = (name, envValue) => {
    const k = SETTING_KEYS[name];
    const v = Number(raw[k]);
    if (raw[k] !== undefined && Number.isInteger(v) && v >= 0) return v;
    const e = fromEnv(envValue);
    return e !== null ? e : DEFAULT_SETTINGS[name];
  };
  const referralBase = pick('referral', env.REFERRAL_BONUS);
  const referralOn = raw.referral_on !== '0';
  settingsCache = {
    welcome: pick('welcome'),
    referral: referralOn ? referralBase : 0,
    referralBase,
    referralOn,
    unlock: pick('unlock'),
    minWithdraw: Math.max(1, pick('minWithdraw', env.MIN_WITHDRAW)),
    promoOn: raw.promo_on === '1',
    raw,
  };
  settingsAt = Date.now();
  return settingsCache;
}

const STATE_TTL_SEC = 3600;
const JOIN_CACHE_MS = 15000;
const joinCache = new Map();

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE NOT NULL,
    username TEXT,
    country TEXT,
    balance INTEGER NOT NULL DEFAULT 0,
    payment_type TEXT,
    payment_details TEXT,
    welcome_given INTEGER NOT NULL DEFAULT 0,
    referred_by INTEGER,
    withdraw_unlocked INTEGER NOT NULL DEFAULT 0,
    banned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    link TEXT,
    points INTEGER NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    require_username INTEGER NOT NULL DEFAULT 1,
    promo_id INTEGER,
    quota INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS user_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    task_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    screenshot_id TEXT,
    submitted_username TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, task_id)
  )`,
  `CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    points INTEGER NOT NULL,
    amount TEXT NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    req TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    description TEXT,
    status TEXT,
    points INTEGER NOT NULL DEFAULT 0,
    ref_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS state (
    telegram_id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    data TEXT,
    ts INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS admins (
    telegram_id INTEGER PRIMARY KEY,
    added_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS promotions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    country TEXT,
    currency TEXT,
    type TEXT NOT NULL,
    link TEXT NOT NULL,
    comment_text TEXT,
    quantity INTEGER NOT NULL,
    price_per_unit REAL NOT NULL,
    total REAL NOT NULL,
    reward INTEGER NOT NULL,
    pay_name TEXT,
    pay_screenshot TEXT,
    refund_details TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS broadcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    text TEXT,
    file_id TEXT,
    status TEXT NOT NULL DEFAULT 'sending',
    total INTEGER NOT NULL DEFAULT 0,
    sent INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    last_user_id INTEGER NOT NULL DEFAULT 0,
    locked_at INTEGER,
    created_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

// Created after the migrations, because some of them use columns the migrations add.
const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_users_balance ON users (balance DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_users_referred ON users (referred_by)`,
  `CREATE INDEX IF NOT EXISTS idx_history_user ON history (user_id, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_history_ref ON history (type, ref_id)`,
  `CREATE INDEX IF NOT EXISTS idx_withdrawals_req ON withdrawals (req)`,
  `CREATE INDEX IF NOT EXISTS idx_promotions_user ON promotions (user_id, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_promo ON tasks (promo_id)`,
];

// Applied by /setup for databases created before these columns existed (errors are ignored).
const MIGRATIONS = [
  `ALTER TABLE users ADD COLUMN withdraw_unlocked INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE tasks ADD COLUMN require_username INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE tasks ADD COLUMN promo_id INTEGER`,
  `ALTER TABLE tasks ADD COLUMN quota INTEGER`,
];

const COUNTRIES = {
  Nigeria: {
    flag: '🇳🇬',
    currency: 'NGN',
    payoutText: 'Bank/Airtime',
    methods: [
      { key: 'bank', label: '🏦 Bank Account', name: 'Bank Account', ask: 'Send your bank name, account number and account name.', example: 'GTB 0123456789 Musa' },
      { key: 'airtime', label: '📱 Airtime', name: 'Airtime', ask: 'Send the phone number that should receive airtime.', example: '08012345678' },
    ],
  },
  Ghana: {
    flag: '🇬🇭',
    currency: 'GHS',
    payoutText: 'MoMo/Airtime',
    methods: [
      { key: 'momo', label: '📱 Mobile Money (MoMo)', name: 'MoMo', ask: 'Send your MoMo network, number and name.', example: 'MTN 0244123456 Kofi' },
      { key: 'airtime', label: '📱 Airtime', name: 'Airtime', ask: 'Send the phone number that should receive airtime.', example: '0244123456' },
    ],
  },
};

// ---------- Small helpers ----------
const cfgOf = (env) => ({
  admins: (env.ADMIN_IDS || env.ADMIN_ID || '')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter(Boolean),
  channels: (env.CHANNELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((c) => (c.startsWith('@') ? c : `@${c}`)),
  minWithdraw: Number(env.MIN_WITHDRAW) || 50,
});

// Owners come from the ADMIN_ID variable. Extra admins are added by an owner from the admin panel.
const isOwner = (env, id) => cfgOf(env).admins.includes(id);

async function getAdminIds(env) {
  let extra = [];
  try {
    extra = (await qa(env, 'SELECT telegram_id FROM admins')).map((r) => Number(r.telegram_id));
  } catch (e) {
    // The admins table is created by /setup.
  }
  return [...new Set([...cfgOf(env).admins, ...extra])];
}

async function isAdmin(env, id) {
  if (isOwner(env, id)) return true;
  try {
    return !!(await q1(env, 'SELECT 1 AS x FROM admins WHERE telegram_id = ?', id));
  } catch (e) {
    return false;
  }
}

const currencyOf = (country) => (COUNTRIES[country] || COUNTRIES.Nigeria).currency;
const nameOf = (u) => (u.username ? `@${u.username}` : `ID ${u.telegram_id}`);
const cb = (text, data) => ({ text, callback_data: data });
const ik = (rows) => ({ inline_keyboard: rows });

const MENU = {
  keyboard: [
    [{ text: '💰 Balance' }, { text: '📋 Tasks' }],
    [{ text: '🏦 Withdraw' }, { text: '💳 Payment Method' }],
    [{ text: '🏆 Leaderboard' }, { text: '📜 History' }],
    [{ text: '👥 Referral' }, { text: '📣 Promotion' }],
  ],
  resize_keyboard: true,
};

const countryKeyboard = () => ik([[cb('🇳🇬 Nigeria', 'country_Nigeria'), cb('🇬🇭 Ghana', 'country_Ghana')]]);
const paymentKeyboard = (country) =>
  ik([(COUNTRIES[country] || COUNTRIES.Nigeria).methods.map((m) => cb(m.label, `pm_${m.key}`))]);

async function tg(env, method, params) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

const send = (env, chatId, text, markup) =>
  tg(env, 'sendMessage', { chat_id: chatId, text, reply_markup: markup, disable_web_page_preview: true });

const safeSend = (env, chatId, text) =>
  send(env, chatId, text).catch((e) => console.error(`Could not message ${chatId}: ${e.message}`));

// Several admins can be set: ADMIN_ID = "111,222,333,444". Requests go to all of them.
async function sendToAdmins(env, text, markup) {
  for (const id of await getAdminIds(env)) {
    await send(env, id, text, markup).catch((e) => console.error(`Could not message admin ${id}: ${e.message}`));
  }
}

async function photoToAdmins(env, params) {
  let delivered = 0;
  for (const id of await getAdminIds(env)) {
    try {
      await tg(env, 'sendPhoto', { ...params, chat_id: id });
      delivered++;
    } catch (e) {
      console.error(`Could not send photo to admin ${id}: ${e.message}`);
    }
  }
  if (!delivered) throw new Error('No admin could be reached');
}

// D1 helpers
const q1 = (env, sql, ...p) => env.DB.prepare(sql).bind(...p).first();
const qa = async (env, sql, ...p) => (await env.DB.prepare(sql).bind(...p).all()).results;
const run = (env, sql, ...p) => env.DB.prepare(sql).bind(...p).run();
const st = (env, sql, ...p) => env.DB.prepare(sql).bind(...p); // statement for batch()

// Conversation state (Workers are stateless, so it lives in D1)
async function setState(env, tid, kind, data) {
  await run(env, 'INSERT OR REPLACE INTO state (telegram_id, kind, data, ts) VALUES (?, ?, ?, ?)', tid, kind, JSON.stringify(data || {}), Math.floor(Date.now() / 1000));
}
async function getState(env, tid) {
  const row = await q1(env, 'SELECT kind, data, ts FROM state WHERE telegram_id = ?', tid);
  if (!row) return null;
  if (Math.floor(Date.now() / 1000) - row.ts > STATE_TTL_SEC) {
    await run(env, 'DELETE FROM state WHERE telegram_id = ?', tid);
    return null;
  }
  return { kind: row.kind, data: JSON.parse(row.data || '{}') };
}
const clearState = (env, tid) => run(env, 'DELETE FROM state WHERE telegram_id = ?', tid);
const clearInput = (env, tid) => run(env, `DELETE FROM state WHERE telegram_id = ? AND kind IN ('payment', 'withdraw', 'promo', 'admin')`, tid);

async function getTaskEarnings(env, userId) {
  const r = await q1(env, `SELECT COALESCE(SUM(points), 0) AS s FROM history WHERE user_id = ? AND type = 'earn' AND status = 'approved'`, userId);
  return Number(r.s);
}

// ---------- Messages ----------
const textWelcomeNew = (s) =>
  `🎉 Welcome to DoubleEarn!\n\nComplete tasks in Nigeria & Ghana and earn points.\n\nWe pay in NGN & GHS to your Bank/MoMo.\n\nSelect your country to start${s.welcome > 0 ? ` and get ${s.welcome} Points FREE` : ''}!`;

const textCountrySelected = (country, s) => {
  const c = COUNTRIES[country];
  return (
    `${c.flag} Welcome to DoubleEarn ${country}!\n\n` +
    `You selected ${country} - you will earn and withdraw in ${c.currency}.\n` +
    `✅ Complete tasks\n✅ Earn points\n✅ Withdraw to ${c.payoutText}\n\n` +
    (s.welcome > 0 ? `Now join our channels to get ${s.welcome} Points FREE!` : 'Now join our channels to continue.')
  );
};

const textVerified = (country) => {
  const c = COUNTRIES[country];
  return (
    `✅ Verified! ${c.flag} Your ${country} account is ready.\n\n` +
    `Currency: ${c.currency}\nPayout methods: ${c.methods.map((m) => m.name).join(', ')}\n\n` +
    `Choose an option from the menu below.`
  );
};

const textWelcomeBack = (country) => {
  const c = COUNTRIES[country];
  return `${c.flag} Welcome back to DoubleEarn ${country}! You are earning in ${c.currency}.\n\nChoose an option from the menu below.`;
};

const taskText = (t) => `📌 ${t.title}\n\n${t.description || ''}\n\n🔗 ${t.link || 'No link'}\n⭐ Points: ${t.points}`;

// ---------- Users, join check, welcome bonus ----------
async function ensureUser(env, from, refPayload = null) {
  const u = await q1(env, 'SELECT * FROM users WHERE telegram_id = ?', from.id);
  if (u) {
    const un = from.username || null;
    if ((u.username || null) !== un) {
      await run(env, 'UPDATE users SET username = ? WHERE id = ?', un, u.id);
      u.username = un;
    }
    return u;
  }
  let referredBy = null;
  const rid = Number(refPayload);
  if (Number.isInteger(rid) && rid > 0 && rid !== from.id) {
    const r = await q1(env, 'SELECT id FROM users WHERE telegram_id = ?', rid);
    if (r) referredBy = r.id;
  }
  await run(env, 'INSERT OR IGNORE INTO users (telegram_id, username, referred_by) VALUES (?, ?, ?)', from.id, from.username || null, referredBy);
  return q1(env, 'SELECT * FROM users WHERE telegram_id = ?', from.id);
}

async function getMissing(env, uid) {
  const hit = joinCache.get(uid);
  if (hit && Date.now() - hit < JOIN_CACHE_MS) return [];
  const results = await Promise.all(
    cfgOf(env).channels.map(async (ch) => {
      try {
        const m = await tg(env, 'getChatMember', { chat_id: ch, user_id: uid });
        const ok = ['creator', 'administrator', 'member'].includes(m.status) || (m.status === 'restricted' && m.is_member);
        return ok ? null : ch;
      } catch (e) {
        console.error(`getChatMember failed for ${ch}: ${e.message} (is the bot an admin there?)`);
        return ch;
      }
    })
  );
  const missing = results.filter(Boolean);
  if (!missing.length) {
    if (joinCache.size > 5000) joinCache.clear();
    joinCache.set(uid, Date.now());
  }
  return missing;
}

async function sendJoinPrompt(env, chatId, missing) {
  const rows = missing.map((c) => [{ text: `📢 Join ${c}`, url: `https://t.me/${c.slice(1)}` }]);
  rows.push([cb("✅ I've Joined - Check", 'check_join')]);
  await send(env, chatId, `You must join ${missing.length} channel(s) to use this bot.`, ik(rows));
}

async function grantWelcome(env, user) {
  if (user.welcome_given) return;
  const s = await getSettings(env);
  let referrerTg = null;
  if (user.referred_by) {
    const r = await q1(env, 'SELECT telegram_id FROM users WHERE id = ?', user.referred_by);
    if (r) referrerTg = r.telegram_id;
  }
  // One atomic batch. Every statement is guarded by "welcome_given = 0", so it runs once per user.
  const res = await env.DB.batch([
    st(env, `UPDATE users SET balance = balance + ? WHERE id = (SELECT referred_by FROM users WHERE id = ? AND welcome_given = 0)`, s.referral, user.id),
    st(env, `INSERT INTO history (user_id, type, description, status, points)
             SELECT referred_by, 'referral', 'Referral Bonus', 'approved', ? FROM users
             WHERE id = ? AND welcome_given = 0 AND referred_by IS NOT NULL AND ? > 0`, s.referral, user.id, s.referral),
    st(env, `INSERT INTO history (user_id, type, description, status, points)
             SELECT id, 'bonus', 'Welcome Bonus (Non-withdrawable)', 'approved', ? FROM users
             WHERE id = ? AND welcome_given = 0 AND ? > 0`, s.welcome, user.id, s.welcome),
    st(env, `UPDATE users SET balance = balance + ?, welcome_given = 1 WHERE id = ? AND welcome_given = 0`, s.welcome, user.id),
  ]);
  if (res[3].meta.changes !== 1) return;
  user.balance += s.welcome;
  user.welcome_given = 1;
  if (referrerTg && s.referral > 0) {
    await safeSend(env, referrerTg, `🎉 You got ${s.referral} points! Your referral ${nameOf(user)} joined the channels.`);
  }
  if (s.welcome > 0) {
    await send(
      env,
      user.telegram_id,
      `🎁 Welcome Bonus: ${s.welcome} Points added!` +
        (s.unlock > 0 ? ` (You must earn ${s.unlock} points from tasks before you can withdraw)` : '')
    );
  }
}

// Runs before every user action: country, channel membership, welcome bonus.
async function passGate(env, from) {
  const user = await ensureUser(env, from);
  if (Number(user.banned) === 1) {
    await send(env, from.id, '🚫 Your account has been suspended. Contact support if you think this is a mistake.');
    return null;
  }
  if (!user.country) {
    await send(env, from.id, 'Please select your country to continue earning:', countryKeyboard());
    return null;
  }
  const missing = await getMissing(env, from.id);
  if (missing.length) {
    await sendJoinPrompt(env, from.id, missing);
    return null;
  }
  await grantWelcome(env, user);
  return user;
}

// ---------- Entry points ----------
async function onStart(env, from, payload) {
  await clearInput(env, from.id);
  const user = await ensureUser(env, from, payload);
  if (!user.country) return send(env, from.id, textWelcomeNew(await getSettings(env)), countryKeyboard());
  const ready = await passGate(env, from);
  if (ready) await send(env, from.id, textWelcomeBack(ready.country), MENU);
}

async function onCountry(env, from, chosen, cq) {
  const user = await ensureUser(env, from);
  if (!user.country) await run(env, 'UPDATE users SET country = ? WHERE id = ? AND country IS NULL', chosen, user.id);
  const fresh = await q1(env, 'SELECT country FROM users WHERE id = ?', user.id);
  await tg(env, 'deleteMessage', { chat_id: cq.message.chat.id, message_id: cq.message.message_id }).catch(() => {});
  await send(env, from.id, textCountrySelected(fresh.country, await getSettings(env)));
  const ready = await passGate(env, from);
  if (ready) await send(env, from.id, textVerified(ready.country), MENU);
}

// ---------- Menu handlers ----------
// A user can withdraw if an admin unlocked them, or they earned enough points from tasks.
async function withdrawStatus(env, user, s) {
  const earned = await getTaskEarnings(env, user.id);
  const unlocked = Number(user.withdraw_unlocked) === 1 || earned >= s.unlock;
  return { earned, unlocked };
}

async function hBalance(env, user) {
  const s = await getSettings(env);
  const { earned, unlocked } = await withdrawStatus(env, user, s);
  await send(
    env,
    user.telegram_id,
    `Your Balance: ${user.balance} Points = ${currencyOf(user.country)} ${user.balance}\n\n` +
      `Task Earnings: ${earned} Points\n` +
      (s.welcome > 0
        ? `Welcome Bonus: ${s.welcome} Points ${unlocked ? '(Unlocked)' : `(Locked until you earn ${s.unlock} points from tasks)`}\n\n`
        : '\n') +
      `Withdrawable: ${unlocked ? user.balance : 0} Points`
  );
}

// A task is open while it is active and, for promotion tasks, while it still has free slots.
const TASK_OPEN_SQL = `t.is_active = 1 AND (t.quota IS NULL OR (SELECT COUNT(*) FROM user_tasks x WHERE x.task_id = t.id AND x.status IN ('pending', 'approved')) < t.quota)`;
const NOT_OWN_PROMO_SQL = `NOT EXISTS (SELECT 1 FROM promotions p WHERE p.id = t.promo_id AND p.user_id = ?)`;
const openTask = (env, user, taskId) =>
  q1(env, `SELECT t.* FROM tasks t WHERE t.id = ? AND ${TASK_OPEN_SQL} AND ${NOT_OWN_PROMO_SQL}`, taskId, user.id);

async function hTasks(env, user) {
  const rows = await qa(
    env,
    `SELECT t.* FROM tasks t WHERE ${TASK_OPEN_SQL}
     AND NOT EXISTS (SELECT 1 FROM user_tasks ut WHERE ut.task_id = t.id AND ut.user_id = ?)
     AND ${NOT_OWN_PROMO_SQL}
     ORDER BY t.id LIMIT 20`,
    user.id,
    user.id
  );
  if (!rows.length) return send(env, user.telegram_id, 'Unavailable - No tasks at the moment');
  for (const t of rows) await send(env, user.telegram_id, taskText(t), ik([[cb(`View Task ${t.id}`, `view_${t.id}`)]]));
}

async function showPaymentMethod(env, user) {
  if (user.payment_details) {
    await send(env, user.telegram_id, `Your payment method:\nType: ${user.payment_type}\nDetails: ${user.payment_details}`, ik([[cb('🗑️ Delete', 'pm_delete')]]));
  } else {
    await send(env, user.telegram_id, 'Choose your payment method:', paymentKeyboard(user.country));
  }
}

async function hWithdraw(env, user) {
  if (!user.payment_details) return send(env, user.telegram_id, 'You must add payment method first', paymentKeyboard(user.country));
  const s = await getSettings(env);
  const { earned, unlocked } = await withdrawStatus(env, user, s);
  if (!unlocked) {
    return send(
      env,
      user.telegram_id,
      `❌ You cannot withdraw yet!\n\nYou must earn at least ${s.unlock} Points from Tasks first.\n` +
        `Currently earned from tasks: ${earned}/${s.unlock} Points\n\n` +
        (s.welcome > 0 ? `The Welcome Bonus (${s.welcome}) cannot be withdrawn until then.\n` : '') +
        `Go to 📋 Tasks and complete tasks.`
    );
  }
  await setState(env, user.telegram_id, 'withdraw', {});
  await send(
    env,
    user.telegram_id,
    `How many points to withdraw? Minimum: ${s.minWithdraw}\n1 Point = ${currencyOf(user.country)} 1\n\n` +
      `Payout to: ${user.payment_type} - ${user.payment_details}\nWithdrawable Balance: ${user.balance} Points\nYour task earnings: ${earned} Points`
  );
}

async function hLeaderboard(env, user) {
  const rows = await qa(env, 'SELECT username, balance, country FROM users ORDER BY balance DESC LIMIT 10');
  if (!rows.length) return send(env, user.telegram_id, 'No users yet.');
  const lines = rows.map((r, i) => `Top ${i + 1}: ${r.username ? '@' + r.username : 'Anonymous'} - ${r.balance} pts (${r.country || 'N/A'})`);
  await send(env, user.telegram_id, `🏆 Leaderboard\n\n${lines.join('\n')}`);
}

async function hHistory(env, user) {
  const rows = await qa(env, 'SELECT type, description, status, points FROM history WHERE user_id = ? ORDER BY id DESC LIMIT 20', user.id);
  if (!rows.length) return send(env, user.telegram_id, 'No history yet.');
  const lines = rows.map((h) => `${h.type} - ${h.description} - ${h.status} - ${h.points}`);
  await send(env, user.telegram_id, `📜 Your last ${rows.length} records\n\n${lines.join('\n')}`);
}

async function hReferral(env, user, botUsername) {
  const bonus = (await getSettings(env)).referral;
  const r = await q1(env, 'SELECT COUNT(*) AS n FROM users WHERE referred_by = ? AND welcome_given = 1', user.id);
  await send(
    env,
    user.telegram_id,
    `👥 Your Referral Link:\nhttps://t.me/${botUsername}?start=${user.telegram_id}\n\n` +
      `Total Referrals: ${r.n}\n` +
      (bonus > 0
        ? `Bonus: ${bonus} Points per referral who joins the channels\n\nShare it to earn!`
        : 'Referral rewards are currently paused.')
  );
}

let botUsernameCache = null;
async function getBotUsername(env) {
  if (!botUsernameCache) botUsernameCache = (await tg(env, 'getMe', {})).username;
  return botUsernameCache;
}

const MENU_HANDLERS = {
  '💰 Balance': hBalance,
  '📋 Tasks': hTasks,
  '🏦 Withdraw': hWithdraw,
  '💳 Payment Method': showPaymentMethod,
  '🏆 Leaderboard': hLeaderboard,
  '📜 History': hHistory,
  '👥 Referral': async (env, user) => hReferral(env, user, await getBotUsername(env)),
  '📣 Promotion': hPromotion,
};

// ---------- Messages ----------
async function onMessage(env, m) {
  if (!m.from || m.chat.type !== 'private') return;
  const text = (m.text || '').trim();

  if (/^\/start(@\w+)?(\s|$)/i.test(text)) return onStart(env, m.from, text.split(/\s+/)[1] || '');
  if (/^\/panel(@\w+)?(\s|$)/i.test(text)) {
    if (!(await isAdmin(env, m.from.id))) return;
    await clearState(env, m.from.id);
    return panelHome(env, null, m.from.id);
  }
  if (/^\/addtask(@\w+)?(\s|$)/i.test(text)) return onAddTask(env, m, text);
  if (text.startsWith('/') && (await isAdmin(env, m.from.id)) && (await onAdminCommand(env, m, text))) return;

  const handler = MENU_HANDLERS[text];
  if (handler) {
    await clearInput(env, m.from.id);
    const user = await passGate(env, m.from);
    if (user) await handler(env, user);
    return;
  }

  const state = m.photo || text ? await getState(env, m.from.id) : null;
  if (state && state.kind === 'admin') return onAdminInput(env, m, text, state);
  // An admin who sends "Title | Description | Link | Points" without /addtask still adds the task.
  if (!state && text.split('|').length >= 4 && (await isAdmin(env, m.from.id))) return onAddTask(env, m, `/addtask ${text}`);
  if (m.photo) return onPhoto(env, m, state);
  if (text) return onText(env, m.from, text, state);
}

async function onText(env, from, text, pre) {
  const state = pre || (await getState(env, from.id));
  if (!state || state.kind === 'submit') return send(env, from.id, 'Please choose an option from the menu.', MENU);
  const user = await passGate(env, from);
  if (!user) return;

  if (state.kind === 'promo') return onPromoText(env, user, text, state);

  if (state.kind === 'payment') {
    const digits = text.replace(/[\s-]/g, '');
    if (text.length < 5 || text.length > 200 || !/\d{9,}/.test(digits)) {
      return send(env, from.id, 'Invalid details. Please send them again, including the account or phone number.');
    }
    await clearState(env, from.id);
    await run(env, 'UPDATE users SET payment_type = ?, payment_details = ? WHERE id = ?', state.data.ptype, text, user.id);
    return send(env, from.id, '✅ Payment method saved.', MENU);
  }

  if (state.kind === 'withdraw') return doWithdraw(env, user, text);
}

async function doWithdraw(env, user, text) {
  const s = await getSettings(env);
  if (!/^\d+$/.test(text)) return send(env, user.telegram_id, 'Please send a whole number. Example: 1000');
  const points = Number(text);
  if (points < s.minWithdraw) return send(env, user.telegram_id, `Minimum withdrawal is ${s.minWithdraw} points.`);
  if (!user.payment_details) return send(env, user.telegram_id, 'You must add payment method first', paymentKeyboard(user.country));

  const { earned, unlocked } = await withdrawStatus(env, user, s);
  if (!unlocked) {
    await clearState(env, user.telegram_id);
    return send(env, user.telegram_id, `❌ You must earn at least ${s.unlock} Points from Tasks first (${earned}/${s.unlock}).`);
  }
  if (points > user.balance) return send(env, user.telegram_id, 'Insufficient balance. Send a smaller amount or press a menu button to cancel.');

  const cur = currencyOf(user.country);
  const req = crypto.randomUUID();
  // Atomic: the withdrawal row is created only if the balance and unlock rule hold,
  // and the balance is deducted only if that row exists.
  const res = await env.DB.batch([
    st(env, `INSERT INTO withdrawals (user_id, points, amount, currency, req)
             SELECT u.id, ?, ?, ?, ? FROM users u
             WHERE u.id = ? AND u.balance >= ?
               AND (u.withdraw_unlocked = 1 OR (SELECT COALESCE(SUM(points), 0) FROM history WHERE user_id = u.id AND type = 'earn' AND status = 'approved') >= ?)`,
       points, String(points), cur, req, user.id, points, s.unlock),
    st(env, `UPDATE users SET balance = balance - ? WHERE id = ? AND EXISTS (SELECT 1 FROM withdrawals WHERE req = ?)`, points, user.id, req),
    st(env, `INSERT INTO history (user_id, type, description, status, points, ref_id)
             SELECT ?, 'withdraw', ?, 'pending', ?, id FROM withdrawals WHERE req = ?`,
       user.id, `Withdrawal ${cur} ${points}`, points, req),
  ]);
  if (res[0].meta.changes !== 1) return send(env, user.telegram_id, 'Insufficient balance. Send a smaller amount or press a menu button to cancel.');

  await clearState(env, user.telegram_id);
  const w = await q1(env, 'SELECT id FROM withdrawals WHERE req = ?', req);
  const fresh = await q1(env, 'SELECT balance FROM users WHERE id = ?', user.id);
  await send(env, user.telegram_id, `✅ Withdrawal request sent: ${cur} ${points}\nRemaining balance: ${fresh.balance} points`, MENU);
  await sendToAdmins(
    env,
    `💸 Withdrawal Request #${w.id}\nUser: ${nameOf(user)} (${user.country})\nID: ${user.telegram_id}\nPoints: ${points}\n` +
      `Amount: ${cur} ${points}\nMethod: ${user.payment_type}\nDetails: ${user.payment_details}`,
    ik([[cb('✅ Paid', `paid_${w.id}`), cb('↩️ Reject & Refund', `wreject_${w.id}`)]])
  ).catch((e) => console.error('Could not notify admin about withdrawal:', e.message));
}

async function onPhoto(env, m, pre) {
  const from = m.from;
  const state = pre || (await getState(env, from.id));
  if (state && state.kind === 'promo') return onPromoPhoto(env, m, state);
  if (!state || state.kind !== 'submit') return send(env, from.id, 'Open a task and press Submit first.');
  const user = await passGate(env, from);
  if (!user) return;

  const taskId = state.data.taskId;
  const task = await q1(env, 'SELECT require_username FROM tasks WHERE id = ?', taskId);
  let caption = (m.caption || '').trim().slice(0, 100);
  if (!caption && (!task || Number(task.require_username) === 1)) {
    return send(env, from.id, 'Please send the photo again with your username as the caption.');
  }
  if (!caption) caption = '(none)';

  const fileId = m.photo[m.photo.length - 1].file_id;

  const res = await env.DB.batch([
    st(env, `INSERT OR IGNORE INTO user_tasks (user_id, task_id, status, screenshot_id, submitted_username)
             SELECT ?, ?, 'pending', ?, ? WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.id = ? AND ${TASK_OPEN_SQL} AND ${NOT_OWN_PROMO_SQL})`,
       user.id, taskId, fileId, caption, taskId, user.id),
    st(env, `INSERT INTO history (user_id, type, description, status, points, ref_id)
             SELECT ?, 'task', 'Task: ' || title, 'pending', 0, (SELECT id FROM user_tasks WHERE user_id = ? AND task_id = ?)
             FROM tasks WHERE id = ?
               AND NOT EXISTS (SELECT 1 FROM history WHERE type = 'task' AND ref_id = (SELECT id FROM user_tasks WHERE user_id = ? AND task_id = ?))`,
       user.id, user.id, taskId, taskId, user.id, taskId),
  ]);
  if (res[0].meta.changes !== 1) {
    await clearState(env, from.id);
    return send(env, from.id, 'This task is not available or was already submitted.');
  }
  const utId = res[0].meta.last_row_id;

  try {
    await photoToAdmins(env, {
      photo: fileId,
      caption: `User ${nameOf(user)} (${user.country})\nID: ${user.telegram_id}\nTask ID: ${taskId}\nUsername: ${caption}\nUT_ID: ${utId}`,
      reply_markup: ik([[cb('✅ Approve', `approve_${utId}`), cb('❌ Reject', `reject_${utId}`)]]),
    });
  } catch (e) {
    console.error('Could not notify admin:', e.message);
    await env.DB.batch([
      st(env, 'DELETE FROM user_tasks WHERE id = ?', utId),
      st(env, `DELETE FROM history WHERE type = 'task' AND ref_id = ?`, utId),
    ]);
    return send(env, from.id, 'Could not send your submission to the admin. Please try again later.');
  }
  await clearState(env, from.id);
  await send(env, from.id, '✅ Submitted! Please wait while the admin reviews your task.');
}

async function onAddTask(env, m, text) {
  if (!(await isAdmin(env, m.from.id))) return;
  const parts = text.replace(/^\/addtask(@\w+)?\s*/i, '').split('|').map((p) => p.trim());
  const pm = (parts[3] || '').match(/^\d+/);
  const points = pm ? Number(pm[0]) : NaN;
  if (parts.length < 4 || !parts[0] || !Number.isInteger(points) || points <= 0) {
    return send(env, m.from.id, 'Usage: /addtask Title | Description | Link | Points\nAdd | optional at the end if the username is not required.');
  }
  const optional = (parts[4] || '').toLowerCase() === 'optional';
  const r = await run(env, 'INSERT INTO tasks (title, description, link, points, require_username) VALUES (?, ?, ?, ?, ?)', parts[0], parts[1], parts[2], points, optional ? 0 : 1);
  await send(env, m.from.id, `✅ Task added. ID: ${r.meta.last_row_id}`);
}

// ---------- Admin commands ----------
const ADMIN_HELP =
  `🛠 Admin commands\n\n` +
  `/panel - open the admin panel (easiest way to do everything)\n\n` +
  `/addtask Title | Description | Link | Points\n/tasks - list active tasks\n/deltask ID - delete a task\n\n` +
  `/settings - show current settings\n/setwelcome N - welcome bonus points\n/setreferral N - referral bonus (0 = off)\n` +
  `/setunlock N - task points needed before withdrawing (0 = none)\n/setminwithdraw N - minimum withdrawal\n\n` +
  `/unlock ID or @username - let a user withdraw without doing tasks\n/lock ID or @username - undo that\n/user ID or @username - view a user`;

const SET_COMMANDS = {
  setwelcome: { key: 'welcome', label: 'Welcome bonus', min: 0 },
  setreferral: { key: 'referral', label: 'Referral bonus', min: 0 },
  setunlock: { key: 'unlock', label: 'Task points needed to unlock withdrawals', min: 0 },
  setminwithdraw: { key: 'minWithdraw', label: 'Minimum withdrawal', min: 1 },
};

async function findUser(env, arg) {
  const a = (arg || '').trim();
  if (!a) return null;
  if (/^\d+$/.test(a)) return q1(env, 'SELECT * FROM users WHERE telegram_id = ?', Number(a));
  return q1(env, 'SELECT * FROM users WHERE lower(username) = lower(?)', a.replace(/^@/, ''));
}

async function onAdminCommand(env, m, text) {
  const parsed = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (!parsed) return false;
  const cmd = parsed[1].toLowerCase();
  const args = (parsed[2] || '').trim();
  const reply = (t) => send(env, m.from.id, t);

  if (cmd === 'admin') {
    await reply(ADMIN_HELP);
    return true;
  }

  if (cmd === 'settings') {
    const s = await getSettings(env);
    await reply(
      `⚙️ Current settings\n\nWelcome bonus: ${s.welcome} points\nReferral bonus: ${s.referral} points${s.referral === 0 ? ' (off)' : ''}\n` +
        `Task points needed before withdrawing: ${s.unlock}${s.unlock === 0 ? ' (no requirement)' : ''}\nMinimum withdrawal: ${s.minWithdraw} points\n\n` +
        `Change them with /setwelcome, /setreferral, /setunlock, /setminwithdraw. Send /admin for all commands.`
    );
    return true;
  }

  const setter = SET_COMMANDS[cmd];
  if (setter) {
    if (!/^\d+$/.test(args) || Number(args) < setter.min) {
      await reply(`Usage: /${cmd} N (a whole number, ${setter.min} or more)`);
      return true;
    }
    await run(env, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', SETTING_KEYS[setter.key], args);
    settingsCache = null;
    await reply(`✅ ${setter.label} is now ${Number(args)}. It applies from now on.`);
    return true;
  }

  if (cmd === 'unlock' || cmd === 'lock') {
    const target = await findUser(env, args);
    if (!target) {
      await reply(`User not found. Usage: /${cmd} ID or @username`);
      return true;
    }
    const on = cmd === 'unlock' ? 1 : 0;
    await run(env, 'UPDATE users SET withdraw_unlocked = ? WHERE id = ?', on, target.id);
    await reply(on ? `✅ ${nameOf(target)} can now withdraw without doing tasks.` : `🔒 Manual unlock removed for ${nameOf(target)}.`);
    if (on) await safeSend(env, target.telegram_id, '✅ Your withdrawals have been unlocked. You can now withdraw from the 🏦 Withdraw button.');
    return true;
  }

  if (cmd === 'user') {
    const u = await findUser(env, args);
    if (!u) {
      await reply('User not found. Usage: /user ID or @username');
      return true;
    }
    const s = await getSettings(env);
    const { earned, unlocked } = await withdrawStatus(env, u, s);
    const refs = await q1(env, 'SELECT COUNT(*) AS n FROM users WHERE referred_by = ? AND welcome_given = 1', u.id);
    const why = Number(u.withdraw_unlocked) === 1 ? 'unlocked by admin' : earned >= s.unlock ? 'earned enough from tasks' : `needs ${s.unlock} task points`;
    await reply(
      `👤 ${nameOf(u)} (${u.country || 'no country yet'})\nTelegram ID: ${u.telegram_id}\nBalance: ${u.balance} points\n` +
        `Task earnings: ${earned} points\nWithdrawals: ${unlocked ? 'unlocked' : 'locked'} (${why})\n` +
        `Payment: ${u.payment_details ? `${u.payment_type} - ${u.payment_details}` : 'not added'}\nReferrals: ${refs.n}`
    );
    return true;
  }

  if (cmd === 'tasks') {
    const rows = await qa(env, 'SELECT id, title, points, link FROM tasks WHERE is_active = 1 ORDER BY id LIMIT 50');
    await reply(rows.length ? `📋 Active tasks\n\n${rows.map((t) => `#${t.id} ${t.title} - ${t.points} pts\n${t.link || ''}`).join('\n\n')}\n\nDelete one with /deltask ID` : 'No active tasks. Add one with /addtask.');
    return true;
  }

  if (cmd === 'deltask') {
    if (!/^\d+$/.test(args)) {
      await reply('Usage: /deltask ID (see /tasks for the IDs)');
      return true;
    }
    // Hidden, not erased, so submissions that are already waiting can still be approved or rejected.
    const r = await run(env, 'UPDATE tasks SET is_active = 0 WHERE id = ? AND is_active = 1', Number(args));
    await reply(r.meta.changes ? `✅ Task ${args} deleted. Users no longer see it. Pending submissions can still be approved or rejected.` : `Task ${args} was not found or is already deleted.`);
    return true;
  }

  return false;
}

// ---------- Admin panel ----------
const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
const BACK_HOME = [cb('⬅️ Back', 'a:home')];

// Edits the panel message in place when possible, otherwise sends a new one.
async function showPanel(env, cq, chatId, text, rows) {
  const markup = ik(rows);
  if (cq) {
    try {
      await tg(env, 'editMessageText', {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        text,
        reply_markup: markup,
        disable_web_page_preview: true,
      });
      return;
    } catch (e) {
      if (String(e.message).includes('not modified')) return;
    }
  }
  await send(env, chatId, text, markup);
}

async function panelHome(env, cq, uid) {
  const owner = isOwner(env, uid);
  const rows = [
    [cb('📊 Stats', 'a:stats'), cb('📋 Tasks', 'a:tasks')],
    [cb('👥 Users', 'a:users'), cb('🏆 Leaderboard', 'a:lb')],
    [cb('📢 Broadcast', 'a:bc'), cb('⚙️ Settings', 'a:set')],
    [cb('📣 Promotions', 'a:pr')],
  ];
  if (owner) rows.push([cb('👮 Admins', 'a:adm')]);
  await showPanel(env, cq, uid, `🛠 Admin Panel${owner ? ' (owner)' : ''}\n\nChoose what you want to manage.`, rows);
}

async function panelStats(env, cq, uid) {
  const u = await q1(env, `SELECT COUNT(*) AS n, COALESCE(SUM(balance), 0) AS pts,
    COALESCE(SUM(CASE WHEN date(created_at) = date('now') THEN 1 ELSE 0 END), 0) AS today,
    COALESCE(SUM(banned), 0) AS banned FROM users`);
  const byCountry = await qa(env, `SELECT COALESCE(country, 'not chosen') AS c, COUNT(*) AS n FROM users GROUP BY country`);
  const count = async (sql) => (await q1(env, sql)).n;
  const pendingTasks = await count(`SELECT COUNT(*) AS n FROM user_tasks WHERE status = 'pending'`);
  const pendingWd = await count(`SELECT COUNT(*) AS n FROM withdrawals WHERE status = 'pending'`);
  const paidPts = await count(`SELECT COALESCE(SUM(points), 0) AS n FROM withdrawals WHERE status = 'paid'`);
  const activeTasks = await count(`SELECT COUNT(*) AS n FROM tasks WHERE is_active = 1`);
  const promos = await qa(env, 'SELECT status, COUNT(*) AS n FROM promotions GROUP BY status');
  await showPanel(
    env,
    cq,
    uid,
    `📊 Stats\n\nTotal users: ${u.n}\nNew today: ${u.today}\nBanned: ${u.banned}\n` +
      `${byCountry.map((r) => `${r.c}: ${r.n}`).join('\n')}\n\n` +
      `Points held by users: ${u.pts}\nPoints paid out: ${paidPts}\n\n` +
      `Active tasks: ${activeTasks}\nTask submissions waiting: ${pendingTasks}\nWithdrawals waiting: ${pendingWd}\n` +
      `Promotions: ${promos.length ? promos.map((p) => `${p.status} ${p.n}`).join(', ') : 'none yet'}`,
    [[cb('🔄 Refresh', 'a:stats')], BACK_HOME]
  );
}

async function panelTasks(env, cq, uid) {
  const rows = await qa(env, 'SELECT id, title, points, require_username FROM tasks WHERE is_active = 1 AND promo_id IS NULL ORDER BY id LIMIT 20');
  const text = rows.length
    ? `📋 Active tasks\n\n${rows.map((t) => `#${t.id} ${t.title} - ${t.points} pts (${Number(t.require_username) === 1 ? 'username required' : 'username optional'})`).join('\n')}\n\nTap 🗑 to delete a task.`
    : '📋 No active tasks yet.';
  const buttons = chunk(rows.map((t) => cb(`🗑 #${t.id}`, `a:dt:${t.id}`)), 4);
  await showPanel(env, cq, uid, text, [...buttons, [cb('➕ Add task', 'a:at')], BACK_HOME]);
}

async function finishAddTask(env, cq, uid, requireUsername) {
  const state = await getState(env, uid);
  if (!state || state.data.act !== 'addtask' || state.data.step !== 'user') return panelTasks(env, cq, uid);
  const d = state.data;
  const r = await run(env, 'INSERT INTO tasks (title, description, link, points, require_username) VALUES (?, ?, ?, ?, ?)', d.title, d.desc, d.link, d.points, requireUsername ? 1 : 0);
  await clearState(env, uid);
  await send(env, uid, `✅ Task #${r.meta.last_row_id} added. A screenshot is required${requireUsername ? ' with the username' : '; the username is optional'}.`);
  await panelTasks(env, null, uid);
}

async function userCard(env, cq, uid, tid) {
  const u = await q1(env, 'SELECT * FROM users WHERE telegram_id = ?', tid);
  if (!u) return showPanel(env, cq, uid, 'User not found.', [[cb('⬅️ Back', 'a:users')]]);
  const s = await getSettings(env);
  const { earned, unlocked } = await withdrawStatus(env, u, s);
  const refs = await q1(env, 'SELECT COUNT(*) AS n FROM users WHERE referred_by = ? AND welcome_given = 1', u.id);
  const why = Number(u.withdraw_unlocked) === 1 ? 'unlocked by admin' : earned >= s.unlock ? 'earned enough from tasks' : `needs ${s.unlock} task points`;
  const text =
    `👤 ${nameOf(u)} (${u.country || 'no country yet'})\nTelegram ID: ${u.telegram_id}\nJoined: ${u.created_at}\n\n` +
    `Balance: ${u.balance} points\nTask earnings: ${earned} points\nWithdrawals: ${unlocked ? 'unlocked' : 'locked'} (${why})\n` +
    `Account: ${Number(u.banned) === 1 ? '🚫 BANNED' : 'active'}\n` +
    `Payment: ${u.payment_details ? `${u.payment_type} - ${u.payment_details}` : 'not added'}\nReferrals: ${refs.n}`;
  const t = u.telegram_id;
  await showPanel(env, cq, uid, text, [
    [cb('➕ Add points', `a:ub:${t}:add`), cb('➖ Remove', `a:ub:${t}:sub`), cb('✏️ Set', `a:ub:${t}:set`)],
    [cb('🔓 Unlock withdraw', `a:ul:${t}:1`), cb('🔒 Lock withdraw', `a:ul:${t}:0`)],
    [cb('🚫 Ban', `a:ban:${t}:1`), cb('✅ Unban', `a:ban:${t}:0`)],
    [cb('✉️ Message user', `a:um:${t}`)],
    [cb('⬅️ Back', 'a:users')],
  ]);
}

async function adjustBalance(env, target, mode, n, note) {
  const before = (await q1(env, 'SELECT balance FROM users WHERE id = ?', target.id)).balance;
  const next = mode === 'add' ? before + n : mode === 'sub' ? Math.max(0, before - n) : n;
  const update =
    mode === 'add'
      ? st(env, 'UPDATE users SET balance = balance + ? WHERE id = ?', n, target.id)
      : mode === 'sub'
        ? st(env, 'UPDATE users SET balance = MAX(0, balance - ?) WHERE id = ?', n, target.id)
        : st(env, 'UPDATE users SET balance = ? WHERE id = ?', n, target.id);
  await env.DB.batch([
    update,
    st(env, `INSERT INTO history (user_id, type, description, status, points) VALUES (?, 'admin', ?, 'approved', ?)`, target.id, note || 'Admin adjustment', next - before),
  ]);
  const after = (await q1(env, 'SELECT balance FROM users WHERE id = ?', target.id)).balance;
  return { before, after, delta: next - before };
}

async function panelLeaderboard(env, cq, uid) {
  const rows = await qa(env, 'SELECT telegram_id, username, balance, country FROM users ORDER BY balance DESC LIMIT 20');
  const text = rows.length
    ? `🏆 Top ${rows.length} users\n\n${rows.map((r, i) => `${i + 1}. ${r.username ? '@' + r.username : 'no username'} (ID ${r.telegram_id}) - ${r.balance} pts - ${r.country || 'N/A'}`).join('\n')}\n\nTap a number to open that user and reward them.`
    : 'No users yet.';
  const buttons = chunk(rows.slice(0, 10).map((r, i) => cb(String(i + 1), `a:u:${r.telegram_id}`)), 5);
  await showPanel(env, cq, uid, text, [...buttons, BACK_HOME]);
}

async function panelBroadcast(env, cq, uid) {
  await setState(env, uid, 'admin', { act: 'broadcast' });
  const last = await q1(env, 'SELECT * FROM broadcasts ORDER BY id DESC LIMIT 1');
  const info = last ? `\n\nLast broadcast: ${last.status === 'done' ? 'finished' : 'sending'} - ${last.sent}/${last.total} delivered, ${last.failed} failed.` : '';
  await showPanel(
    env,
    cq,
    uid,
    `📢 Broadcast\n\nSend the notice every user should receive: a text message, or a photo with a caption. Send /cancel to stop.${info}`,
    [BACK_HOME]
  );
}

// Sends a notice to users in small batches (called by the cron trigger every minute).
async function runBroadcastChunk(env) {
  const b = await q1(env, `SELECT * FROM broadcasts WHERE status = 'sending' ORDER BY id LIMIT 1`);
  if (!b) return;
  const now = Math.floor(Date.now() / 1000);
  const lock = await run(env, 'UPDATE broadcasts SET locked_at = ? WHERE id = ? AND (locked_at IS NULL OR locked_at < ?)', now, b.id, now - 45);
  if (lock.meta.changes !== 1) return;
  const users = await qa(env, 'SELECT id, telegram_id FROM users WHERE id > ? AND banned = 0 ORDER BY id LIMIT 35', b.last_user_id);
  if (!users.length) {
    await run(env, `UPDATE broadcasts SET status = 'done', locked_at = NULL WHERE id = ?`, b.id);
    await safeSend(env, b.created_by, `📢 Broadcast finished: ${b.sent} delivered, ${b.failed} failed (users who blocked the bot).`);
    return;
  }
  let sent = 0;
  let failed = 0;
  for (const u of users) {
    try {
      if (b.kind === 'photo') await tg(env, 'sendPhoto', { chat_id: u.telegram_id, photo: b.file_id, caption: b.text || undefined });
      else await tg(env, 'sendMessage', { chat_id: u.telegram_id, text: b.text, disable_web_page_preview: true });
      sent++;
    } catch (e) {
      failed++;
    }
  }
  await run(env, 'UPDATE broadcasts SET sent = sent + ?, failed = failed + ?, last_user_id = ?, locked_at = NULL WHERE id = ?', sent, failed, users[users.length - 1].id, b.id);
}

const NUM_SETTINGS = {
  welcome: { label: 'Welcome bonus (points for new users)', min: 0 },
  referral: { label: 'Referral bonus (points per referral)', min: 0 },
  unlock: { label: 'Task points needed before withdrawing (0 = none)', min: 0 },
  minWithdraw: { label: 'Minimum withdrawal (points)', min: 1 },
};

async function saveSetting(env, key, value) {
  await run(env, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', key, String(value));
  settingsCache = null;
}

async function panelSettings(env, cq, uid) {
  const s = await getSettings(env);
  const prices = PROMO_TYPES.map((t) => `${PROMO_LABEL[t]}: NGN ${money(priceOf(s, t, 'NGN'))} / GHS ${money(priceOf(s, t, 'GHS'))} (user earns ${rewardOf(s, t)} pts)`).join('\n');
  const text =
    `⚙️ Settings\n\nWelcome bonus: ${s.welcome} points\nReferral: ${s.referralOn ? 'ON' : 'OFF'} (${s.referralBase} points each)\n` +
    `Withdraw unlock: ${s.unlock} task points${s.unlock === 0 ? ' (none needed)' : ''}\nMinimum withdrawal: ${s.minWithdraw} points\n\n` +
    `Promotion: ${s.promoOn ? 'ON' : 'OFF (users see Coming soon)'}\nPrice per unit and points users earn:\n${prices}\n\n` +
    `Payment accounts:\nNigeria: ${payInfoOf(s, 'Nigeria') || 'not set'}\nGhana: ${payInfoOf(s, 'Ghana') || 'not set'}`;
  await showPanel(env, cq, uid, text, [
    [cb('🎁 Welcome bonus', 'a:s:welcome'), cb('👥 Referral points', 'a:s:referral')],
    [cb(`Referral: ${s.referralOn ? 'turn OFF' : 'turn ON'}`, 'a:t:referral')],
    [cb('🔓 Unlock points', 'a:s:unlock'), cb('💸 Min withdraw', 'a:s:minWithdraw')],
    [cb(`📣 Promotion: ${s.promoOn ? 'turn OFF' : 'turn ON'}`, 'a:t:promo')],
    [cb('💲 Promo prices', 'a:s:price'), cb('⭐ Task rewards', 'a:s:reward')],
    [cb('🏦 Payment accounts', 'a:s:pay')],
    BACK_HOME,
  ]);
}

async function panelAdmins(env, cq, uid) {
  const rows = await qa(env, 'SELECT telegram_id FROM admins ORDER BY created_at');
  const owners = cfgOf(env).admins;
  const text =
    `👮 Admins\n\nOwner: ${owners.join(', ')}\n\n` +
    (rows.length ? `Admins:\n${rows.map((r) => `• ${r.telegram_id}`).join('\n')}` : 'No extra admins yet.') +
    '\n\nAdmins can use the whole panel except this section.';
  const buttons = chunk(rows.map((r) => cb(`🗑 ${r.telegram_id}`, `a:radm:${r.telegram_id}`)), 2);
  await showPanel(env, cq, uid, text, [...buttons, [cb('➕ Add admin', 'a:aadm')], BACK_HOME]);
}

async function panelPromos(env, cq, uid) {
  const pending = await qa(env, `SELECT id, type, quantity, currency, total FROM promotions WHERE status = 'pending' ORDER BY id LIMIT 10`);
  const active = await qa(
    env,
    `SELECT p.id, p.type, p.quantity, (SELECT COUNT(*) FROM user_tasks ut JOIN tasks t ON t.id = ut.task_id WHERE t.promo_id = p.id AND ut.status = 'approved') AS done
     FROM promotions p WHERE p.status = 'active' ORDER BY p.id LIMIT 10`
  );
  const text =
    `📣 Promotions\n\nWaiting for approval: ${pending.length}\n` +
    (pending.length ? pending.map((p) => `#${p.id} ${PROMO_LABEL[p.type]} x ${p.quantity} - ${p.currency} ${money(p.total)}`).join('\n') : '') +
    `\n\nActive: ${active.length}\n` +
    (active.length ? active.map((p) => `#${p.id} ${PROMO_LABEL[p.type]} ${p.done} / ${p.quantity}`).join('\n') : '');
  const rows = [
    ...chunk(pending.map((p) => cb(`👁 Review #${p.id}`, `a:pv:${p.id}`)), 2),
    ...chunk(active.map((p) => cb(`⛔ Stop #${p.id}`, `a:pstop:${p.id}`)), 2),
    BACK_HOME,
  ];
  await showPanel(env, cq, uid, text, rows);
}

async function onPanelCallback(env, cq, data) {
  const uid = cq.from.id;
  const p = data.split(':');
  const owner = isOwner(env, uid);

  switch (p[1]) {
    case 'home':
      await clearState(env, uid);
      return panelHome(env, cq, uid);
    case 'stats':
      return panelStats(env, cq, uid);
    case 'tasks':
      return panelTasks(env, cq, uid);
    case 'at':
      await setState(env, uid, 'admin', { act: 'addtask', step: 'title' });
      return send(env, uid, '➕ New task\n\nSend the task title. (Send /cancel to stop.)');
    case 'atu':
      return finishAddTask(env, cq, uid, p[2] === '1');
    case 'dt':
      await run(env, 'UPDATE tasks SET is_active = 0 WHERE id = ? AND promo_id IS NULL', Number(p[2]));
      return panelTasks(env, cq, uid);
    case 'users':
      await setState(env, uid, 'admin', { act: 'finduser' });
      return showPanel(env, cq, uid, "👥 Users\n\nSend the user's Telegram ID or @username.", [BACK_HOME]);
    case 'u':
      await clearState(env, uid);
      return userCard(env, cq, uid, Number(p[2]));
    case 'ub': {
      const modes = { add: 'add (example: 50 Congratulations, you won our quiz!)', sub: 'remove (example: 20 Reason for the correction)', set: 'set the balance to (example: 100 Balance corrected)' };
      await setState(env, uid, 'admin', { act: 'balance', tid: Number(p[2]), mode: p[3] });
      return send(env, uid, `Send the number of points to ${modes[p[3]] || modes.add}.\nThe text after the number is sent to the user as a message. Send /cancel to stop.`);
    }
    case 'ul': {
      const on = p[3] === '1' ? 1 : 0;
      const t = await q1(env, 'SELECT * FROM users WHERE telegram_id = ?', Number(p[2]));
      if (t) {
        await run(env, 'UPDATE users SET withdraw_unlocked = ? WHERE id = ?', on, t.id);
        if (on) await safeSend(env, t.telegram_id, '✅ Your withdrawals have been unlocked. You can now use the 🏦 Withdraw button.');
      }
      return userCard(env, cq, uid, Number(p[2]));
    }
    case 'ban': {
      const on = p[3] === '1' ? 1 : 0;
      const t = await q1(env, 'SELECT * FROM users WHERE telegram_id = ?', Number(p[2]));
      if (t && !(await isAdmin(env, t.telegram_id))) {
        await run(env, 'UPDATE users SET banned = ? WHERE id = ?', on, t.id);
        await safeSend(env, t.telegram_id, on ? '🚫 Your account has been suspended. Contact support if you think this is a mistake.' : '✅ Your account has been restored. Welcome back!');
      }
      return userCard(env, cq, uid, Number(p[2]));
    }
    case 'um':
      await setState(env, uid, 'admin', { act: 'msguser', tid: Number(p[2]) });
      return send(env, uid, 'Send the message for this user. Send /cancel to stop.');
    case 'lb':
      return panelLeaderboard(env, cq, uid);
    case 'bc':
      return panelBroadcast(env, cq, uid);
    case 'bcno':
      await clearState(env, uid);
      return panelHome(env, cq, uid);
    case 'bcgo': {
      const state = await getState(env, uid);
      if (!state || state.data.act !== 'bcconfirm') return panelHome(env, cq, uid);
      const d = state.data;
      const total = (await q1(env, 'SELECT COUNT(*) AS n FROM users WHERE banned = 0')).n;
      await run(env, `INSERT INTO broadcasts (kind, text, file_id, status, total, created_by) VALUES (?, ?, ?, 'sending', ?, ?)`, d.kind, d.text || '', d.file_id || null, total, uid);
      await clearState(env, uid);
      await send(env, uid, `📢 Broadcast started for ${total} users. It is sent in small batches, so large audiences take a while. You will get a message when it finishes.`);
      await runBroadcastChunk(env);
      return;
    }
    case 'set':
      return panelSettings(env, cq, uid);
    case 's': {
      const key = p[2];
      if (NUM_SETTINGS[key]) {
        await setState(env, uid, 'admin', { act: 'setnum', key });
        return send(env, uid, `${NUM_SETTINGS[key].label}\n\nSend the new value (a whole number). Send /cancel to stop.`);
      }
      await setState(env, uid, 'admin', { act: key === 'price' ? 'setprice' : key === 'reward' ? 'setreward' : 'setpay' });
      const hints = {
        price: 'Send: type, currency and price per unit.\nExample: followers NGN 10\nTypes: followers, likes, views, comments. Currency: NGN or GHS. A price of 0 turns that type off for that country.',
        reward: 'Send: type and the points users earn for each completed task.\nExample: followers 10',
        pay: 'Send: country and the account advertisers must pay.\nExample: Nigeria GTBank 0123456789 DoubleEarn Ltd\nExample: Ghana MTN MoMo 0244123456 Kofi Mensah',
      };
      return send(env, uid, `${hints[key] || hints.price}\n\nSend /cancel to stop.`);
    }
    case 't': {
      const s = await getSettings(env);
      if (p[2] === 'referral') await saveSetting(env, 'referral_on', s.referralOn ? '0' : '1');
      if (p[2] === 'promo') await saveSetting(env, 'promo_on', s.promoOn ? '0' : '1');
      return panelSettings(env, cq, uid);
    }
    case 'pr':
      return panelPromos(env, cq, uid);
    case 'pv': {
      const pr = await q1(env, 'SELECT p.*, u.telegram_id AS tid, u.username AS uname, u.country AS ucountry FROM promotions p JOIN users u ON u.id = p.user_id WHERE p.id = ?', Number(p[2]));
      if (!pr) return send(env, uid, 'Promotion not found.');
      const caption = promoCaption(pr, { username: pr.uname, telegram_id: pr.tid, country: pr.ucountry });
      const markup = pr.status === 'pending' ? ik([[cb('✅ Approve', `papprove_${pr.id}`), cb('❌ Reject', `preject_${pr.id}`)]]) : undefined;
      return tg(env, 'sendPhoto', { chat_id: uid, photo: pr.pay_screenshot, caption, reply_markup: markup });
    }
    case 'pstop': {
      const id = Number(p[2]);
      const pr = await q1(env, `SELECT p.id, p.currency, p.total, u.telegram_id AS tid FROM promotions p JOIN users u ON u.id = p.user_id WHERE p.id = ? AND p.status = 'active'`, id);
      if (pr) {
        await env.DB.batch([
          st(env, `UPDATE promotions SET status = 'stopped' WHERE id = ? AND status = 'active'`, id),
          st(env, 'UPDATE tasks SET is_active = 0 WHERE promo_id = ?', id),
        ]);
        await safeSend(env, pr.tid, `⛔ Your promotion #${id} was stopped by the admin. Support will contact you about the remaining balance.`);
      }
      return panelPromos(env, cq, uid);
    }
    case 'adm':
      if (!owner) return;
      return panelAdmins(env, cq, uid);
    case 'aadm':
      if (!owner) return;
      await setState(env, uid, 'admin', { act: 'addadmin' });
      return send(env, uid, "Send the new admin's Telegram ID (numbers only). They must have opened the bot with /start. Send /cancel to stop.");
    case 'radm':
      if (!owner) return;
      await run(env, 'DELETE FROM admins WHERE telegram_id = ?', Number(p[2]));
      await safeSend(env, Number(p[2]), 'ℹ️ You are no longer an admin of DoubleEarn.');
      return panelAdmins(env, cq, uid);
    default:
      return panelHome(env, cq, uid);
  }
}

// Text and photo messages an admin sends while a panel action is waiting for input.
async function onAdminInput(env, m, text, state) {
  const uid = m.from.id;
  const d = state.data;
  if (text === '/cancel') {
    await clearState(env, uid);
    return panelHome(env, null, uid);
  }

  if (d.act === 'broadcast') {
    const content = m.photo ? { kind: 'photo', file_id: m.photo[m.photo.length - 1].file_id, text: (m.caption || '').trim() } : { kind: 'text', text };
    if (!content.text && content.kind === 'text') return;
    await setState(env, uid, 'admin', { act: 'bcconfirm', ...content });
    const total = (await q1(env, 'SELECT COUNT(*) AS n FROM users WHERE banned = 0')).n;
    const markup = ik([[cb(`✅ Send to ${total} users`, 'a:bcgo'), cb('❌ Cancel', 'a:bcno')]]);
    await send(env, uid, '👇 This is exactly what users will receive:');
    if (content.kind === 'photo') return tg(env, 'sendPhoto', { chat_id: uid, photo: content.file_id, caption: content.text || undefined, reply_markup: markup });
    return send(env, uid, content.text, markup);
  }

  if (!text) return;

  if (d.act === 'addtask') {
    if (d.step === 'title') {
      await setState(env, uid, 'admin', { ...d, step: 'desc', title: text.slice(0, 100) });
      return send(env, uid, 'Send the task description (what users must do).');
    }
    if (d.step === 'desc') {
      await setState(env, uid, 'admin', { ...d, step: 'link', desc: text.slice(0, 500) });
      return send(env, uid, 'Send the task link. (Send - if there is no link.)');
    }
    if (d.step === 'link') {
      await setState(env, uid, 'admin', { ...d, step: 'points', link: text === '-' ? '' : text.slice(0, 300) });
      return send(env, uid, 'How many points should users earn for this task? (a whole number)');
    }
    if (d.step === 'points') {
      if (!/^\d+$/.test(text) || Number(text) <= 0) return send(env, uid, 'Send a whole number greater than 0.');
      await setState(env, uid, 'admin', { ...d, step: 'user', points: Number(text) });
      return send(env, uid, 'Is the username required? A screenshot is always required.', ik([[cb('🧑 Username required', 'a:atu:1'), cb('🙈 Username optional', 'a:atu:0')]]));
    }
    return;
  }

  if (d.act === 'finduser') {
    const u = await findUser(env, text);
    if (!u) return send(env, uid, 'User not found. Send a Telegram ID or @username, or /cancel.');
    await clearState(env, uid);
    return userCard(env, null, uid, u.telegram_id);
  }

  if (d.act === 'balance') {
    const mt = text.match(/^(\d+)(?:\s+([\s\S]+))?$/);
    if (!mt) return send(env, uid, 'Send a whole number, then an optional message.\nExample: 50 Congratulations, you won!');
    const target = await q1(env, 'SELECT * FROM users WHERE telegram_id = ?', d.tid);
    if (!target) {
      await clearState(env, uid);
      return send(env, uid, 'User not found.');
    }
    const n = Number(mt[1]);
    const note = (mt[2] || '').trim().slice(0, 300);
    const r = await adjustBalance(env, target, d.mode, n, note);
    await clearState(env, uid);
    const msg =
      d.mode === 'add'
        ? `🎉 ${note || 'You received a reward from DoubleEarn!'}\n\n+${r.delta} points added. New balance: ${r.after} points.`
        : d.mode === 'sub'
          ? `ℹ️ Your balance was adjusted by the admin${note ? `: ${note}` : '.'}\n${r.delta} points. New balance: ${r.after} points.`
          : `ℹ️ Your balance was updated to ${r.after} points${note ? ` (${note})` : ''}.`;
    await safeSend(env, target.telegram_id, msg);
    await send(env, uid, `✅ Done. ${nameOf(target)}: ${r.before} → ${r.after} points. The user was notified.`);
    return userCard(env, null, uid, target.telegram_id);
  }

  if (d.act === 'msguser') {
    await clearState(env, uid);
    await safeSend(env, d.tid, `📩 Message from DoubleEarn support:\n\n${text}`);
    return send(env, uid, '✅ Message sent.');
  }

  if (d.act === 'setnum') {
    const spec = NUM_SETTINGS[d.key];
    if (!/^\d+$/.test(text) || Number(text) < spec.min) return send(env, uid, `Send a whole number (${spec.min} or more), or /cancel.`);
    await saveSetting(env, SETTING_KEYS[d.key], Number(text));
    await clearState(env, uid);
    return panelSettings(env, null, uid);
  }

  if (d.act === 'setprice') {
    const mt = text.match(/^(followers|likes|views|comments)\s+(NGN|GHS)\s+([0-9]*\.?[0-9]+)$/i);
    if (!mt) return send(env, uid, 'Use this format: followers NGN 10\n(or /cancel)');
    await saveSetting(env, `price_${mt[1].toLowerCase()}_${mt[2].toUpperCase()}`, Number(mt[3]));
    await clearState(env, uid);
    return panelSettings(env, null, uid);
  }

  if (d.act === 'setreward') {
    const mt = text.match(/^(followers|likes|views|comments)\s+(\d+)$/i);
    if (!mt || Number(mt[2]) <= 0) return send(env, uid, 'Use this format: followers 10\n(or /cancel)');
    await saveSetting(env, `reward_${mt[1].toLowerCase()}`, Number(mt[2]));
    await clearState(env, uid);
    return panelSettings(env, null, uid);
  }

  if (d.act === 'setpay') {
    const mt = text.match(/^(nigeria|ghana)\s+([\s\S]{5,300})$/i);
    if (!mt) return send(env, uid, 'Use this format: Nigeria GTBank 0123456789 Your Name\n(or /cancel)');
    const country = mt[1].toLowerCase() === 'ghana' ? 'Ghana' : 'Nigeria';
    await saveSetting(env, `pay_${country}`, mt[2].trim());
    await clearState(env, uid);
    return panelSettings(env, null, uid);
  }

  if (d.act === 'addadmin') {
    if (!isOwner(env, uid)) return;
    if (!/^\d{5,15}$/.test(text)) return send(env, uid, 'Send the Telegram ID as numbers only, or /cancel.');
    await run(env, 'INSERT OR IGNORE INTO admins (telegram_id, added_by) VALUES (?, ?)', Number(text), uid);
    await clearState(env, uid);
    await safeSend(env, Number(text), '✅ You are now an admin of DoubleEarn. Send /panel to open the admin panel.');
    return panelAdmins(env, null, uid);
  }
}

// ---------- Promotions (advertisers) ----------
const PROMO_TYPES = ['followers', 'likes', 'views', 'comments'];
const PROMO_LABEL = { followers: 'Followers', likes: 'Likes', views: 'Views', comments: 'Comments' };
const DEFAULT_REWARDS = { followers: 10, likes: 3, views: 2, comments: 5 };
const PROMO_MIN_QTY = 10;
const PROMO_MAX_QTY = 100000;
const PROMO_STATUS = {
  pending: '⏳ Waiting for admin approval',
  active: '🟢 Active',
  completed: '✅ Completed',
  rejected: '❌ Rejected (refund in progress)',
  refunded: '💸 Rejected and refunded',
  stopped: '⛔ Stopped',
};

const money = (n) => String(Math.round(n * 100) / 100);
const priceOf = (s, type, cur) => {
  const v = Number(s.raw[`price_${type}_${cur}`]);
  return Number.isFinite(v) && v > 0 ? v : 0;
};
const rewardOf = (s, type) => {
  const v = Number(s.raw[`reward_${type}`]);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_REWARDS[type];
};
const payInfoOf = (s, country) => (s.raw[`pay_${country}`] || '').trim();

function promoCaption(p, u) {
  return (
    `📣 Promotion #${p.id} (${p.status})\nAdvertiser: ${nameOf(u)} (${u.country})\nID: ${u.telegram_id}\n` +
    `Type: ${PROMO_LABEL[p.type]} x ${p.quantity}\nLink: ${String(p.link).slice(0, 200)}\n` +
    (p.comment_text ? `Comment: ${String(p.comment_text).slice(0, 150)}\n` : '') +
    `Total paid: ${p.currency} ${money(p.total)} (${p.currency} ${money(p.price_per_unit)} each)\n` +
    `Payer name: ${String(p.pay_name).slice(0, 80)}\nRefund account: ${String(p.refund_details).slice(0, 150)}`
  ).slice(0, 1000);
}

async function hPromotion(env, user) {
  const s = await getSettings(env);
  if (!s.promoOn) {
    return send(env, user.telegram_id, '📣 Promotion is coming soon!\n\nVery soon you will be able to promote your profile and get real followers, likes, views and comments from our users. Stay tuned.');
  }
  await send(
    env,
    user.telegram_id,
    '📣 Promotion\n\nGrow your profile with real people. Create a promotion, pay, and our users complete the work for you.',
    ik([[cb('➕ Create Promotion', 'promo_new')], [cb('📊 My Promotion', 'promo_my')]])
  );
}

async function myPromotions(env, user) {
  const rows = await qa(
    env,
    `SELECT p.*, (SELECT COUNT(*) FROM user_tasks ut JOIN tasks t ON t.id = ut.task_id WHERE t.promo_id = p.id AND ut.status = 'approved') AS done
     FROM promotions p WHERE p.user_id = ? ORDER BY p.id DESC LIMIT 10`,
    user.id
  );
  if (!rows.length) return send(env, user.telegram_id, 'You have no promotions yet. Tap 📣 Promotion → ➕ Create Promotion to start one.');
  const blocks = rows.map((p) => {
    const done = p.status === 'pending' || p.status === 'rejected' || p.status === 'refunded' ? 0 : p.done;
    return (
      `#${p.id} ${PROMO_LABEL[p.type]} Promotion\n${done} / ${p.quantity}\n${done} completed${p.status === 'active' ? `, ${p.quantity - done} remaining` : ''}\n` +
      `Status: ${PROMO_STATUS[p.status] || p.status}\n${String(p.link).slice(0, 100)}`
    );
  });
  await send(env, user.telegram_id, `📊 My Promotion\n\n${blocks.join('\n\n')}`);
}

async function onPromoCallback(env, user, data) {
  const s = await getSettings(env);
  const tid = user.telegram_id;
  if (!s.promoOn) return send(env, tid, '📣 Promotion is coming soon!');
  const cur = currencyOf(user.country);

  if (data === 'promo_my') return myPromotions(env, user);

  if (data === 'promo_new') {
    const types = PROMO_TYPES.filter((t) => priceOf(s, t, cur) > 0);
    if (!types.length || !payInfoOf(s, user.country)) return send(env, tid, 'Promotion is not available right now. Please try again later.');
    await setState(env, tid, 'promo', { step: 'type' });
    return send(env, tid, `What do you want to get?\nPrices are in ${cur}.`, ik(types.map((t) => [cb(`${PROMO_LABEL[t]} - ${cur} ${money(priceOf(s, t, cur))} each`, `promo_t_${t}`)])));
  }

  const state = await getState(env, tid);
  if (!state || state.kind !== 'promo') return send(env, tid, 'Please start again from 📣 Promotion.');
  const d = state.data;
  let m;

  if ((m = data.match(/^promo_t_(followers|likes|views|comments)$/))) {
    if (priceOf(s, m[1], cur) <= 0) return send(env, tid, 'This option is not available right now.');
    await setState(env, tid, 'promo', { step: 'link', type: m[1] });
    return send(env, tid, 'Send the link of the profile or post you want to promote.\nExample: https://www.tiktok.com/@yourname');
  }

  if (data === 'promo_skip' && d.step === 'comment') {
    await setState(env, tid, 'promo', { ...d, step: 'qty', comment: '' });
    return send(env, tid, `How many ${PROMO_LABEL[d.type].toLowerCase()} do you want? (${PROMO_MIN_QTY} to ${PROMO_MAX_QTY})`);
  }

  if (data === 'promo_paid' && d.step === 'confirm') {
    await setState(env, tid, 'promo', { ...d, step: 'shot' });
    return send(env, tid, '📸 Send the screenshot of your payment as a photo.');
  }

  if (data === 'promo_cancel') {
    await clearState(env, tid);
    return send(env, tid, 'Promotion cancelled.', MENU);
  }
}

async function onPromoText(env, user, text, state) {
  const s = await getSettings(env);
  const tid = user.telegram_id;
  const d = state.data;
  const cur = currencyOf(user.country);

  if (d.step === 'link') {
    if (!/^https?:\/\/\S{4,300}$/i.test(text)) return send(env, tid, 'Please send a valid link that starts with http:// or https://');
    if (d.type === 'comments') {
      await setState(env, tid, 'promo', { ...d, step: 'comment', link: text });
      return send(env, tid, 'Send the comment you want users to post. You can also skip and let users write their own.', ik([[cb('⏭ Skip', 'promo_skip')]]));
    }
    await setState(env, tid, 'promo', { ...d, step: 'qty', link: text });
    return send(env, tid, `How many ${PROMO_LABEL[d.type].toLowerCase()} do you want? (${PROMO_MIN_QTY} to ${PROMO_MAX_QTY})`);
  }

  if (d.step === 'comment') {
    await setState(env, tid, 'promo', { ...d, step: 'qty', comment: text.slice(0, 200) });
    return send(env, tid, `How many comments do you want? (${PROMO_MIN_QTY} to ${PROMO_MAX_QTY})`);
  }

  if (d.step === 'qty') {
    const qty = /^\d+$/.test(text) ? Number(text) : 0;
    if (qty < PROMO_MIN_QTY || qty > PROMO_MAX_QTY) return send(env, tid, `Send a whole number from ${PROMO_MIN_QTY} to ${PROMO_MAX_QTY}.`);
    const price = priceOf(s, d.type, cur);
    const pay = payInfoOf(s, user.country);
    if (!price || !pay) return send(env, tid, 'Promotion is not available right now. Please try again later.');
    const total = Math.round(qty * price * 100) / 100;
    await setState(env, tid, 'promo', { ...d, step: 'confirm', qty, price, total, cur });
    return send(
      env,
      tid,
      `🧾 Your promotion\n\n${PROMO_LABEL[d.type]}: ${qty}\nPrice: ${cur} ${money(price)} each\nTotal to pay: ${cur} ${money(total)}\n\n` +
        `Pay to:\n${pay}\n\nAfter paying, tap the button below and send your screenshot.`,
      ik([[cb('✅ I have paid', 'promo_paid')], [cb('❌ Cancel', 'promo_cancel')]])
    );
  }

  if (d.step === 'name') {
    if (text.length < 3 || text.length > 80) return send(env, tid, 'Send your full name (the name used for the payment).');
    await setState(env, tid, 'promo', { ...d, step: 'refund', payName: text });
    return send(env, tid, 'Send your account number and account name (bank or MoMo network) where we should refund you if your promotion is rejected.');
  }

  if (d.step === 'refund') {
    if (text.length < 5 || text.length > 200) return send(env, tid, 'Send your account number and account name, for example: GTB 0123456789 Musa Ali');
    const r = await run(
      env,
      `INSERT INTO promotions (user_id, country, currency, type, link, comment_text, quantity, price_per_unit, total, reward, pay_name, pay_screenshot, refund_details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      user.id, user.country, d.cur, d.type, d.link, d.comment || '', d.qty, d.price, d.total, rewardOf(s, d.type), d.payName, d.shot, text
    );
    const id = r.meta.last_row_id;
    await clearState(env, tid);
    await send(env, tid, `✅ Submitted! Promotion #${id} is waiting for admin approval. You will be notified here. Track it in 📣 Promotion → 📊 My Promotion.`, MENU);
    const p = await q1(env, 'SELECT * FROM promotions WHERE id = ?', id);
    await photoToAdmins(env, {
      photo: d.shot,
      caption: promoCaption(p, user),
      reply_markup: ik([[cb('✅ Approve', `papprove_${id}`), cb('❌ Reject', `preject_${id}`)]]),
    }).catch((e) => console.error('Could not notify admins about a promotion:', e.message));
    return;
  }
}

async function onPromoPhoto(env, m, state) {
  const user = await passGate(env, m.from);
  if (!user) return;
  if (state.data.step !== 'shot') return send(env, user.telegram_id, 'Please follow the steps shown above, or start again from 📣 Promotion.');
  await setState(env, user.telegram_id, 'promo', { ...state.data, step: 'name', shot: m.photo[m.photo.length - 1].file_id });
  await send(env, user.telegram_id, 'Send your full name (the name used for the payment).');
}

function promoTaskText(p) {
  const how = {
    followers: ['Follow this profile', 'Open the link, follow the account, then send a screenshot as proof.'],
    likes: ['Like this post', 'Open the link, like it, then send a screenshot as proof.'],
    views: ['Watch this video', 'Open the link, watch the video, then send a screenshot as proof.'],
    comments: ['Comment on this post', p.comment_text ? `Open the link and post this comment: "${p.comment_text}", then send a screenshot as proof.` : 'Open the link and write a genuine comment, then send a screenshot as proof.'],
  }[p.type];
  return { title: `📣 ${how[0]}`, description: `${how[1]}\nPut your username in the caption of the photo.` };
}

async function approvePromo(env, cq, id, ack) {
  const p = await q1(env, `SELECT p.*, u.telegram_id AS tid FROM promotions p JOIN users u ON u.id = p.user_id WHERE p.id = ? AND p.status = 'pending'`, id);
  if (!p) return alreadyHandled(env, cq, ack);
  const t = promoTaskText(p);
  const res = await env.DB.batch([
    st(env, `UPDATE promotions SET status = 'active' WHERE id = ? AND status = 'pending'`, id),
    st(env, `INSERT INTO tasks (title, description, link, points, is_active, require_username, promo_id, quota)
             SELECT ?, ?, link, reward, 1, 1, id, quantity FROM promotions
             WHERE id = ? AND status = 'active' AND NOT EXISTS (SELECT 1 FROM tasks WHERE promo_id = ?)`, t.title, t.description, id, id),
  ]);
  if (res[0].meta.changes !== 1) return alreadyHandled(env, cq, ack);
  await ack('Approved');
  await safeSend(env, p.tid, `✅ Your promotion #${id} is now ACTIVE. Real users can start completing it. Track it in 📣 Promotion → 📊 My Promotion.`);
  await tg(env, 'editMessageCaption', { ...chatOf(cq), caption: `${(cq.message.caption || '').slice(0, 900)}\n\n✅ APPROVED - now active` }).catch(() => {});
}

async function rejectPromo(env, cq, id, ack) {
  const p = await q1(env, `SELECT p.*, u.telegram_id AS tid FROM promotions p JOIN users u ON u.id = p.user_id WHERE p.id = ? AND p.status = 'pending'`, id);
  if (!p) return alreadyHandled(env, cq, ack);
  const res = await run(env, `UPDATE promotions SET status = 'rejected' WHERE id = ? AND status = 'pending'`, id);
  if (res.meta.changes !== 1) return alreadyHandled(env, cq, ack);
  await ack('Rejected');
  await safeSend(env, p.tid, `❌ Your promotion #${id} was rejected. Your payment of ${p.currency} ${money(p.total)} will be refunded to the account you gave us. You will get a message when the refund is sent.`);
  await tg(env, 'editMessageCaption', {
    ...chatOf(cq),
    caption: `${(cq.message.caption || '').slice(0, 800)}\n\n❌ REJECTED - refund ${p.currency} ${money(p.total)} to:\n${String(p.refund_details).slice(0, 150)}`,
    reply_markup: ik([[cb('💸 Mark refunded', `prefunded_${id}`)]]),
  }).catch(() => {});
}

async function markRefunded(env, cq, id, ack) {
  const p = await q1(env, `SELECT p.id, p.currency, p.total, u.telegram_id AS tid FROM promotions p JOIN users u ON u.id = p.user_id WHERE p.id = ? AND p.status = 'rejected'`, id);
  if (!p) return alreadyHandled(env, cq, ack);
  const res = await run(env, `UPDATE promotions SET status = 'refunded' WHERE id = ? AND status = 'rejected'`, id);
  if (res.meta.changes !== 1) return alreadyHandled(env, cq, ack);
  await ack('Marked as refunded');
  await safeSend(env, p.tid, `💸 Your refund of ${p.currency} ${money(p.total)} for promotion #${id} has been sent.`);
  await tg(env, 'editMessageCaption', { ...chatOf(cq), caption: `${(cq.message.caption || '').slice(0, 900)}\n\n💸 REFUNDED` }).catch(() => {});
}

// ---------- Callbacks ----------
async function onCallback(env, cq) {
  const data = cq.data || '';
  const from = cq.from;
  const cfg = cfgOf(env);
  const ack = (text, alert) =>
    tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: !!alert }).catch(() => {});
  let m;

  // Admin panel
  if (data.startsWith('a:')) {
    if (!(await isAdmin(env, from.id))) return ack('Not allowed', true);
    await ack();
    return onPanelCallback(env, cq, data);
  }

  // Promotion approvals
  if (/^(papprove|preject|prefunded)_\d+$/.test(data)) {
    if (!(await isAdmin(env, from.id))) return ack('Not allowed', true);
    const [action, pid] = data.split('_');
    if (action === 'papprove') return approvePromo(env, cq, Number(pid), ack);
    if (action === 'preject') return rejectPromo(env, cq, Number(pid), ack);
    return markRefunded(env, cq, Number(pid), ack);
  }

  // Admin actions
  if (/^(approve|reject|paid|wreject)_\d+$/.test(data)) {
    if (!(await isAdmin(env, from.id))) return ack('Not allowed', true);
    const [action, id] = data.split('_');
    if (action === 'approve') return approveTask(env, cq, Number(id), ack);
    if (action === 'reject') return rejectTask(env, cq, Number(id), ack);
    if (action === 'paid') return markPaid(env, cq, Number(id), ack);
    return rejectWithdrawal(env, cq, Number(id), ack);
  }

  await ack();

  if ((m = data.match(/^country_(Nigeria|Ghana)$/))) return onCountry(env, from, m[1], cq);

  if (data === 'check_join') {
    joinCache.delete(from.id);
    const user = await passGate(env, from);
    if (user) await send(env, from.id, textVerified(user.country), MENU);
    return;
  }

  const user = await passGate(env, from);
  if (!user) return;

  if (data.startsWith('promo_')) return onPromoCallback(env, user, data);

  if ((m = data.match(/^pm_(bank|momo|airtime)$/))) {
    if (user.payment_details) return showPaymentMethod(env, user);
    const method = COUNTRIES[user.country].methods.find((x) => x.key === m[1]);
    if (!method) return send(env, from.id, 'This payment method is not available in your country.', paymentKeyboard(user.country));
    await setState(env, from.id, 'payment', { ptype: method.name });
    return send(env, from.id, `${method.ask}\nExample: ${method.example}`);
  }

  if (data === 'pm_delete') {
    await run(env, 'UPDATE users SET payment_type = NULL, payment_details = NULL WHERE id = ?', user.id);
    return send(env, from.id, 'Payment method deleted. You can add a new one.', paymentKeyboard(user.country));
  }

  if ((m = data.match(/^view_(\d+)$/))) {
    const taskId = Number(m[1]);
    const t = await openTask(env, user, taskId);
    if (!t) return send(env, from.id, 'This task is no longer available.');
    if (await q1(env, 'SELECT 1 AS x FROM user_tasks WHERE user_id = ? AND task_id = ?', user.id, taskId)) {
      return send(env, from.id, 'You already submitted this task.');
    }
    return send(env, from.id, taskText(t), ik([[cb(`Submit Task ${taskId}`, `submit_${taskId}`)]]));
  }

  if ((m = data.match(/^submit_(\d+)$/))) {
    const taskId = Number(m[1]);
    const t = await openTask(env, user, taskId);
    if (!t) return send(env, from.id, 'This task is no longer available.');
    if (await q1(env, 'SELECT 1 AS x FROM user_tasks WHERE user_id = ? AND task_id = ?', user.id, taskId)) {
      return send(env, from.id, 'You already submitted this task.');
    }
    await setState(env, from.id, 'submit', { taskId });
    return send(env, from.id, `📸 Send your screenshot as a photo.\n${Number(t.require_username) === 1 ? 'Put your username in the caption of the photo.' : 'Adding your username in the caption is optional.'}`);
  }
}

// ---------- Admin actions ----------
const chatOf = (cq) => ({ chat_id: cq.message.chat.id, message_id: cq.message.message_id });

async function alreadyHandled(env, cq, ack) {
  await ack('Already handled', true);
  await tg(env, 'editMessageReplyMarkup', { ...chatOf(cq), reply_markup: { inline_keyboard: [] } }).catch(() => {});
}

async function approveTask(env, cq, utId, ack) {
  const row = await q1(
    env,
    `SELECT ut.id, t.title, t.points, u.telegram_id FROM user_tasks ut
     JOIN tasks t ON t.id = ut.task_id JOIN users u ON u.id = ut.user_id
     WHERE ut.id = ? AND ut.status = 'pending'`,
    utId
  );
  if (!row) return alreadyHandled(env, cq, ack);

  const res = await env.DB.batch([
    st(env, `UPDATE users SET balance = balance + (SELECT t.points FROM user_tasks ut JOIN tasks t ON t.id = ut.task_id WHERE ut.id = ? AND ut.status = 'pending')
             WHERE id = (SELECT user_id FROM user_tasks WHERE id = ? AND status = 'pending')`, utId, utId),
    st(env, `INSERT INTO history (user_id, type, description, status, points, ref_id)
             SELECT ut.user_id, 'earn', 'Task reward: ' || t.title, 'approved', t.points, ut.id
             FROM user_tasks ut JOIN tasks t ON t.id = ut.task_id WHERE ut.id = ? AND ut.status = 'pending'`, utId),
    st(env, `UPDATE history SET status = 'approved' WHERE type = 'task' AND ref_id = ? AND status = 'pending'
             AND EXISTS (SELECT 1 FROM user_tasks WHERE id = ? AND status = 'pending')`, utId, utId),
    st(env, `UPDATE user_tasks SET status = 'approved', screenshot_id = NULL WHERE id = ? AND status = 'pending'`, utId),
    // When the purchased number of approved completions is reached, the promotion is completed.
    st(env, `UPDATE promotions SET status = 'completed'
             WHERE status = 'active' AND id = (SELECT promo_id FROM tasks WHERE id = (SELECT task_id FROM user_tasks WHERE id = ?))
               AND (SELECT COUNT(*) FROM user_tasks WHERE task_id = (SELECT task_id FROM user_tasks WHERE id = ?) AND status = 'approved') >= quantity`, utId, utId),
    st(env, `UPDATE tasks SET is_active = 0 WHERE id = (SELECT task_id FROM user_tasks WHERE id = ?) AND promo_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM promotions p WHERE p.id = tasks.promo_id AND p.status = 'completed')`, utId),
  ]);
  if (res[3].meta.changes !== 1) return alreadyHandled(env, cq, ack);

  if (res[4].meta.changes === 1) {
    const done = await q1(env, `SELECT p.id, p.quantity, u.telegram_id AS tid FROM promotions p JOIN users u ON u.id = p.user_id
                                WHERE p.id = (SELECT promo_id FROM tasks WHERE id = (SELECT task_id FROM user_tasks WHERE id = ?))`, utId);
    if (done) await safeSend(env, done.tid, `✅ Your promotion #${done.id} is COMPLETED: ${done.quantity} / ${done.quantity} done. Thank you for using DoubleEarn!`);
  }

  await ack('Approved');
  await safeSend(env, row.telegram_id, `✅ Task ${row.title} Approved! You got ${row.points} points`);
  await tg(env, 'editMessageCaption', { ...chatOf(cq), caption: 'APPROVED - Picture Deleted' }).catch(() => {});
}

async function rejectTask(env, cq, utId, ack) {
  const row = await q1(
    env,
    `SELECT ut.id, t.title, u.telegram_id FROM user_tasks ut
     JOIN tasks t ON t.id = ut.task_id JOIN users u ON u.id = ut.user_id
     WHERE ut.id = ? AND ut.status = 'pending'`,
    utId
  );
  if (!row) return alreadyHandled(env, cq, ack);

  const res = await env.DB.batch([
    st(env, `UPDATE history SET status = 'rejected' WHERE type = 'task' AND ref_id = ? AND status = 'pending'
             AND EXISTS (SELECT 1 FROM user_tasks WHERE id = ? AND status = 'pending')`, utId, utId),
    // Deleting the row removes the screenshot and lets the user redo the task.
    st(env, `DELETE FROM user_tasks WHERE id = ? AND status = 'pending'`, utId),
  ]);
  if (res[1].meta.changes !== 1) return alreadyHandled(env, cq, ack);

  await ack('Rejected');
  await safeSend(env, row.telegram_id, `❌ Task ${row.title} was rejected. You can open the task and submit it again.`);
  await tg(env, 'editMessageCaption', { ...chatOf(cq), caption: 'REJECTED - Picture Deleted' }).catch(() => {});
}

async function markPaid(env, cq, wId, ack) {
  const row = await q1(
    env,
    `SELECT w.points, w.currency, u.telegram_id FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.id = ? AND w.status = 'pending'`,
    wId
  );
  if (!row) return alreadyHandled(env, cq, ack);

  const res = await env.DB.batch([
    st(env, `UPDATE withdrawals SET status = 'paid' WHERE id = ? AND status = 'pending'`, wId),
    st(env, `UPDATE history SET status = 'approved' WHERE type = 'withdraw' AND ref_id = ?
             AND EXISTS (SELECT 1 FROM withdrawals WHERE id = ? AND status = 'paid')`, wId, wId),
  ]);
  if (res[0].meta.changes !== 1) return alreadyHandled(env, cq, ack);

  await ack('Marked as paid');
  await safeSend(env, row.telegram_id, `✅ Your withdrawal of ${row.currency} ${row.points} has been paid.`);
  await tg(env, 'editMessageText', { ...chatOf(cq), text: `${cq.message.text || ''}\n\n✅ PAID` }).catch(() => {});
}

async function rejectWithdrawal(env, cq, wId, ack) {
  const row = await q1(
    env,
    `SELECT w.points, w.currency, u.telegram_id FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.id = ? AND w.status = 'pending'`,
    wId
  );
  if (!row) return alreadyHandled(env, cq, ack);

  const res = await env.DB.batch([
    st(env, `UPDATE users SET balance = balance + (SELECT points FROM withdrawals WHERE id = ? AND status = 'pending')
             WHERE id = (SELECT user_id FROM withdrawals WHERE id = ? AND status = 'pending')`, wId, wId),
    st(env, `UPDATE history SET status = 'rejected' WHERE type = 'withdraw' AND ref_id = ?
             AND EXISTS (SELECT 1 FROM withdrawals WHERE id = ? AND status = 'pending')`, wId, wId),
    st(env, `UPDATE withdrawals SET status = 'rejected' WHERE id = ? AND status = 'pending'`, wId),
  ]);
  if (res[2].meta.changes !== 1) return alreadyHandled(env, cq, ack);

  await ack('Rejected and refunded');
  await safeSend(env, row.telegram_id, `↩️ Your withdrawal of ${row.currency} ${row.points} was rejected. ${row.points} points were returned to your balance.`);
  await tg(env, 'editMessageText', { ...chatOf(cq), text: `${cq.message.text || ''}\n\n↩️ REJECTED & REFUNDED` }).catch(() => {});
}

// ---------- Worker entry ----------
// The database is upgraded automatically the first time a new version runs, so opening /setup is no longer needed after an update.
const SCHEMA_VERSION = '2026-11-08-a';
let schemaReady = false;

async function applySchema(env) {
  await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
  for (const sql of MIGRATIONS) {
    try {
      await env.DB.prepare(sql).run();
    } catch (e) {
      // The column already exists.
    }
  }
  await env.DB.batch(INDEXES.map((sql) => env.DB.prepare(sql)));
  await run(env, `INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?)`, SCHEMA_VERSION);
}

async function ensureSchema(env) {
  if (schemaReady) return;
  let current = null;
  try {
    const r = await q1(env, `SELECT value FROM settings WHERE key = 'schema_version'`);
    current = r ? r.value : null;
  } catch (e) {
    // The settings table does not exist yet.
  }
  if (current !== SCHEMA_VERSION) await applySchema(env);
  schemaReady = true;
}

// Admins see the real error in Telegram. Normal users get a short friendly message.
async function reportError(env, update, e) {
  console.error('Handler error:', e);
  const from = (update.message && update.message.from) || (update.callback_query && update.callback_query.from);
  if (!from) return;
  try {
    const text = (await isAdmin(env, from.id)) ? `⚠️ Error: ${String(e && e.message).slice(0, 300)}` : 'Something went wrong. Please try again in a moment.';
    await send(env, from.id, text);
  } catch (x) {
    // Nothing more to do.
  }
}

async function handle(env, update) {
  await ensureSchema(env);
  if (update.message) return onMessage(env, update.message);
  if (update.callback_query) return onCallback(env, update.callback_query);
}

async function setup(env, url) {
  const secret = (env.WEBHOOK_SECRET || '').trim();
  if (!secret) {
    return new Response('Forbidden: WEBHOOK_SECRET is missing on this Worker. Add it under Settings > Variables and Secrets (the runtime one, not Build), then deploy.', { status: 403 });
  }
  if (url.searchParams.get('key') !== secret) {
    return new Response('Forbidden: the key in the address does not match WEBHOOK_SECRET.', { status: 403 });
  }
  if (!env.BOT_TOKEN) return new Response('BOT_TOKEN is missing on this Worker.', { status: 500 });
  if (!env.DB) return new Response('The D1 binding named DB is missing on this Worker.', { status: 500 });
  await applySchema(env);
  schemaReady = true;
  const result = await tg(env, 'setWebhook', {
    url: `${url.origin}/webhook`,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  return new Response(`Database ready. Webhook set: ${JSON.stringify(result)} (version ${VERSION})`);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/setup') {
      try {
        return await setup(env, url);
      } catch (e) {
        return new Response(`Setup failed: ${e.message}`, { status: 500 });
      }
    }
    if (url.pathname === '/webhook' && request.method === 'POST') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== (env.WEBHOOK_SECRET || '').trim()) {
        return new Response('Forbidden', { status: 403 });
      }
      const update = await request.json();
      ctx.waitUntil(handle(env, update).catch((e) => reportError(env, update, e)));
      return new Response('ok');
    }
    return new Response(`DoubleEarn bot is running (version ${VERSION})`);
  },

  // Cron trigger (every minute): sends the next batch of a running broadcast.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(ensureSchema(env).then(() => runBroadcastChunk(env)).catch((e) => console.error('Broadcast error:', e)));
  },
};
