// Public storefront. Resolves a slug to a shop, then renders its products live.
//
// Everything here builds DOM nodes and assigns .textContent rather than
// interpolating into .innerHTML. Shop and product text is written by whoever
// owns the shop and rendered to strangers, so a product literally named
// `<img onerror=...>` has to stay inert.

import {
  shopIdForSlug,
  shopIdForDomain,
  watchShop,
  watchPublishedProducts,
} from "./db-shop.js";
import {
  mediaPlaceholder,
  mediaElement,
  coverMedia,
  isVideoMedia,
  observeAutoplayVideos,
  applyAccent,
  money,
  priceRow,
  isInStock,
  isQuoteOnly,
  QUOTE_LABEL,
} from "./ui.js";

const $ = (id) => document.getElementById(id);
const grid = $("grid");
const stateEl = $("state");

/** Supports both the pretty route (/s/hassan-toys) and the raw ?s= query. */
function currentSlug() {
  const q = new URLSearchParams(location.search).get("s");
  if (q) return q.trim().toLowerCase();
  const m = location.pathname.match(/^\/s\/([^/]+)/);
  return m ? decodeURIComponent(m[1]).toLowerCase() : "";
}

function setState(message) {
  stateEl.textContent = message || "";
  stateEl.hidden = !message;
}

/** Show an element only when it has content — avoids empty gaps in the hero. */
function setText(el, text) {
  el.textContent = text || "";
  el.hidden = !text;
}

/**
 * Admin paste often jams bullets and section labels onto one line. Split those
 * onto their own lines so white-space: pre-wrap can show a readable list.
 * Still returns plain text — callers must assign via textContent.
 */
function normalizeDescription(text) {
  if (!text) return "";
  let t = String(text).replace(/\r\n/g, "\n");
  // "* foo * bar" → each bullet on its own line (skip ones already lined up)
  t = t.replace(/([^\n])\s+\*\s+/g, "$1\n* ");
  t = t.replace(/([^\n])\s*(Short\s*Description\s*:)/gi, "$1\n\n$2");
  return t.trim();
}

// ------------------------------------------------------- filters & paging

const PAGE_SIZE = 12;

/** Selected category, or "" for all. Read from the URL so a filtered view is
 *  shareable and the browser Back button behaves as customers expect. */
let activeCategory = new URLSearchParams(location.search).get("c") || "";
let searchTerm = (new URLSearchParams(location.search).get("q") || "").trim();
let visibleCount = PAGE_SIZE;

/**
 * Match a product against the search box.
 *
 * Every term must appear somewhere in the product, but not necessarily in the
 * same field — so "wooden 30" finds a wooden item priced 3000, and word order
 * doesn't matter. Substring rather than whole-word, because shoppers type
 * fragments ("stor" for storage).
 */
