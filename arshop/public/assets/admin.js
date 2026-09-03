// Owner dashboard: sign in, claim a shop address, manage products.
//
// Three mutually exclusive views driven by auth state:
//   signed out           → authView
//   signed in, no shop   → setupView   (claim a slug, once)
//   signed in, has shop  → adminView

import {
  auth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  getOwnShop,
  createShopWithSlug,
  watchShop,
  saveShop,
  claimDomain,
  normalizeHostname,
  watchAllProducts,
  newProductId,
  saveProduct,
  deleteProduct,
  uploadAsset,
  removeAsset,
} from "./db.js";
import {
  mediaPlaceholder,
  mediaElement,
  mediaKindFromFile,
  videoContentType,
  videoExtension,
  coverMedia,
  isVideoMedia,
  MAX_VIDEO_BYTES,
  applyAccent,
  money,
  priceRow,
  isInStock,
  isQuoteOnly,
  QUOTE_LABEL,
} from "./ui.js";
import { photoToStandeeGlb } from "./glb.js";

const $ = (id) => document.getElementById(id);
const views = { auth: $("authView"), setup: $("setupView"), admin: $("adminView") };

function show(which) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== which;
}

function friendlyAuthError(err) {
  const map = {
    "auth/invalid-email": "That email address doesn't look right.",
    "auth/invalid-credential": "Email or password is incorrect.",
    "auth/wrong-password": "Email or password is incorrect.",
    "auth/user-not-found": "No account with that email.",
    "auth/email-already-in-use": "That email already has an account — sign in instead.",
    "auth/weak-password": "Use at least 6 characters.",
    "auth/too-many-requests": "Too many attempts. Wait a minute and try again.",
    "auth/network-request-failed": "Network problem — check your connection.",
    // Firebase rejects auth from any domain not on its allow-list. The raw
    // message doesn't say where to fix it, and this fires on every deploy to a
    // new hostname, so spell it out.
    "auth/unauthorized-domain":
      `This site (${location.hostname}) isn't on the Firebase authorized ` +
      `domains list. Add it in Firebase console → Authentication → Settings → ` +
      `Authorized domains.`,
    "auth/operation-not-allowed":
      "Email/password sign-in isn't enabled for this Firebase project. " +
      "Enable it in Firebase console → Authentication → Sign-in method.",
  };
  return map[err?.code] || err?.message || "Something went wrong.";
}

// ------------------------------------------------------------------- auth

let signingUp = false;

function renderAuthMode() {
  $("authTitle").textContent = signingUp ? "Create account" : "Sign in";
  $("authSubmit").textContent = signingUp ? "Create account" : "Sign in";
  $("toggleMode").textContent = signingUp
    ? "I already have an account"
    : "Create an account";
  $("password").autocomplete = signingUp ? "new-password" : "current-password";
  $("authError").textContent = "";
}

$("toggleMode").addEventListener("click", (e) => {
  e.preventDefault();
  signingUp = !signingUp;
  renderAuthMode();
});

$("authSubmit").addEventListener("click", async () => {
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!email || !password) {
    $("authError").textContent = "Enter your email and password.";
    return;
  }
  $("authSubmit").disabled = true;
  $("authError").textContent = "";
  try {
    if (signingUp) await createUserWithEmailAndPassword(auth, email, password);
    else await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    $("authError").textContent = friendlyAuthError(err);
  } finally {
    $("authSubmit").disabled = false;
  }
});

$("password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("authSubmit").click();
});

$("resetLink").addEventListener("click", async (e) => {
  e.preventDefault();
  const email = $("email").value.trim();
  if (!email) {
    $("authError").textContent = "Type your email above first.";
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    $("authError").textContent = "Reset link sent — check your inbox.";
    $("authError").classList.add("ok");
  } catch (err) {
    $("authError").classList.remove("ok");
    $("authError").textContent = friendlyAuthError(err);
  }
});

$("signOutBtn").addEventListener("click", () => signOut(auth));

// ------------------------------------------------------------------- tabs

const TABS = {
  products: { btn: "tabBtnProducts", pane: "paneProducts" },
  settings: { btn: "tabBtnSettings", pane: "paneSettings" },
};

/**
 * Show one dashboard section.
 *
 * The choice lives in the URL hash so a reload — or the round trip through a
 * file picker on mobile, which can re-create the page — comes back to the
 * section the owner was actually working in.
 */
function showTab(name, { updateHash = true } = {}) {
  const target = TABS[name] ? name : "products";
  for (const [key, { btn, pane }] of Object.entries(TABS)) {
    const active = key === target;
    $(pane).hidden = !active;
    $(btn).setAttribute("aria-selected", String(active));
  }
  if (updateHash) history.replaceState(null, "", `#${target}`);
  // A tab is a new screen, not a scroll position.
  window.scrollTo(0, 0);
}

for (const [name, { btn }] of Object.entries(TABS)) {
  $(btn).addEventListener("click", () => showTab(name));
}
window.addEventListener("hashchange", () =>
  showTab(location.hash.slice(1), { updateHash: false })
);

// ------------------------------------------------------- shop setup (slug)

const RESERVED = new Set([
  "admin", "api", "assets", "s", "shop", "www", "app", "login",
  "signup", "index", "about", "help", "support", "static",
]);

/** Normalise anything a person types into a URL-safe slug. */
function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    // Drop apostrophes rather than let the next rule turn them into dashes —
    // otherwise "Hassan's Toys" becomes "hassan-s-toys", and slugs are permanent.
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/, ""); // the 30-char cut can leave a trailing dash
}

