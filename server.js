const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '919712565375';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ----- Store -----
let store = {
  users: [], websites: [], inquiries: [], orders: [], wishlists: [], views: {}, daily_stats: {},
  _ids: { user: 0, website: 0, inquiry: 0, order: 0 }
};
function loadStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      store = { users:[], websites:[], inquiries:[], orders:[], wishlists:[], views:{}, daily_stats:{}, _ids:{user:0,website:0,inquiry:0,order:0}, ...loaded };
      ['orders','wishlists'].forEach(k => { if (!store[k]) store[k] = []; });
      ['views','daily_stats'].forEach(k => { if (!store[k]) store[k] = {}; });
      ['order'].forEach(k => { if (!store._ids[k]) store._ids[k] = 0; });
    }
  } catch(e) { console.error('load:', e); }
}
let saveTimer = null;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2)), 50);
}
function nextId(k) { store._ids[k] = (store._ids[k]||0) + 1; return store._ids[k]; }
function todayStr() { return new Date().toISOString().slice(0,10); }
function bumpDaily(metric, n=1) {
  const d = todayStr();
  if (!store.daily_stats[d]) store.daily_stats[d] = {};
  store.daily_stats[d][metric] = (store.daily_stats[d][metric]||0) + n;
  saveStore();
}

function logEvent(type, data = {}) {
  const event = { id: nextId('event'), type, at: new Date().toISOString(), ...data };
  store.events = store.events || [];
  store.events.push(event);
  // Keep last 50k events to prevent unbounded growth
  if (store.events.length > 50000) {
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    store.events = store.events.filter(e => new Date(e.at).getTime() >= cutoff);
  }
  saveStore();
}


loadStore();

// Sync admin from env every start
const adminIdx = store.users.findIndex(u => u.username === ADMIN_USERNAME);
if (adminIdx < 0) {
  store.users.push({ id: nextId('user'), username: ADMIN_USERNAME, password: bcrypt.hashSync(ADMIN_PASSWORD,10), role: 'admin', email_verified: true, created_at: new Date().toISOString() });
  saveStore(); console.log('Admin created');
} else {
  if (!bcrypt.compareSync(ADMIN_PASSWORD, store.users[adminIdx].password) || store.users[adminIdx].role !== 'admin') {
    store.users[adminIdx].password = bcrypt.hashSync(ADMIN_PASSWORD,10);
    store.users[adminIdx].role = 'admin';
    store.users[adminIdx].email_verified = true;
    saveStore(); console.log('Admin synced');
  }
}

// Seed demo
if (store.websites.length === 0) {
  const seed = [
    ['techcrunch.com','Technology',850,92,94,25000000,'Premium tech publication, do-follow link'],
    ['forbes.com','Business',1200,95,95,80000000,'Top tier business site, contributor post'],
    ['entrepreneur.com','Business',700,91,92,12000000,'Sponsored post, fast turnaround'],
    ['mashable.com','Technology',600,92,93,18000000,'Tech and culture, do-follow'],
    ['huffpost.com','News',550,94,94,30000000,'General news, no-follow'],
    ['inc.com','Business',800,92,93,8000000,'Business and startups'],
    ['readwrite.com','Technology',250,86,87,1500000,'IoT and tech focus'],
    ['benzinga.com','Finance',400,88,89,10000000,'Finance and crypto'],
    ['hackernoon.com','Technology',180,84,85,4000000,'Developer audience'],
    ['thrillist.com','Lifestyle',350,87,88,9000000,'Food and lifestyle'],
    ['mindbodygreen.com','Health',320,84,85,6000000,'Health and wellness'],
    ['cointelegraph.com','Crypto',500,86,87,12000000,'Crypto news leader'],
    ['decrypt.co','Crypto',380,80,81,4000000,'Crypto and Web3'],
    ['gamerant.com','Gaming',220,82,84,8000000,'Gaming news and reviews'],
    ['screenrant.com','Entertainment',280,87,88,50000000,'Movies and TV'],
    ['themuse.com','Career',240,84,85,3000000,'Career and jobs'],
    ['fastcompany.com','Business',650,91,92,7000000,'Innovation and design'],
    ['vox.com','News',720,93,93,35000000,'Explanatory journalism'],
    ['wired.com','Technology',950,92,93,20000000,'Premium tech magazine'],
    ['ibtimes.com','News',300,88,89,8000000,'International news'],
  ];
  for (const [website,category,price,dr,da,traffic,notes] of seed) {
    store.websites.push({ id: nextId('website'), website, category, price, dr, da, traffic, notes, featured:0, views:0, deleted_at: null, created_at: new Date().toISOString() });
  }
  saveStore(); console.log('Seeded');
}

