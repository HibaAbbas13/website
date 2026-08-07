// Small shared view helpers used by both the storefront and the dashboard.

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

/**
 * Format a price for display. Shared so the dashboard and the storefront can
 * never disagree — they previously differed on thousands separators
 * ("PKR 2000" vs "PKR 2,000"), which makes the tool look unfinished to the
 * person deciding whether to buy it.
 */
export function money(amount, currency) {
  if (amount == null || amount === "") return "";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 0,
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
 * Build the price line: current price, the struck-through original, and a
 * discount pill. Shared so the card, the detail sheet and the dashboard can't
 * drift apart on how a sale is presented.
 */
export function priceRow(product, currency, money) {
  const row = document.createElement("div");
  row.className = "price-row";

  const now = document.createElement("span");
  now.className = "price";
  now.textContent = money(product.price, currency);
  row.appendChild(now);

  const off = discountPercent(product.price, product.compareAtPrice);
  if (off > 0) {
    const was = document.createElement("s");
    was.className = "was";
    was.textContent = money(product.compareAtPrice, currency);
    const pill = document.createElement("span");
    pill.className = "off";
    pill.textContent = `−${off}%`;
    row.append(was, pill);
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