function slugProblem(slug) {
  if (slug.length < 3) return "Use at least 3 characters.";
  if (RESERVED.has(slug)) return "That address is reserved — pick another.";
  return null;
}

// Typing a business name pre-fills the address, but only until the owner edits
// the address themselves — after that their choice wins.
let slugTouched = false;
$("slugInput").addEventListener("input", () => {
  slugTouched = true;
  updateSlugPreview();
});
$("shopNameInput").addEventListener("input", () => {
  if (!slugTouched) $("slugInput").value = slugify($("shopNameInput").value);
  updateSlugPreview();
});

function updateSlugPreview() {
  const slug = slugify($("slugInput").value);
  $("slugPreview").textContent = slug
    ? `${location.origin}/s/${slug}`
    : "Letters, numbers and dashes.";
}

$("createShop").addEventListener("click", async () => {
  const name = $("shopNameInput").value.trim();
  const slug = slugify($("slugInput").value);
  const err = $("setupError");
  err.textContent = "";

  if (!name) {
    err.textContent = "Enter your business name.";
    return;
  }
  const problem = slugProblem(slug);
  if (problem) {
    err.textContent = problem;
    return;
  }

  $("createShop").disabled = true;
  try {
    await createShopWithSlug({
      shopId: auth.currentUser.uid,
      slug,
      name,
      ownerEmail: auth.currentUser.email || "",
    });
    await enterAdmin(auth.currentUser.uid);
  } catch (e) {
    err.textContent = e.message || "Couldn't create the shop.";
  } finally {
    $("createShop").disabled = false;
  }
});

// -------------------------------------------------------------- dashboard

let shopId = null;
let shop = null;
let unsubShop = null;
let unsubProducts = null;
let products = [];

async function enterAdmin(uid) {
  shopId = uid;
  show("admin");
  showTab(location.hash.slice(1), { updateHash: false });
  $("acctEmail").textContent = auth.currentUser?.email
    ? `Signed in as ${auth.currentUser.email}`
    : "";

  unsubShop?.();
  unsubShop = watchShop(uid, (s) => {
    if (!s) return;
    shop = s;
    $("navName").textContent = s.name || "Shop";
    $("navLink").textContent = `/s/${s.slug}`;
    $("navLink").href = `/s/${s.slug}`;
    $("navLogo").hidden = !s.logoUrl;
    if (s.logoUrl) $("navLogo").src = s.logoUrl;
    applyAccent(s.accent);
    fillSettings(s);
    // The cards carry the "Product of the week" flag, so they have to repaint
    // when that choice changes — the product documents themselves did not.
    renderProducts();
  });

  unsubProducts?.();
  unsubProducts = watchAllProducts(
    uid,
    (list) => {
      products = list;
      renderProducts();
      renderFeaturedOptions();
    },
    (e) => {
      console.error(e);
      $("adminState").hidden = false;
      $("adminState").textContent = "Couldn't load products.";
    }
  );
}

const ADMIN_PAGE_SIZE = 12;
let adminCategory = "";
let adminVisible = ADMIN_PAGE_SIZE;
let adminSearch = "";

/** Same all-terms-anywhere matching as the storefront, so results agree. */
function adminMatchesSearch(p) {
  if (!adminSearch) return true;
  const haystack = [p.name, p.description, p.category, p.price]
    .filter((v) => v != null && v !== "")
    .join(" ")
    .toLowerCase();
  return adminSearch
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => haystack.includes(t));
}

function categoryOf(p) {
  return (p.category || "").trim();
}

