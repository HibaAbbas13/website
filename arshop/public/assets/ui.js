// Small shared view helpers used by both the storefront and the dashboard.

const VIDEO_EXT = /\.(mp4|webm|mov)(?:$|[?#])/i;
const VIDEO_MIME = /^video\/(mp4|webm|quicktime)$/i;
/** Client + Storage ceiling for product videos (bytes). */
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

/** Strip query/hash so Firebase download URLs still match by extension. */
function mediaPathname(value) {
  const raw = String(value || "");
  try {
    return decodeURIComponent(new URL(raw, "https://local.invalid").pathname);
  } catch {
    return raw.split("?")[0].split("#")[0];
  }
}

/** True when a Storage path or download URL points at a product video. */
export function isVideoMedia(url, path = "") {
  return VIDEO_EXT.test(mediaPathname(path)) || VIDEO_EXT.test(mediaPathname(url));
}

/** Classify a File from the product media picker. */
export function mediaKindFromFile(file) {
  const name = file?.name || "";
  const type = file?.type || "";
  if (VIDEO_MIME.test(type) || VIDEO_EXT.test(name)) return "video";
  if (type.startsWith("image/") || /\.(jpe?g|png|webp|gif)$/i.test(name)) {
    return "image";
  }
  return null;
}

export function videoContentType(filename, mime = "") {
  if (VIDEO_MIME.test(mime)) return mime;
  const ext = String(filename || "").toLowerCase().split(".").pop();
  if (ext === "webm") return "video/webm";
  if (ext === "mov") return "video/quicktime";
  return "video/mp4";
}

export function videoExtension(filename, mime = "") {
  const fromName = String(filename || "").toLowerCase().split(".").pop();
  if (fromName === "mp4" || fromName === "webm" || fromName === "mov") return fromName;
  if (mime === "video/webm") return "webm";
  if (mime === "video/quicktime") return "mov";
  return "mp4";
}

/**
 * Prefer the first still image for covers / AR posters; fall back to the first
 * media item (which may be a video) when the product has only videos.
 */
export function coverMedia(product) {
  const urls = product?.photoUrls || [];
  const paths = product?.photoPaths || [];
  for (let i = 0; i < urls.length; i++) {
    if (!urls[i] || isVideoMedia(urls[i], paths[i])) continue;
    return { url: urls[i], path: paths[i] || "", video: false, index: i };
  }
  if (urls[0]) {
    return {
      url: urls[0],
      path: paths[0] || "",
      video: isVideoMedia(urls[0], paths[0]),
      index: 0,
    };
  }
  return null;
}

/** Start muted tile videos when they enter the viewport. */
export function observeAutoplayVideos(root = document) {
  const videos = root.querySelectorAll?.("video[data-autoplay-when-visible]") || [];
  if (!videos.length) return;
  if (!("IntersectionObserver" in window)) {
    for (const v of videos) {
      v.autoplay = true;
      v.play?.().catch(() => {});
    }
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const v = entry.target;
        if (!(v instanceof HTMLVideoElement)) continue;
        if (entry.isIntersecting) {
          v.play?.().catch(() => {});
        } else {
          v.pause?.();
        }
      }
    },
    { rootMargin: "100px", threshold: 0.15 }
  );
  for (const v of videos) io.observe(v);
}

/**
 * Placeholder shown where a product image would go.
 *
 * A product with no photo previously rendered a transparent 1×1 pixel stretched
 * over a grey square, which reads as a broken image rather than an empty one.
 * Shops legitimately sit in this state — an owner adds products before
 * photographing them — so it needs to look deliberate.
 */
