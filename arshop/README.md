# AR Storefront

A multi-tenant product website with in-browser augmented reality. Each business
signs up, picks an address, and manages products from a web dashboard — the
public site updates live.

- `/` — landing page
- `/admin` — owner dashboard (sign in, product CRUD, shop settings)
- `/s/<slug>` — a customer-facing storefront

No build step, no npm install. Plain ES modules, Firebase from CDN.

---

## Layout

```
arshop/
├── firestore.rules          ← paste into Firebase console
├── storage.rules            ← paste into Firebase console
├── cors.json                ← only needed if 3D models fail to load (see below)
├── vercel.json              ← /s/:slug routing
└── public/
    ├── index.html           landing
    ├── shop.html            public storefront
    ├── admin.html           owner dashboard
    └── assets/
        ├── firebase-config.js  ← YOU FILL THIS IN
        ├── db.js               all Firestore/Storage access
        ├── shop.js             storefront rendering + AR
        ├── admin.js            auth, CRUD, uploads
        └── app.css
```

## Data model

```
slugs/{slug}                     → { shopId, claimedAt }        public read
domains/{hostname}               → { shopId, claimedAt }        public read
shops/{shopId}                   → name, tagline, currency,     public read
                                   whatsapp, accent, logoUrl,
                                   published, ownerUid
shops/{shopId}/products/{id}     → name, description, price,    public read
                                   compareAtPrice, inStock,
                                   category, widthCm,
                                   photoUrls[], photoPaths[],
                                   modelGlbUrl/Path, modelAuto,
                                   modelUsdzUrl/Path,
                                   published, sortOrder
```

### Custom domains

A customer with their own domain gets their shop at its root — `hassantoys.pk`
rather than `…vercel.app/s/hassan-toys`. Both keep working; the shared address is
never taken away.

**How it resolves.** `domains/{hostname} → shopId` is a second lookup alongside
`slugs`. `shop.js` uses the slug when the URL has one and the hostname when it
doesn't, so a custom domain needs no slug in its URL at all. Hostnames are stored
lowercased and stripped of `www.`, protocol, port and path, so a customer who
types `HTTPS://WWW.Shop.PK/` still matches.

**Routing.** `vercel.json` decides by host, first match wins: `*.vercel.app` and
`localhost` serve `/landing`; anything else serves `/shop`. That is why the
marketing page is `landing.html` and there is no `index.html` — with one, Vercel
would serve it at `/` before any rewrite could run.

**Connecting one** takes three parties and cannot be fully self-service:

1. *Customer* — enters the domain in Settings → Custom domain. This reserves
   `domains/{hostname}` and shows them the DNS records to add.
2. *Customer* — adds those records at their registrar (`A @ 76.76.21.21`,
   `CNAME www cname.vercel-dns.com`). Propagation can take up to 24 hours.
3. *You* — add the domain to the Vercel project. This is the step no customer
   can do, so the UI ends with "tell us" rather than implying it is live:

```bash
cd arshop && npx vercel domains add hassantoys.pk
```

Verify the DNS records against `npx vercel domains inspect hassantoys.pk` — the
values above are Vercel's current defaults and Vercel is the source of truth if
they ever change.

Security is the same shape as slugs: world-readable, create-once, never
repointable or deletable from a client, and `shopId` must equal the caller's uid.
Self-claiming is harmless because a mapping does nothing until step 3.

> **Check your Vercel plan before selling this.** Hobby is for non-commercial use
> — selling storefronts is commercial, and custom domains at any volume is
> exactly the usage that gets noticed. Price a paid plan into the deal rather
> than discovering it after you have customers depending on their domains.

### Discounts and stock

`compareAtPrice` is the "was" price. When it is **higher than** `price`, the
storefront shows the current price, the old one struck through, and a `−N%` pill;
otherwise the discount is silently dropped. That guard matters because the common
failure is a *stale* sale — the price gets put back up and the old "was" is left
behind, which would otherwise render a struck-through price lower than what
you're charging. The editor states in plain words what the pair will produce
("Shows as −25%…" / "'Was' must be higher than the price"), so nobody has to
discover the rule by watching nothing happen.