/** Distinct categories, grouped case-insensitively so "Toys"/"toys" is one. */
function shopCategories() {
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

function adminChip(label, count, active, onClick) {
  const btn = document.createElement("button");
  btn.className = "chip";
  btn.type = "button";
  btn.setAttribute("aria-pressed", String(active));
  btn.textContent = label;
  const n = document.createElement("span");
  n.className = "n";
  n.textContent = count;
  btn.appendChild(n);
  btn.addEventListener("click", onClick);
  return btn;
}

function renderProducts() {
  const grid = $("adminGrid");
  const categories = shopCategories();

  // Feed the editor's autocomplete, so the owner reuses an existing category
  // instead of creating a near-duplicate that splits their storefront filters.
  $("categoryList").replaceChildren(
    ...categories.map((c) => {
      const o = document.createElement("option");
      o.value = c.label;
      return o;
    })
  );

  if (adminCategory && !categories.some((c) => c.label.toLowerCase() === adminCategory.toLowerCase())) {
    adminCategory = "";
  }

  const showChips = categories.length > 1;
  $("adminFilters").hidden = !showChips;
  if (showChips) {
    $("adminFilters").replaceChildren(
      adminChip("All", products.length, !adminCategory, () => {
        adminCategory = "";
        adminVisible = ADMIN_PAGE_SIZE;
        renderProducts();
      }),
      ...categories.map((c) =>
        adminChip(
          c.label,
          c.count,
          adminCategory.toLowerCase() === c.label.toLowerCase(),
          () => {
            adminCategory = c.label;
            adminVisible = ADMIN_PAGE_SIZE;
            renderProducts();
          }
        )
      )
    );
  }

  const matching = products.filter(
    (p) =>
      (!adminCategory ||
        categoryOf(p).toLowerCase() === adminCategory.toLowerCase()) &&
      adminMatchesSearch(p)
  );
  const page = matching.slice(0, adminVisible);
  $("adminSearchClear").hidden = !adminSearch;

  grid.replaceChildren(...page.map(productCard));

  const more = $("adminLoadMore");
  more.hidden = page.length >= matching.length;
  more.textContent = `Load more (${matching.length - page.length} left)`;

  $("adminState").hidden = matching.length > 0;
  $("adminState").textContent = !products.length
    ? "No products yet. Use “Add product” to create one."
    : adminSearch
      ? `Nothing matches “${adminSearch}”.`
      : "Nothing in this category.";
}

let adminSearchTimer;
$("adminSearch").addEventListener("input", (e) => {
  clearTimeout(adminSearchTimer);
  adminSearchTimer = setTimeout(() => {
    adminSearch = e.target.value.trim();
    adminVisible = ADMIN_PAGE_SIZE;
    renderProducts();
  }, 180);
});
$("adminSearchClear").addEventListener("click", () => {
  $("adminSearch").value = "";
  adminSearch = "";
  adminVisible = ADMIN_PAGE_SIZE;
  renderProducts();
  $("adminSearch").focus();
});

$("adminLoadMore").addEventListener("click", () => {
  adminVisible += ADMIN_PAGE_SIZE;
  renderProducts();
});

function productCard(p) {
  const tile = document.createElement("div");
  tile.className = "tile";

  const media = document.createElement("div");
  media.className = "media";
  const cover = coverMedia(p);
  if (cover) {
    media.appendChild(
      mediaElement(cover.url, { path: cover.path, alt: "", controls: false })
    );
  } else {
    // The dashboard names the gap explicitly — this is the screen where the
    // owner can actually do something about it.
    media.appendChild(mediaPlaceholder("No photo yet"));
  }

  if (!p.published) {
    const badge = document.createElement("span");
    badge.className = "badge draft";
    badge.textContent = "Hidden";
    media.appendChild(badge);
  } else if (p.modelGlbUrl || p.modelUsdzUrl) {
    const badge = document.createElement("span");
    badge.className = "badge";
    // Match the storefront: a generated flat standee is "AR", not "3D".
    badge.textContent = p.modelAuto ? "AR" : "3D · AR";
    media.appendChild(badge);
  }

  // Mirrors the storefront banner, so "which one is the Product of the Week"
  // is answerable from the product list without opening Settings.
  if (shop?.featuredProductId && p.id === shop.featuredProductId) {
    const star = document.createElement("span");
    star.className = "badge featured-flag";
    star.textContent = "Product of the week";
    media.appendChild(star);
  }

  if (!isInStock(p)) {
    const sold = document.createElement("span");
    sold.className = "badge sold";
    sold.textContent = "Sold out";
    media.appendChild(sold);
    tile.classList.add("sold-out");
  }

  const body = document.createElement("div");
  body.className = "body";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = p.name || "Untitled";
  const price = priceRow(p, p.currency || shop?.currency, money);
  const edit = document.createElement("button");
  edit.className = "btn ghost small cta";
  edit.style.alignSelf = "flex-start";
  edit.textContent = "Edit";
  edit.addEventListener("click", () => openEditor(p));
  body.append(name, price, edit);

  tile.append(media, body);
  return tile;
}

// --------------------------------------------------------------- settings

// The settings form is an editing surface, not a live mirror of the document.
// Once the owner has touched it, the realtime listener must stop writing into
// it: focus alone was not enough of a guard, because on a phone the keyboard
// dismisses and blurs the field, and any later write to the shop doc then
// replaced the owner's unsaved text with the stored value — silently, which is
// exactly what "nothing got saved" looked like.
let settingsDirty = false;

function markSettingsDirty() {
  if (settingsDirty) return;
  settingsDirty = true;
  $("unsavedFlag").hidden = false;
}

function clearSettingsDirty() {
  settingsDirty = false;
  $("unsavedFlag").hidden = true;
}

// `input` covers typing and the colour picker; `change` covers file pickers
// and checkboxes. Capture so it fires for controls added later.
$("paneSettings").addEventListener("input", markSettingsDirty, true);
$("paneSettings").addEventListener("change", markSettingsDirty, true);

// Leaving the page with pending edits is almost never intentional.
window.addEventListener("beforeunload", (e) => {
  if (!settingsDirty) return;
  e.preventDefault();
  e.returnValue = "";
});

/**
 * Rebuild the "Product of the week" dropdown from the live product list.
 *
 * Called from both the product listener and fillSettings, because either can
 * arrive first. The current selection is preserved across rebuilds — the list
 * re-renders on every product edit, and dropping the choice mid-edit would
 * silently unfeature the product when the owner saved.
 *
 * Hidden products are excluded: featuring one would point the banner at
 * something the storefront never renders, and the customer would land on a
 * "product not found" gap. A previously featured product that has since been
 * hidden still gets an option, marked, so the owner can see why their banner
 * disappeared instead of finding an empty dropdown.
 */
function renderFeaturedOptions() {
  const select = $("sFeatured");
  const chosen = select.value || shop?.featuredProductId || "";

  const options = [["", "None — hide the banner"]];
  for (const p of products) {
    if (p.published === false && p.id !== chosen) continue;
    const label = p.name || "Untitled";
    options.push([p.id, p.published === false ? `${label} (hidden)` : label]);
  }
  // A stale id — the product was deleted — must not silently become "None"
  // the next time settings are saved without the owner meaning it.
  if (chosen && !options.some(([value]) => value === chosen)) {
    options.push([chosen, "Previously featured product (deleted)"]);
  }

  select.replaceChildren(
    ...options.map(([value, label]) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      return o;
    })
  );
  select.value = chosen;
}

