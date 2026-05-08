/**
 * CoachAI Subscription Backend — Square Payments
 * ─────────────────────────────────────────────────
 * Routes:
 *   POST /subscribe          → Create Square customer + card on file + subscription → email key
 *   POST /webhook            → Square webhook events (renewal, cancel, failure)
 *   POST /validate-key       → App validates license key on activation
 *   GET  /status/:key        → App verifies key still active on launch
 *   POST /admin/revoke/:key  → Manually revoke (protected by ADMIN_SECRET)
 *   GET  /admin/licenses     → View all licenses
 *   GET  /health             → Render health check
 *
 * Storage: licenses.json flat file (swap for Postgres/Supabase in production)
 */

require('dotenv').config();
const express    = require('express');
const { Client, Environment, ApiError } = require('square');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const { v4: uuid } = require('uuid');
const fs         = require('fs');
const path       = require('path');
const cors       = require('cors');

// ─── Square client ────────────────────────────────────────────────────────────
const squareClient = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: process.env.SQUARE_ENVIRONMENT === 'production'
    ? Environment.Production
    : Environment.Sandbox,
});

// ─── Database (flat-file JSON) ────────────────────────────────────────────────
// { [licenseKey]: LicenseRecord }
// LicenseRecord: {
//   email, squareCustomerId, squareSubscriptionId, squareCardId,
//   status: 'active' | 'past_due' | 'cancelled',
//   createdAt, cancelledAt?,
//   deviceIds: string[]   (max 3 per key)
// }
const DB_PATH = path.join(__dirname, 'licenses.json');
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return {}; }
}
function saveDB(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }

// reverse lookup: squareSubscriptionId → licenseKey
function findBySubscriptionId(db, subId) {
  return Object.entries(db).find(([, v]) => v.squareSubscriptionId === subId);
}
function findByCustomerId(db, custId) {
  return Object.entries(db).find(([, v]) => v.squareCustomerId === custId);
}

// ─── Key generator ────────────────────────────────────────────────────────────
function genKey() {
  const seg = () => Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4).padEnd(4,'X');
  return `DC-PRO-${seg()}-${seg()}`;
}

// ─── Email sender ─────────────────────────────────────────────────────────────
function makeTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendKeyEmail(email, key) {
  if (!process.env.SMTP_HOST) { console.log('⚠️  No SMTP config — key:', key); return; }
  const transport = makeTransport();
  await transport.sendMail({
    from: process.env.EMAIL_FROM || 'CoachAI <noreply@coachai.app>',
    to: email,
    subject: '🏆 Your CoachAI Pro License Key',
    html: `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#0a0c10;color:#e8eaf2;border-radius:12px;overflow:hidden">
      <div style="background:linear-gradient(135deg,#f5a623,#d4700a);padding:28px 32px;text-align:center">
        <div style="font-size:32px">⛳🏀🏈⚾🏒</div>
        <h1 style="margin:12px 0 4px;font-size:24px;color:#0a0c10">Welcome to CoachAI Pro!</h1>
        <p style="margin:0;font-size:14px;color:rgba(10,12,16,0.8)">Your license key is ready</p>
      </div>
      <div style="padding:32px">
        <p>Thanks for subscribing! Here's your Pro license key:</p>
        <div style="background:#13161e;border:2px solid #f5a623;border-radius:10px;padding:20px;text-align:center;margin:20px 0">
          <div style="font-size:11px;letter-spacing:0.15em;color:#8b93aa;text-transform:uppercase;margin-bottom:8px">License Key</div>
          <div style="font-size:26px;font-weight:800;letter-spacing:0.12em;color:#f5a623;font-family:monospace">${key}</div>
        </div>
        <p style="font-size:14px;color:#8b93aa"><strong style="color:#e8eaf2">How to activate:</strong></p>
        <ol style="font-size:14px;color:#8b93aa;line-height:2">
          <li>Open the <strong style="color:#e8eaf2">CoachAI app</strong></li>
          <li>Tap your <strong style="color:#e8eaf2">API key icon</strong> (top right)</li>
          <li>Select <strong style="color:#e8eaf2">CoachAI Pro</strong> tab</li>
          <li>Paste the key above and tap <strong style="color:#e8eaf2">Activate</strong></li>
        </ol>
        <p style="font-size:13px;color:#8b93aa">Up to 3 devices per key. Need help? Reply to this email.</p>
      </div>
      <div style="padding:16px 32px;border-top:1px solid #1e2235;text-align:center;font-size:12px;color:#4a5070">
        CoachAI · AI Sports Coaching · Unsubscribe via your Square receipt
      </div>
    </div>`,
  });
}