`inStock` defaults to true when absent, so products created before the field
existed keep working. Out-of-stock products stay listed with a "Sold out" badge
and a dimmed image, and **the WhatsApp order button is withheld** — a message
about something the shop can't supply wastes both sides' time. Only the image
dims; name and price stay fully legible, because a customer still needs to read
what it was. To remove a product from the storefront entirely, untick "Visible
on the storefront" instead.

The discount pill uses its own `--sale` colour rather than the shop accent: the
accent is already carrying AR badges and buttons, and a discount has to read as
a discount whatever colour the owner picked.

### Categories and paging

`category` is free text rather than a managed list — there is no category admin
screen to build, explain or keep in sync. The storefront derives its filter
chips from whatever categories exist, grouped case-insensitively so "Toys" and
"toys" stay one chip, and the editor offers existing values as autocomplete so
owners reuse rather than invent near-duplicates. The active filter lives in the
URL (`?c=Storage`), so a filtered view is shareable and Back behaves normally; a
filter naming a category that no longer exists silently falls back to "All"
instead of showing a permanently empty grid.

Paging is **client-side**, 12 at a time, on both the storefront and dashboard.
Firestore cursor pagination would mean giving up the realtime listener that makes
edits appear instantly, and would need hand-built composite indexes for
category + sort — the same setup friction avoided in `watchPublishedProducts`.

The tradeoff is that the first load still reads every published product. That is
correct at shop scale and wrong somewhere north of a few hundred products per
shop; at that point move to `query(..., limit(), startAfter())`, accept the
index setup, and drop the live listener for the paged view.

`shopId` is deliberately the owner's Firebase uid. That makes every permission
check a string compare (`request.auth.uid == shopId`) instead of a billed
document lookup on every write. The tradeoff is one shop per account.

Storage mirrors it: `shops/{shopId}/products/{productId}/{photos,models}/…`

> **`published: false` hides, it does not protect.** Unpublished products are
> filtered out by the storefront's *query*, but the rules still allow anyone to
> read the products collection directly. Treat drafts as visible to anyone who
> looks, and don't park confidential pricing or unannounced products there.
> Making drafts genuinely private needs them in a separate owner-only
> subcollection.

---

## Setup

### 1. Create a Firebase project

Use a **new** project — do not reuse Monetra's (`toybiz`). This app makes
collections world-readable by design; Monetra's Firestore holds paying
customers' revenue data. Keep them in separate blast radii.

<https://console.firebase.google.com> → Add project.

### 2. Enable Email/Password auth

Authentication → Get started → Sign-in method → Email/Password → Enable.

That's all this app needs. **Authorized domains do not apply here** — Firebase's
allow-list (Authentication → Settings → Authorized domains) only gates OAuth
popup and redirect flows, i.e. `signInWithPopup` / `signInWithRedirect` for
providers like Google. `signInWithEmailAndPassword` works from any origin, so
this app signs in fine from a Vercel domain that isn't on the list.

If you later add Google or Facebook sign-in, that changes: every hostname you
serve from — the stable alias *and* any custom domain — has to be added there,
or those flows fail with `auth/unauthorized-domain`. The dashboard already
translates that error into an instruction naming the exact console screen.

### 3. Create Firestore and paste the rules

Firestore Database → Create database → **Production mode**.
Then Rules → paste all of `firestore.rules` → Publish.

### 4. Create Storage and paste the rules

Storage → Get started. Then Rules → paste all of `storage.rules` → Publish.

### 5. Paste your web config

Project settings → General → Your apps → Web app (`</>`) → register →
copy the `firebaseConfig` object into `public/assets/firebase-config.js`.

Those values are not secrets — they ship in every Firebase web app. The rules
files are what protect the data.

### 6. Run it locally

The repo runs against the **Firebase emulator suite** with no credentials at
all. `firebase-config.js` falls back to a `demo-arshop` project whenever the
config is unfilled *and* you're on localhost, and `db.js` routes any `demo-`
project id to 127.0.0.1. A `demo-` prefix can never name a real project, so
there's no configuration slip that points local testing at live data.

