// Tasky Wallet - bot + API. Run: npm i && cp .env.example .env && npm start
// The bot must be an ADMIN in both force-join channels (and in any task channel).
import express from 'express';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { Bot, InlineKeyboard } from 'grammy';

const { BOT_TOKEN, WEBAPP_URL, ADMIN_IDS = '', CHANNELS = '', PORT = 3000 } = process.env;
const admins = ADMIN_IDS.split(',').map(Number);
const channels = CHANNELS.split(',').map(s => s.trim()).filter(Boolean);
const RATE = 5000, FEE = 0.05, MIN_USDT = 1, MICRO = 1e6; // USDT stored as integer micro-USDT
const AD_LIMIT = 30, AD_REWARD = 3, TASK_REWARD = 5, REF_REWARD = 100, REF_ADS = 5, REF_TASKS = 3, NETWORKS = 3;

const db = new Database('tasky.db');
db.exec(`
create table if not exists users(id integer primary key, name text, tasky integer default 0, usdt integer default 0,
  ref_by integer, ads_total integer default 0, ref_paid integer default 0,
  ads_day text, ads_n integer default 0, ad_nonce text, ad_at integer default 0, created integer);
create table if not exists tasks(id integer primary key autoincrement, title text, url text, chat text, on_ integer default 1);
create table if not exists done(user integer, task integer, primary key(user, task));
create table if not exists wd(id integer primary key autoincrement, user integer, addr text, gross integer, fee integer,
  net integer, status text default 'pending', created integer);
`);

try { db.exec('alter table users add column ads_total integer default 0'); } catch {} // upgrade older DBs

const bot = new Bot(BOT_TOKEN);
const botUsername = (await bot.api.getMe()).username;
const day = () => new Date().toISOString().slice(0, 10);
const isAdmin = id => admins.includes(id);
const gone = s => ['left', 'kicked'].includes(s);

// ---------- force join ----------
const okCache = new Map();
async function joined(uid, fresh = false) {
  const t = okCache.get(uid);
  if (!fresh && t && Date.now() - t < 60000) return true;
  for (const ch of channels) {
    try { if (gone((await bot.api.getChatMember(ch, uid)).status)) return false; } catch { return false; }
  }
  okCache.set(uid, Date.now());
  return true;
}
const joinKb = () => {
  const kb = new InlineKeyboard();
  channels.forEach((c, i) => kb.url(`Join channel ${i + 1}`, `https://t.me/${c.replace('@', '')}`).row());
  return kb.text("I've joined", 'chk');
};
const openKb = () => new InlineKeyboard().webApp('Open Tasky Wallet', WEBAPP_URL);

bot.command('start', async ctx => {
  const id = ctx.from.id, ref = Number(ctx.match) || null;
  db.prepare('insert or ignore into users(id,name,ref_by,created) values(?,?,?,?)')
    .run(id, ctx.from.first_name, ref && ref !== id ? ref : null, Date.now());
  if (!(await joined(id, true))) return ctx.reply('Join both channels to use Tasky Wallet.', { reply_markup: joinKb() });
  ctx.reply('Earn TASKY by watching ads and finishing tasks.', { reply_markup: openKb() });
});
bot.callbackQuery('chk', async ctx => {
  if (!(await joined(ctx.from.id, true))) return ctx.answerCallbackQuery({ text: 'Join both channels first.', show_alert: true });
  await ctx.answerCallbackQuery();
  ctx.editMessageText('You are in. Open the app below.', { reply_markup: openKb() });
});

