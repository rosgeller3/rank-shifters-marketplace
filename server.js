require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '919712565375';
const MONGODB_URI = process.env.MONGODB_URI;

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let db;
let client;

async function nextId(k) {
  const result = await db.collection('counters').findOneAndUpdate(
    { _id: k },
    { $inc: { seq: 1 } },
    { returnDocument: 'after', upsert: true }
  );
  return result.seq;
}

function todayStr() { return new Date().toISOString().slice(0,10); }

async function bumpDaily(metric, n=1) {
  const d = todayStr();
  const update = {};
  update[metric] = n;
  await db.collection('daily_stats').updateOne(
    { date: d },
    { $inc: update },
    { upsert: true }
  );
}

async function logEvent(type, data = {}) {
  const event = { id: await nextId('event'), type, at: new Date().toISOString(), ...data };
  await db.collection('events').insertOne(event);
  
  // Cleanup old events (approximate, running occasionally)
  if (Math.random() < 0.05) {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    await db.collection('events').deleteMany({ at: { $lt: cutoff } });
  }
}

// Ensure clean objects without MongoDB _id
function cleanOutput(obj) {
  if (!obj) return null;
  const { _id, ...rest } = obj;
  return rest;
}
function cleanArray(arr) { return arr.map(cleanOutput); }