function matchesSearch(product) {
  if (!searchTerm) return true;
  const haystack = [
    product.name,
    product.description,
    product.category,
    product.price,
  ]
    .filter((v) => v != null && v !== "")
    .join(" ")
    .toLowerCase();
  return searchTerm
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

function setSearch(term) {
  searchTerm = term.trim();
  visibleCount = PAGE_SIZE; // new result set — never leave the user on page 3
  const url = new URL(location.href);
  if (searchTerm) url.searchParams.set("q", searchTerm);
  else url.searchParams.delete("q");
  history.replaceState(null, "", url);
}

function categoryOf(product) {
  return (product.category || "").trim();
}

/**
 * Categories are free text, so "Toys" and "toys" would otherwise become two
 * chips. Group case-insensitively but display the first spelling encountered.
 */
function categoriesFrom(products) {
  const seen = new Map();
  for (const p of products) {
    const label = categoryOf(p);
    if (!label) continue;
    const key = label.toLowerCase();
    if (!seen.has(key)) seen.set(key, { label, count: 0 });
    seen.get(key).count += 1;
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function matchesFilter(product) {
  if (!activeCategory) return true;
  return categoryOf(product).toLowerCase() === activeCategory.toLowerCase();
}

function selectCategory(label) {
  activeCategory = label;
  visibleCount = PAGE_SIZE; // a new filter is a new list — never page 3 of it
  const url = new URL(location.href);
  if (label) url.searchParams.set("c", label);
  else url.searchParams.delete("c");
  history.replaceState(null, "", url);
}

function chip(label, count, isActive, onClick) {
  const btn = document.createElement("button");
  btn.className = "chip";
  btn.type = "button";
  btn.setAttribute("aria-pressed", String(isActive));
  btn.textContent = label;
  if (count != null) {
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = count;
    btn.appendChild(n);
  }
  btn.addEventListener("click", onClick);
  return btn;
}

function hasModel(p) {
  return Boolean(p.modelGlbUrl || p.modelUsdzUrl);
}

/**
 * Fetch the <model-viewer> definition the first time a product actually needs
 * it. Most shops have no 3D models, and this is ~300KB — loading it from the
 * document head made every shopper pay for a feature their shop may not use.
 * Elements already in the DOM upgrade themselves once the definition lands.
 */
let modelViewerLoader = null;
function ensureModelViewer() {
  modelViewerLoader ??= import(
    "https://cdn.jsdelivr.net/npm/@google/model-viewer@4.3.1/dist/model-viewer.min.js"
  ).catch((err) => {
    // A CDN failure must not take the storefront down: the poster image is
    // already in place, so the product still shows, just without 3D.
    console.error("model-viewer failed to load", err);
  });
  return modelViewerLoader;
}

/** AR Quick Look is a Safari/iOS feature; feature-detect rather than sniff. */
function supportsQuickLook() {
  const a = document.createElement("a");
  return a.relList?.supports?.("ar") === true;
}

/**
 * Build the visual for a product.
 *
 * Three genuinely different cases, because the file formats aren't
 * interchangeable:
 *
 *  - GLB present   → <model-viewer> renders an interactive 3D view on every
 *                    platform, and hands the USDZ to iOS for AR when we have one.
 *  - USDZ only     → model-viewer cannot render USDZ in its viewport at all, so
 *                    the photo is shown and iOS Safari gets a native AR Quick
 *                    Look link (<a rel="ar">). Other platforms see the photo.
 *                    This is the common case for iPhone-scanned products.
 *  - Neither       → cover photo/video, or a deliberate placeholder.
 */
function buildMedia(product, alt) {
  const cover = coverMedia(product);
  const poster = cover && !cover.video ? cover.url : "";

  if (product.modelGlbUrl) {
    ensureModelViewer();
    const mv = document.createElement("model-viewer");
    mv.src = product.modelGlbUrl;
    if (product.modelUsdzUrl) mv.setAttribute("ios-src", product.modelUsdzUrl);
    if (poster) mv.poster = poster;
    mv.alt = alt;
    mv.setAttribute("ar", "");
    mv.setAttribute("ar-modes", "webxr scene-viewer quick-look");
    mv.setAttribute("camera-controls", "");
    mv.setAttribute("touch-action", "pan-y"); // keep the page scrollable on mobile
    mv.setAttribute("shadow-intensity", "1");
    mv.setAttribute("loading", "lazy");

    const btn = document.createElement("button");
    btn.className = "ar-btn";
    btn.slot = "ar-button"; // model-viewer hides this where AR is unavailable
    btn.textContent = "View in your room";
    mv.appendChild(btn);
    return mv;
  }

  if (!cover) return mediaPlaceholder();

  const el = mediaElement(cover.url, {
    path: cover.path,
    alt,
    controls: false,
  });

  if (product.modelUsdzUrl && supportsQuickLook() && !cover.video) {
    const a = document.createElement("a");
    a.rel = "ar";
    a.href = product.modelUsdzUrl;
    a.style.cssText = "display:block;width:100%;height:100%";
    // Quick Look only activates when the <a rel="ar"> contains an <img>.
    a.appendChild(el);
    const hint = document.createElement("span");
    hint.className = "ar-btn";
    hint.textContent = "View in your room";
    a.appendChild(hint);
    return a;
  }
  return el;
}

/**
 * Swipeable media gallery for the detail dialog. Grid tiles keep using
 * buildMedia() (cover only); customers need every uploaded photo/video here.
 */
function buildCarousel(items, alt) {
  const root = document.createElement("div");
  root.className = "carousel";
  root.setAttribute("role", "region");
  root.setAttribute("aria-roledescription", "carousel");
  root.setAttribute("aria-label", alt || "Product media");

  const frame = document.createElement("div");
  frame.className = "carousel-frame";

  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "carousel-nav prev";
  prev.setAttribute("aria-label", "Previous");
  prev.textContent = "‹";

  const next = document.createElement("button");
  next.type = "button";
  next.className = "carousel-nav next";
  next.setAttribute("aria-label", "Next");
  next.textContent = "›";

  const dots = document.createElement("div");
  dots.className = "carousel-dots";
  dots.setAttribute("role", "tablist");
  dots.setAttribute("aria-label", "Choose media");

  const count = document.createElement("span");
  count.className = "carousel-count";

  let index = 0;
  let active = null;

  function show(i) {
    index = ((i % items.length) + items.length) % items.length;
    const item = items[index];
    if (active?.tagName === "VIDEO") {
      active.pause();
      active.removeAttribute("src");
      active.load();
    }
    active = mediaElement(item.url, {
      path: item.path,
      alt: `${alt || "Product"} — ${index + 1} of ${items.length}`,
      controls: item.video,
    });
    if (active.tagName === "IMG") active.draggable = false;
    frame.replaceChildren(active);
    count.textContent = `${index + 1} / ${items.length}`;
    for (const [di, dot] of [...dots.children].entries()) {
      dot.setAttribute("aria-current", di === index ? "true" : "false");
    }
  }

  for (let i = 0; i < items.length; i++) {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "carousel-dot";
    dot.setAttribute(
      "aria-label",
      items[i].video ? `Video ${i + 1}` : `Photo ${i + 1}`
    );
    dot.addEventListener("click", (e) => {
      e.stopPropagation();
      show(i);
    });
    dots.appendChild(dot);
  }

  prev.addEventListener("click", (e) => {
    e.stopPropagation();
    show(index - 1);
  });
  next.addEventListener("click", (e) => {
    e.stopPropagation();
    show(index + 1);
  });

  // Horizontal swipe without fighting vertical scroll on the dialog body.
  // Ignore swipes that start on native video controls.
  let startX = 0;
  let startY = 0;
  let tracking = false;
  root.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.target.closest("video")) return;
      tracking = true;
      startX = e.clientX;
      startY = e.clientY;
    },
    { passive: true }
  );
  root.addEventListener("pointerup", (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
    show(index + (dx < 0 ? 1 : -1));
  });
  root.addEventListener("pointercancel", () => {
    tracking = false;
  });

  root.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      show(index - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      show(index + 1);
    }
  });
  root.tabIndex = 0;

  root.append(frame, prev, next, dots, count);
  show(0);
  return root;
}