// ---------- admin: tasks ----------
// /addtask Title | https://link | @channel_to_verify (optional)
bot.command('addtask', ctx => {
  if (!isAdmin(ctx.from.id)) return;
  const [title, url, chat] = ctx.match.split('|').map(s => s.trim());
  if (!title || !url) return ctx.reply('Usage: /addtask Title | https://link | @channel (optional)');
  const r = db.prepare('insert into tasks(title,url,chat) values(?,?,?)').run(title, url, chat || null);
  ctx.reply(`Task #${r.lastInsertRowid} added.`);
});
bot.command('tasks', ctx => {
  if (!isAdmin(ctx.from.id)) return;
  const rows = db.prepare('select t.*, (select count(*) from done where task=t.id) n from tasks t where on_=1').all();
  ctx.reply(rows.map(t => `#${t.id} ${t.title} (${t.n} done)`).join('\n') || 'No active tasks.');
});
bot.command('deltask', ctx => {
  if (!isAdmin(ctx.from.id)) return;
  db.prepare('update tasks set on_=0 where id=?').run(Number(ctx.match));
  ctx.reply('Task removed.');
});

// ---------- admin: withdrawals ----------
bot.callbackQuery(/^wd:(ok|no):(\d+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery();
  const [, act, id] = ctx.match;
  const w = db.prepare("select * from wd where id=? and status='pending'").get(id);
  if (!w) return ctx.answerCallbackQuery({ text: 'Already handled.' });
  if (act === 'ok') db.prepare("update wd set status='paid' where id=?").run(id);
  else db.transaction(() => {
    db.prepare("update wd set status='rejected' where id=?").run(id);
    db.prepare('update users set usdt=usdt+? where id=?').run(w.gross, w.user); // refund
  })();
  await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n${act === 'ok' ? 'PAID (sent manually)' : 'REJECTED (refunded)'}`);
  bot.api.sendMessage(w.user, act === 'ok' ? `Withdrawal #${id} sent: ${w.net / MICRO} USDT.` : `Withdrawal #${id} was rejected and refunded.`).catch(() => {});
});

// ---------- Mini App auth ----------
function auth(initData) {
  const p = new URLSearchParams(initData), hash = p.get('hash');
  p.delete('hash');
  const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const h = crypto.createHmac('sha256', key).update(str).digest('hex');
  if (!hash || h.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash))) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date')) > 86400) return null;
  return JSON.parse(p.get('user'));
}

const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use('/api', async (req, res, next) => {
  const u = auth(req.get('x-init') || '');
  if (!u) return res.status(401).json({ error: 'Open this app from Telegram.' });
  if (!(await joined(u.id))) return res.status(403).json({ error: 'join', channels });
  db.prepare('insert or ignore into users(id,name,created) values(?,?,?)').run(u.id, u.first_name, Date.now());
  req.uid = u.id;
  next();
});

// Referrer is paid once, after the friend has watched 5+ ads AND completed 3+ tasks.
function checkRef(uid) {
  const u = db.prepare('select ref_by, ref_paid, ads_total from users where id=?').get(uid);
  if (!u.ref_by || u.ref_paid || u.ads_total < REF_ADS) return;
  if (db.prepare('select count(*) n from done where user=?').get(uid).n < REF_TASKS) return;
  db.transaction(() => {
    db.prepare('update users set ref_paid=1 where id=?').run(uid);
    db.prepare('update users set tasky=tasky+? where id=?').run(REF_REWARD, u.ref_by);
  })();
}

const getUser = id => {
  let u = db.prepare('select * from users where id=?').get(id);
  if (u.ads_day !== day()) {
    db.prepare('update users set ads_day=?, ads_n=0 where id=?').run(day(), id);
    u = { ...u, ads_n: 0 };
  }
  return u;
};
const fail = (res, error, code = 400) => res.status(code).json({ error });

app.post('/api/me', (req, res) => {
  const u = getUser(req.uid);
  const tasks = db.prepare('select id,title,url from tasks where on_=1 and id not in (select task from done where user=?)').all(req.uid);
  res.json({ tasky: u.tasky, usdt: u.usdt / MICRO, adsLeft: AD_LIMIT - u.ads_n, adsMax: AD_LIMIT, tasks,
    refLink: `https://t.me/${botUsername}?start=${req.uid}`, refs: db.prepare('select count(*) n from users where ref_by=? and ref_paid=1').get(req.uid).n,
    rate: RATE, fee: FEE, min: MIN_USDT, reward: { ad: AD_REWARD, task: TASK_REWARD, ref: REF_REWARD } });
});

