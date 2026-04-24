const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-prod';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '919712565375';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: 'text/csv', limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ----- Simple JSON store -----
let store = { users: [], websites: [], inquiries: [], _ids: { user: 0, website: 0, inquiry: 0 } };

function loadStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      store = { users: [], websites: [], inquiries: [], _ids: { user: 0, website: 0, inquiry: 0 }, ...loaded };
      if (!store.inquiries) store.inquiries = [];
      if (!store._ids.inquiry) store._ids.inquiry = 0;
    }
  } catch (e) { console.error('load error', e); }
}
let saveTimer = null;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
  }, 50);
}
function nextId(kind) { store._ids[kind] = (store._ids[kind] || 0) + 1; return store._ids[kind]; }

loadStore();

// Always make sure admin matches env (resets password if env changed)
const adminIdx = store.users.findIndex(u => u.username === ADMIN_USERNAME);
if (adminIdx < 0) {
  store.users.push({
    id: nextId('user'),
    username: ADMIN_USERNAME,
    password: bcrypt.hashSync(ADMIN_PASSWORD, 10),
    role: 'admin',
    created_at: new Date().toISOString(),
  });
  saveStore();
  console.log('Admin user created:', ADMIN_USERNAME);
} else {
  // Ensure role is admin and password matches env
  if (store.users[adminIdx].role !== 'admin' || !bcrypt.compareSync(ADMIN_PASSWORD, store.users[adminIdx].password)) {
    store.users[adminIdx].password = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    store.users[adminIdx].role = 'admin';
    saveStore();
    console.log('Admin password/role synced from env');
  }
}

// Seed demo websites
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
  for (const [website, category, price, dr, da, traffic, notes] of seed) {
    store.websites.push({
      id: nextId('website'),
      website, category, price, dr, da, traffic, notes,
      featured: 0,
      created_at: new Date().toISOString(),
    });
  }
  saveStore();
  console.log('Seeded', seed.length, 'demo websites');
}

// ----- Auth middleware -----
function auth(required = true) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || null);
    if (!token) {
      if (required) return res.status(401).json({ error: 'Unauthorized' });
      return next();
    }
    try { req.user = jwt.verify(token, JWT_SECRET); next(); }
    catch (e) {
      if (required) return res.status(401).json({ error: 'Invalid token' });
      next();
    }
  };
}
function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

function normalizePayload(b = {}) {
  return {
    website: String(b.website || '').trim(),
    category: String(b.category || '').trim(),
    price: Number(b.price) || 0,
    dr: Number(b.dr) || 0,
    da: Number(b.da) || 0,
    traffic: Number(b.traffic) || 0,
    notes: String(b.notes || '').trim(),
    featured: b.featured ? 1 : 0,
  };
}

// ----- CSV helpers -----
function parseCSV(text) {
  const rows = [];
  let cur = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i+1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { cur.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i+1] === '\n') i++;
        cur.push(field); field = '';
        if (cur.some(v => v !== '')) rows.push(cur);
        cur = [];
      } else field += c;
    }
  }
  if (field !== '' || cur.length) { cur.push(field); if (cur.some(v => v !== '')) rows.push(cur); }
  return rows;
}
function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}
function toCSV(rows, headers) {
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map(h => csvEscape(r[h])).join(','));
  return lines.join('\n');
}

// ----- Routes -----
app.get('/api/config', (req, res) => res.json({ whatsapp: WHATSAPP_NUMBER }));

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (password.length < 4) return res.status(400).json({ error: 'password too short' });
  if (store.users.find(u => u.username === username)) return res.status(409).json({ error: 'Username taken' });
  const user = {
    id: nextId('user'),
    username,
    password: bcrypt.hashSync(password, 10),
    role: 'user',
    created_at: new Date().toISOString(),
  };
  store.users.push(user); saveStore();
  const token = jwt.sign({ id: user.id, username, role: 'user' }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username, role: 'user' } });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = store.users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password || '', user.password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

app.get('/api/me', auth(true), (req, res) => res.json({ user: req.user }));

app.get('/api/websites', (req, res) => {
  res.json([...store.websites].sort((a,b) => (b.featured||0) - (a.featured||0) || b.id - a.id));
});

app.post('/api/websites', auth(true), adminOnly, (req, res) => {
  const data = normalizePayload(req.body);
  if (!data.website) return res.status(400).json({ error: 'website required' });
  const w = { id: nextId('website'), ...data, created_at: new Date().toISOString() };
  store.websites.push(w); saveStore();
  res.json(w);
});

app.put('/api/websites/:id', auth(true), adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const idx = store.websites.findIndex(w => w.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  const data = normalizePayload(req.body);
  store.websites[idx] = { ...store.websites[idx], ...data };
  saveStore();
  res.json(store.websites[idx]);
});

app.delete('/api/websites/:id', auth(true), adminOnly, (req, res) => {
  const id = Number(req.params.id);
  store.websites = store.websites.filter(w => w.id !== id);
  saveStore();
  res.json({ ok: true });
});

// Bulk delete
app.post('/api/websites/bulk-delete', auth(true), adminOnly, (req, res) => {
  const ids = (req.body?.ids || []).map(Number);
  const before = store.websites.length;
  store.websites = store.websites.filter(w => !ids.includes(w.id));
  saveStore();
  res.json({ deleted: before - store.websites.length });
});