function fillSettings(s) {
  // Never overwrite pending edits.
  if (settingsDirty) return;
  if (document.activeElement?.closest("#adminView .card")) return;
  $("sName").value = s.name || "";
  $("sTagline").value = s.tagline || "";
  $("sAbout").value = s.about || "";
  $("sCurrency").value = s.currency || "";
  $("sWhatsapp").value = s.whatsapp || "";
  $("sInstagram").value = s.instagram || "";
  $("sTiktok").value = s.tiktok || "";
  $("sFacebook").value = s.facebook || "";
  $("sEmail").value = s.email || "";
  $("sAccent").value = s.accent || "#5b5bd6";
  $("sPublished").checked = s.published !== false;
  renderWhatsappHint();
  // Cleared first so renderFeaturedOptions takes the stored id rather than
  // preserving whatever was selected before this fill.
  $("sFeatured").value = "";
  renderFeaturedOptions();
  $("sCoverScrim").value = s.coverScrim === "soft" ? "soft" : "";
  $("coverPreviewWrap").hidden = !s.coverUrl;
  if (s.coverUrl) $("coverPreview").src = s.coverUrl;
  $("sDomain").value = s.customDomain || "";
  $("domainSteps").hidden = !s.customDomain;
  $("domFallback").textContent = `${location.host}/s/${s.slug}`;
}

/**
 * Warn about a WhatsApp number wa.me cannot dial.
 *
 * wa.me needs the full international number with no leading zero, but the
 * natural way to write a Pakistani mobile is 0333 4896777 — and typing it that
 * way produces wa.me/03334896777, which fails for every customer with no error
 * anywhere the owner would see it. The shop looks fine and simply never
 * receives an order. Say so at the point of entry instead.
 */
function renderWhatsappHint() {
  const digits = $("sWhatsapp").value.replace(/\D/g, "");
  const hint = $("whatsappHint");
  hint.classList.remove("warn");

  if (!digits) {
    hint.textContent = "Full international number, no + and no leading 0.";
    return;
  }
  if (digits.startsWith("0")) {
    hint.textContent =
      `Starting with 0 won't work — drop it and add your country code ` +
      `(Pakistan: 92${digits.slice(1)}).`;
    hint.classList.add("warn");
    return;
  }
  if (digits.length < 10) {
    hint.textContent = "That looks too short for an international number.";
    hint.classList.add("warn");
    return;
  }
  hint.textContent = `Customers will message https://wa.me/${digits}`;
}

$("sWhatsapp").addEventListener("input", renderWhatsappHint);

// Repaint the dashboard as the colour is dragged, so the owner sees what their
// storefront will look like before committing — the picker swatch alone doesn't
// convey how the colour reads on a button or badge.
$("sAccent").addEventListener("input", (e) => applyAccent(e.target.value));

$("saveSettings").addEventListener("click", async () => {
  const msg = $("settingsMsg");
  msg.classList.remove("ok");
  msg.textContent = "";
  $("saveSettings").disabled = true;
  try {
    const fields = {
      name: $("sName").value.trim(),
      tagline: $("sTagline").value.trim(),
      about: $("sAbout").value.trim(),
      currency: $("sCurrency").value.trim().toUpperCase(),
      whatsapp: $("sWhatsapp").value.replace(/\D/g, ""),
      // Stored bare — the storefront builds the full URL, so an owner can type
      // "@therangoco", "therangoco" or a full profile link and all three work.
      instagram: $("sInstagram").value.trim().replace(/^@/, ""),
      tiktok: $("sTiktok").value.trim().replace(/^@/, ""),
      facebook: $("sFacebook").value.trim(),
      email: $("sEmail").value.trim(),
      accent: $("sAccent").value,
      published: $("sPublished").checked,
      coverScrim: $("sCoverScrim").value,
      // Just an id on the shop doc — the storefront looks it up in the product
      // list it already has, so changing the weekly feature is one write.
      featuredProductId: $("sFeatured").value,
    };

    const logoFile = $("sLogo").files[0];
    if (logoFile) {
      const { blob, mime, ext } = await downscaleImage(logoFile, 512);
      const { url } = await uploadAsset(
        `shops/${shopId}/branding/logo-${Date.now()}.${ext}`,
        blob,
        mime,
        (pct) => setBar("logoBar", pct)
      );
      fields.logoUrl = url;
      $("sLogo").value = "";
      setBar("logoBar", null);
    }

    const coverFile = $("sCover").files[0];
    if (coverFile) {
      // Wider cap than the logo: this is a full-bleed banner, so 512px would
      // look obviously soft stretched across a desktop hero.
      const { blob, mime, ext } = await downscaleImage(coverFile, 1800);
      const { url } = await uploadAsset(
        `shops/${shopId}/branding/cover-${Date.now()}.${ext}`,
        blob,
        mime,
        (pct) => setBar("coverBar", pct)
      );
      fields.coverUrl = url;
      $("sCover").value = "";
      setBar("coverBar", null);
    }

    if (removeCoverRequested) {
      fields.coverUrl = "";
      removeCoverRequested = false;
    }

    await saveShop(shopId, fields);
    clearSettingsDirty();
    msg.classList.add("ok");
    msg.textContent = "Saved.";
  } catch (e) {
    console.error(e);
    msg.textContent = e.message || "Couldn't save.";
  } finally {
    $("saveSettings").disabled = false;
  }
});

// Staged rather than applied immediately, so "Remove cover" follows the same
// save-or-discard contract as every other field on this form.
let removeCoverRequested = false;