// Ads: start -> show ad -> claim. The 10s minimum is a basic guard; for real protection
// use each network's server-to-server postback and credit from that instead.
app.post('/api/ad/start', (req, res) => {
  const u = getUser(req.uid);
  if (u.ads_n >= AD_LIMIT) return fail(res, 'Daily ad limit reached. Come back tomorrow.', 429);
  const nonce = crypto.randomUUID();
  db.prepare('update users set ad_nonce=?, ad_at=? where id=?').run(nonce, Date.now(), req.uid);
  res.json({ nonce, network: u.ads_n % NETWORKS });
});
app.post('/api/ad/claim', (req, res) => {
  const u = getUser(req.uid);
  if (u.ads_n >= AD_LIMIT) return fail(res, 'Daily ad limit reached.', 429);
  if (!u.ad_nonce || u.ad_nonce !== req.body.nonce || Date.now() - u.ad_at < 10000) return fail(res, 'Ad was not completed.');
  db.prepare('update users set tasky=tasky+?, ads_n=ads_n+1, ads_total=ads_total+1, ad_nonce=null where id=?').run(AD_REWARD, req.uid);
  checkRef(req.uid);
  res.json({ ok: true });
});

app.post('/api/task/:id', async (req, res) => {
  const t = db.prepare('select * from tasks where id=? and on_=1').get(req.params.id);
  if (!t) return fail(res, 'Task not found.', 404);
  if (db.prepare('select 1 from done where user=? and task=?').get(req.uid, t.id)) return fail(res, 'Task already done.');
  if (t.chat) {
    try { if (gone((await bot.api.getChatMember(t.chat, req.uid)).status)) return fail(res, 'Join the channel first.'); }
    catch { return fail(res, 'Could not verify membership. Try again.'); }
  }
  try {
    db.transaction(() => {
      db.prepare('insert into done values(?,?)').run(req.uid, t.id);
      db.prepare('update users set tasky=tasky+? where id=?').run(TASK_REWARD, req.uid);
    })();
  } catch { return fail(res, 'Task already done.'); }
  checkRef(req.uid);
  res.json({ ok: true });
});

app.post('/api/swap', (req, res) => {
  const amt = Math.floor(Number(req.body.amount));
  const u = getUser(req.uid);
  if (!(amt > 0) || amt > u.tasky) return fail(res, 'Not enough TASKY.');
  db.prepare('update users set tasky=tasky-?, usdt=usdt+? where id=?').run(amt, amt * (MICRO / RATE), req.uid);
  res.json({ ok: true });
});

app.post('/api/withdraw', async (req, res) => {
  const gross = Math.round(Number(req.body.amount) * MICRO), addr = String(req.body.address || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) return fail(res, 'Enter a valid BEP-20 address (starts with 0x).');
  if (!(gross >= MIN_USDT * MICRO)) return fail(res, `Minimum withdrawal is ${MIN_USDT} USDT.`);
  const u = getUser(req.uid);
  if (gross > u.usdt) return fail(res, 'Not enough USDT. Swap TASKY first.');
  const fee = Math.floor(gross * FEE), net = gross - fee;
  const id = db.transaction(() => {
    db.prepare('update users set usdt=usdt-? where id=?').run(gross, req.uid);
    return db.prepare('insert into wd(user,addr,gross,fee,net,created) values(?,?,?,?,?,?)').run(req.uid, addr, gross, fee, net, Date.now()).lastInsertRowid;
  })();
  const kb = new InlineKeyboard().text('Mark paid', `wd:ok:${id}`).text('Reject', `wd:no:${id}`);
  for (const a of admins) bot.api.sendMessage(a, `Withdrawal #${id}\nUser: ${req.uid}\nSend: ${net / MICRO} USDT (BEP-20)\nFee: ${fee / MICRO}\nTo:\n${addr}`, { reply_markup: kb }).catch(() => {});
  res.json({ ok: true, net: net / MICRO });
});

app.listen(PORT, () => console.log('Tasky Wallet on :' + PORT));
bot.start();