// Auth middleware
function auth(required=true) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || null);
    if (!tok) { if (required) return res.status(401).json({error:'Unauthorized'}); return next(); }
    try { req.user = jwt.verify(tok, JWT_SECRET); next(); }
    catch { if (required) return res.status(401).json({error:'Invalid token'}); next(); }
  };
}
function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({error:'Admin only'});
  next();
}

function normalizeWebsite(b={}) {
  return {
    website: String(b.website||'').trim(),
    category: String(b.category||'').trim(),
    price: Number(b.price)||0,
    dr: Number(b.dr)||0,
    da: Number(b.da)||0,
    traffic: Number(b.traffic)||0,
    notes: String(b.notes||'').trim(),
    featured: b.featured ? 1 : 0,
  };
}

// CSV helpers
function parseCSV(t) {
  const rows=[]; let cur=[],f='',q=false;
  for (let i=0;i<t.length;i++){const c=t[i];
    if(q){if(c==='"'&&t[i+1]==='"'){f+='"';i++;}else if(c==='"')q=false;else f+=c;}
    else{if(c==='"')q=true;else if(c===','){cur.push(f);f='';}else if(c==='\n'||c==='\r'){if(c==='\r'&&t[i+1]==='\n')i++;cur.push(f);f='';if(cur.some(v=>v!==''))rows.push(cur);cur=[];}else f+=c;}
  }
  if(f!==''||cur.length){cur.push(f);if(cur.some(v=>v!==''))rows.push(cur);}
  return rows;
}
function csvEscape(v){const s=v==null?'':String(v);return /[",\n\r]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;}
function toCSV(rows,headers){return [headers.join(','), ...rows.map(r=>headers.map(h=>csvEscape(r[h])).join(','))].join('\n');}

// ============== ROUTES ==============
app.get('/api/config', (req,res) => res.json({ whatsapp: WHATSAPP_NUMBER }));

// ----- Auth -----
app.post('/api/register', (req,res) => {
  const { username, password, email } = req.body || {};
  if (!username || !password) return res.status(400).json({error:'username and password required'});
  if (password.length < 4) return res.status(400).json({error:'password too short'});
  if (store.users.find(u => u.username === username)) return res.status(409).json({error:'Username taken'});
  const user = {
    id: nextId('user'), username, password: bcrypt.hashSync(password,10), role:'user',
    email: (email||'').trim() || null,
    email_verified: false,
    verification_token: crypto.randomBytes(16).toString('hex'),
    created_at: new Date().toISOString()
  };
  store.users.push(user); saveStore();
  bumpDaily('signups');
  const token = jwt.sign({id:user.id,username,role:'user'}, JWT_SECRET, {expiresIn:'30d'});
  res.json({ token, user: {id:user.id, username, role:'user'} });
});

app.post('/api/login', (req,res) => {
  const { username, password } = req.body || {};
  const user = store.users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password||'', user.password)) return res.status(401).json({error:'Invalid credentials'});
  user.last_login = new Date().toISOString();
  saveStore();
  const token = jwt.sign({id:user.id,username:user.username,role:user.role}, JWT_SECRET, {expiresIn:'30d'});
  res.json({ token, user: {id:user.id, username:user.username, role:user.role} });
});

app.get('/api/me', auth(true), (req,res) => res.json({ user: req.user }));

// ----- Websites (with soft delete + view tracking) -----
app.get('/api/websites', (req,res) => {
  const includeDeleted = String(req.query.deleted||'') === '1';
  const rows = store.websites.filter(w => includeDeleted ? w.deleted_at : !w.deleted_at);
  res.json([...rows].sort((a,b) => (b.featured||0)-(a.featured||0) || b.id - a.id));
});

app.post('/api/websites', auth(true), adminOnly, (req,res) => {
  const data = normalizeWebsite(req.body);
  if (!data.website) return res.status(400).json({error:'website required'});
  const w = { id: nextId('website'), ...data, views:0, deleted_at:null, created_at: new Date().toISOString() };
  store.websites.push(w); saveStore();
  res.json(w);
});

