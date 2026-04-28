/**
 * CoachAI Subscription Backend
 * ─────────────────────────────
 * Handles:
 *   POST /create-checkout      → Stripe checkout session (web subscribe page)
 *   POST /webhook              → Stripe events (payment, cancellation, renewal)
 *   POST /validate-key         → App calls this to activate a license key
 *   GET  /status/:key          → App calls on every launch to verify key still active
 *   POST /admin/revoke/:key    → Manually revoke a key (protected by ADMIN_SECRET)
 *
 * Storage: licenses.json on disk (swap for Postgres/Supabase in production)
 */

require('dotenv').config();
const express   = require('express');
const stripe    = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer= require('nodemailer');
const { v4: uuid } = require('uuid');
const fs        = require('fs');
const path      = require('path');
const cors      = require('cors');

// ─── Database (flat-file JSON) ────────────────────────────────────────────────
// Structure: { [licenseKey]: LicenseRecord }
// LicenseRecord: {
//   email, stripeCustomerId, subscriptionId,
//   status: 'active'|'past_due'|'cancelled',
//   createdAt, cancelledAt?,
//   deviceIds: string[]    // max 3 devices per key
// }
const DB_PATH = path.join(__dirname, 'licenses.json');
let db = {};

function loadDB() {
  if (fs.existsSync(DB_PATH)) {
    try { db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
    catch (_) { db = {}; }
  }
}

function saveDB() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

loadDB();
console.log(`Loaded ${Object.keys(db).length} license(s) from disk.`);

// ─── Key generation ───────────────────────────────────────────────────────────
function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const seg   = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `DC-PRO-${seg(4)}-${seg(4)}`;
}

function uniqueKey() {
  let key;
  let attempts = 0;
  do {
    key = generateKey();
    if (++attempts > 100) throw new Error('Key generation exhausted');
  } while (db[key]);
  return key;
}