/** Detail media: all photos/videos when there is no interactive GLB model. */
function buildDetailMedia(product, alt) {
  const urls = product.photoUrls || [];
  const paths = product.photoPaths || [];
  const items = urls
    .map((url, i) =>
      url
        ? {
            url,
            path: paths[i] || "",
            video: isVideoMedia(url, paths[i]),
          }
        : null
    )
    .filter(Boolean);

  if (product.modelGlbUrl) {
    return buildMedia(product, alt);
  }

  if (items.length > 1) {
    const carousel = buildCarousel(items, alt);

    if (product.modelUsdzUrl && supportsQuickLook()) {
      const still = items.find((m) => !m.video);
      if (still) {
        const a = document.createElement("a");
        a.rel = "ar";
        a.href = product.modelUsdzUrl;
        a.className = "ar-btn";
        a.textContent = "View in your room";
        // Quick Look needs an <img> descendant.
        const hidden = document.createElement("img");
        hidden.src = still.url;
        hidden.alt = "";
        hidden.hidden = true;
        a.prepend(hidden);
        carousel.appendChild(a);
      }
    }

    return carousel;
  }

  // Single video: show controls in the detail sheet (tile stays muted loop).
  if (items.length === 1 && items[0].video) {
    return mediaElement(items[0].url, {
      path: items[0].path,
      alt,
      controls: true,
    });
  }

  return buildMedia(product, alt);
}