$("removeCover").addEventListener("click", () => {
  removeCoverRequested = true;
  $("coverPreviewWrap").hidden = true;
  $("sCover").value = "";
  const msg = $("settingsMsg");
  msg.classList.remove("ok");
  msg.textContent = "Cover will be removed when you save.";
});

// ---------------------------------------------------------- custom domain

/**
 * Claim a hostname for this shop and show the DNS the owner has to add.
 *
 * The mapping is only half the job — the platform operator still has to add the
 * domain to the hosting project, which is not something a shop owner can do
 * themselves. So this deliberately ends with "tell us" rather than implying the
 * domain is live, and the shared address keeps working throughout.
 */
$("connectDomain").addEventListener("click", async () => {
  const msg = $("domainMsg");
  msg.classList.remove("ok");
  msg.textContent = "";

  const raw = $("sDomain").value;
  if (!raw.trim()) {
    msg.textContent = "Enter your domain first.";
    return;
  }

  $("connectDomain").disabled = true;
  try {
    const host = await claimDomain(shopId, raw);
    // Mirrored onto the shop so the dashboard can show it without a second read.
    await saveShop(shopId, { customDomain: host });
    $("sDomain").value = host;
    msg.classList.add("ok");
    msg.textContent = `Reserved ${host}. Now add the DNS records below.`;
    $("domainSteps").hidden = false;
  } catch (e) {
    console.error(e);
    msg.textContent = e.message || "Couldn't connect that domain.";
  } finally {
    $("connectDomain").disabled = false;
  }
});

$("sDomain").addEventListener("blur", () => {
  const v = normalizeHostname($("sDomain").value);
  if (v) $("sDomain").value = v;
});

function setBar(id, pct) {
  const bar = $(id);
  if (pct == null) {
    bar.hidden = true;
    bar.firstElementChild.style.width = "0%";
    return;
  }
  bar.hidden = false;
  bar.firstElementChild.style.width = `${pct}%`;
}

// ---------------------------------------------------------------- images

/**
 * Shrink an image to `maxEdge` and re-encode as JPEG.
 *
 * Phone cameras produce 4–12MB files, well past the 8MB ceiling in
 * storage.rules — without this, uploading a photo straight from a phone fails
 * with a bare permission error. It also keeps the storefront fast on mobile data.
 */
function decodeFailure(file) {
  // iPhones shoot HEIC by default. Safari decodes it; Chrome and Firefox do
  // not, so the same photo that works on the owner's phone fails on their
  // laptop. "That file isn't a readable image" sends people hunting for a
  // corrupt file instead of changing one camera setting.
  if (/\.(heic|heif)$/i.test(file.name) || /heic|heif/i.test(file.type)) {
    return new Error(
      "This browser can't read HEIC photos. On iPhone set " +
        "Settings → Camera → Formats → Most Compatible, or open the photo in " +
        "Preview and export it as JPEG."
    );
  }
  return new Error(`Couldn't read “${file.name}” as an image.`);
}

/**
 * Shrink an image to `maxEdge` and re-encode as JPEG.
 *
 * Phone cameras produce 4–12MB files, well past the 8MB ceiling in
 * storage.rules — without this, uploading a photo straight from a phone fails
 * with a bare permission error. It also keeps the storefront fast on mobile data.
 *
 * Uses createImageBitmap first: it handles more formats than <img> (and decodes
 * off the main thread), falling back to <img> for older browsers.
 *
 * Transparency is preserved for PNG/WebP sources. Re-encoding those to JPEG
 * would flatten the alpha channel onto black, which breaks two things at once:
 * the storefront thumbnail gains an ugly box, and the AR standee loses the
 * cut-out that makes it look like a product rather than a floating photograph.
 *
 * @returns {Promise<{blob: Blob, mime: string, ext: string}>}
 */
async function downscaleImage(file, maxEdge = 1600, quality = 0.85) {
  let width, height, source;

  try {
    const bitmap = await createImageBitmap(file);
    width = bitmap.width;
    height = bitmap.height;
    source = bitmap;
  } catch {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        width = img.naturalWidth;
        height = img.naturalHeight;
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(decodeFailure(file));
      };
      img.src = url;
    });
  }

  if (!width || !height) throw decodeFailure(file);

  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();

  const keepAlpha = file.type === "image/png" || file.type === "image/webp";
  const mime = keepAlpha ? "image/png" : "image/jpeg";
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, mime, quality)
  );
  if (!blob) throw new Error("Image conversion failed.");
  return { blob, mime, ext: keepAlpha ? "png" : "jpg" };
}

/**
 * Browsers hand up .usdz and .glb with an empty or generic type, and the
 * storefront needs a real one: Safari only offers AR Quick Look when the USDZ
 * is served as model/vnd.usdz+zip. Decide from the extension instead.
 */
function modelContentType(filename) {
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "usdz") return "model/vnd.usdz+zip";
  if (ext === "glb") return "model/gltf-binary";
  return null;
}

/**
 * Explain what the "was" price will actually do.
 *
 * A `compareAtPrice` that isn't above the price renders nothing at all — the
 * discount is simply dropped. Without this the owner types a number, sees no
 * change on the storefront, and has no idea why. This is also the common shape
 * of a stale sale: the price gets raised back up and the old "was" is left behind.
 */