// CSV import (text/csv body or JSON { csv: "..." })
app.post('/api/websites/import', auth(true), adminOnly, (req, res) => {
  let csv = '';
  if (typeof req.body === 'string') csv = req.body;
  else if (req.body && typeof req.body.csv === 'string') csv = req.body.csv;
  if (!csv) return res.status(400).json({ error: 'No CSV provided' });

  const rows = parseCSV(csv.trim());
  if (rows.length < 2) return res.status(400).json({ error: 'CSV must have header + rows' });

  const headers = rows[0].map(h => h.trim().toLowerCase());
  const idx = (name) => headers.indexOf(name);
  const wIdx = idx('website');
  if (wIdx < 0) return res.status(400).json({ error: 'CSV must have a "website" column' });

  const cIdx = idx('category');
  const pIdx = idx('price');
  const drIdx = idx('dr');
  const daIdx = idx('da');
  const tIdx = idx('traffic');
  const nIdx = idx('notes');
  const fIdx = idx('featured');
  const replace = String(req.query.replace || '') === '1';

  if (replace) {
    store.websites = [];
    store._ids.website = 0;
  }

  let added = 0, updated = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const website = (r[wIdx] || '').trim();
    if (!website) continue;
    const data = {
      website,
      category: cIdx >= 0 ? (r[cIdx] || '').trim() : '',
      price: pIdx >= 0 ? Number(r[pIdx]) || 0 : 0,
      dr: drIdx >= 0 ? Number(r[drIdx]) || 0 : 0,
      da: daIdx >= 0 ? Number(r[daIdx]) || 0 : 0,
      traffic: tIdx >= 0 ? Number(r[tIdx]) || 0 : 0,
      notes: nIdx >= 0 ? (r[nIdx] || '').trim() : '',
      featured: fIdx >= 0 ? (['1','true','yes','y'].includes((r[fIdx]||'').trim().toLowerCase()) ? 1 : 0) : 0,
    };
    // Upsert by website domain (case-insensitive)
    const existing = !replace && store.websites.find(w => w.website.toLowerCase() === website.toLowerCase());
    if (existing) {
      Object.assign(existing, data);
      updated++;
    } else {
      store.websites.push({ id: nextId('website'), ...data, created_at: new Date().toISOString() });
      added++;
    }
  }
  saveStore();
  res.json({ added, updated, total: store.websites.length });
});

// CSV export
app.get('/api/websites/export', auth(false), (req, res) => {
  const headers = ['id','website','category','price','dr','da','traffic','notes','featured','created_at'];
  const csv = toCSV(store.websites, headers);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="websites-${Date.now()}.csv"`);
  res.send(csv);
});

// Stats
app.get('/api/stats', (req, res) => {
  const ws = store.websites;
  const total = ws.length;
  const avgPrice = total ? Math.round(ws.reduce((s,w) => s + (w.price||0), 0) / total) : 0;
  const totalValue = ws.reduce((s,w) => s + (w.price||0), 0);
  const byCategory = {};
  for (const w of ws) {
    const c = w.category || 'Uncategorized';
    byCategory[c] = (byCategory[c] || 0) + 1;
  }
  const minPrice = ws.length ? Math.min(...ws.map(w => w.price||0)) : 0;
  const maxPrice = ws.length ? Math.max(...ws.map(w => w.price||0)) : 0;
  const avgDR = total ? Math.round(ws.reduce((s,w) => s + (w.dr||0), 0) / total) : 0;
  const avgDA = total ? Math.round(ws.reduce((s,w) => s + (w.da||0), 0) / total) : 0;
  res.json({ total, avgPrice, totalValue, minPrice, maxPrice, avgDR, avgDA, byCategory });
});

// Inquiries (when sub-user clicks WhatsApp)
app.post('/api/inquiries', auth(false), (req, res) => {
  const { items, total } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'No items' });
  const inq = {
    id: nextId('inquiry'),
    username: req.user?.username || 'guest',
    items, total: Number(total) || 0,
    created_at: new Date().toISOString(),
  };
  store.inquiries.push(inq); saveStore();
  res.json({ ok: true, id: inq.id });
});

app.get('/api/inquiries', auth(true), adminOnly, (req, res) => {
  res.json([...store.inquiries].sort((a,b) => b.id - a.id));
});

app.delete('/api/inquiries/:id', auth(true), adminOnly, (req, res) => {
  const id = Number(req.params.id);
  store.inquiries = store.inquiries.filter(i => i.id !== id);
  saveStore();
  res.json({ ok: true });
});

// Users
app.get('/api/users', auth(true), adminOnly, (req, res) => {
  res.json(store.users.map(u => ({ id: u.id, username: u.username, role: u.role, created_at: u.created_at }))
    .sort((a,b) => b.id - a.id));
});

app.delete('/api/users/:id', auth(true), adminOnly, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "Can't delete yourself" });
  store.users = store.users.filter(u => u.id !== id);
  saveStore();
  res.json({ ok: true });
});


// Full JSON backup (admin only) - used by daily scheduled backup
app.get('/api/backup', auth(true), adminOnly, (req, res) => {
  const snapshot = {
    generated_at: new Date().toISOString(),
    counts: {
      websites: store.websites.length,
      users: store.users.length,
      sub_users: store.users.filter(u => u.role !== 'admin').length,
      inquiries: store.inquiries.length,
    },
    websites: store.websites,
    inquiries: store.inquiries,
    users: store.users.map(u => ({ id: u.id, username: u.username, role: u.role, created_at: u.created_at })),
  };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="rankshifters-backup-${new Date().toISOString().slice(0,10)}.json"`);
  res.send(JSON.stringify(snapshot, null, 2));
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server on http://0.0.0.0:${PORT}`));