// --------------------------------------------------- product of the week

/**
 * The featured banner.
 *
 * Which product is featured is one field on the shop document
 * (`featuredProductId`), set from a dropdown in the dashboard — so changing the
 * Product of the Week is picking a different product, never touching this
 * layout. An id that no longer resolves (product deleted, hidden, or the field
 * left empty) simply hides the section rather than leaving a broken banner at
 * the top of the shop.
 */
function featuredProduct(shop, products) {
  const id = String(shop?.featuredProductId || "").trim();
  if (!id) return null;
  return products.find((p) => p.id === id) || null;
}

function renderFeatured(shop, products) {
  const section = $("featured");
  const product = featuredProduct(shop, products);

  // While the customer is searching or browsing a category they are looking for
  // something specific; a promo for a different product on top of their results
  // is in the way. It comes back as soon as they clear the filter.
  const show = Boolean(product) && !searchTerm && !activeCategory;
  section.hidden = !show;
  if (!show) {
    section.replaceChildren();
    return;
  }

  const inStock = isInStock(product);
  const name = product.name || "Untitled";

  const media = document.createElement("div");
  media.className = "featured-media";
  const cover = coverMedia(product);
  media.appendChild(
    cover
      ? mediaElement(cover.url, { path: cover.path, alt: name, controls: false })
      : mediaPlaceholder("No photo yet")
  );

  const badge = document.createElement("span");
  badge.className = "featured-badge";
  badge.textContent = "Product of the week";

  const heading = document.createElement("h2");
  heading.className = "featured-name";
  heading.id = "featuredTitle";
  heading.textContent = name;

  const prices = priceRow(product, product.currency || shop.currency, money, {
    contactHref: quoteLink(shop, product),
  });
  prices.classList.add("featured-price");

  const cta = document.createElement("button");
  cta.type = "button";
  cta.className = "btn featured-cta";
  cta.textContent = isQuoteOnly(product) ? "View product" : "Shop now";

  const info = document.createElement("div");
  info.className = "featured-info";
  info.append(badge, heading, prices);

  if (product.description) {
    const desc = document.createElement("p");
    desc.className = "featured-desc";
    desc.textContent = product.description;
    info.appendChild(desc);
  }

  if (!inStock) {
    const sold = document.createElement("p");
    sold.className = "featured-sold";
    sold.textContent = "Sold out — currently unavailable";
    info.appendChild(sold);
  }

  info.appendChild(cta);
  section.replaceChildren(media, info);

  const open = (e) => {
    // The quotation link goes straight to WhatsApp; opening the dialog behind
    // it would leave the customer looking at a dialog when they come back.
    if (e.target.closest(".quote-link")) return;
    openDetail(product, shop);
  };
  cta.addEventListener("click", open);
  media.addEventListener("click", open);
  observeAutoplayVideos(section);
}