function renderPriceHint() {
  const price = Number($("pPrice").value);
  const was = Number($("pCompareAt").value);
  const hint = $("priceHint");

  // The values are kept, not cleared, so unticking the box restores the price
  // the owner had — but while it is ticked neither number reaches the
  // storefront, and the fields say so instead of inviting edits that do nothing.
  const quoteOnly = $("pQuoteOnly").checked;
  $("pPrice").disabled = quoteOnly;
  $("pCompareAt").disabled = quoteOnly;
  if (quoteOnly) {
    hint.textContent = `Shows “${QUOTE_LABEL}” instead of a price.`;
    return;
  }

  if (!$("pCompareAt").value) {
    hint.textContent = "";
    return;
  }
  if (!Number.isFinite(was) || !Number.isFinite(price) || price <= 0) {
    hint.textContent = "Set a price to show a discount.";
    return;
  }
  if (was <= price) {
    hint.textContent =
      "“Was” must be higher than the price, or no discount is shown.";
    return;
  }
  hint.textContent = `Shows as −${Math.round((1 - price / was) * 100)}% with the old price struck through.`;
}

for (const id of ["pPrice", "pCompareAt"]) {
  $(id).addEventListener("input", renderPriceHint);
}
$("pQuoteOnly").addEventListener("change", renderPriceHint);

// ----------------------------------------------------------- product editor

const editor = $("editor");
let editing = null; // the product being edited
let isNew = false;
let staged = null; // working copy of asset fields, committed on save
let stagedUploads = []; // paths written this session — swept if we don't save
let pendingDeletes = []; // paths the live doc still uses — swept only after saving
// The downscaled first photo, kept so the standee can be rebuilt without
// re-downloading it from Storage on every save.
let firstPhotoBlob = null;

// Uploads start the moment a file is chosen, but the product document is only
// written on Save. Nothing used to connect the two, so clicking Save while an
// upload was still running wrote an empty `photoUrls` and the photo vanished —
// intermittently, depending on file size and connection speed, which made it
// look like uploads "sometimes don't work". Save now waits on this chain, and
// is disabled while anything is in flight.
let uploadChain = Promise.resolve();
let uploadsInFlight = 0;

function setUploadBusy(delta) {
  uploadsInFlight = Math.max(0, uploadsInFlight + delta);
  const busy = uploadsInFlight > 0;
  const save = $("saveProduct");
  save.disabled = busy;
  save.textContent = busy ? "Uploading…" : "Save";
  $("deleteProduct").disabled = busy;
  $("cancelEditor").disabled = busy;
}

/** Queue asset work so uploads can't interleave, and Save can await all of it. */
function queueUpload(task) {
  setUploadBusy(1);
  uploadChain = uploadChain
    .then(task)
    .catch((e) => {
      console.error(e);
      $("editorError").textContent = friendlyUploadError(e);
    })
    .finally(() => setUploadBusy(-1));
  return uploadChain;
}

function friendlyUploadError(err) {
  const code = err?.code || "";
  if (code === "storage/unauthorized")
    return "Storage rejected the upload. Check storage.rules is published for this project.";
  if (code === "storage/retry-limit-exceeded" || code === "storage/canceled")
    return "Upload timed out. Check your connection and try again.";
  if (code === "storage/quota-exceeded")
    return "Storage quota is full for this Firebase project.";
  return err?.message || "Upload failed.";
}

function openEditor(product) {
  isNew = !product;
  editing = product || {
    id: newProductId(shopId),
    name: "",
    description: "",
    price: "",
    photoUrls: [],
    photoPaths: [],
    published: true,
    sortOrder: products.length,
  };
  staged = {
    photoUrls: [...(editing.photoUrls || [])],
    photoPaths: [...(editing.photoPaths || [])],
    modelGlbUrl: editing.modelGlbUrl || "",
    modelGlbPath: editing.modelGlbPath || "",
    modelUsdzUrl: editing.modelUsdzUrl || "",
    modelUsdzPath: editing.modelUsdzPath || "",
    // `modelAuto` marks a GLB this app generated from the photo, so a real
    // uploaded scan is never silently overwritten by the generator.
    modelAuto: editing.modelAuto === true,
    autoSrc: editing.autoSrc || "",
  };
  firstPhotoBlob = null;
  stagedUploads = [];
  pendingDeletes = [];

  $("editorTitle").textContent = isNew ? "Add product" : "Edit product";
  $("pName").value = editing.name || "";
  $("pCategory").value = editing.category || "";
  $("pDesc").value = editing.description || "";
  $("pPrice").value = editing.price ?? "";
  $("pCompareAt").value = editing.compareAtPrice ?? "";
  $("pWidthCm").value = editing.widthCm ?? "";
  $("pSort").value = editing.sortOrder ?? 0;
  $("pPublished").checked = editing.published !== false;
  $("pInStock").checked = isInStock(editing);
  $("pQuoteOnly").checked = isQuoteOnly(editing);
  $("pPhotos").value = "";
  $("pModel").value = "";
  $("editorError").textContent = "";
  setBar("photoBar", null);
  setBar("modelBar", null);
  $("deleteProduct").hidden = isNew;
  uploadsInFlight = 0;
  uploadChain = Promise.resolve();
  setUploadBusy(0); // resets the button label and enabled state

  renderThumbs();
  renderModelState();
  renderPriceHint();
  editor.showModal();
}

