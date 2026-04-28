# CoachAI Backend — Deployment Guide

## Architecture
```
User pays on diamondcoach.app  →  Stripe  →  Webhook hits this server
                                           →  License key generated + emailed
App taps Activate              →  POST /validate-key  →  Pro unlocked
App launches                   →  GET /status/:key    →  Still active?
```

---

## Step 1 — Deploy to Render (free tier)

1. Push this `backend/` folder to a GitHub repo (or use the whole project repo)
2. Go to https://render.com → New → Web Service
3. Connect your GitHub repo
4. Settings:
   - **Root directory**: `backend`
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - **Instance type**: Free (or Starter for always-on)
5. Add environment variables (see Step 3)
6. Deploy → copy your URL e.g. `https://coachai-backend.onrender.com`

> ⚠️ Free tier sleeps after 15 min inactivity. Use a cron ping service
> (e.g. https://cron-job.org) to hit `/health` every 10 minutes to keep it awake.
> Or upgrade to Starter ($7/mo) for always-on.

---

## Step 2 — Stripe setup

1. Go to https://dashboard.stripe.com
2. Create a **Product**: CoachAI Pro
   - Price: $9.99 / month (recurring)
   - Copy the **Price ID**: `price_xxx...`
3. Go to Developers → API Keys
   - Copy **Secret key**: `sk_live_xxx...`
4. Go to Developers → Webhooks → Add endpoint
   - URL: `https://your-render-url.onrender.com/webhook`
   - Events to listen for:
     - `checkout.session.completed`
     - `invoice.paid`
     - `invoice.payment_failed`
     - `customer.subscription.deleted`
   - Copy the **Signing secret**: `whsec_xxx...`

---

## Step 3 — Environment variables on Render

Set these in Render → Your service → Environment:

```
STRIPE_SECRET_KEY      = sk_live_...
STRIPE_WEBHOOK_SECRET  = whsec_...
STRIPE_PRICE_ID        = price_...
FRONTEND_URL           = https://your-render-url.onrender.com
SMTP_HOST              = smtp.gmail.com
SMTP_PORT              = 587
SMTP_USER              = your@gmail.com
SMTP_PASS              = your-gmail-app-password
EMAIL_FROM             = CoachAI <noreply@diamondcoach.app>
ADMIN_SECRET           = pick-a-random-secret-string
NODE_ENV               = production
```

### Gmail app password
Gmail → Account → Security → 2-Step Verification (enable) → App Passwords → Create one for "Mail"

---

## Step 4 — Custom domain (optional)

In Render → Custom Domains → add `api.diamondcoach.app`
Then in your DNS provider (Cloudflare, etc.) add a CNAME record:
```
api.diamondcoach.app  →  coachai-backend.onrender.com
```

---

## Step 5 — Update the app with your backend URL

In `www/index.html`, find:
```javascript
const BACKEND_URL = 'https://api.diamondcoach.app';
```
Change it to your Render URL if not using a custom domain.

---

## Step 6 — Test end-to-end

1. Use Stripe **test mode** first (keys start with `sk_test_`)
2. Use test card: `4242 4242 4242 4242` expiry `12/34` CVV `123`
3. Subscribe on your page → check email arrives → enter key in app → confirm Pro unlocks
4. Switch to live keys when ready

---

## Admin endpoints

List all licenses:
```
curl -H "x-admin-secret: YOUR_ADMIN_SECRET" https://your-url/admin/licenses
```

Revoke a key:
```
curl -X POST -H "x-admin-secret: YOUR_ADMIN_SECRET" https://your-url/admin/revoke/DC-PRO-XXXX-XXXX
```

---

## Upgrading storage to PostgreSQL (recommended for scale)

Replace the `db` object and `loadDB/saveDB` functions in `server.js` with Supabase:

```bash
npm install @supabase/supabase-js
```

```javascript
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Replace: db[key] = {...}  with:
await supabase.from('licenses').insert({ key, email, status: 'active', ... });

// Replace: const license = db[key]  with:
const { data } = await supabase.from('licenses').select('*').eq('key', key).single();
```

Supabase free tier: 500MB storage, 2GB bandwidth — plenty for thousands of users.