function tileFor(product, shop) {
  const inStock = isInStock(product);
  const tile = document.createElement("div");
  tile.className = inStock ? "tile clickable" : "tile clickable sold-out";
  tile.tabIndex = 0;
  tile.setAttribute("role", "button");
  tile.setAttribute("aria-label", `View ${product.name || "product"}`);

  const media = document.createElement("div");
  media.className = "media";
  media.appendChild(buildMedia(product, product.name || "Product"));

  if (hasModel(product)) {
    const badge = document.createElement("span");
    badge.className = "badge";
    // Don't advertise "3D" for an auto-generated flat standee — it sets the
    // wrong expectation, and a customer who spins it and finds a flat panel
    // trusts the shop less than one who was promised only room placement.
    badge.textContent = product.modelAuto ? "AR" : "3D · AR";
    media.appendChild(badge);
  }

  if (!inStock) {
    const sold = document.createElement("span");
    sold.className = "badge sold";
    sold.textContent = "Sold out";
    media.appendChild(sold);
  }

  const body = document.createElement("div");
  body.className = "body";

  const name = document.createElement("div");
  name.className = "name";
  name.textContent = product.name || "Untitled";

  body.append(
    name,
    priceRow(product, product.currency || shop.currency, money, {
      contactHref: quoteLink(shop, product),
    })
  );

  if (product.description) {
    const desc = document.createElement("div");
    desc.className = "desc";
    desc.textContent = product.description;
    body.appendChild(desc);
  }

  const cta = document.createElement("span");
  cta.className = "btn ghost small cta";
  cta.textContent = hasModel(product)
    ? product.modelAuto
      ? "View in your room"
      : "View in 3D"
    : "See details";
  body.appendChild(cta);

  tile.append(media, body);

  const open = () => openDetail(product, shop);
  tile.addEventListener("click", (e) => {
    // The AR button lives inside the card; letting its click bubble would open
    // the dialog behind the AR viewer the moment the customer taps it.
    // Same reasoning for the quotation link: it opens WhatsApp, and letting the
    // click bubble would leave the detail dialog open behind the chat.
    if (e.target.closest(".ar-btn, a[rel~='ar'], .quote-link")) return;
    open();
  });
  tile.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  });
  return tile;
}

// ----------------------------------------------------------------- socials

/**
 * Contact links under the shop name.
 *
 * Owners are stored bare (`therangoco`, not a URL) so they can type a handle,
 * a bare name or a full profile link and all three resolve. Anything that
 * already looks like a URL is passed through untouched, and only http/https is
 * accepted — a stored `javascript:` string would otherwise become a live link.
 */
function safeUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function socialLink(label, href) {
  const a = document.createElement("a");
  a.className = "social";
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = label;
  return a;
}

function renderFooter(s) {
  const logo = $("footLogo");
  logo.hidden = !s.logoUrl;
  if (s.logoUrl) logo.src = s.logoUrl;

  $("footName").textContent = s.name || "";
  setText($("footTagline"), s.tagline);
  $("footCopy").textContent = `© ${new Date().getFullYear()} ${s.name || ""}`.trim();

  // Same link set as the hero, built fresh — nodes can't live in two places.
  $("footSocials").replaceChildren(...buildSocialLinks(s));
}

function renderSocials(s) {
  $("socials").replaceChildren(...buildSocialLinks(s));
  renderFooter(s);
}

function buildSocialLinks(s) {
  const links = [];

  const ig = String(s.instagram || "").trim().replace(/^@/, "");
  if (ig) {
    links.push(
      socialLink("Instagram", safeUrl(ig) || `https://instagram.com/${encodeURIComponent(ig)}`)
    );
  }

  const fb = String(s.facebook || "").trim();
  if (fb) {
    // Owners type a page *name* ("Rango Bhai") as often as a username.
    // facebook.com/Rango%20Bhai is a 404, so anything containing a space goes
    // to Facebook search instead, which does find the page.
    const href =
      safeUrl(fb) ||
      (/\s/.test(fb)
        ? `https://www.facebook.com/search/top?q=${encodeURIComponent(fb)}`
        : `https://facebook.com/${encodeURIComponent(fb)}`);
    links.push(socialLink("Facebook", href));
  }

  const email = String(s.email || "").trim();
  // Not encodeURIComponent: it escapes the "@" to %40, which breaks mailto in
  // most clients. Only characters that genuinely can't appear in a URL are
  // stripped, and the address is validated as a single-@ token first.
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    links.push(socialLink("Email", `mailto:${email.replace(/[\s<>"]/g, "")}`));
  }

  return links;
}