function renderThumbs() {
  const wrap = $("pThumbs");
  wrap.replaceChildren(
    ...staged.photoUrls.map((url, i) => {
      const path = staged.photoPaths[i] || "";
      const cell = document.createElement("div");
      cell.className = "t";
      const el = mediaElement(url, {
        path,
        alt: "",
        controls: false,
      });
      if (el.tagName === "VIDEO") el.classList.add("thumb-video");
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "×";
      del.title = isVideoMedia(url, path) ? "Remove video" : "Remove photo";
      del.addEventListener("click", () => {
        staged.photoUrls.splice(i, 1);
        const [removed] = staged.photoPaths.splice(i, 1);
        // Queue rather than delete: the saved document still references this
        // file until the owner actually saves, and cancelling must leave the
        // live storefront untouched.
        if (removed) pendingDeletes.push(removed);
        // May have removed the still we kept for standee generation.
        firstPhotoBlob = null;
        renderThumbs();
      });
      cell.append(el, del);
      return cell;
    })
  );
}

function renderModelState() {
  const parts = [];
  if (staged.modelUsdzUrl) parts.push("USDZ ✓ (AR on iPhone/iPad)");
  if (staged.modelGlbUrl) {
    parts.push(
      staged.modelAuto
        ? "Auto flat standee from your photo — upload a real scan to replace it"
        : "GLB ✓ (full 3D everywhere + AR)"
    );
  }
  $("modelState").textContent = parts.length
    ? parts.join(" · ")
    : "No model yet — set a real width above to get one automatically.";
}

/**
 * Regenerate the auto-standee when it's missing or out of date.
 *
 * Skipped entirely when the owner uploaded a real model: a scan is strictly
 * better than a flat panel, and silently replacing one with the other would be
 * infuriating. `autoSrc` fingerprints the inputs so an unrelated edit (renaming
 * the product, fixing a typo) doesn't burn an upload rebuilding an identical file.
 */
async function syncStandee() {
  const widthCm = Number($("pWidthCm").value);
  // Standee needs a still image — a video as the first media item must not
  // be fed into the GLB generator.
  const cover = coverMedia({
    photoUrls: staged.photoUrls,
    photoPaths: staged.photoPaths,
  });
  const photo = cover && !cover.video ? cover.url : "";

  const wantsStandee = Boolean(photo) && widthCm > 0;

  // The generated standee is only justified while both its inputs exist.
  // Clearing the width is how an owner says "this isn't a physical product,
  // don't offer AR" — so it has to actually remove the model, not just stop
  // regenerating it, or the AR badge would stick forever with no way to undo it.
  if (!wantsStandee) {
    if (staged.modelAuto) {
      if (staged.modelGlbPath) pendingDeletes.push(staged.modelGlbPath);
      staged.modelGlbUrl = staged.modelGlbPath = staged.autoSrc = "";
      staged.modelAuto = false;
      renderModelState();
    }
    return;
  }
  if (staged.modelGlbPath && !staged.modelAuto) return; // real scan wins

  const signature = `${photo}|${widthCm}`;
  if (signature === staged.autoSrc && staged.modelGlbUrl) return;

  // Prefer the in-memory blob; fall back to refetching when the owner only
  // changed the width in a later session.
  let source = firstPhotoBlob;
  if (!source) {
    const res = await fetch(photo);
    if (!res.ok) throw new Error("Couldn't read the photo to build the AR model.");
    source = await res.blob();
  }

  setBar("modelBar", 5);
  const glb = await photoToStandeeGlb(source, widthCm / 100);
  const path = `shops/${shopId}/products/${editing.id}/models/standee-${Date.now()}.glb`;
  const { url } = await uploadAsset(path, glb, "model/gltf-binary", (pct) =>
    setBar("modelBar", pct)
  );
  setBar("modelBar", null);

  if (staged.modelGlbPath) pendingDeletes.push(staged.modelGlbPath);
  staged.modelGlbUrl = url;
  staged.modelGlbPath = path;
  staged.modelAuto = true;
  staged.autoSrc = signature;
  stagedUploads.push(path);
  renderModelState();
}

$("pPhotos").addEventListener("change", () => {
  const files = [...$("pPhotos").files];
  if (!files.length) return;
  $("pPhotos").value = ""; // clear now: the queued task owns the list
  queueUpload(() => uploadPhotos(files));
});

async function uploadPhotos(files) {
  $("editorError").textContent = "";
  try {
    for (const [i, file] of files.entries()) {
      const kind = mediaKindFromFile(file);
      if (!kind) {
        $("editorError").textContent =
          `Skipped “${file.name}” — use a photo (JPEG/PNG/WebP) or video (MP4/WebM/MOV).`;
        continue;
      }

      let blob;
      let mime;
      let ext;
      if (kind === "video") {
        if (file.size > MAX_VIDEO_BYTES) {
          $("editorError").textContent =
            `“${file.name}” is too large (max 50 MB for videos).`;
          continue;
        }
        blob = file;
        mime = videoContentType(file.name, file.type);
        ext = videoExtension(file.name, mime);
      } else {
        ({ blob, mime, ext } = await downscaleImage(file));
      }

      const path = `shops/${shopId}/products/${editing.id}/photos/${Date.now()}-${i}.${ext}`;
      const { url } = await uploadAsset(path, blob, mime, (pct) =>
        setBar("photoBar", Math.round(((i + pct / 100) / files.length) * 100))
      );
      // Keep a still-image blob for AR standee generation (never a video).
      if (kind === "image" && !firstPhotoBlob) firstPhotoBlob = blob;
      staged.photoUrls.push(url);
      staged.photoPaths.push(path);
      stagedUploads.push(path);
      renderThumbs();
    }
  } finally {
    setBar("photoBar", null);
  }
}

$("pModel").addEventListener("change", () => {
  const files = [...$("pModel").files];
  if (!files.length) return;
  $("pModel").value = "";
  queueUpload(() => uploadModels(files));
});

