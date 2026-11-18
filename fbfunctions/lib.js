// Flowork – biblioteka ćwiczeń: nauczyciele udostępniają ćwiczenia innym i kopiują cudze jednym kliknięciem.
// Wszystkie zapisy idą przez funkcje (kolekcja lib jest zamknięta w regułach Firestore).
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");

const REGION = "europe-west1";
const ADMIN_EMAIL = "wkwebstudio@gmail.com";
const TRIAL_H = 5;            // okres próbny (godziny) – tak samo jak w fb.js i firestore.rules
const MAX_P = 800000;         // maks. rozmiar ćwiczenia (znaki JSON)
const MAX_PER_USER = 300;     // maks. udostępnionych ćwiczeń jednego nauczyciela
const LIST_MAX = 600;         // ile najnowszych pozycji zwraca lista

const db = () => admin.firestore();
const ms = t => (t && t.toMillis ? t.toMillis() : 0);
const str = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);

function need(req) {
  if (!req.auth || !req.auth.token.email_verified) throw new HttpsError("unauthenticated", "Zaloguj się i potwierdź e-mail.");
  return req.auth;
}
const isAdmin = a => a.token.email === ADMIN_EMAIL;

async function active(uid) {
  const [u, s] = await Promise.all([db().doc("users/" + uid).get(), db().doc("subs/" + uid).get()]);
  if (!u.exists || u.data().blocked) return false;
  if (ms(u.data().createdAt) + TRIAL_H * 3600e3 > Date.now()) return true;
  return s.exists && ms(s.data().accessUntil) > Date.now();
}
async function needActive(a) {
  if (isAdmin(a)) return;
  if (!(await active(a.uid))) throw new HttpsError("permission-denied", "Biblioteka działa przy aktywnym dostępie do panelu.");
}

const META = d => ({
  id: d.id, t: d.get("t"), k: d.get("k"), ty: d.get("ty"), m: d.get("m"), d: d.get("d"), sm: d.get("sm"),
  sub: d.get("sub"), lv: d.get("lv"), by: d.get("by"), n: d.get("n") || 0, at: ms(d.get("at")), upd: ms(d.get("upd")),
});

// Udostępnij albo zaktualizuj ćwiczenie w bibliotece.
exports.libPublish = onCall({ region: REGION }, async req => {
  const a = need(req);
  await needActive(a);
  const x = req.data || {};
  const src = str(x.src, 40);
  if (!src) throw new HttpsError("invalid-argument", "Brak ćwiczenia.");
  const p = typeof x.p === "string" ? x.p : JSON.stringify(x.p || null);
  if (!p || p === "null") throw new HttpsError("invalid-argument", "Brak treści ćwiczenia.");
  if (p.length > MAX_P) throw new HttpsError("invalid-argument", "To ćwiczenie jest za duże do biblioteki (zwykle przez duże zdjęcia). Zmniejsz zdjęcia i spróbuj ponownie.");
  try { const o = JSON.parse(p); if (!o || typeof o !== "object") throw 0; } catch (e) { throw new HttpsError("invalid-argument", "Nieprawidłowe ćwiczenie."); }
  const t = str(x.t, 120);
  if (!t) throw new HttpsError("invalid-argument", "Wpisz tytuł ćwiczenia.");
  const id = crypto.createHash("sha1").update(a.uid + ":" + src).digest("hex").slice(0, 20);
  const ref = db().doc("lib/" + id);
  const old = await ref.get();
  if (!old.exists) {
    const cnt = await db().collection("lib").where("owner", "==", a.uid).count().get();
    if (cnt.data().count >= MAX_PER_USER) throw new HttpsError("resource-exhausted", "Masz już " + MAX_PER_USER + " ćwiczeń w bibliotece. Usuń starsze, żeby dodać nowe.");
  }
  const now = admin.firestore.FieldValue.serverTimestamp();
  const doc = {
    owner: a.uid, src, p, t,
    k: str(x.k, 20), ty: str(x.ty, 4), m: str(x.m, 60), d: str(x.d, 300), sm: str(x.sm, 400),
    sub: str(x.sub, 40), lv: str(x.lv, 40), by: str(x.by, 60) || "Nauczyciel", upd: now,
  };
  if (!old.exists) { doc.at = now; doc.n = 0; }
  await ref.set(doc, { merge: true });
  return { id, upd: !!old.exists };
});

// Lista (bez treści ćwiczeń) – filtrowanie i wyszukiwanie robi przeglądarka.
exports.libList = onCall({ region: REGION }, async req => {
  const a = need(req);
  await needActive(a);
  const sel = ["owner", "t", "k", "ty", "m", "d", "sm", "sub", "lv", "by", "n", "at", "upd"];
  const [all, mine] = await Promise.all([
    db().collection("lib").orderBy("at", "desc").limit(LIST_MAX).select(...sel).get(),
    db().collection("lib").where("owner", "==", a.uid).select(...sel).get(),
  ]);
  const seen = new Set(), items = [];
  const adm = isAdmin(a);
  const add = d => { if (seen.has(d.id)) return; seen.add(d.id); const o = META(d); o.mine = d.get("owner") === a.uid; if (adm) o.owner = d.get("owner"); items.push(o); };
  all.forEach(add); mine.forEach(add);
  return { items, adm };
});

// Pobierz treść do skopiowania (licznik kopii rośnie raz na nauczyciela).
exports.libGet = onCall({ region: REGION }, async req => {
  const a = need(req);
  await needActive(a);
  const id = str(req.data && req.data.id, 40);
  if (!/^[a-f0-9]{20}$/.test(id)) throw new HttpsError("invalid-argument", "Nieprawidłowe ćwiczenie.");
  const ref = db().doc("lib/" + id);
  const d = await ref.get();
  if (!d.exists) throw new HttpsError("not-found", "Tego ćwiczenia nie ma już w bibliotece.");
  if (d.get("owner") !== a.uid && !isAdmin(a) && !(req.data && req.data.peek)) {
    try {
      await db().runTransaction(async tx => {
        const c = db().doc("libcp/" + id + "_" + a.uid);
        if ((await tx.get(c)).exists) return;
        tx.set(c, { at: admin.firestore.FieldValue.serverTimestamp() });
        tx.update(ref, { n: admin.firestore.FieldValue.increment(1) });
      });
    } catch (e) { console.error("libGet count", e && e.message); }
  }
  return { p: d.get("p"), t: d.get("t") };
});

// Usuń z biblioteki (autor albo administrator).
exports.libDel = onCall({ region: REGION }, async req => {
  const a = need(req);
  const id = str(req.data && req.data.id, 40);
  if (!/^[a-f0-9]{20}$/.test(id)) throw new HttpsError("invalid-argument", "Nieprawidłowe ćwiczenie.");
  const ref = db().doc("lib/" + id);
  const d = await ref.get();
  if (!d.exists) return { ok: true };
  if (d.get("owner") !== a.uid && !isAdmin(a)) throw new HttpsError("permission-denied", "Możesz usunąć tylko swoje ćwiczenia.");
  await ref.delete();
  return { ok: true };
});