// ------------------------------------------------------------ detail dialog

const detail = $("detail");
$("detailClose").addEventListener("click", () => detail.close());

// Click the backdrop to dismiss. Safe here because this dialog is read-only —
// the product editor deliberately does NOT do this, since a stray click outside
// a half-filled form would throw the owner's work away.
detail.addEventListener("click", (e) => {
  if (e.target === detail) detail.close();
});

function whatsappLink(shop, product) {
  const number = String(shop.whatsapp || "").replace(/\D/g, "");
  if (!number) return "";
  const text = isQuoteOnly(product)
    ? `Hi! Could I get a quotation for "${product.name}" from ${shop.name}?`
    : `Hi! I'm interested in "${product.name}" from ${shop.name}.`;
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

/**
 * Destination for a "DM for Quotation" line, or "" when there is nowhere to
 * send the customer — priceRow then renders it as plain text rather than a
 * link that goes nowhere. Stock is deliberately ignored: asking the price of
 * something currently unavailable is a normal enquiry.
 */
function quoteLink(shop, product) {
  return isQuoteOnly(product) ? whatsappLink(shop, product) : "";
}

function openDetail(product, shop) {
  const inStock = isInStock(product);

  const media = buildDetailMedia(product, product.name || "Product");
  $("detailMedia").replaceChildren(media);
  // If every photo/video URL failed, still show a deliberate empty state.
  if (!$("detailMedia").childElementCount) {
    $("detailMedia").appendChild(mediaPlaceholder("No photo yet"));
  }

  $("detailName").textContent = product.name || "Untitled";

  const prices = priceRow(product, product.currency || shop.currency, money, {
    contactHref: quoteLink(shop, product),
  });
  prices.classList.add("detail-price");
  $("detailPriceRow").replaceChildren(prices);

  setText($("detailStock"), inStock ? "" : "Sold out — currently unavailable");
  setText($("detailDesc"), normalizeDescription(product.description));

  // Ordering is hidden rather than disabled when out of stock: a WhatsApp
  // message about an item the shop can't supply wastes the customer's time and
  // the owner's. The product stays listed so people can still see it exists.
  const order = $("detailOrder");
  const link = inStock ? whatsappLink(shop, product) : "";
  order.hidden = !link;
  // A quoted product has no price to order at yet, so the button asks for one
  // instead of promising a checkout the shop can't honour.
  order.textContent = isQuoteOnly(product) ? QUOTE_LABEL : "Order on WhatsApp";
  if (link) order.href = link;

  detail.showModal();
  // Fresh open should start at the photo, not mid-scroll from a previous product.
  $("detail").querySelector(".dlg-body")?.scrollTo?.(0, 0);
}

// ------------------------------------------------------------------- boot

/**
 * Work out which shop this page is for.
 *
 * Two routes reach here. `/s/<slug>` on the platform domain names its shop
 * explicitly. A customer's own domain has no slug — the hostname *is* the
 * identifier — so fall back to the domain registry. `?host=` overrides the
 * lookup on localhost only, since a custom domain can't otherwise be exercised
 * in local development.
 */
const idCacheKey = (kind, key) => `arshop:id:v1:${kind}:${key}`;
const bootCacheKey = (shopId) => `arshop:boot:v1:${shopId}`;

function readJson(key) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode / quota — caching is a speedup, never required.
  }
}