app.put('/api/websites/:id', auth(true), adminOnly, (req,res) => {
  const id = Number(req.params.id);
  const idx = store.websites.findIndex(w => w.id === id);
  if (idx < 0) return res.status(404).json({error:'Not found'});
  store.websites[idx] = { ...store.websites[idx], ...normalizeWebsite(req.body) };
  saveStore();
  res.json(store.websites[idx]);
});

// Soft delete
app.delete('/api/websites/:id', auth(true), adminOnly, (req,res) => {
  const id = Number(req.params.id);
  const w = store.websites.find(w => w.id === id);
  if (!w) return res.status(404).json({error:'Not found'});
  w.deleted_at = new Date().toISOString();
  saveStore();
  res.json({ ok:true });
});

// Restore
app.post('/api/websites/:id/restore', auth(true), adminOnly, (req,res) => {
  const id = Number(req.params.id);
  const w = store.websites.find(w => w.id === id);
  if (!w) return res.status(404).json({error:'Not found'});
  w.deleted_at = null;
  saveStore();
  res.json(w);
});

// Permanent delete
app.delete('/api/websites/:id/permanent', auth(true), adminOnly, (req,res) => {
  const id = Number(req.params.id);
  store.websites = store.websites.filter(w => w.id !== id);
  saveStore();
  res.json({ ok:true });
});

// Bulk delete (soft)
app.post('/api/websites/bulk-delete', auth(true), adminOnly, (req,res) => {
  const ids = (req.body?.ids||[]).map(Number);
  let n = 0;
  for (const w of store.websites) {
    if (ids.includes(w.id) && !w.deleted_at) { w.deleted_at = new Date().toISOString(); n++; }
  }
  saveStore();
  res.json({ deleted:n });
});

// Bulk edit
app.post('/api/websites/bulk-edit', auth(true), adminOnly, (req,res) => {
  const { ids = [], updates = {}, priceAdjust } = req.body || {};
  const idSet = new Set(ids.map(Number));
  let updated = 0;
  for (const w of store.websites) {
    if (!idSet.has(w.id) || w.deleted_at) continue;
    if (updates.category !== undefined) w.category = String(updates.category).trim();
    if (updates.notes !== undefined) w.notes = String(updates.notes).trim();
    if (updates.featured !== undefined) w.featured = updates.featured ? 1 : 0;
    if (priceAdjust && priceAdjust.type) {
      const base = Number(w.price)||0;
      if (priceAdjust.type === 'set') w.price = Number(priceAdjust.value)||0;
      else if (priceAdjust.type === 'percent') w.price = Math.round(base * (1 + Number(priceAdjust.value)/100));
      else if (priceAdjust.type === 'add') w.price = base + Number(priceAdjust.value)||0;
    }
    updated++;
  }
  saveStore();
  res.json({ updated });
});

// View tracking (anyone)
app.post('/api/websites/:id/view', (req,res) => {
  const id = Number(req.params.id);
  const w = store.websites.find(w => w.id === id);
  if (!w) return res.status(404).json({error:'Not found'});
  w.views = (w.views||0) + 1;
  bumpDaily('views');
  saveStore();
  res.json({ views: w.views });
});

// ---------- Generic event tracking (clicks, etc) ----------
app.post('/api/track', auth(false), (req, res) => {
  const { kind, website_id, meta } = req.body || {};
  if (!['view','click','search','add_to_cart','add_to_wishlist'].includes(kind)) {
    return res.status(400).json({ error: 'invalid kind' });
  }
  logEvent(kind, { website_id: website_id ? Number(website_id) : null, meta, username: req.user?.username || 'guest' });
  if (kind === 'click' && website_id) {
    const w = store.websites.find(x => x.id === Number(website_id));
    if (w) { w.clicks = (w.clicks || 0) + 1; saveStore(); }
  }
  res.json({ ok: true });
});

// Trending (top by views in last 7 days - approximated by total views for now)
app.get('/api/websites/trending', (req,res) => {
  const limit = Number(req.query.limit) || 5;
  const trending = store.websites
    .filter(w => !w.deleted_at && (w.views||0) > 0)
    .sort((a,b) => (b.views||0) - (a.views||0))
    .slice(0, limit)
    .map(w => ({ id: w.id, website: w.website, views: w.views }));
  res.json(trending);
});

