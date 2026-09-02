# Website (separate from Monetra iOS)

This folder is **not** part of the Monetra iOS app repo. It lives next to it:

```
Ios_projects/
  monetra/     ← iOS app (Firebase project: toybiz)
  website/     ← this folder
    arshop/        AR storefront (Firebase project: monetra-web)
    monetra-site/  marketing + privacy pages (static / Vercel)
```

## Firebase

Use the **same Firebase/Google account** that owns Monetra, but keep a
**separate Firebase project** (`monetra-web`) for the AR storefront. The
storefront intentionally has world-readable shop data; Monetra’s `toybiz`
project holds paying customers’ revenue data — do not merge them.

Fill web credentials in `arshop/public/assets/firebase-config.js`.

## Deploy

```bash
./arshop/deploy.sh          # AR storefront → Vercel project ar_shop
# Optional: PROD_HOST=https://therango.co ./arshop/deploy.sh
```

Vercel project: **ar_shop** (`prj_0AcYgiwKNFKwBxoGQgHLJRtgABAc`).  
If this GitHub repo is connected for auto-deploy, set **Root Directory** to `arshop` in the Vercel project settings.
