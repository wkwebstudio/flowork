// Wspólny moduł Firebase dla stron Flowork (logowanie, rejestracja, konto).
// Dane w firebaseConfig są publiczne – bezpieczeństwo zapewniają reguły Firestore (firestore.rules).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, sendEmailVerification,
  sendPasswordResetEmail, updateProfile, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
 
const firebaseConfig = {
  apiKey: "AIzaSyDXgyG6rMx8JfbUYSug0IV7ZBG12sSlyUE",
  authDomain: "flowork-29fcc.firebaseapp.com",
  projectId: "flowork-29fcc",
  storageBucket: "flowork-29fcc.firebasestorage.app",
  messagingSenderId: "153850625261",
  appId: "1:153850625261:web:9d1beaa0d69a0ce34660e4"
};
 
export const TRIAL_MS = 3 * 60 * 60 * 1000; // 3 godziny
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
auth.languageCode = "pl";
 
export {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, sendEmailVerification,
  sendPasswordResetEmail, updateProfile, onAuthStateChanged, signOut, doc, getDoc, setDoc, serverTimestamp
};
 
const MSG = {
  "auth/email-already-in-use": "Konto z tym adresem e-mail już istnieje. Zaloguj się.",
  "auth/invalid-email": "Nieprawidłowy adres e-mail.",
  "auth/weak-password": "Hasło jest za słabe. Użyj co najmniej 8 znaków.",
  "auth/user-not-found": "Nieprawidłowy e-mail lub hasło.",
  "auth/wrong-password": "Nieprawidłowy e-mail lub hasło.",
  "auth/invalid-credential": "Nieprawidłowy e-mail lub hasło.",
  "auth/too-many-requests": "Zbyt wiele prób. Odczekaj chwilę i spróbuj ponownie.",
  "auth/network-request-failed": "Brak połączenia z internetem.",
  "auth/operation-not-allowed": "Logowanie e-mailem nie jest włączone w projekcie Firebase.",
  "auth/unauthorized-domain": "Ta domena nie jest dodana w Firebase (Authentication → Settings → Authorized domains).",
  "permission-denied": "Brak uprawnień. Potwierdź adres e-mail i spróbuj ponownie."
};
export const errMsg = e => MSG[e && e.code] || ("Coś poszło nie tak" + (e && e.code ? " (" + e.code + ")" : "") + ". Spróbuj ponownie.");
 
// Zakłada profil (i tym samym startuje okres próbny) dopiero po potwierdzeniu e-maila.
export async function ensureProfile(user) {
  const ref = doc(db, "users", user.uid);
  let snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, { name: user.displayName || "", email: user.email, createdAt: serverTimestamp() });
    snap = await getDoc(ref);
  }
  return snap.data();
}
 
// Zwraca stan dostępu: trial / paid / expired
export function accessState(profile, sub) {
  const now = Date.now();
  const created = profile && profile.createdAt && profile.createdAt.toMillis ? profile.createdAt.toMillis() : now;
  const trialEnd = created + TRIAL_MS;
  const paidUntil = sub && sub.accessUntil && sub.accessUntil.toMillis ? sub.accessUntil.toMillis() : 0;
  if (paidUntil > now) return { state: "paid", until: paidUntil };
  if (trialEnd > now) return { state: "trial", until: trialEnd };
  return { state: "expired", until: Math.max(trialEnd, paidUntil) };
}
 