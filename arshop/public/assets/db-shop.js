// Firestore access for the PUBLIC storefront only.
//
// Deliberately separate from db.js. The dashboard needs Auth and Storage; a
// shopper does not, yet importing db.js pulled `firebase-auth` and
// `firebase-storage` into every storefront visit — two whole module trees
// downloaded, parsed and initialised to render a page that never signs anyone
// in or uploads anything.
//
// Nothing here writes, so there is no shared state to keep in sync with db.js;
// the two are never loaded on the same page.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-app.js";
import {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  getDoc,
  collection,
  query,
  where,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js";

import { firebaseConfig, isConfigured } from "./firebase-config.js";

if (!isConfigured) {
  document.addEventListener("DOMContentLoaded", () => {
    document.body.innerHTML =
      '<div style="font:16px/1.6 ui-sans-serif,system-ui;max-width:34rem;margin:18vh auto;padding:0 1.5rem">' +
      "<h1 style='font-size:1.3rem'>Firebase isn’t configured yet</h1>" +
      "<p>Open <code>public/assets/firebase-config.js</code> and paste the config " +
      "from your Firebase project.</p></div>";
  });
  throw new Error("firebase-config.js still contains REPLACE_ME placeholders");
}

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

if (firebaseConfig.projectId.startsWith("demo-")) {
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

/** Resolve a public URL slug to its shop id. */
export async function shopIdForSlug(slug) {
  const snap = await getDoc(doc(db, "slugs", slug));
  return snap.exists() ? snap.data().shopId : null;
}

export function normalizeHostname(hostname) {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^www\./, "");
}

/** Resolve a customer's own domain to its shop id. */
export async function shopIdForDomain(hostname) {
  const key = normalizeHostname(hostname);
  if (!key) return null;
  const snap = await getDoc(doc(db, "domains", key));
  return snap.exists() ? snap.data().shopId : null;
}

export function watchShop(shopId, onChange, onError) {
  return onSnapshot(
    doc(db, "shops", shopId),
    (snap) => onChange(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    onError
  );
}

const bySortOrder = (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0);

/**
 * Published products only. No `orderBy` — pairing it with the `where` would
 * require a hand-created composite index; see db.js for the full reasoning.
 */
export function watchPublishedProducts(shopId, onChange, onError) {
  const q = query(
    collection(db, "shops", shopId, "products"),
    where("published", "==", true)
  );
  return onSnapshot(
    q,
    (snap) =>
      onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(bySortOrder)),
    onError
  );
}