// ─── Email ────────────────────────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendLicenseEmail(email, key) {
  if (!process.env.SMTP_USER) {
    console.log(`[EMAIL SKIPPED] Key for ${email}: ${key}`);
    return;
  }
  await mailer.sendMail({
    from:    process.env.EMAIL_FROM || 'CoachAI <noreply@diamondcoach.app>',
    to:      email,
    subject: '⭐ Your CoachAI Pro License Key',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#f5a623">⭐ Welcome to CoachAI Pro!</h2>
        <p>Thank you for subscribing. Here is your license key:</p>
        <div style="background:#111;border:2px solid #f5a623;border-radius:10px;padding:16px 24px;text-align:center;margin:20px 0">
          <span style="font-family:monospace;font-size:22px;font-weight:bold;color:#f5a623;letter-spacing:0.1em">${key}</span>
        </div>
        <p><strong>To activate:</strong></p>
        <ol>
          <li>Open the CoachAI app</li>
          <li>Tap <strong>⬆️ Upgrade</strong> in the top right</li>
          <li>Enter your key in the <em>Already subscribed?</em> box</li>
          <li>Tap <strong>Activate</strong></li>
        </ol>
        <p style="color:#666;font-size:12px">
          Your key works on up to 3 devices. Keep this email safe — you'll need the key
          if you reinstall the app. For help: support@diamondcoach.app
        </p>
      </div>`,
  });
}

// ─── Express setup ────────────────────────────────────────────────────────────
const app = express();

// Stripe webhooks need the raw body — must come before express.json()
app.use('/webhook', express.raw({ type: 'application/json' }));

// Everything else
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── 1. Create Stripe checkout session ───────────────────────────────────────
// Called by the subscribe page (not the app)
app.post('/create-checkout', async (req, res) => {
  const { email } = req.body;
  try {
    const session = await stripe.checkout.sessions.create({
      mode:                 'subscription',
      payment_method_types: ['card'],
      customer_email:        email || undefined,
      line_items: [{
        price:    process.env.STRIPE_PRICE_ID,
        quantity: 1,
      }],
      success_url: `${process.env.FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.FRONTEND_URL}/`,
      metadata:    { app: 'coachAI' },
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── 2. Stripe webhooks ───────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`Stripe event: ${event.type}`);

  // ── New subscription paid ──────────────────────────────────────────────────
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    // Only handle subscription mode (not one-time)
    if (session.mode !== 'subscription') return res.json({ received: true });

    const key = uniqueKey();
    db[key] = {
      email:             session.customer_email || '',
      stripeCustomerId:  session.customer,
      subscriptionId:    session.subscription,
      status:            'active',
      createdAt:         new Date().toISOString(),
      deviceIds:         [],
    };
    saveDB();
    console.log(`✅ New license: ${key} → ${db[key].email}`);

    try { await sendLicenseEmail(db[key].email, key); }
    catch (e) { console.error('Email failed:', e.message); }
  }

  // ── Renewal succeeded (keep status active) ────────────────────────────────
  if (event.type === 'invoice.paid') {
    const inv = event.data.object;
    const entry = Object.entries(db).find(([, v]) => v.subscriptionId === inv.subscription);
    if (entry) {
      entry[1].status = 'active';
      saveDB();
      console.log(`🔄 Renewed: ${entry[0]}`);
    }
  }

  // ── Payment failed ────────────────────────────────────────────────────────
  if (event.type === 'invoice.payment_failed') {
    const inv = event.data.object;
    const entry = Object.entries(db).find(([, v]) => v.subscriptionId === inv.subscription);
    if (entry) {
      entry[1].status = 'past_due';
      saveDB();
      console.log(`⚠️  Past due: ${entry[0]}`);
    }
  }

  // ── Subscription cancelled / expired ──────────────────────────────────────
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const entry = Object.entries(db).find(([, v]) => v.subscriptionId === sub.id);
    if (entry) {
      entry[1].status      = 'cancelled';
      entry[1].cancelledAt = new Date().toISOString();
      saveDB();
      console.log(`❌ Cancelled: ${entry[0]}`);
    }
  }

  res.json({ received: true });
});

// ─── 3. Validate / activate a key (called by the app) ────────────────────────
app.post('/validate-key', (req, res) => {
  const { key, deviceId } = req.body || {};
  if (!key) return res.json({ valid: false, reason: 'No key provided.' });

  const license = db[key.toUpperCase().trim()];
  if (!license) return res.json({ valid: false, reason: 'Key not found. Check your confirmation email.' });

  if (license.status === 'cancelled') {
    return res.json({ valid: false, reason: 'Subscription cancelled. Resubscribe at diamondcoach.app.' });
  }
  if (license.status === 'past_due') {
    return res.json({ valid: false, reason: 'Payment failed. Update your payment method at diamondcoach.app.' });
  }

  // Device limit: max 3 simultaneous devices per key
  if (deviceId && !license.deviceIds.includes(deviceId)) {
    if (license.deviceIds.length >= 3) {
      return res.json({
        valid:  false,
        reason: 'This key is already active on 3 devices. Email support@diamondcoach.app to transfer.',
      });
    }
    license.deviceIds.push(deviceId);
    saveDB();
  }

  res.json({ valid: true, email: license.email, status: license.status });
});

// ─── 4. Status check (called by app on every launch) ─────────────────────────
app.get('/status/:key', (req, res) => {
  const license = db[req.params.key?.toUpperCase()?.trim()];
  if (!license) return res.json({ valid: false, status: 'not_found' });
  res.json({
    valid:  license.status === 'active',
    status: license.status,
    email:  license.email,
  });
});

// ─── 5. Admin: manually revoke a key ─────────────────────────────────────────
app.post('/admin/revoke/:key', (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const k = req.params.key?.toUpperCase();
  if (!db[k]) return res.status(404).json({ error: 'Key not found' });
  db[k].status = 'cancelled';
  saveDB();
  res.json({ ok: true, key: k });
});

// ─── 6. Admin: list all licenses ─────────────────────────────────────────────
app.get('/admin/licenses', (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const summary = Object.entries(db).map(([key, v]) => ({
    key,
    email:    v.email,
    status:   v.status,
    devices:  v.deviceIds.length,
    created:  v.createdAt?.split('T')[0],
  }));
  res.json({ total: summary.length, licenses: summary });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, licenses: Object.keys(db).length }));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CoachAI backend running on port ${PORT}`));
