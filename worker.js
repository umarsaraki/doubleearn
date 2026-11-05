// DoubleEarn Telegram bot - Cloudflare Worker + D1 (SQLite). No dependencies.
// Bindings: DB (D1). Secrets: BOT_TOKEN, WEBHOOK_SECRET.
// Variables: ADMIN_ID, CHANNELS (e.g. @channel1,@channel2), MIN_WITHDRAW (optional).

const WELCOME_BONUS = 50;
const REFERRAL_BONUS = 20;
const UNLOCK_EARNINGS = 100;
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
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    link TEXT,
    points INTEGER NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
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
  `CREATE INDEX IF NOT EXISTS idx_users_balance ON users (balance DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_users_referred ON users (referred_by)`,
  `CREATE INDEX IF NOT EXISTS idx_history_user ON history (user_id, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_history_ref ON history (type, ref_id)`,
  `CREATE INDEX IF NOT EXISTS idx_withdrawals_req ON withdrawals (req)`,
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
  admin: Number(env.ADMIN_ID),
  channels: (env.CHANNELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((c) => (c.startsWith('@') ? c : `@${c}`)),
  minWithdraw: Number(env.MIN_WITHDRAW) || 50,
});

const currencyOf = (country) => (COUNTRIES[country] || COUNTRIES.Nigeria).currency;
const nameOf = (u) => (u.username ? `@${u.username}` : `ID ${u.telegram_id}`);
const cb = (text, data) => ({ text, callback_data: data });
const ik = (rows) => ({ inline_keyboard: rows });