// Auth middleware
function auth(required=true) {
  return async (req, res, next) => {
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
app.post('/api/register', async (req,res) => {
  const { username, password, email } = req.body || {};
  if (!username || !password) return res.status(400).json({error:'username and password required'});
  if (password.length < 4) return res.status(400).json({error:'password too short'});
  const existing = await db.collection('users').findOne({ username });
  if (existing) return res.status(409).json({error:'Username taken'});
  
  const user = {
    id: await nextId('user'), username, password: bcrypt.hashSync(password,10), role:'user',
    email: (email||'').trim() || null,
    email_verified: false,
    verification_token: crypto.randomBytes(16).toString('hex'),
    created_at: new Date().toISOString()
  };
  await db.collection('users').insertOne(user);
  await bumpDaily('signups');
  const token = jwt.sign({id:user.id,username,role:'user'}, JWT_SECRET, {expiresIn:'30d'});
  res.json({ token, user: {id:user.id, username, role:'user'} });
});

app.post('/api/login', async (req,res) => {
  const { username, password } = req.body || {};
  const user = await db.collection('users').findOne({ username });
  if (!user || !bcrypt.compareSync(password||'', user.password)) return res.status(401).json({error:'Invalid credentials'});
  
  await db.collection('users').updateOne({ id: user.id }, { $set: { last_login: new Date().toISOString() } });
  
  const token = jwt.sign({id:user.id,username:user.username,role:user.role}, JWT_SECRET, {expiresIn:'30d'});
  res.json({ token, user: {id:user.id, username:user.username, role:user.role} });
});

app.get('/api/me', auth(true), (req,res) => res.json({ user: req.user }));

// ----- Websites -----
app.get('/api/websites', async (req,res) => {
  const includeDeleted = String(req.query.deleted||'') === '1';
  const query = includeDeleted ? { deleted_at: { $ne: null } } : { deleted_at: null };
  const rows = await db.collection('websites').find(query).toArray();
  res.json(cleanArray(rows.sort((a,b) => (b.featured||0)-(a.featured||0) || b.id - a.id)));
});

app.post('/api/websites', auth(true), adminOnly, async (req,res) => {
  const data = normalizeWebsite(req.body);
  if (!data.website) return res.status(400).json({error:'website required'});
  const w = { id: await nextId('website'), ...data, views:0, deleted_at:null, created_at: new Date().toISOString() };
  await db.collection('websites').insertOne(w);
  res.json(cleanOutput(w));
});

app.put('/api/websites/:id', auth(true), adminOnly, async (req,res) => {
  const id = Number(req.params.id);
  const data = normalizeWebsite(req.body);
  const result = await db.collection('websites').findOneAndUpdate(
    { id },
    { $set: data },
    { returnDocument: 'after' }
  );
  if (!result) return res.status(404).json({error:'Not found'});
  res.json(cleanOutput(result));
});

app.delete('/api/websites/:id', auth(true), adminOnly, async (req,res) => {
  const id = Number(req.params.id);
  const result = await db.collection('websites').updateOne({ id }, { $set: { deleted_at: new Date().toISOString() } });
  if (result.matchedCount === 0) return res.status(404).json({error:'Not found'});
  res.json({ ok:true });
});

app.post('/api/websites/:id/restore', auth(true), adminOnly, async (req,res) => {
  const id = Number(req.params.id);
  const result = await db.collection('websites').findOneAndUpdate({ id }, { $set: { deleted_at: null } }, { returnDocument: 'after' });
  if (!result) return res.status(404).json({error:'Not found'});
  res.json(cleanOutput(result));
});

app.delete('/api/websites/:id/permanent', auth(true), adminOnly, async (req,res) => {
  const id = Number(req.params.id);
  await db.collection('websites').deleteOne({ id });
  res.json({ ok:true });
});

app.post('/api/websites/bulk-delete', auth(true), adminOnly, async (req,res) => {
  const ids = (req.body?.ids||[]).map(Number);
  const result = await db.collection('websites').updateMany(
    { id: { $in: ids }, deleted_at: null },
    { $set: { deleted_at: new Date().toISOString() } }
  );
  res.json({ deleted: result.modifiedCount });
});

app.post('/api/websites/bulk-edit', auth(true), adminOnly, async (req,res) => {
  const { ids = [], updates = {}, priceAdjust } = req.body || {};
  const idSet = ids.map(Number);
  
  const sites = await db.collection('websites').find({ id: { $in: idSet }, deleted_at: null }).toArray();
  let updated = 0;
  
  for (const w of sites) {
    let changed = false;
    if (updates.category !== undefined) { w.category = String(updates.category).trim(); changed = true; }
    if (updates.notes !== undefined) { w.notes = String(updates.notes).trim(); changed = true; }
    if (updates.featured !== undefined) { w.featured = updates.featured ? 1 : 0; changed = true; }
    if (priceAdjust && priceAdjust.type) {
      const base = Number(w.price)||0;
      if (priceAdjust.type === 'set') w.price = Number(priceAdjust.value)||0;
      else if (priceAdjust.type === 'percent') w.price = Math.round(base * (1 + Number(priceAdjust.value)/100));
      else if (priceAdjust.type === 'add') w.price = base + Number(priceAdjust.value)||0;
      changed = true;
    }
    if (changed) {
      await db.collection('websites').updateOne({ id: w.id }, { $set: w });
      updated++;
    }
  }
  res.json({ updated });
});

app.post('/api/websites/:id/view', async (req,res) => {
  const id = Number(req.params.id);
  const result = await db.collection('websites').findOneAndUpdate(
    { id },
    { $inc: { views: 1 } },
    { returnDocument: 'after' }
  );
  if (!result) return res.status(404).json({error:'Not found'});
  await bumpDaily('views');
  res.json({ views: result.views });
});

app.post('/api/track', auth(false), async (req, res) => {
  const { kind, website_id, meta } = req.body || {};
  if (!['view','click','search','add_to_cart','add_to_wishlist'].includes(kind)) {
    return res.status(400).json({ error: 'invalid kind' });
  }
  await logEvent(kind, { website_id: website_id ? Number(website_id) : null, meta, username: req.user?.username || 'guest' });
  if (kind === 'click' && website_id) {
    await db.collection('websites').updateOne({ id: Number(website_id) }, { $inc: { clicks: 1 } });
  }
  res.json({ ok: true });
});

app.get('/api/websites/trending', async (req,res) => {
  const limit = Number(req.query.limit) || 5;
  const trending = await db.collection('websites')
    .find({ deleted_at: null, views: { $gt: 0 } })
    .sort({ views: -1 })
    .limit(limit)
    .toArray();
  res.json(trending.map(w => ({ id: w.id, website: w.website, views: w.views })));
});

app.post('/api/websites/import', auth(true), adminOnly, async (req,res) => {
  let csv = (req.body && req.body.csv) || '';
  if (!csv) return res.status(400).json({error:'No CSV'});
  const rows = parseCSV(csv.trim());
  if (rows.length < 2) return res.status(400).json({error:'CSV needs header + rows'});
  const headers = rows[0].map(h => h.trim().toLowerCase());
  const idx = name => headers.indexOf(name);
  const wIdx = idx('website');
  if (wIdx < 0) return res.status(400).json({error:'Missing "website" column'});
  
  const replace = String(req.query.replace||'') === '1';
  if (replace) {
    await db.collection('websites').deleteMany({});
  }
  
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
    
    if (!replace) {
      // Use collation for case-insensitive match if needed, but here simple regex is fine, or standard exact match
      const existing = await db.collection('websites').findOne({ website: { $regex: new RegExp(`^${website}$`, 'i') } });
      if (existing) {
        await db.collection('websites').updateOne({ id: existing.id }, { $set: data });
        updated++;
        continue;
      }
    }
    
    data.id = await nextId('website');
    data.views = 0;
    data.deleted_at = null;
    data.created_at = new Date().toISOString();
    await db.collection('websites').insertOne(data);
    added++;
  }
  const total = await db.collection('websites').countDocuments();
  res.json({ added, updated, total });
});

app.get('/api/websites/export', auth(false), async (req,res) => {
  const headers = ['id','website','category','price','dr','da','traffic','notes','featured','views','deleted_at','created_at'];
  const sites = await db.collection('websites').find({ deleted_at: null }).toArray();
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="websites-${todayStr()}.csv"`);
  res.send(toCSV(sites, headers));
});

// ----- Stats / Analytics -----
app.get('/api/stats', async (req,res) => {
  const ws = await db.collection('websites').find({ deleted_at: null }).toArray();
  const total = ws.length;
  const totalValue = ws.reduce((s,w)=>s+(w.price||0),0);
  const avgPrice = total ? Math.round(totalValue/total) : 0;
  const minPrice = total ? Math.min(...ws.map(w=>w.price||0)) : 0;
  const maxPrice = total ? Math.max(...ws.map(w=>w.price||0)) : 0;
  const avgDR = total ? Math.round(ws.reduce((s,w)=>s+(w.dr||0),0)/total) : 0;
  const avgDA = total ? Math.round(ws.reduce((s,w)=>s+(w.da||0),0)/total) : 0;
  const byCategory = {};
  for (const w of ws) byCategory[w.category||'Uncategorized'] = (byCategory[w.category||'Uncategorized']||0)+1;
  const deleted = await db.collection('websites').countDocuments({ deleted_at: { $ne: null } });
  res.json({ total, avgPrice, totalValue, minPrice, maxPrice, avgDR, avgDA, byCategory, deleted });
});

app.get('/api/analytics', auth(true), adminOnly, async (req,res) => {
  const days = Number(req.query.days) || 14;
  const today = new Date();
  const series = [];
  for (let i = days-1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate()-i);
    const key = d.toISOString().slice(0,10);
    const s = await db.collection('daily_stats').findOne({ date: key }) || {};
    series.push({ date: key, signups: s.signups||0, inquiries: s.inquiries||0, views: s.views||0, orders: s.orders||0 });
  }
  
  const topViewedRaw = await db.collection('websites')
    .find({ deleted_at: null, views: { $gt: 0 } })
    .sort({ views: -1 }).limit(10).toArray();
  const topViewed = topViewedRaw.map(w => ({ website: w.website, views: w.views }));
  
  const inquiries = await db.collection('inquiries').find().toArray();
  const inquiryCounts = {};
  for (const inq of inquiries) for (const it of (inq.items||[])) inquiryCounts[it.website] = (inquiryCounts[it.website]||0) + 1;
  const topInquired = Object.entries(inquiryCounts).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([website, count]) => ({ website, count }));
  
  const recent = series.slice(-7);
  const totalViews = recent.reduce((s,r) => s + r.views, 0);
  const totalInq = recent.reduce((s,r) => s + r.inquiries, 0);
  const conversionRate = totalViews ? Math.round((totalInq / totalViews) * 1000) / 10 : 0;
  
  res.json({
    days, series, topViewed, topInquired,
    summary: {
      totalUsers: await db.collection('users').countDocuments({ role: { $ne: 'admin' } }),
      totalWebsites: await db.collection('websites').countDocuments({ deleted_at: null }),
      totalInquiries: await db.collection('inquiries').countDocuments(),
      totalOrders: await db.collection('orders').countDocuments(),
      conversionRate
    }
  });
});

app.post('/api/inquiries', auth(false), async (req,res) => {
  const { items, total } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({error:'No items'});
  const inq = { id: await nextId('inquiry'), username: req.user?.username || 'guest', items, total: Number(total)||0, created_at: new Date().toISOString() };
  await db.collection('inquiries').insertOne(inq);
  await bumpDaily('inquiries');
  res.json({ ok:true, id: inq.id });
});

app.get('/api/inquiries', auth(true), adminOnly, async (req,res) => {
  const inquiries = await db.collection('inquiries').find().sort({ id: -1 }).toArray();
  res.json(cleanArray(inquiries));
});

app.delete('/api/inquiries/:id', auth(true), adminOnly, async (req,res) => {
  const id = Number(req.params.id);
  await db.collection('inquiries').deleteOne({ id });
  res.json({ ok:true });
});

const ORDER_STATUSES = ['pending','approved','paid','delivered','cancelled'];

app.post('/api/orders', auth(true), async (req,res) => {
  const { items, currency, notes } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({error:'No items'});
  const total = items.reduce((s,i) => s + (Number(i.price)||0), 0);
  const orderId = await nextId('order');
  const order = {
    id: orderId,
    order_number: 'RS-' + new Date().getFullYear() + '-' + String(orderId).padStart(5,'0'),
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
  await db.collection('orders').insertOne(order);
  await bumpDaily('orders');
  res.json(cleanOutput(order));
});

app.get('/api/orders', auth(true), async (req,res) => {
  const isAdmin = req.user.role === 'admin';
  const query = isAdmin ? {} : { user_id: req.user.id };
  const orders = await db.collection('orders').find(query).sort({ id: -1 }).toArray();
  res.json(cleanArray(orders));
});

app.get('/api/orders/:id', auth(true), async (req,res) => {
  const id = Number(req.params.id);
  const o = await db.collection('orders').findOne({ id });
  if (!o) return res.status(404).json({error:'Not found'});
  if (req.user.role !== 'admin' && o.user_id !== req.user.id) return res.status(403).json({error:'Forbidden'});
  res.json(cleanOutput(o));
});

app.put('/api/orders/:id/status', auth(true), adminOnly, async (req,res) => {
  const id = Number(req.params.id);
  const { status, note } = req.body || {};
  if (!ORDER_STATUSES.includes(status)) return res.status(400).json({error:'Invalid status'});
  const o = await db.collection('orders').findOne({ id });
  if (!o) return res.status(404).json({error:'Not found'});
  
  const historyEntry = { status, at: new Date().toISOString(), by: req.user.username, note: note||'' };
  const updated = await db.collection('orders').findOneAndUpdate(
    { id },
    { $set: { status, updated_at: new Date().toISOString() }, $push: { status_history: historyEntry } },
    { returnDocument: 'after' }
  );
  res.json(cleanOutput(updated));
});

app.delete('/api/orders/:id', auth(true), adminOnly, async (req,res) => {
  const id = Number(req.params.id);
  await db.collection('orders').deleteOne({ id });
  res.json({ ok:true });
});

// ----- Wishlist -----
app.get('/api/wishlist', auth(true), async (req,res) => {
  const list = await db.collection('wishlists').find({ user_id: req.user.id }).toArray();
  const websiteIds = list.map(w => w.website_id);
  const websites = await db.collection('websites').find({ id: { $in: websiteIds }, deleted_at: null }).toArray();
  res.json(cleanArray(websites));
});

app.post('/api/wishlist/:websiteId', auth(true), async (req,res) => {
  const wid = Number(req.params.websiteId);
  const site = await db.collection('websites').findOne({ id: wid });
  if (!site) return res.status(404).json({error:'Not found'});
  await db.collection('wishlists').updateOne(
    { user_id: req.user.id, website_id: wid },
    { $set: { user_id: req.user.id, website_id: wid, added_at: new Date().toISOString() } },
    { upsert: true }
  );
  res.json({ ok:true });
});

app.delete('/api/wishlist/:websiteId', auth(true), async (req,res) => {
  const wid = Number(req.params.websiteId);
  await db.collection('wishlists').deleteOne({ user_id: req.user.id, website_id: wid });
  res.json({ ok:true });
});

app.get('/api/users', auth(true), adminOnly, async (req,res) => {
  const users = await db.collection('users').find().sort({ id: -1 }).toArray();
  res.json(users.map(u => ({
    id: u.id, username: u.username, role: u.role, email: u.email,
    email_verified: u.email_verified, created_at: u.created_at, last_login: u.last_login
  })));
});

app.delete('/api/users/:id', auth(true), adminOnly, async (req,res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({error:"Can't delete yourself"});
  await db.collection('users').deleteOne({ id });
  await db.collection('wishlists').deleteMany({ user_id: id });
  res.json({ ok:true });
});

app.get('/api/backup', auth(true), adminOnly, async (req,res) => {
  const snap = {
    generated_at: new Date().toISOString(),
    websites: cleanArray(await db.collection('websites').find().toArray()),
    users: cleanArray(await db.collection('users').find().toArray()),
    inquiries: cleanArray(await db.collection('inquiries').find().toArray()),
    orders: cleanArray(await db.collection('orders').find().toArray()),
    wishlists: cleanArray(await db.collection('wishlists').find().toArray()),
    daily_stats: cleanArray(await db.collection('daily_stats').find().toArray())
  };
  res.setHeader('Content-Type','application/json');
  res.setHeader('Content-Disposition', `attachment; filename="rankshifters-backup-${todayStr()}.json"`);
  res.send(JSON.stringify(snap, null, 2));
});

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

app.post('/api/smart-search', async (req, res) => {
  let q = String(req.body && req.body.query || '').toLowerCase();
  if (!q) return res.json({ filters: {}, count: 0, ids: [] });
  const filters = {};
  let m;
  if ((m = q.match(/dr\s*(?:>=?|over|above|min|of at least)\s*(\d+)/))) { filters.minDR = Number(m[1]); q = q.replace(m[0], ' '); }
  if ((m = q.match(/dr\s*(?:<=?|under|below|max)\s*(\d+)/))) { filters.maxDR = Number(m[1]); q = q.replace(m[0], ' '); }
  if ((m = q.match(/da\s*(?:>=?|over|above|min)\s*(\d+)/))) { filters.minDA = Number(m[1]); q = q.replace(m[0], ' '); }
  if ((m = q.match(/da\s*(?:<=?|under|below|max)\s*(\d+)/))) { filters.maxDA = Number(m[1]); q = q.replace(m[0], ' '); }
  if ((m = q.match(/traffic\s*(?:>=?|over|above|min)\s*(\d+)k?/))) { let v = Number(m[1]); if (/k\b/.test(m[0])) v *= 1000; filters.minTraffic = v; q = q.replace(m[0], ' '); }
  if ((m = q.match(/(?:under|below|less than|max)\s*\$?\s*(\d+)/))) { filters.maxPrice = Number(m[1]); q = q.replace(m[0], ' '); }
  if ((m = q.match(/(?:over|above|more than|min)\s*\$?\s*(\d+)/))) { filters.minPrice = Number(m[1]); q = q.replace(m[0], ' '); }
  if ((m = q.match(/between\s*\$?\s*(\d+)\s*(?:and|to|-)\s*\$?\s*(\d+)/))) { filters.minPrice = Number(m[1]); filters.maxPrice = Number(m[2]); q = q.replace(m[0], ' '); }
  
  if (/featured|premium|top|best/.test(q)) { filters.featured = true; q = q.replace(/featured|premium|top|best/g, ' '); }
  let text = q.replace(/sites?|websites?|with|and|the|a|an/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length >= 3) filters.text = text;

  const mongoQuery = { deleted_at: null };
  if (filters.maxPrice != null) mongoQuery.price = { ...mongoQuery.price, $lte: filters.maxPrice };
  if (filters.minPrice != null) mongoQuery.price = { ...mongoQuery.price, $gte: filters.minPrice };
  if (filters.minDR != null) mongoQuery.dr = { ...mongoQuery.dr, $gte: filters.minDR };
  if (filters.maxDR != null) mongoQuery.dr = { ...mongoQuery.dr, $lte: filters.maxDR };
  if (filters.minDA != null) mongoQuery.da = { ...mongoQuery.da, $gte: filters.minDA };
  if (filters.maxDA != null) mongoQuery.da = { ...mongoQuery.da, $lte: filters.maxDA };
  if (filters.minTraffic != null) mongoQuery.traffic = { ...mongoQuery.traffic, $gte: filters.minTraffic };
  if (filters.featured) mongoQuery.featured = 1;
  if (filters.text) {
    mongoQuery.$or = [
      { website: { $regex: filters.text, $options: 'i' } },
      { notes: { $regex: filters.text, $options: 'i' } }
    ];
  }
  
  // Actually, wait: category matching requires getting distinct categories first or simple regex if text matches
  // A simplified approach:
  const categories = await db.collection('websites').distinct('category');
  const cats = categories.filter(Boolean).map(c=>c.toLowerCase());
  for (const c of cats) if (q.includes(c)) { filters.category = c; mongoQuery.category = new RegExp(`^${c}$`, 'i'); q = q.replace(c, ' '); break; }

  const r = await db.collection('websites').find(mongoQuery).limit(500).toArray();
  res.json({ filters, count: r.length, ids: r.map(w => w.id) });
});

app.post('/api/recommendations', auth(false), async (req,res) => {
  const cartIds = (req.body?.cart_ids || []).map(Number);
  const seedIds = [...new Set(cartIds)];
  const seedSites = await db.collection('websites').find({ id: { $in: seedIds }, deleted_at: null }).toArray();
  if (seedSites.length === 0) {
    const trending = await db.collection('websites').find({ deleted_at: null }).sort({ views: -1 }).limit(6).toArray();
    return res.json({ items: cleanArray(trending) });
  }
  const seedCats = [...new Set(seedSites.map(s => s.category).filter(Boolean))];
  const avgPrice = seedSites.reduce((s,w) => s + (w.price||0), 0) / seedSites.length;
  const candidates = await db.collection('websites').find({ deleted_at: null, id: { $nin: seedIds } }).toArray();
  
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
  res.json({ items: cleanArray(scored) });
});

app.get('/api/trending', async (req,res) => {
  const list = await db.collection('websites').find({ deleted_at: null }).sort({ views: -1 }).limit(10).toArray();
  res.json(cleanArray(list));
});

// START SERVER & SEED DATA
async function start() {
  console.log('--- STARTING UP ---');
  console.log('MONGODB_URI defined:', !!MONGODB_URI);
  
  // Add a 5-second timeout so it doesn't hang infinitely
  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  
  try {
    console.log('Attempting to connect to MongoDB...');
    await client.connect();
    console.log('Connected to MongoDB successfully!');
  } catch (err) {
    console.error('CRITICAL ERROR: Failed to connect to MongoDB!', err);
    process.exit(1); // Force crash so Render logs it immediately
  }
  
  db = client.db('rankshifters');

  // Sync admin
  const admin = await db.collection('users').findOne({ username: ADMIN_USERNAME });
  if (!admin) {
    await db.collection('users').insertOne({
      id: await nextId('user'),
      username: ADMIN_USERNAME,
      password: bcrypt.hashSync(ADMIN_PASSWORD, 10),
      role: 'admin',
      email_verified: true,
      created_at: new Date().toISOString()
    });
    console.log('Admin created');
  } else {
    if (!bcrypt.compareSync(ADMIN_PASSWORD, admin.password) || admin.role !== 'admin') {
      await db.collection('users').updateOne(
        { id: admin.id },
        { $set: { password: bcrypt.hashSync(ADMIN_PASSWORD, 10), role: 'admin', email_verified: true } }
      );
      console.log('Admin synced');
    }
  }

  // Seed demo
  const siteCount = await db.collection('websites').countDocuments();
  if (siteCount === 0) {
    const seed = [
      ['techbullion.com','Business',25,81,80,71000,'Premium tech publication, Dofollow Backlink'],
      ['trustpost.org','General',10,25,25,80000000,'Dofollow Backlink'],
      ['grammarvibe.org','General',20,9,9,1,'Dofollow Backlink'],
      ['loveequotes.com','General',20,31,31,1,'Dofollow Backlink'],
      ['grammeroverview.com','General',20,41,41,1,'Dofollow Backlink']
    ];
    for (const [website,category,price,dr,da,traffic,notes] of seed) {
      await db.collection('websites').insertOne({
        id: await nextId('website'),
        website, category, price, dr, da, traffic, notes,
        featured:0, views:0, deleted_at: null, created_at: new Date().toISOString()
      });
    }
    console.log('Seeded demo websites');
  }

  app.listen(PORT, '0.0.0.0', () => console.log(`Server on :${PORT}`));
}

start().catch(console.error);