Once real credentials are in `firebase-config.js` they win everywhere, so append
**`?emu=1`** to force the emulator instead — the only safe way to exercise
uploads and writes without touching live shop data:

```
http://localhost:5055/admin.html?emu=1
```

The flag is ignored off localhost, so it can do nothing on the deployed site.

Requires a JDK 21+ for the Firestore and Storage emulators:

```bash
brew install openjdk@21
```

It installs keg-only, so it won't disturb your system Java or Xcode. Start it:

```bash
PATH=/opt/homebrew/opt/openjdk@21/bin:$PATH firebase emulators:start --project demo-arshop --config arshop/firebase.json
```

Site at <http://localhost:5055>, emulator UI at <http://localhost:4000>.
Sign-up needs no real email — the Auth emulator accepts anything.

Once you paste real credentials into `firebase-config.js` they win everywhere,
localhost included, and you're talking to your live project again.

### 7. Deploy

Live at **<https://monetra-web-psi.vercel.app>** (Vercel project `monetra-web`).

From inside `arshop/`:

```bash
./deploy.sh
```

From the repo root, it's `./arshop/deploy.sh`. The script `cd`s to its own
directory before doing anything, so it behaves identically either way — only
the path you use to reach it changes.

Use the script, not `vercel` directly. Vercel picks the project from the current
working directory, so running it from `public/` or `public/assets/` silently
creates a *new* project named after that folder, deploys the wrong subtree, and
leaves a stray `.vercel/` link that makes the next deploy wrong too. This
happened twice. `deploy.sh` cd's to its own directory, refuses to run if the
link has drifted from `monetra-web`, clears stray links, and smoke-tests the
routes afterwards.

`arshop/.vercel/project.json` pins this to the `monetra-web` project. Two things
that already went wrong once and are worth not repeating:

> **Never let `vercel link` attach this folder to `monetra-site`.** That is
> Monetra's live support site, and its `/privacy` page is the privacy-policy URL
> on the App Store listing. Deploying `arshop` into that project replaces the
> whole site and 404s the policy. If the interactive prompt ever asks which
> project to use, the answer is `monetra-web` — or delete `.vercel/` and re-link
> with `npx vercel link --project monetra-web`.

> **Rewrite destinations must be extension-less.** `cleanUrls: true` turns
> `/shop.html` into a 308 redirect to `/shop`, and a rewrite pointing at a
> redirect resolves to 404 — which silently breaks every storefront URL while
> the home page keeps working. `vercel.json` therefore rewrites `/s/:slug` to
> `/shop`, not `/shop.html`. Always smoke-test `/s/<anything>` after deploying.

### 8. If 3D models don't load in the browser

