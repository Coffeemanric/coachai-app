# CoachAI — iOS App Store Build Guide

> ⚠️  iOS builds require macOS + Xcode. You CANNOT build for iOS on Windows.
> Options: physical Mac, MacBook, or cloud Mac (see Step 0).

---

## Step 0 — Get a Mac build environment

**Option A: Cloud Mac (no Mac needed)**
- **Codemagic** (https://codemagic.io) — 500 free build minutes/month
  - Connects to your GitHub repo, builds + signs automatically
  - Best option if you don't own a Mac
- **GitHub Actions** with `macos-latest` runner (2,000 free minutes/month for public repos)

**Option B: Borrow / rent a Mac**
- MacStadium cloud Mac from $49/month
- Any modern Mac (M1/M2/M3 preferred, Intel works)

---

## Step 1 — Prerequisites (one-time, on Mac)

```bash
# Install Xcode from Mac App Store (free, ~10 GB)
# Then install command-line tools:
xcode-select --install

# Install Node if not installed
brew install node

# Install CocoaPods (iOS dependency manager)
sudo gem install cocoapods
```

---

## Step 2 — Add the iOS platform

On your Mac, clone/copy the project, then:

```bash
cd diamond-coach-app

# Install project dependencies
npm install

# Add iOS platform (only needed once)
npx cap add ios

# Sync web assets to iOS
npx cap sync ios
```

This creates `ios/App/` — an Xcode project.

---

## Step 3 — Open in Xcode

```bash
npx cap open ios
```

Xcode opens automatically with `App.xcworkspace`.

---

## Step 4 — Configure signing in Xcode

1. In Xcode, click the **App** project in the left sidebar
2. Select the **App** target → **Signing & Capabilities**
3. Check **Automatically manage signing**
4. Team: Select your Apple Developer account
   - If you don't have one: enroll at https://developer.apple.com ($99/year)
5. Bundle Identifier: `com.diamondcoach.app` (already set in capacitor.config.json)

---

## Step 5 — App Store assets to prepare

### Icons
Generate all required sizes from a single 1024×1024 PNG:
- Use https://appicon.co — upload your icon, download the iOS set
- Drop the `AppIcon.appiconset` folder into Xcode → `App/Assets.xcassets/`

### Launch Screen
Already handled by Capacitor (SplashScreen plugin). Customize in:
`ios/App/App/Assets.xcassets/Splash.imageset/`

### Screenshots (required for App Store submission)
Take screenshots on these simulators in Xcode:
- iPhone 6.9" (iPhone 16 Pro Max)
- iPhone 6.7" (iPhone 15 Plus)
- iPhone 6.5" (iPhone 14 Plus)  ← required
- iPhone 5.5" (iPhone 8 Plus)   ← required

---

## Step 6 — App Store Connect setup (one-time)

1. Go to https://appstoreconnect.apple.com
2. **My Apps** → **+** → New App
3. Fill in:
   - **Name**: CoachAI — Multi-Sport Coach
   - **Bundle ID**: com.diamondcoach.app
   - **SKU**: coachai-001
   - **Primary language**: English
4. App Information:
   - **Category**: Sports
   - **Age Rating**: 4+ (no objectionable content)
   - **Privacy Policy URL**: https://diamondcoach.app/privacy
5. Add screenshots + description (see below)

### App description (copy-paste ready)
```
CoachAI is an AI-powered sports coaching app for Baseball, Hockey, Basketball, and Football.

Upload a video or describe your technique, and get instant AI-graded analysis with step-by-step correction plans — just like having a professional coach in your pocket.

FEATURES
• AI video analysis with letter grades (A–D) for every technique area
• Step-by-step correction drills with animated technique guides
• Coach Chat — ask your AI coach anything, get specific actionable advice
• Player Profiles — track multiple athletes with their own history
• Analysis History — see grade trends over time with improvement tracking
• Drill Logger — log every practice session and track reps
• Positions diagram — tap any position for coaching tips

SPORTS SUPPORTED
⚾ Baseball: Hitting, Catching, Throwing, Baserunning, Fielding
🏒 Hockey: Skating, Shooting, Stickhandling, Goaltending, Defense
🏀 Basketball: Shooting, Ball Handling, Defense, Post Play, Passing
🏈 Football: QB, Receiving, O-Line, Defense, Running Back

FREE TIER
Connect your own AI API key (Claude, GPT-4o, or Gemini) to use all baseball features with up to 5 analyses per day.

COACHAI PRO ($9.99/month)
Unlock all 4 sports, unlimited analyses, unlimited coaching, and the built-in DiamondCoach AI — no API key needed.
```

---

## Step 7 — Build and archive for App Store

In Xcode:
1. Set scheme to **Any iOS Device (arm64)**
2. **Product** → **Archive**
3. Wait for archive to complete (2–5 minutes)
4. **Distribute App** → **App Store Connect** → **Upload**

Or via command line:
```bash
xcodebuild -workspace ios/App/App.xcworkspace \
           -scheme App \
           -configuration Release \
           -archivePath build/CoachAI.xcarchive \
           archive

xcodebuild -exportArchive \
           -archivePath build/CoachAI.xcarchive \
           -exportPath build/CoachAI.ipa \
           -exportOptionsPlist ios/ExportOptions.plist
```

---

## Step 8 — Submit for review

1. In App Store Connect → your app → **Add for Review**
2. Select the build you uploaded
3. Answer export compliance (No encryption beyond HTTPS = No)
4. Submit

**Review time**: Usually 24–48 hours for new apps.

---

## Step 9 — Update flow (after initial release)

```bash
# Make changes to www/index.html
npx cap sync ios
# Open Xcode, bump version/build number, Archive, Upload
```

---

## iOS-specific notes for this app

### WKWebView restrictions (already handled)
- `alert()` / `confirm()` → replaced with `showToast()` / `showConfirm()` ✅
- HTTP traffic blocked → all API calls use HTTPS ✅
- CORS on native → `CapacitorHttp` plugin used ✅

### Privacy manifest (required iOS 17+)
Xcode will prompt you — the app uses:
- **NSUserDefaults** (localStorage): select "App Functionality"
- No camera, microphone, or location access required

### In-App Purchases (Apple's rule)
Apple requires that subscriptions sold *within* an iOS app use Apple's IAP (30% fee).
The current implementation uses a **web-based checkout** (Stripe) — to comply:
- Make the subscribe button open Safari to `diamondcoach.app/subscribe`
- Users pay on the web, enter their key in the app
- This is allowed because no purchase happens inside the app itself
- Do NOT mention the price inside the app (Apple guidelines §3.1.1)

The `subscribePro()` function already opens an external URL — this is compliant. ✅

---

## Codemagic automated builds (no Mac required)

1. Push code to GitHub
2. Sign up at https://codemagic.io
3. New project → Select your repo → iOS workflow
4. Add your Apple Developer credentials in Codemagic settings
5. Every push builds + uploads to TestFlight automatically

`codemagic.yaml` starter:
```yaml
workflows:
  ios-release:
    name: iOS Release
    environment:
      xcode: latest
      node: 20
    scripts:
      - npm install
      - npx cap sync ios
      - xcode-project use-profiles
      - xcode-project build-ipa
    artifacts:
      - build/ios/ipa/*.ipa
    publishing:
      app_store_connect:
        api_key: $APP_STORE_CONNECT_PRIVATE_KEY
        key_id: $APP_STORE_CONNECT_KEY_IDENTIFIER
        issuer_id: $APP_STORE_CONNECT_ISSUER_ID
        submit_to_testflight: true
```