async function uploadModels(files) {
  $("editorError").textContent = "";
  try {
    for (const [i, file] of files.entries()) {
      const type = modelContentType(file.name);
      if (!type) {
        $("editorError").textContent = `Skipped ${file.name} — only .usdz and .glb are supported.`;
        continue;
      }
      const isUsdz = type === "model/vnd.usdz+zip";
      const ext = isUsdz ? "usdz" : "glb";
      const path = `shops/${shopId}/products/${editing.id}/models/${Date.now()}.${ext}`;
      const { url } = await uploadAsset(path, file, type, (pct) =>
        setBar("modelBar", Math.round(((i + pct / 100) / files.length) * 100))
      );

      // Replacing a model orphans the previous file — queue it for deletion
      // once the save succeeds, not now, in case the owner cancels.
      const oldPath = isUsdz ? staged.modelUsdzPath : staged.modelGlbPath;
      if (oldPath) pendingDeletes.push(oldPath);

      if (isUsdz) {
        staged.modelUsdzUrl = url;
        staged.modelUsdzPath = path;
      } else {
        staged.modelGlbUrl = url;
        staged.modelGlbPath = path;
        // A hand-uploaded GLB is a real model; stop the generator touching it.
        staged.modelAuto = false;
        staged.autoSrc = "";
      }
      stagedUploads.push(path);
      renderModelState();
    }
  } finally {
    setBar("modelBar", null);
  }
}

$("saveProduct").addEventListener("click", async () => {
  const name = $("pName").value.trim();
  if (!name) {
    $("editorError").textContent = "Give the product a name.";
    return;
  }
  $("saveProduct").disabled = true;
  try {
    // Belt and braces: the button is disabled while uploads run, but a file
    // chosen in the same tick as the click could still be queued behind us.
    // Saving without this wrote an empty photoUrls and silently lost the photo.
    await uploadChain;

    // Build the AR model before writing the document, so the saved product
    // never points at a standee that failed to upload.
    await syncStandee();

    const priceRaw = $("pPrice").value;
    const compareRaw = $("pCompareAt").value;
    const widthRaw = $("pWidthCm").value;
    await saveProduct(shopId, editing.id, {
      name,
      // Trimmed so a stray space doesn't fork "Storage" into a second chip.
      category: $("pCategory").value.trim(),
      description: $("pDesc").value.trim(),
      price: priceRaw === "" ? null : Number(priceRaw),
      compareAtPrice: compareRaw === "" ? null : Number(compareRaw),
      widthCm: widthRaw === "" ? null : Number(widthRaw),
      sortOrder: Number($("pSort").value) || 0,
      published: $("pPublished").checked,
      inStock: $("pInStock").checked,
      quoteOnly: $("pQuoteOnly").checked,
      ...staged,
      ...(isNew ? { createdAt: new Date() } : {}),
    });
    // The document now points at the new assets, so the old ones are safe to
    // drop and this session's uploads are no longer orphans.
    stagedUploads = [];
    for (const path of pendingDeletes) removeAsset(path);
    pendingDeletes = [];
    editor.close();
  } catch (e) {
    console.error(e);
    $("editorError").textContent = e.message || "Couldn't save.";
  } finally {
    // Don't re-enable if an upload is still queued — setUploadBusy owns the
    // button in that case.
    if (uploadsInFlight === 0) {
      $("saveProduct").disabled = false;
      $("saveProduct").textContent = "Save";
    }
  }
});

$("cancelEditor").addEventListener("click", () => editor.close());

// Files upload immediately so progress is visible, but a cancelled *new*
// product never gets a document — those objects would be unreachable and billed
// forever. Sweep them. On an existing product the document still points at its
// originals, so only this session's uploads are discarded.
editor.addEventListener("close", () => {
  for (const path of stagedUploads) removeAsset(path);
  stagedUploads = [];
  pendingDeletes = []; // discard queued deletions — nothing was committed
});

$("deleteProduct").addEventListener("click", async () => {
  if (!confirm(`Delete “${editing.name || "this product"}”? This can't be undone.`)) return;
  $("deleteProduct").disabled = true;
  try {
    await deleteProduct(shopId, editing.id);
    stagedUploads = [];
    editor.close();
  } catch (e) {
    console.error(e);
    $("editorError").textContent = e.message || "Couldn't delete.";
  } finally {
    $("deleteProduct").disabled = false;
  }
});

// Two entry points — the header button on desktop, an in-pane button on mobile
// where the header has no room for it.
for (const id of ["addProduct", "addProductMobile"]) {
  $(id).addEventListener("click", () => openEditor(null));
}

// -------------------------------------------------------------------- boot

renderAuthMode();

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    unsubShop?.();
    unsubProducts?.();
    unsubShop = unsubProducts = null;
    shopId = shop = null;
    products = [];
    show("auth");
    return;
  }
  // Deciding which view to show needs a Firestore read, and that read can fail
  // (offline, rules misconfigured). Without this guard the rejection is
  // unhandled and the owner is left staring at a blank page with no signed-in
  // state and no way back to the sign-in form.
  try {
    const existing = await getOwnShop(user.uid);
    if (existing) {
      await enterAdmin(user.uid);
    } else {
      show("setup");
      updateSlugPreview();
    }
  } catch (e) {
    console.error(e);
    show("auth");
    $("authError").classList.remove("ok");
    $("authError").textContent =
      "Signed in, but couldn't reach the database. Check your connection and reload.";
  }
});