// CSV import
app.post('/api/websites/import', auth(true), adminOnly, (req,res) => {
  let csv = (req.body && req.body.csv) || '';
  if (!csv) return res.status(400).json({error:'No CSV'});
  const rows = parseCSV(csv.trim());
  if (rows.length < 2) return res.status(400).json({error:'CSV needs header + rows'});
  const headers = rows[0].map(h => h.trim().toLowerCase());
  const idx = name => headers.indexOf(name);
  const wIdx = idx('website');
  if (wIdx < 0) return res.status(400).json({error:'Missing "website" column'});
  const replace = String(req.query.replace||'') === '1';
  if (replace) { store.websites = []; store._ids.website = 0; }
  let added=0, updated=0;
  for (let i=1; i<rows.length; i++) {
    const r = rows[i];
    const website = (r[wIdx]||'').trim();
    if (!website) continue;
    const data = {
      website,
      category: idx('category')>=0 ? (r[idx('category')]||'').trim() : '',
      price: idx('price')>=0 ? Number(r[idx('price')])||0 : 0,
      dr: idx('dr')>=0 ? Number(r[idx('dr')])||0 : 0,
      da: idx('da')>=0 ? Number(r[idx('da')])||0 : 0,
      traffic: idx('traffic')>=0 ? Number(r[idx('traffic')])||0 : 0,
      notes: idx('notes')>=0 ? (r[idx('notes')]||'').trim() : '',
      featured: idx('featured')>=0 ? (['1','true','yes'].includes((r[idx('featured')]||'').trim().toLowerCase()) ? 1 : 0) : 0,
    };
    const existing = !replace && store.websites.find(w => w.website.toLowerCase() === website.toLowerCase());
    if (existing) { Object.assign(existing, data); updated++; }
    else { store.websites.push({ id: nextId('website'), ...data, views:0, deleted_at:null, created_at: new Date().toISOString() }); added++; }
  }
  saveStore();
  res.json({ added, updated, total: store.websites.length });
});