async function resolveShopId() {
  const slug = currentSlug();
  if (slug) {
    const cached = sessionStorage.getItem(idCacheKey("slug", slug));
    if (cached) return { id: cached, label: `“${slug}”` };
    const id = await shopIdForSlug(slug);
    if (id) sessionStorage.setItem(idCacheKey("slug", slug), id);
    return { id, label: `“${slug}”` };
  }

  const onLocalhost = ["localhost", "127.0.0.1"].includes(location.hostname);
  const override = onLocalhost
    ? new URLSearchParams(location.search).get("host")
    : null;
  const host = override || location.hostname;

  const cached = sessionStorage.getItem(idCacheKey("host", host));
  if (cached) return { id: cached, label: host };
  const id = await shopIdForDomain(host);
  if (id) sessionStorage.setItem(idCacheKey("host", host), id);
  return { id, label: host };
}

/** Placeholder cards shown until the first product snapshot arrives. */
function showSkeletons(n = 4) {
  const cards = Array.from({ length: n }, () => {
    const t = document.createElement("div");
    t.className = "tile skeleton";
    t.setAttribute("aria-hidden", "true");
    const media = document.createElement("div");
    media.className = "media";
    const body = document.createElement("div");
    body.className = "body";
    const l1 = document.createElement("div");
    l1.className = "line";
    const l2 = document.createElement("div");
    l2.className = "line short";
    body.append(l1, l2);
    t.append(media, body);
    return t;
  });
  grid.replaceChildren(...cards);
  setState("");
}

function applyShopChrome(s) {
  if (!s) return;
  document.title = s.name || "Shop";
  $("shopName").textContent = s.name || "Shop";
  $("barName").textContent = s.name || "Shop";
  setText($("shopTagline"), s.tagline);
  setText($("about"), s.about);
  applyAccent(s.accent);

  for (const el of [$("logo"), $("barLogo")]) {
    el.hidden = !s.logoUrl;
    if (s.logoUrl) el.src = s.logoUrl;
  }

  // Use the shop's own logo as the browser-tab icon. A storefront on a
  // custom domain showing the platform's generic mark looks like someone
  // else's site; the shop's own logo makes the tab unmistakably theirs.
  if (s.logoUrl) {
    let icon = document.querySelector('link[rel="icon"]');
    if (!icon) {
      icon = document.createElement("link");
      icon.rel = "icon";
      document.head.appendChild(icon);
    }
    icon.href = s.logoUrl;
    icon.removeAttribute("type"); // it's a PNG/JPEG now, not the SVG default
  }

  // An <img> rather than a CSS background: building a `url("…")` string
  // from owner-supplied data is a CSS-injection surface, and this also
  // gets proper image decoding and error handling for free.
  const cover = $("cover");
  cover.hidden = !s.coverUrl;
  $("hero").classList.toggle("has-cover", Boolean(s.coverUrl));
  // `cover-mode` on <body> lets the top bar float over the image; the CSS
  // needs to know from an ancestor of the bar, not from the hero.
  document.body.classList.toggle("cover-mode", Boolean(s.coverUrl));
  if (s.coverUrl) $("coverImg").src = s.coverUrl;

  const number = String(s.whatsapp || "").replace(/\D/g, "");
  const contact = $("contactBtn");
  contact.hidden = !number;
  if (number) contact.href = `https://wa.me/${number}`;

  renderSocials(s);
}