const MENU = {
  keyboard: [
    [{ text: '💰 Balance' }, { text: '📋 Tasks' }],
    [{ text: '🏦 Withdraw' }, { text: '💳 Payment Method' }],
    [{ text: '🏆 Leaderboard' }, { text: '📜 History' }],
    [{ text: '👥 Referral' }],
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
const clearInput = (env, tid) => run(env, `DELETE FROM state WHERE telegram_id = ? AND kind IN ('payment', 'withdraw')`, tid);

async function getTaskEarnings(env, userId) {
  const r = await q1(env, `SELECT COALESCE(SUM(points), 0) AS s FROM history WHERE user_id = ? AND type = 'earn' AND status = 'approved'`, userId);
  return Number(r.s);
}

// ---------- Messages ----------
const textWelcomeNew = () =>
  `🎉 Welcome to DoubleEarn!\n\nComplete tasks in Nigeria & Ghana and earn points.\n\nWe pay in NGN & GHS to your Bank/MoMo.\n\nSelect your country to start and get ${WELCOME_BONUS} Points FREE!`;

const textCountrySelected = (country) => {
  const c = COUNTRIES[country];
  return (
    `${c.flag} Welcome to DoubleEarn ${country}!\n\n` +
    `You selected ${country} - you will earn and withdraw in ${c.currency}.\n` +
    `✅ Complete tasks\n✅ Earn points\n✅ Withdraw to ${c.payoutText}\n\n` +
    `Now join our channels to get ${WELCOME_BONUS} Points FREE!`
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
  let referrerTg = null;
  if (user.referred_by) {
    const r = await q1(env, 'SELECT telegram_id FROM users WHERE id = ?', user.referred_by);
    if (r) referrerTg = r.telegram_id;
  }
  // One atomic batch. Every statement is guarded by "welcome_given = 0", so it runs once per user.
  const res = await env.DB.batch([
    st(env, `UPDATE users SET balance = balance + ? WHERE id = (SELECT referred_by FROM users WHERE id = ? AND welcome_given = 0)`, REFERRAL_BONUS, user.id),
    st(env, `INSERT INTO history (user_id, type, description, status, points)
             SELECT referred_by, 'referral', 'Referral Bonus', 'approved', ? FROM users
             WHERE id = ? AND welcome_given = 0 AND referred_by IS NOT NULL`, REFERRAL_BONUS, user.id),
    st(env, `INSERT INTO history (user_id, type, description, status, points)
             SELECT id, 'bonus', 'Welcome Bonus (Non-withdrawable)', 'approved', ? FROM users
             WHERE id = ? AND welcome_given = 0`, WELCOME_BONUS, user.id),
    st(env, `UPDATE users SET balance = balance + ?, welcome_given = 1 WHERE id = ? AND welcome_given = 0`, WELCOME_BONUS, user.id),
  ]);
  if (res[3].meta.changes !== 1) return;
  user.balance += WELCOME_BONUS;
  user.welcome_given = 1;
  if (referrerTg) {
    await safeSend(env, referrerTg, `🎉 You got ${REFERRAL_BONUS} points! Your referral ${nameOf(user)} joined the channels.`);
  }
  await send(env, user.telegram_id, `🎁 Welcome Bonus: ${WELCOME_BONUS} Points added! (You must earn ${UNLOCK_EARNINGS} points from tasks before you can withdraw)`);
}

// Runs before every user action: country, channel membership, welcome bonus.
async function passGate(env, from) {
  const user = await ensureUser(env, from);
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
  if (!user.country) return send(env, from.id, textWelcomeNew(), countryKeyboard());
  const ready = await passGate(env, from);
  if (ready) await send(env, from.id, textWelcomeBack(ready.country), MENU);
}

async function onCountry(env, from, chosen, cq) {
  const user = await ensureUser(env, from);
  if (!user.country) await run(env, 'UPDATE users SET country = ? WHERE id = ? AND country IS NULL', chosen, user.id);
  const fresh = await q1(env, 'SELECT country FROM users WHERE id = ?', user.id);
  await tg(env, 'deleteMessage', { chat_id: cq.message.chat.id, message_id: cq.message.message_id }).catch(() => {});
  await send(env, from.id, textCountrySelected(fresh.country));
  const ready = await passGate(env, from);
  if (ready) await send(env, from.id, textVerified(ready.country), MENU);
}

// ---------- Menu handlers ----------
async function hBalance(env, user) {
  const earned = await getTaskEarnings(env, user.id);
  const unlocked = earned >= UNLOCK_EARNINGS;
  await send(
    env,
    user.telegram_id,
    `Your Balance: ${user.balance} Points = ${currencyOf(user.country)} ${user.balance}\n\n` +
      `Task Earnings: ${earned} Points\n` +
      `Welcome Bonus: ${WELCOME_BONUS} Points ${unlocked ? '(Unlocked)' : `(Locked until you earn ${UNLOCK_EARNINGS} points from tasks)`}\n\n` +
      `Withdrawable: ${unlocked ? user.balance : 0} Points`
  );
}

async function hTasks(env, user) {
  const rows = await qa(
    env,
    `SELECT t.* FROM tasks t WHERE t.is_active = 1
     AND NOT EXISTS (SELECT 1 FROM user_tasks ut WHERE ut.task_id = t.id AND ut.user_id = ?)
     ORDER BY t.id LIMIT 20`,
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
  const earned = await getTaskEarnings(env, user.id);
  if (earned < UNLOCK_EARNINGS) {
    return send(
      env,
      user.telegram_id,
      `❌ You cannot withdraw yet!\n\nYou must earn at least ${UNLOCK_EARNINGS} Points from Tasks first.\n` +
        `Currently earned from tasks: ${earned}/${UNLOCK_EARNINGS} Points\n\n` +
        `The Welcome Bonus (${WELCOME_BONUS}) cannot be withdrawn until then.\nGo to 📋 Tasks and complete tasks.`
    );
  }
  await setState(env, user.telegram_id, 'withdraw', {});
  await send(
    env,
    user.telegram_id,
    `How many points to withdraw? Minimum: ${cfgOf(env).minWithdraw}\n1 Point = ${currencyOf(user.country)} 1\n\n` +
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
  const r = await q1(env, 'SELECT COUNT(*) AS n FROM users WHERE referred_by = ? AND welcome_given = 1', user.id);
  await send(
    env,
    user.telegram_id,
    `👥 Your Referral Link:\nhttps://t.me/${botUsername}?start=${user.telegram_id}\n\n` +
      `Total Referrals: ${r.n}\nBonus: ${REFERRAL_BONUS} Points per referral who joins the channels\n\nShare it to earn!`
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
};

// ---------- Messages ----------
async function onMessage(env, m) {
  if (!m.from || m.chat.type !== 'private') return;
  const text = (m.text || '').trim();

  if (/^\/start(@\w+)?(\s|$)/i.test(text)) return onStart(env, m.from, text.split(/\s+/)[1] || '');
  if (/^\/addtask(@\w+)?(\s|$)/i.test(text)) return onAddTask(env, m, text);

  const handler = MENU_HANDLERS[text];
  if (handler) {
    await clearInput(env, m.from.id);
    const user = await passGate(env, m.from);
    if (user) await handler(env, user);
    return;
  }
  if (m.photo) return onPhoto(env, m);
  if (text) return onText(env, m.from, text);
}

async function onText(env, from, text) {
  const state = await getState(env, from.id);
  if (!state || state.kind === 'submit') return send(env, from.id, 'Please choose an option from the menu.', MENU);
  const user = await passGate(env, from);
  if (!user) return;

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
  const cfg = cfgOf(env);
  if (!/^\d+$/.test(text)) return send(env, user.telegram_id, 'Please send a whole number. Example: 1000');
  const points = Number(text);
  if (points < cfg.minWithdraw) return send(env, user.telegram_id, `Minimum withdrawal is ${cfg.minWithdraw} points.`);
  if (!user.payment_details) return send(env, user.telegram_id, 'You must add payment method first', paymentKeyboard(user.country));

  const earned = await getTaskEarnings(env, user.id);
  if (earned < UNLOCK_EARNINGS) {
    await clearState(env, user.telegram_id);
    return send(env, user.telegram_id, `❌ You must earn at least ${UNLOCK_EARNINGS} Points from Tasks first (${earned}/${UNLOCK_EARNINGS}).`);
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
               AND (SELECT COALESCE(SUM(points), 0) FROM history WHERE user_id = u.id AND type = 'earn' AND status = 'approved') >= ?`,
       points, String(points), cur, req, user.id, points, UNLOCK_EARNINGS),
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
  await send(
    env,
    cfg.admin,
    `💸 Withdrawal Request #${w.id}\nUser: ${nameOf(user)} (${user.country})\nID: ${user.telegram_id}\nPoints: ${points}\n` +
      `Amount: ${cur} ${points}\nMethod: ${user.payment_type}\nDetails: ${user.payment_details}`,
    ik([[cb('✅ Paid', `paid_${w.id}`), cb('↩️ Reject & Refund', `wreject_${w.id}`)]])
  ).catch((e) => console.error('Could not notify admin about withdrawal:', e.message));
}

async function onPhoto(env, m) {
  const from = m.from;
  const state = await getState(env, from.id);
  if (!state || state.kind !== 'submit') return send(env, from.id, 'Open a task and press Submit first.');
  const user = await passGate(env, from);
  if (!user) return;

  const caption = (m.caption || '').trim().slice(0, 100);
  if (!caption) return send(env, from.id, 'Please send the photo again with your username as the caption.');

  const fileId = m.photo[m.photo.length - 1].file_id;
  const taskId = state.data.taskId;

  const res = await env.DB.batch([
    st(env, `INSERT OR IGNORE INTO user_tasks (user_id, task_id, status, screenshot_id, submitted_username)
             SELECT ?, ?, 'pending', ?, ? WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ? AND is_active = 1)`,
       user.id, taskId, fileId, caption, taskId),
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
    await tg(env, 'sendPhoto', {
      chat_id: cfgOf(env).admin,
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
  if (m.from.id !== cfgOf(env).admin) return;
  const parts = text.replace(/^\/addtask(@\w+)?\s*/i, '').split('|').map((p) => p.trim());
  const points = Number(parts[3]);
  if (parts.length < 4 || !parts[0] || !Number.isInteger(points) || points <= 0) {
    return send(env, m.from.id, 'Usage: /addtask Title | Description | Link | Points');
  }
  const r = await run(env, 'INSERT INTO tasks (title, description, link, points) VALUES (?, ?, ?, ?)', parts[0], parts[1], parts[2], points);
  await send(env, m.from.id, `✅ Task added. ID: ${r.meta.last_row_id}`);
}

// ---------- Callbacks ----------
async function onCallback(env, cq) {
  const data = cq.data || '';
  const from = cq.from;
  const cfg = cfgOf(env);
  const ack = (text, alert) =>
    tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: !!alert }).catch(() => {});
  let m;

  // Admin actions
  if (/^(approve|reject|paid|wreject)_\d+$/.test(data)) {
    if (from.id !== cfg.admin) return ack('Not allowed', true);
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
    const t = await q1(env, 'SELECT * FROM tasks WHERE id = ? AND is_active = 1', taskId);
    if (!t) return send(env, from.id, 'This task is no longer available.');
    if (await q1(env, 'SELECT 1 AS x FROM user_tasks WHERE user_id = ? AND task_id = ?', user.id, taskId)) {
      return send(env, from.id, 'You already submitted this task.');
    }
    return send(env, from.id, taskText(t), ik([[cb(`Submit Task ${taskId}`, `submit_${taskId}`)]]));
  }

  if ((m = data.match(/^submit_(\d+)$/))) {
    const taskId = Number(m[1]);
    const t = await q1(env, 'SELECT id FROM tasks WHERE id = ? AND is_active = 1', taskId);
    if (!t) return send(env, from.id, 'This task is no longer available.');
    if (await q1(env, 'SELECT 1 AS x FROM user_tasks WHERE user_id = ? AND task_id = ?', user.id, taskId)) {
      return send(env, from.id, 'You already submitted this task.');
    }
    await setState(env, from.id, 'submit', { taskId });
    return send(env, from.id, '📸 Send your screenshot as a photo.\nPut your username in the caption of the photo.');
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
  ]);
  if (res[3].meta.changes !== 1) return alreadyHandled(env, cq, ack);

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
async function handle(env, update) {
  if (update.message) return onMessage(env, update.message);
  if (update.callback_query) return onCallback(env, update.callback_query);
}

async function setup(env, url) {
  if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET) {
    return new Response('Forbidden', { status: 403 });
  }
  await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
  const result = await tg(env, 'setWebhook', {
    url: `${url.origin}/webhook`,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  return new Response(`Database ready. Webhook set: ${JSON.stringify(result)}`);
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
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('Forbidden', { status: 403 });
      }
      const update = await request.json();
      ctx.waitUntil(handle(env, update).catch((e) => console.error('Handler error:', e)));
      return new Response('ok');
    }
    return new Response('DoubleEarn bot is running');
  },
};