`<model-viewer>` fetches GLB files with XHR, which some Firebase Storage buckets
reject cross-origin until CORS is set. Symptom: AR works on iPhone (Quick Look
doesn't use XHR) but the 3D viewport is blank on desktop and Android.

```bash
gcloud storage buckets update gs://YOUR-BUCKET --cors-file=cors.json
```

Bucket name is in your Firebase config (`storageBucket`).

---

## Selling this

Each customer is a self-serve signup — you don't deploy anything per sale:

1. They open `/admin`, create an account, pick their address.
2. They add products and upload photos/models.
3. Their site is live at `yourdomain.com/s/their-name`.

One deployment, unlimited shops. If you later want to charge recurring rather
than a one-off $20, the hook is the `published` flag on the shop document —
flipping it false takes a storefront offline without touching their data.

Bear in mind at $20 one-off you're also signing up for the Firebase bill and
support requests indefinitely. Storage and bandwidth for 3D models are the costs
that actually scale with usage — a 20MB model viewed 1,000 times is 20GB of
egress. Watch that before selling in volume.

---

## Getting 3D models

This is the genuinely hard part of an AR storefront, and it's worth being blunt:
**the site is only as impressive as the models put into it.** Products without a
model still work — they display as normal photos — so a shop can launch on
photos and add models over time.

Two formats matter, and they are not interchangeable:

| Format | Used for | Without it |
| --- | --- | --- |
| `.usdz` | AR on iPhone/iPad (Quick Look) | iPhone users get no AR button |
| `.glb`  | The interactive 3D viewport everywhere, AR on Android | Product renders as a flat photo |

The dashboard accepts both and stores them separately. Upload whichever you have;
upload both for full coverage.

### Automatic AR from a photo (no scanning)

Every product with a photo **and** a `Real width (cm)` gets AR for free. On save,
`glb.js` generates a `.glb` in the browser: a flat panel carrying the photo,
sized to the real product, standing on the floor. Think cardboard standee.

- Free, instant, no server, no API key.
- Works on iPhone *and* Android — `<model-viewer>` generates the iOS USDZ from
  the GLB on the fly when `ios-src` isn't set, so one file covers both.
- Honest about what it is: these products show an **AR** badge, not **3D · AR**,
  and the button says "View in your room". A customer who is promised room
  placement and gets it trusts the shop; one promised 3D who finds a flat panel
  does not.
- Convincing for flat goods — rugs, posters, wall art, boxes, laid-out clothing.
  For solid objects it answers "how big is this?" rather than "what does the
  back look like?".
- **Upload a PNG with a transparent background** for a proper cut-out. A JPEG
  produces a rectangle including its background, which floats oddly in a room.
  Transparency is carried end to end: a PNG or WebP source stays PNG through
  downscaling, upload and texture packing, and the material is written with
  `alphaMode: MASK`. (JPEG sources stay JPEG — re-encoding them to PNG would
  quadruple the file size to store an alpha channel that is entirely opaque.)

An uploaded scan always wins: `modelAuto` marks generated files, and the
generator never overwrites a real model. Delete the photo or clear the width and
the generated file is cleaned up.

Validate the generator after any change to `glb.js`:

```bash
cd arshop/test && npm install gltf-validator && node glb-validate.mjs
```

It runs the official Khronos validator plus real-world size assertions. Worth
keeping green: a malformed GLB fails *silently* — `model-viewer` emits neither a
`load` nor an `error` event, it just shows nothing.

### Scanning a real product with an iPhone

**[Scaniverse](https://apps.apple.com/us/app/scaniverse-3d-scanner/id1541433223)**
(by Niantic) is the recommended tool. It's free, scans on-device, and — the part
that matters here — exports **both GLB and USDZ**, so one scan covers every
platform. No conversion step, no server.

1. Install Scaniverse and scan the product, walking fully around it.
2. Export the finished scan as **USDZ**, then export it again as **GLB**.
3. AirDrop or email both files to whatever device runs the dashboard.
4. In the dashboard, open the product → **3D model** → select both files.
   The uploader detects each format by extension and stores them separately.

Scanning tips that make the difference between an impressive model and a bad one:

- Bright, even, indirect light. Harsh shadows get baked into the texture permanently.
- A matte object on a contrasting surface. Glass, chrome and anything mirrored scan badly.
- Move slowly and keep the whole object in frame.
- Small objects: put them on a box at waist height so you can circle them properly.

A product with no model still works — it displays as a normal photo — so a shop
can launch on photos and add models over time.

---

## Not built yet

Known gaps, listed so they don't come as a surprise:

- **No in-app scanning.** Object Capture is an iOS-native API and cannot run in a
  browser, so scanning happens in Scaniverse and the files are uploaded by hand
  (see above). Closing this gap would mean building a companion iOS app.
- **No USDZ→GLB conversion.** Not needed with the Scaniverse workflow, which
  exports both. It matters only if an owner obtains a USDZ from somewhere else —
  they'd get AR on iPhone and a flat photo everywhere else.
- **No search-engine indexing of products.** Products render client-side from
  Firestore, so crawlers see an empty grid. Fine for a link you share directly;
  not fine if customers should find the shop via Google.
- **Slugs are permanent.** `slugs/*` is create-only in the rules, so an owner who
  picks a bad address can't change it without console access.
- **No rate limit on signups.** Firestore rules can't express one. If this gets
  abused, add App Check.