async function main() {
  showSkeletons();
  const { id: shopId, label } = await resolveShopId();
  if (!shopId) {
    grid.replaceChildren();
    setState(`No shop is connected to ${label}.`);
    $("shopName").textContent = "Not found";
    return;
  }

  let shop = null;
  let products = null;

  const onStreamError = (err) => {
    console.error(err);
    setState("Couldn’t load this shop. Check your connection and refresh.");
  };

  // Paint the grid as soon as products arrive. Currency/WhatsApp fall back to
  // product fields / empty until the shop document lands — previously the grid
  // waited on both snapshots even though tiles mostly need the product list.
  const shopForTiles = () =>
    shop || { currency: "PKR", name: "", whatsapp: "", published: true };

  const render = () => {
    if (!products) return;
    if (shop && shop.published === false) {
      grid.replaceChildren();
      $("featured").hidden = true;
      $("filters").hidden = true;
      $("loadMore").hidden = true;
      $("count").textContent = "";
      setState("This shop isn’t open yet.");
      return;
    }

    const categories = categoriesFrom(products);

    // A filter that no longer matches anything — the owner renamed or removed
    // the category while someone had it open — would otherwise show a
    // permanently empty grid with no obvious way back.
    if (
      activeCategory &&
      !categories.some((c) => c.label.toLowerCase() === activeCategory.toLowerCase())
    ) {
      selectCategory("");
    }

    // One category isn't a choice; chips would just be noise.
    const showChips = categories.length > 1;
    $("filters").hidden = !showChips;
    if (showChips) {
      $("filters").replaceChildren(
        chip("All", products.length, !activeCategory, () => {
          selectCategory("");
          render();
        }),
        ...categories.map((c) =>
          chip(
            c.label,
            c.count,
            activeCategory.toLowerCase() === c.label.toLowerCase(),
            () => {
              selectCategory(c.label);
              render();
            }
          )
        )
      );
    }

    renderFeatured(shop, products);

    const matching = products.filter((p) => matchesFilter(p) && matchesSearch(p));
    const page = matching.slice(0, visibleCount);
    grid.replaceChildren(...page.map((p) => tileFor(p, shopForTiles())));
    observeAutoplayVideos(grid);

    $("shelfTitle").hidden = products.length === 0;
    $("count").textContent = matching.length
      ? page.length < matching.length
        ? `Showing ${page.length} of ${matching.length}`
        : `${matching.length} item${matching.length === 1 ? "" : "s"}`
      : "";

    const more = $("loadMore");
    more.hidden = page.length >= matching.length;
    more.textContent = `Load more (${matching.length - page.length} left)`;

    if (products.length === 0) setState("No products yet — check back soon.");
    else if (matching.length === 0)
      setState(
        searchTerm
          ? `Nothing matches “${searchTerm}”.`
          : "Nothing in this category yet."
      );
    else setState("");

    $("searchClear").hidden = !searchTerm;

    if (shop && products) {
      writeJson(bootCacheKey(shopId), {
        shop,
        products,
        savedAt: Date.now(),
      });
    }
  };

  // Instant paint on repeat visits, then live snapshots refresh.
  const warm = readJson(bootCacheKey(shopId));
  if (warm?.shop && Array.isArray(warm.products)) {
    shop = warm.shop;
    products = warm.products;
    applyShopChrome(shop);
    render();
  }

  $("loadMore").addEventListener("click", () => {
    visibleCount += PAGE_SIZE;
    render();
  });

  // Debounced: re-rendering the grid on every keystroke rebuilds every card,
  // including any <model-viewer>, which stutters badly on a phone.
  const searchInput = $("search");
  searchInput.value = searchTerm;
  let searchTimer;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      setSearch(searchInput.value);
      render();
    }, 180);
  });
  searchInput.addEventListener("search", () => {
    setSearch(searchInput.value);
    render();
  });
  $("searchClear").addEventListener("click", () => {
    searchInput.value = "";
    setSearch("");
    render();
    searchInput.focus();
  });

  watchShop(
    shopId,
    (s) => {
      shop = s;
      if (!s) {
        setState("This shop is no longer available.");
        return;
      }
      applyShopChrome(s);
      render();
    },
    onStreamError
  );

  watchPublishedProducts(
    shopId,
    (list) => {
      products = list;
      render();
    },
    onStreamError
  );
}

// Swap the floating bar to its solid state once the hero has scrolled past.
// Passive + rAF-throttled: this fires on every scroll frame, and doing layout
// work here would make the whole page feel heavy on a phone.
let scrollQueued = false;
addEventListener(
  "scroll",
  () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      document.body.classList.toggle("scrolled", window.scrollY > 60);
      scrollQueued = false;
    });
  },
  { passive: true }
);

main().catch((err) => {
  console.error(err);
  setState("Something went wrong loading this shop.");
});