// ─── Square webhook signature verification ────────────────────────────────────
function verifySquareSignature(req) {
  const sigKey    = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  if (!sigKey) return true; // skip in dev
  const notifUrl  = process.env.FRONTEND_URL + '/webhook';
  const body      = req.rawBody || '';
  const sigHeader = req.headers['x-square-hmacsha256-signature'] || '';
  const hmac      = crypto.createHmac('sha256', sigKey);
  hmac.update(notifUrl + body);
  const expected  = hmac.digest('base64');
  return crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
}

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();

// Capture raw body for webhook sig verification
app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    try { req.body = JSON.parse(data); } catch { req.body = {}; }
    next();
  });
});

app.use(cors({ origin: '*' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => {
  const db = loadDB();
  res.json({ ok: true, licenses: Object.keys(db).length, provider: 'square' });
});

// ─── POST /subscribe ──────────────────────────────────────────────────────────
// Body: { sourceId, email, verificationToken? }
// sourceId = card nonce from Square Web Payments SDK
app.post('/subscribe', async (req, res) => {
  const { sourceId, email, verificationToken } = req.body;
  if (!sourceId || !email) return res.status(400).json({ error: 'sourceId and email required' });

  const db = loadDB();

  try {
    // 1. Create (or find) Square customer
    let customerId;
    try {
      const { result } = await squareClient.customersApi.createCustomer({
        idempotencyKey: uuid(),
        emailAddress: email,
        referenceId: 'coachai_' + Date.now(),
      });
      customerId = result.customer.id;
    } catch (err) {
      // If email already exists, search for them
      const { result } = await squareClient.customersApi.searchCustomers({
        query: { filter: { emailAddress: { exact: email } } }
      });
      if (result.customers?.length) {
        customerId = result.customers[0].id;
      } else throw err;
    }

    // 2. Create card on file for recurring billing
    const cardBody = {
      idempotencyKey: uuid(),
      sourceId,
      card: { customerId },
    };
    if (verificationToken) cardBody.verificationToken = verificationToken;

    const { result: cardResult } = await squareClient.cardsApi.createCard(cardBody);
    const cardId = cardResult.card.id;

    // 3. Create subscription
    const { result: subResult } = await squareClient.subscriptionsApi.createSubscription({
      idempotencyKey: uuid(),
      locationId: process.env.SQUARE_LOCATION_ID,
      planVariationId: process.env.SQUARE_PLAN_VARIATION_ID,
      customerId,
      cardId,
      startDate: new Date().toISOString().split('T')[0],
    });
    const subscriptionId = subResult.subscription.id;

    // 4. Generate license key and save
    const key = genKey();
    db[key] = {
      email,
      squareCustomerId: customerId,
      squareSubscriptionId: subscriptionId,
      squareCardId: cardId,
      status: 'active',
      createdAt: new Date().toISOString(),
      deviceIds: [],
    };
    saveDB(db);

    // 5. Send key email
    await sendKeyEmail(email, key);

    res.json({ ok: true, message: 'Subscription created. Check your email for your license key.' });
  } catch (err) {
    console.error('Subscribe error:', err);
    const msg = err instanceof ApiError
      ? err.errors?.[0]?.detail || 'Square API error'
      : err.message;
    res.status(500).json({ error: msg });
  }
});

// ─── POST /webhook ────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // Verify Square signature
  if (!verifySquareSignature(req)) {
    console.warn('⚠️  Invalid webhook signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = req.body;
  const db    = loadDB();
  console.log('Square webhook:', event.type, event.data?.object?.subscription?.id || '');

  try {
    switch (event.type) {
      case 'subscription.updated': {
        const sub   = event.data?.object?.subscription;
        if (!sub) break;
        const entry = findBySubscriptionId(db, sub.id);
        if (!entry) break;
        const [key, rec] = entry;
        const newStatus = sub.status === 'ACTIVE'    ? 'active'
                        : sub.status === 'CANCELED'  ? 'cancelled'
                        : sub.status === 'PAUSED'    ? 'paused'
                        : rec.status;
        if (newStatus !== rec.status) {
          db[key].status = newStatus;
          if (newStatus === 'cancelled') db[key].cancelledAt = new Date().toISOString();
          saveDB(db);
          console.log(`Key ${key} → ${newStatus}`);
        }
        break;
      }

      case 'invoice.payment_made': {
        const invoice = event.data?.object?.invoice;
        const subId   = invoice?.subscriptionId;
        if (!subId) break;
        const entry   = findBySubscriptionId(db, subId);
        if (!entry) break;
        const [key] = entry;
        db[key].status    = 'active';
        db[key].renewedAt = new Date().toISOString();
        saveDB(db);
        console.log(`Key ${key} renewed`);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data?.object?.invoice;
        const subId   = invoice?.subscriptionId;
        if (!subId) break;
        const entry   = findBySubscriptionId(db, subId);
        if (!entry) break;
        const [key] = entry;
        db[key].status = 'past_due';
        saveDB(db);
        console.log(`Key ${key} past_due`);
        break;
      }
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
  }

  res.json({ ok: true });
});

// ─── POST /validate-key ───────────────────────────────────────────────────────
// App calls this on Pro activation and on background launch verify
app.post('/validate-key', (req, res) => {
  const { key, deviceId } = req.body;
  if (!key) return res.status(400).json({ valid: false, error: 'key required' });

  const db  = loadDB();
  const rec = db[key];
  if (!rec) return res.json({ valid: false, error: 'Key not found' });
  if (rec.status === 'cancelled') return res.json({ valid: false, error: 'Subscription cancelled' });
  if (rec.status === 'past_due')  return res.json({ valid: false, error: 'Payment failed — please update billing' });

  // Device limit (max 3)
  const MAX_DEVICES = 3;
  if (deviceId && !rec.deviceIds.includes(deviceId)) {
    if (rec.deviceIds.length >= MAX_DEVICES) {
      return res.json({ valid: false, error: `Device limit reached (${MAX_DEVICES} max). Contact support to reset.` });
    }
    rec.deviceIds.push(deviceId);
    db[key] = rec;
    saveDB(db);
  }

  res.json({ valid: true, status: rec.status, email: rec.email });
});

// ─── GET /status/:key ─────────────────────────────────────────────────────────
app.get('/status/:key', (req, res) => {
  const db  = loadDB();
  const rec = db[req.params.key];
  if (!rec) return res.json({ valid: false });
  res.json({ valid: rec.status === 'active', status: rec.status });
});

// ─── POST /admin/revoke/:key ──────────────────────────────────────────────────
app.post('/admin/revoke/:key', (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const db  = loadDB();
  const rec = db[req.params.key];
  if (!rec) return res.status(404).json({ error: 'Key not found' });
  db[req.params.key].status = 'cancelled';
  db[req.params.key].cancelledAt = new Date().toISOString();
  saveDB(db);
  res.json({ ok: true, key: req.params.key });
});

// ─── GET /admin/licenses ──────────────────────────────────────────────────────
app.get('/admin/licenses', (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const db = loadDB();
  res.json(db);
});

// ─── POST /admin/resend-key ───────────────────────────────────────────────────
app.post('/admin/resend-key', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { key } = req.body;
  const db = loadDB();
  const rec = db[key];
  if (!rec) return res.status(404).json({ error: 'Key not found' });
  await sendKeyEmail(rec.email, key);
  res.json({ ok: true, sentTo: rec.email });
});

// ─── Sync Storage ─────────────────────────────────────────────────────────────
// Stores player/analysis/drill data per Pro key
// File: sync_data/{keyHash}.json
// Format: { players:[], analyses:[], drills:[], updatedAt }
const SYNC_DIR = path.join(__dirname, 'sync_data');
if (!fs.existsSync(SYNC_DIR)) fs.mkdirSync(SYNC_DIR, { recursive: true });

function syncPath(key) {
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
  return path.join(SYNC_DIR, `${hash}.json`);
}
function loadSync(key) {
  try { return JSON.parse(fs.readFileSync(syncPath(key), 'utf8')); }
  catch { return { players: [], analyses: [], drills: [], updatedAt: null }; }
}
function saveSync(key, data) {
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(syncPath(key), JSON.stringify(data));
}

// Merge arrays by id — latest updatedAt wins per record
function mergeById(existing, incoming) {
  const map = new Map();
  for (const item of existing) map.set(item.id, item);
  for (const item of incoming) {
    const ex = map.get(item.id);
    if (!ex) { map.set(item.id, item); continue; }
    const exTime = new Date(ex.updatedAt || ex.createdAt || 0).getTime();
    const inTime = new Date(item.updatedAt || item.createdAt || 0).getTime();
    if (inTime >= exTime) map.set(item.id, item);
  }
  return Array.from(map.values());
}

// Validate the key is real and active (allows owner keys too)
function isValidProKey(key) {
  const OWNER_KEYS = ['DC-PRO-ADMN-0001', 'DC-PRO-ADMN-0002', 'DC-PRO-ADMN-0003'];
  if (OWNER_KEYS.includes(key)) return true;
  const db  = loadDB();
  const rec = db[key];
  return rec && (rec.status === 'active' || rec.status === 'past_due');
}

// ─── POST /sync/push ──────────────────────────────────────────────────────────
// Body: { key, players[], analyses[], drills[] }
app.post('/sync/push', (req, res) => {
  const { key, players = [], analyses = [], drills = [] } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  if (!isValidProKey(key)) return res.status(403).json({ error: 'Invalid or inactive Pro key' });

  const existing = loadSync(key);
  const merged = {
    players:  mergeById(existing.players,  players),
    analyses: mergeById(existing.analyses, analyses),
    drills:   mergeById(existing.drills,   drills),
  };
  saveSync(key, merged);
  res.json({ ok: true, counts: { players: merged.players.length, analyses: merged.analyses.length, drills: merged.drills.length } });
});

// ─── GET /sync/pull ───────────────────────────────────────────────────────────
// Query: ?key=DC-PRO-...
app.get('/sync/pull', (req, res) => {
  const key = req.query.key || req.headers['x-pro-key'];
  if (!key) return res.status(400).json({ error: 'key required' });
  if (!isValidProKey(key)) return res.status(403).json({ error: 'Invalid or inactive Pro key' });

  const data = loadSync(key);
  res.json({ ok: true, ...data });
});

// ─── GET /portal/data ─────────────────────────────────────────────────────────
// Same as pull but returns HTML-portal-friendly JSON (via query param for browser)
app.get('/portal/data', (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: 'key required' });
  if (!isValidProKey(key)) return res.status(403).json({ error: 'Invalid or inactive Pro key' });

  const data = loadSync(key);
  const db   = loadDB();
  const rec  = db[key];
  res.json({
    ok: true,
    license: rec ? { email: rec.email, status: rec.status, createdAt: rec.createdAt } : { status: 'owner' },
    ...data,
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CoachAI backend running on port ${PORT}`));
