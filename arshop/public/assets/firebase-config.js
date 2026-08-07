// Fill these in from your Firebase project:
//   Firebase console → Project settings → General → Your apps → Web app → Config
//
// Same Firebase/Google account as Monetra is fine. Use a SEPARATE project (this one is `monetra-web`) — do not reuse Monetra's iOS project (`toybiz`): this app makes
// collections world-readable by design, and Monetra's Firestore holds paying
// customers' revenue data. Keep the blast radius separate.
//
// These values are not secrets — they ship in every Firebase web app and are
// visible in the browser. Your data is protected by firestore.rules and
// storage.rules, not by hiding this file. Setup steps are in ../../README.md.

const projectConfig = {
  apiKey: "AIzaSyCKMxJJL4d5NuqWn7djZZoaTt0H63SdaH4",
  authDomain: "monetra-web.firebaseapp.com",
  projectId: "monetra-web",
  storageBucket: "monetra-web.firebasestorage.app",
  messagingSenderId: "709282318290",
  appId: "1:709282318290:web:ef0b439742b5580d83ea0b",
  // measurementId is intentionally omitted — it only matters to Google
  // Analytics, which this app doesn't load.
};

// The `demo-` prefix is reserved by Firebase for the local emulator suite and
// can never name a real project, so these placeholder credentials cannot reach
// anyone's live data. db.js routes any `demo-` project at 127.0.0.1.
const emulatorConfig = {
  apiKey: "demo-key",
  authDomain: "127.0.0.1",
  projectId: "demo-arshop",
  storageBucket: "demo-arshop.firebasestorage.app",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:demo",
};

const unfilled = Object.values(projectConfig).some((v) =>
  String(v).includes("REPLACE_ME")
);
const onLocalhost = ["localhost", "127.0.0.1", ""].includes(location.hostname);

// `?emu=1` forces the emulator even when real credentials are filled in — the
// only way to exercise write paths without touching live shop data. Restricted
// to localhost so the flag can never do anything on the deployed site.
const forceEmulator =
  onLocalhost && new URLSearchParams(location.search).get("emu") === "1";

// A fresh clone with no credentials also runs against the emulator rather than
// erroring, so `firebase emulators:start` works immediately after cloning.
export const firebaseConfig =
  forceEmulator || (unfilled && onLocalhost) ? emulatorConfig : projectConfig;
export const isConfigured = !unfilled || onLocalhost;
