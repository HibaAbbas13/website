// Firebase bootstrap + every read/write the app performs.
// Keeping all Firestore/Storage access in one module means the collection
// layout is described in exactly one place, and the page scripts stay readable.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-app.js";
import {
  getAuth,
  connectAuthEmulator,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/12.17.0/firebase-auth.js";
import {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  onSnapshot,
  runTransaction,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js";
import {
  getStorage,
  connectStorageEmulator,
  ref as storageRef,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
} from "https://www.gstatic.com/firebasejs/12.17.0/firebase-storage.js";

import { firebaseConfig, isConfigured } from "./firebase-config.js";

if (!isConfigured) {
  document.addEventListener("DOMContentLoaded", () => {
    document.body.innerHTML =
      '<div style="font:16px/1.6 ui-sans-serif,system-ui;max-width:34rem;margin:18vh auto;padding:0 1.5rem">' +
      "<h1 style='font-size:1.3rem'>Firebase isn’t configured yet</h1>" +
      "<p>Open <code>public/assets/firebase-config.js</code> and paste the config " +
      "from your Firebase project. The README walks through creating one.</p></div>";
  });
  throw new Error("firebase-config.js still contains REPLACE_ME placeholders");
}

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

// A `demo-` project id is reserved by Firebase for the local emulator suite and
// can never be a real project, so it's a safe switch: there is no configuration
// mistake that points this at live customer data.
if (firebaseConfig.projectId.startsWith("demo-")) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectStorageEmulator(storage, "127.0.0.1", 9199);
  console.info("Connected to Firebase emulators.");
}

export {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
};

// ---------------------------------------------------------------- shops

/** Resolve a public URL slug to its shop id. Returns null when unclaimed. */
export async function shopIdForSlug(slug) {
  const snap = await getDoc(doc(db, "slugs", slug));
  return snap.exists() ? snap.data().shopId : null;
}

/**
 * Resolve a custom domain to its shop id. Returns null when unregistered.
 *
 * Hostnames are stored lowercase and without `www.`, so a customer who types
 * one form and links the other still lands on their shop.
 */
export async function shopIdForDomain(hostname) {
  const key = normalizeHostname(hostname);
  if (!key) return null;
  const snap = await getDoc(doc(db, "domains", key));
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

/** Claim a hostname for this shop. Fails if another shop already holds it. */
export async function claimDomain(shopId, hostname) {
  const key = normalizeHostname(hostname);
  if (!key || !key.includes(".")) {
    throw new Error("Enter a domain like shopname.com");
  }
  await runTransaction(db, async (tx) => {
    const ref = doc(db, "domains", key);
    const existing = await tx.get(ref);
    if (existing.exists()) {
      if (existing.data().shopId === shopId) return; // already ours — no-op
      throw new Error(`“${key}” is already connected to another shop.`);
    }
    tx.set(ref, { shopId, claimedAt: serverTimestamp() });
  });
  return key;
}

export async function getShop(shopId) {
  const snap = await getDoc(doc(db, "shops", shopId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export function watchShop(shopId, onChange, onError) {
  return onSnapshot(
    doc(db, "shops", shopId),
    (snap) => onChange(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    onError
  );
}

export async function saveShop(shopId, fields) {
  await updateDoc(doc(db, "shops", shopId), {
    ...fields,
    updatedAt: serverTimestamp(),
  });
}

/**
 * Claim `slug` and create the shop, or fail without side effects.
 *
 * Both writes go in one transaction on purpose. Claiming the slug first and
 * then creating the shop would, on a failure between the two, permanently burn
 * the slug — `slugs/*` is create-only in the rules, so nothing could ever
 * reclaim it. Uniqueness comes from the existence check inside the transaction.
 */
export async function createShopWithSlug({ shopId, slug, name, ownerEmail }) {
  await runTransaction(db, async (tx) => {
    const slugRef = doc(db, "slugs", slug);
    if ((await tx.get(slugRef)).exists()) {
      throw new Error(`The address "${slug}" is already taken — try another.`);
    }
    tx.set(slugRef, { shopId, claimedAt: serverTimestamp() });
    tx.set(doc(db, "shops", shopId), {
      ownerUid: shopId,
      slug,
      name,
      ownerEmail,
      tagline: "",
      about: "",
      currency: "PKR",
      whatsapp: "",
      instagram: "",
      logoUrl: "",
      accent: "#5b5bd6",
      published: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
}

/** The shop owned by a signed-in uid, or null if they haven't set one up. */
export async function getOwnShop(uid) {
  return getShop(uid);
}

// ------------------------------------------------------------- products

const bySortOrder = (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0);

/**
 * Storefront view: published products only.
 *
 * Deliberately no `orderBy` — pairing a `where` with an `orderBy` on a
 * different field requires a hand-created composite index, which would make
 * every new deployment fail with an empty grid until someone clicked a link in
 * a console error. Shops hold tens of products, so sorting here is free and
 * setup stays a copy-paste of the rules files.
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

/** Admin view: everything, drafts included. */
export function watchAllProducts(shopId, onChange, onError) {
  return onSnapshot(
    collection(db, "shops", shopId, "products"),
    (snap) =>
      onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(bySortOrder)),
    onError
  );
}

export function newProductId(shopId) {
  return doc(collection(db, "shops", shopId, "products")).id;
}

export async function saveProduct(shopId, productId, fields) {
  await setDoc(
    doc(db, "shops", shopId, "products", productId),
    { ...fields, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

/**
 * Delete a product and the Storage objects it owns.
 *
 * Storage first: if the document went first and the file sweep then failed,
 * the URLs would be gone and those objects would be unreachable garbage
 * billing forever. Failing the other way leaves files with a live document,
 * which a retry can still clean up.
 */
export async function deleteProduct(shopId, productId) {
  const snap = await getDoc(doc(db, "shops", shopId, "products", productId));
  if (snap.exists()) {
    const p = snap.data();
    const paths = [
      ...(p.photoPaths || []),
      p.modelGlbPath,
      p.modelUsdzPath,
    ].filter(Boolean);
    // Missing objects are fine — a half-finished upload leaves a path with no
    // file behind it, and that shouldn't block deleting the product.
    await Promise.all(
      paths.map((path) =>
        deleteObject(storageRef(storage, path)).catch(() => {})
      )
    );
  }
  await deleteDoc(doc(db, "shops", shopId, "products", productId));
}

// -------------------------------------------------------------- uploads

/**
 * Upload one file and return its path + public download URL.
 * `onProgress` receives 0–100.
 */
export function uploadAsset(path, file, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const task = uploadBytesResumable(storageRef(storage, path), file, {
      contentType,
      // Assets are immutable once written (every upload gets a fresh filename),
      // so let browsers and the CDN hold onto them.
      cacheControl: "public, max-age=31536000, immutable",
    });
    task.on(
      "state_changed",
      (s) =>
        onProgress?.(Math.round((s.bytesTransferred / s.totalBytes) * 100)),
      reject,
      async () => resolve({ path, url: await getDownloadURL(task.snapshot.ref) })
    );
  });
}

export async function removeAsset(path) {
  await deleteObject(storageRef(storage, path)).catch(() => {});
}

export { serverTimestamp };