export function mediaPlaceholder(caption = "") {
  const wrap = document.createElement("div");
  wrap.className = "ph";

  wrap.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <circle cx="8.5" cy="8.5" r="1.6" />
      <path d="m21 15-4.6-4.6a2 2 0 0 0-2.8 0L3.5 20.5" />
    </svg>`;

  if (caption) {
    const label = document.createElement("span");
    label.textContent = caption;
    wrap.appendChild(label);
  }
  return wrap;
}

function swapBrokenMedia(el) {
  el.replaceWith(mediaPlaceholder("Photo unavailable"));
}

/** Build an <img> or <video> for a product media URL. */
export function mediaElement(url, { path = "", alt = "", controls = false } = {}) {
  if (!url) return mediaPlaceholder();

  if (isVideoMedia(url, path)) {
    const video = document.createElement("video");
    video.src = url;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.preload = "metadata";
    video.muted = !controls;
    if (controls) {
      video.controls = true;
    } else {
      // Tiles: silent loop, but only once visible — autoplaying every card on
      // first paint fights the product images for bandwidth.
      video.loop = true;
      video.setAttribute("muted", "");
      video.dataset.autoplayWhenVisible = "1";
    }
    video.setAttribute("aria-label", alt || "Product video");
    video.addEventListener("error", () => swapBrokenMedia(video), { once: true });
    return video;
  }
  const img = document.createElement("img");
  img.src = url;
  img.alt = alt || "";
  img.loading = "lazy";
  img.addEventListener("error", () => swapBrokenMedia(img), { once: true });
  return img;
}

/**
 * Format a price for display. Shared so the dashboard and the storefront can
 * never disagree — they previously differed on thousands separators
 * ("PKR 2000" vs "PKR 2,000"), which makes the tool look unfinished to the
 * person deciding whether to buy it.
 */
export function money(amount, currency) {
  if (amount == null || amount === "") return "";
  try {
    // No grouping separators — "PKR 4000", not "PKR 4,000" / locale variants.
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 0,
      useGrouping: false,
    }).format(Number(amount));
  } catch {
    // An owner can type any three letters into the currency field; an invalid
    // code must not blank out every price on the site.
    return `${currency || ""} ${amount}`.trim();
  }
}

/**
 * Percentage off, or 0 when there's no genuine discount.
 *
 * Returns 0 rather than a negative or zero percentage when `compareAt` is
 * missing, not higher than the price, or rounds to nothing — a "−0% OFF" flash
 * or a struck-through price that's *lower* than what you're charging reads as a
 * broken shop, and owners do leave stale "was" prices behind after a sale ends.
 */
export function discountPercent(price, compareAt) {
  const now = Number(price);
  const was = Number(compareAt);
  if (!Number.isFinite(now) || !Number.isFinite(was)) return 0;
  if (now <= 0 || was <= now) return 0;
  return Math.round((1 - now / was) * 100);
}

/** Absent `inStock` means in stock — products created before the field existed. */
export function isInStock(product) {
  return product.inStock !== false;
}

/**
 * Some items — the 1–2 lakh pieces — are quoted per order rather than sold at a
 * shelf price, because the cost moves between the enquiry and the sale. Showing
 * a number that is already stale is worse than showing none, so the owner can
 * mark a product `quoteOnly` and the storefront asks the customer to message
 * instead. Absent means false: every existing product keeps its price.
 */
export function isQuoteOnly(product) {
  return product?.quoteOnly === true;
}

/** One wording for every surface — card, detail sheet, banner, dashboard. */
export const QUOTE_LABEL = "DM for Quotation";

/**
 * Build the price line: current price, the struck-through original, and a
 * discount pill. Shared so the card, the detail sheet and the dashboard can't
 * drift apart on how a sale is presented.
 *
 * `contactHref` turns the quote-only line into a live link. It is optional
 * because the dashboard has nobody to message — there it stays plain text.
 */
export function priceRow(product, currency, money, { contactHref = "" } = {}) {
  const row = document.createElement("div");
  row.className = "price-row";

  // Deliberately before anything else: a quoted product shows no price, no
  // "was" and no discount pill, whatever those fields still hold. Owners flip
  // this on for an item that already had a price, and a struck-through number
  // left sitting next to "DM for Quotation" is exactly the confusion the
  // feature exists to remove.
  if (isQuoteOnly(product)) {
    const quote = document.createElement(contactHref ? "a" : "span");
    quote.className = "quote-link";
    quote.textContent = QUOTE_LABEL;
    if (contactHref) {
      quote.href = contactHref;
      quote.target = "_blank";
      quote.rel = "noopener noreferrer";
    }
    row.appendChild(quote);
    return row;
  }

  const now = document.createElement("span");
  now.className = "price";
  now.textContent = money(product.price, currency);
  row.appendChild(now);

  const off = discountPercent(product.price, product.compareAtPrice);
  if (off > 0) {
    // Keep "was + %" on one cluster so narrow 2-column cards wrap cleanly
    // under the current price instead of scattering three loose pieces.
    const deal = document.createElement("span");
    deal.className = "deal";
    const was = document.createElement("s");
    was.className = "was";
    was.textContent = money(product.compareAtPrice, currency);
    const pill = document.createElement("span");
    pill.className = "off";
    pill.textContent = `−${off}%`;
    deal.append(was, pill);
    row.appendChild(deal);
  }
  return row;
}

// --------------------------------------------------------------- theming

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Normalise `#abc` / `abc` / `#aabbcc` to `#aabbcc`, or null if unparseable. */
function normalizeHex(value) {
  const m = HEX.exec(String(value || "").trim());
  if (!m) return null;
  const h = m[1];
  return "#" + (h.length === 3 ? [...h].map((c) => c + c).join("") : h).toLowerCase();
}

// Pure black rather than a softened near-black. These two are only ever painted
// ON the accent colour (button labels, badges), never used as body text, so the
// extra harshness doesn't show — and softening the dark end to #101014 drops the
// guaranteed floor below from 4.58:1 to 4.37:1, which fails AA for some hues.
const INK_DARK = "#000000";
const INK_LIGHT = "#ffffff";

/** WCAG relative luminance of a normalised `#rrggbb`. */
function luminance(norm) {
  const channel = (i) => {
    const c = parseInt(norm.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(aLum, bLum) {
  const [hi, lo] = aLum > bLum ? [aLum, bLum] : [bLum, aLum];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Pick black or white text for a background — whichever actually contrasts more.
 *
 * This has to be computed, not hardcoded: owners choose their own accent from a
 * colour picker, and a fixed white foreground disappears the moment somebody
 * picks yellow or lime. A simple "is it light or dark" threshold isn't enough
 * either — hot pink (#ff69b4) reads as dark by luminance but only reaches 2.65:1
 * against white, below the 4.5:1 AA floor.
 *
 * Comparing both candidates and taking the better one is not just a heuristic:
 * the two contrast curves cross at L≈0.179, where both sit at 4.58:1. So the
 * winner is always at least 4.58:1 — every accent an owner can pick clears AA
 * for normal text.
 */
export function readableInk(hex) {
  const norm = normalizeHex(hex);
  if (!norm) return INK_LIGHT;
  const bg = luminance(norm);
  return contrast(bg, luminance(INK_LIGHT)) >= contrast(bg, luminance(INK_DARK))
    ? INK_LIGHT
    : INK_DARK;
}

/**
 * Apply a shop's brand colour to the whole page.
 *
 * Only two custom properties are set here — every other accent shade in the
 * stylesheet is derived from `--accent` with `color-mix()`, so one hex from the
 * settings form repaints buttons, badges, hero wash, focus rings, hover borders
 * and price highlights consistently.
 */
export function applyAccent(hex) {
  const norm = normalizeHex(hex);
  if (!norm) return;
  const root = document.documentElement;
  root.style.setProperty("--accent", norm);
  root.style.setProperty("--accent-ink", readableInk(norm));
}