app.get('/api/websites/export', auth(false), (req,res) => {
  const headers = ['id','website','category','price','dr','da','traffic','notes','featured','views','deleted_at','created_at'];
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="websites-${todayStr()}.csv"`);
  res.send(toCSV(store.websites.filter(w => !w.deleted_at), headers));
});

// ----- Stats / Analytics -----
app.get('/api/stats', (req,res) => {
  const ws = store.websites.filter(w => !w.deleted_at);
  const total = ws.length;
  const totalValue = ws.reduce((s,w)=>s+(w.price||0),0);
  const avgPrice = total ? Math.round(totalValue/total) : 0;
  const minPrice = total ? Math.min(...ws.map(w=>w.price||0)) : 0;
  const maxPrice = total ? Math.max(...ws.map(w=>w.price||0)) : 0;
  const avgDR = total ? Math.round(ws.reduce((s,w)=>s+(w.dr||0),0)/total) : 0;
  const avgDA = total ? Math.round(ws.reduce((s,w)=>s+(w.da||0),0)/total) : 0;
  const byCategory = {};
  for (const w of ws) byCategory[w.category||'Uncategorized'] = (byCategory[w.category||'Uncategorized']||0)+1;
  res.json({ total, avgPrice, totalValue, minPrice, maxPrice, avgDR, avgDA, byCategory, deleted: store.websites.filter(w=>w.deleted_at).length });
});

// Analytics (admin)
app.get('/api/analytics', auth(true), adminOnly, (req,res) => {
  const days = Number(req.query.days) || 14;
  const today = new Date();
  const series = [];
  for (let i = days-1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate()-i);
    const key = d.toISOString().slice(0,10);
    const s = store.daily_stats[key] || {};
    series.push({ date: key, signups: s.signups||0, inquiries: s.inquiries||0, views: s.views||0, orders: s.orders||0 });
  }
  // Top viewed
  const topViewed = store.websites.filter(w => !w.deleted_at && (w.views||0)>0)
    .sort((a,b) => (b.views||0)-(a.views||0)).slice(0,10).map(w => ({ website: w.website, views: w.views }));
  // Top inquired
  const inquiryCounts = {};
  for (const inq of store.inquiries) for (const it of (inq.items||[])) inquiryCounts[it.website] = (inquiryCounts[it.website]||0) + 1;
  const topInquired = Object.entries(inquiryCounts).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([website, count]) => ({ website, count }));
  // Conversion rate (last 7 days)
  const recent = series.slice(-7);
  const totalViews = recent.reduce((s,r) => s + r.views, 0);
  const totalInq = recent.reduce((s,r) => s + r.inquiries, 0);
  const conversionRate = totalViews ? Math.round((totalInq / totalViews) * 1000) / 10 : 0;
  res.json({
    days, series, topViewed, topInquired,
    summary: {
      totalUsers: store.users.filter(u=>u.role!=='admin').length,
      totalWebsites: store.websites.filter(w=>!w.deleted_at).length,
      totalInquiries: store.inquiries.length,
      totalOrders: store.orders.length,
      conversionRate
    }
  });
});

// ----- Inquiries -----
app.post('/api/inquiries', auth(false), (req,res) => {
  const { items, total } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({error:'No items'});
  const inq = { id: nextId('inquiry'), username: req.user?.username || 'guest', items, total: Number(total)||0, created_at: new Date().toISOString() };
  store.inquiries.push(inq); bumpDaily('inquiries'); saveStore();
  res.json({ ok:true, id: inq.id });
});

app.get('/api/inquiries', auth(true), adminOnly, (req,res) => {
  res.json([...store.inquiries].sort((a,b) => b.id - a.id));
});

app.delete('/api/inquiries/:id', auth(true), adminOnly, (req,res) => {
  const id = Number(req.params.id);
  store.inquiries = store.inquiries.filter(i => i.id !== id);
  saveStore();
  res.json({ ok:true });
});

// ----- Orders / Quotes -----
const ORDER_STATUSES = ['pending','approved','paid','delivered','cancelled'];

app.post('/api/orders', auth(true), (req,res) => {
  const { items, currency, notes } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({error:'No items'});
  const total = items.reduce((s,i) => s + (Number(i.price)||0), 0);
  const order = {
    id: nextId('order'),
    order_number: 'RS-' + new Date().getFullYear() + '-' + String(nextId('order')).padStart(5,'0').slice(-5).padStart(5,'0'),
    username: req.user.username,
    user_id: req.user.id,
    items, total,
    currency: currency || 'USD',
    status: 'pending',
    notes: notes || '',
    status_history: [{ status:'pending', at: new Date().toISOString(), by: req.user.username }],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  // hack: undo the second nextId increment used for order_number
  store._ids.order = order.id;
  order.order_number = 'RS-' + new Date().getFullYear() + '-' + String(order.id).padStart(5,'0');
  store.orders.push(order); bumpDaily('orders'); saveStore();
  res.json(order);
});

app.get('/api/orders', auth(true), (req,res) => {
  const isAdmin = req.user.role === 'admin';
  const list = isAdmin ? store.orders : store.orders.filter(o => o.user_id === req.user.id);
  res.json([...list].sort((a,b) => b.id - a.id));
});

app.get('/api/orders/:id', auth(true), (req,res) => {
  const id = Number(req.params.id);
  const o = store.orders.find(x => x.id === id);
  if (!o) return res.status(404).json({error:'Not found'});
  if (req.user.role !== 'admin' && o.user_id !== req.user.id) return res.status(403).json({error:'Forbidden'});
  res.json(o);
});

app.put('/api/orders/:id/status', auth(true), adminOnly, (req,res) => {
  const id = Number(req.params.id);
  const { status, note } = req.body || {};
  if (!ORDER_STATUSES.includes(status)) return res.status(400).json({error:'Invalid status'});
  const o = store.orders.find(x => x.id === id);
  if (!o) return res.status(404).json({error:'Not found'});
  o.status = status;
  o.status_history.push({ status, at: new Date().toISOString(), by: req.user.username, note: note||'' });
  o.updated_at = new Date().toISOString();
  saveStore();
  res.json(o);
});

app.delete('/api/orders/:id', auth(true), adminOnly, (req,res) => {
  const id = Number(req.params.id);
  store.orders = store.orders.filter(o => o.id !== id);
  saveStore();
  res.json({ ok:true });
});

// ----- Wishlist -----
app.get('/api/wishlist', auth(true), (req,res) => {
  const list = store.wishlists.filter(w => w.user_id === req.user.id);
  const websiteIds = list.map(w => w.website_id);
  const websites = store.websites.filter(w => websiteIds.includes(w.id) && !w.deleted_at);
  res.json(websites);
});

app.post('/api/wishlist/:websiteId', auth(true), (req,res) => {
  const wid = Number(req.params.websiteId);
  if (!store.websites.find(w => w.id === wid)) return res.status(404).json({error:'Not found'});
  if (store.wishlists.find(w => w.user_id === req.user.id && w.website_id === wid)) return res.json({ ok:true });
  store.wishlists.push({ user_id: req.user.id, website_id: wid, added_at: new Date().toISOString() });
  saveStore();
  res.json({ ok:true });
});

app.delete('/api/wishlist/:websiteId', auth(true), (req,res) => {
  const wid = Number(req.params.websiteId);
  store.wishlists = store.wishlists.filter(w => !(w.user_id === req.user.id && w.website_id === wid));
  saveStore();
  res.json({ ok:true });
});

// ----- Users -----
app.get('/api/users', auth(true), adminOnly, (req,res) => {
  res.json(store.users.map(u => ({
    id: u.id, username: u.username, role: u.role, email: u.email,
    email_verified: u.email_verified, created_at: u.created_at, last_login: u.last_login
  })).sort((a,b) => b.id - a.id));
});

app.delete('/api/users/:id', auth(true), adminOnly, (req,res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({error:"Can't delete yourself"});
  store.users = store.users.filter(u => u.id !== id);
  store.wishlists = store.wishlists.filter(w => w.user_id !== id);
  saveStore();
  res.json({ ok:true });
});

// ----- Backup -----
app.get('/api/backup', auth(true), adminOnly, (req,res) => {
  const snap = {
    generated_at: new Date().toISOString(),
    counts: {
      websites: store.websites.filter(w=>!w.deleted_at).length,
      websites_deleted: store.websites.filter(w=>w.deleted_at).length,
      users: store.users.length,
      sub_users: store.users.filter(u=>u.role!=='admin').length,
      inquiries: store.inquiries.length,
      orders: store.orders.length,
      wishlists: store.wishlists.length
    },
    websites: store.websites,
    users: store.users.map(u => ({ id:u.id, username:u.username, role:u.role, email:u.email, created_at:u.created_at, last_login:u.last_login })),
    inquiries: store.inquiries,
    orders: store.orders,
    wishlists: store.wishlists,
    daily_stats: store.daily_stats
  };
  res.setHeader('Content-Type','application/json');
  res.setHeader('Content-Disposition', `attachment; filename="rankshifters-backup-${todayStr()}.json"`);
  res.send(JSON.stringify(snap, null, 2));
});

// ----- Currency rates (cached, refreshed every 12h) -----
let currencyCache = { rates: { USD:1, INR:83.5, EUR:0.92, GBP:0.79, CAD:1.36, AUD:1.51 }, updated: 0 };
async function refreshRates() {
  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
    const data = await r.json();
    if (data && data.rates) {
      currencyCache.rates = { USD:1, INR:data.rates.INR, EUR:data.rates.EUR, GBP:data.rates.GBP, CAD:data.rates.CAD, AUD:data.rates.AUD };
      currencyCache.updated = Date.now();
    }
  } catch(e) { console.warn('rate fetch failed', e.message); }
}
refreshRates();
setInterval(refreshRates, 12*60*60*1000);

app.get('/api/rates', (req,res) => res.json(currencyCache));


// ----- Smart search (regex-based, no API key needed) -----
app.post('/api/smart-search', (req,res) => {
  const q = String(req.body?.query || '').toLowerCase();
  if (!q) return res.json({ filters: {}, count: 0, ids: [] });
  const filters = {};
  let m;
  if ((m = q.match(/(?:under|below|less than|max|<=?)\s*\$?\s*(\d+)/))) filters.maxPrice = Number(m[1]);
  if ((m = q.match(/(?:over|above|more than|min|>=?)\s*\$?\s*(\d+)/))) filters.minPrice = Number(m[1]);
  if ((m = q.match(/between\s*\$?\s*(\d+)\s*(?:and|to|-)\s*\$?\s*(\d+)/))) { filters.minPrice = Number(m[1]); filters.maxPrice = Number(m[2]); }
  if ((m = q.match(/dr\s*(?:>|>=|over|above|min|of at least)\s*(\d+)/))) filters.minDR = Number(m[1]);
  if ((m = q.match(/dr\s*(?:<|<=|under|below|max)\s*(\d+)/))) filters.maxDR = Number(m[1]);
  if ((m = q.match(/da\s*(?:>|>=|over|above|min)\s*(\d+)/))) filters.minDA = Number(m[1]);
  if ((m = q.match(/da\s*(?:<|<=|under|below|max)\s*(\d+)/))) filters.maxDA = Number(m[1]);
  if ((m = q.match(/traffic\s*(?:>|>=|over|above|min)\s*(\d+)k?/))) {
    let v = Number(m[1]); if (/\d+k/.test(m[0])) v *= 1000;
    filters.minTraffic = v;
  }
  const cats = [...new Set(store.websites.filter(w=>!w.deleted_at).map(w => (w.category||'').toLowerCase()).filter(Boolean))];
  for (const c of cats) if (q.includes(c)) { filters.category = c; break; }
  if (/featured|premium|top|best/.test(q)) filters.featured = true;
  let text = q.replace(/(?:under|below|less than|max|<=?|over|above|more than|min|>=?)\s*\$?\s*\d+/g, '')
    .replace(/dr\s*[><=]+?\s*\d+/g, '').replace(/da\s*[><=]+?\s*\d+/g, '')
    .replace(/traffic\s*[><=]+?\s*\d+k?/g, '').replace(/featured|premium|top|best/g, '')
    .replace(/sites?|websites?/g, '').trim();
  if (text.length >= 3) filters.text = text;

  let results = store.websites.filter(w => !w.deleted_at);
  if (filters.maxPrice != null) results = results.filter(w => (w.price||0) <= filters.maxPrice);
  if (filters.minPrice != null) results = results.filter(w => (w.price||0) >= filters.minPrice);
  if (filters.minDR != null) results = results.filter(w => (w.dr||0) >= filters.minDR);
  if (filters.maxDR != null) results = results.filter(w => (w.dr||0) <= filters.maxDR);
  if (filters.minDA != null) results = results.filter(w => (w.da||0) >= filters.minDA);
  if (filters.maxDA != null) results = results.filter(w => (w.da||0) <= filters.maxDA);
  if (filters.minTraffic != null) results = results.filter(w => (w.traffic||0) >= filters.minTraffic);
  if (filters.category) results = results.filter(w => (w.category||'').toLowerCase() === filters.category);
  if (filters.featured) results = results.filter(w => w.featured);
  if (filters.text) results = results.filter(w => (w.website||'').toLowerCase().includes(filters.text) || (w.notes||'').toLowerCase().includes(filters.text));

  res.json({ filters, count: results.length, ids: results.slice(0, 500).map(w => w.id) });
});

// ----- Recommendations (similarity scoring) -----
app.post('/api/recommendations', auth(false), (req,res) => {
  const cartIds = (req.body?.cart_ids || []).map(Number);
  const seedIds = [...new Set(cartIds)];
  const seedSites = seedIds.map(id => store.websites.find(w => w.id === id && !w.deleted_at)).filter(Boolean);
  if (seedSites.length === 0) {
    const trending = [...store.websites].filter(w => !w.deleted_at).sort((a,b) => (b.views||0) - (a.views||0)).slice(0, 6);
    return res.json({ items: trending });
  }
  const seedCats = [...new Set(seedSites.map(s => s.category).filter(Boolean))];
  const avgPrice = seedSites.reduce((s,w) => s + (w.price||0), 0) / seedSites.length;
  const candidates = store.websites.filter(w => !w.deleted_at && !seedIds.includes(w.id));
  const scored = candidates.map(w => {
    let score = 0;
    if (seedCats.includes(w.category)) score += 50;
    const priceDiff = Math.abs((w.price||0) - avgPrice);
    score += Math.max(0, 30 - (priceDiff / Math.max(avgPrice, 1)) * 30);
    score += (w.dr || 0) / 5;
    score += (w.featured ? 10 : 0);
    score += Math.min(20, (w.views || 0));
    return { w, score };
  }).sort((a,b) => b.score - a.score).slice(0, 6).map(x => x.w);
  res.json({ items: scored });
});

// ----- Trending (alias) -----
app.get('/api/trending', (req,res) => {
  const list = [...store.websites].filter(w => !w.deleted_at)
    .sort((a,b) => (b.views||0) - (a.views||0))
    .slice(0, 10);
  res.json(list);
});


app.listen(PORT, '0.0.0.0', () => console.log(`Server on :${PORT}`));
