// Flowork – polecenia (tydzień gratis dla obu nauczycieli) i statystyki dla panelu admina.
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const Stripe = require("stripe");
const crypto = require("crypto");

const REGION = "europe-west1";
const STRIPE_KEY = defineSecret("STRIPE_SECRET_KEY");
const ADMIN_EMAIL = "wkwebstudio@gmail.com";
const REF_DAYS = 7;          // ile dni gratis dostaje każda ze stron
const REF_MAX = 10;          // maks. nagród za polecenia dla jednego nauczyciela
const CLAIM_WINDOW_DAYS = 14; // kod można wpisać do 14 dni od założenia konta
const DAY = 86400e3;
const ALPH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const db = () => admin.firestore();
const TS = ms => admin.firestore.Timestamp.fromMillis(ms);
const ms = t => (t && t.toMillis ? t.toMillis() : 0);
const need = req => {
  if (!req.auth || !req.auth.token.email_verified) throw new HttpsError("unauthenticated", "Zaloguj się i potwierdź e-mail.");
  return req.auth;
};
const stripeActive = s => s && s.subscriptionId && ["active", "trialing"].includes(s.status) && !s.cancelAtPeriodEnd && ms(s.accessUntil) > Date.now();

// Kod polecający nauczyciela (tworzony przy pierwszym użyciu).
async function codeFor(uid) {
  const uref = db().doc("users/" + uid);
  const u = await uref.get();
  if (!u.exists) throw new HttpsError("failed-precondition", "Najpierw zaloguj się do panelu.");
  if (u.data().ref) return u.data().ref;
  for (let i = 0; i < 8; i++) {
    const code = Array.from(crypto.randomBytes(6), b => ALPH[b % ALPH.length]).join("");
    const ok = await db().runTransaction(async tx => {
      const r = await tx.get(db().doc("refs/" + code));
      const me = await tx.get(uref);
      if (me.data().ref) return me.data().ref;
      if (r.exists) return null;
      tx.set(db().doc("refs/" + code), { uid, at: admin.firestore.FieldValue.serverTimestamp() });
      tx.set(uref, { ref: code }, { merge: true });
      return code;
    });
    if (ok) return ok;
  }
  throw new HttpsError("internal", "Nie udało się utworzyć kodu. Spróbuj ponownie.");
}

exports.refInfo = onCall({ region: REGION }, async req => {
  const a = need(req);
  const code = await codeFor(a.uid);
  const u = (await db().doc("users/" + a.uid).get()).data() || {};
  const age = Date.now() - ms(u.createdAt);
  return {
    code, n: u.refN || 0, max: REF_MAX, days: REF_DAYS,
    by: !!u.refBy,
    canClaim: !u.refBy && age < CLAIM_WINDOW_DAYS * DAY,
  };
});

// Dodaje dni gratis. Gdy nauczyciel ma aktywną subskrypcję w Stripe, przesuwamy mu najbliższą płatność.
// W pozostałych przypadkach wydłużamy dostęp (bonusUntil), którego nie nadpisze późniejsza płatność.
function bonusPlan(sub, days) {
  if (stripeActive(sub)) return { stripe: sub.subscriptionId };
  const now = Date.now();
  const base = Math.max(now, ms(sub && sub.accessUntil), ms(sub && sub.bonusUntil));
  const b = base + days * DAY;
  return { set: { bonusUntil: TS(b), accessUntil: TS(Math.max(ms(sub && sub.accessUntil), b)), status: (sub && sub.status) || "bonus", updatedAt: admin.firestore.FieldValue.serverTimestamp() } };
}
async function stripeBonus(uid, subId, days) {
  const stripe = new Stripe(STRIPE_KEY.value(), { apiVersion: "2025-03-31.basil" });
  const s = await stripe.subscriptions.retrieve(subId);
  const it = s.items && s.items.data && s.items.data[0];
  const end = Math.max(s.trial_end || 0, s.current_period_end || (it && it.current_period_end) || 0, Math.floor(Date.now() / 1000));
  await stripe.subscriptions.update(subId, { trial_end: end + days * 86400, proration_behavior: "none" });
  await db().doc("subs/" + uid).set({ accessUntil: TS((end + days * 86400) * 1000 + 6 * 3600e3), status: "trialing", updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}

exports.claimRef = onCall({ region: REGION, secrets: [STRIPE_KEY] }, async req => {
  const a = need(req);
  const code = String((req.data && req.data.code) || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  if (code.length < 4) throw new HttpsError("invalid-argument", "Wpisz kod polecający.");
  const res = await db().runTransaction(async tx => {
    const meRef = db().doc("users/" + a.uid), rRef = db().doc("refs/" + code);
    const [me, r] = await Promise.all([tx.get(meRef), tx.get(rRef)]);
    if (!me.exists) throw new HttpsError("failed-precondition", "Najpierw zaloguj się do panelu.");
    const m = me.data();
    if (m.refBy) throw new HttpsError("already-exists", "Kod polecający został już użyty na tym koncie.");
    if (Date.now() - ms(m.createdAt) > CLAIM_WINDOW_DAYS * DAY) throw new HttpsError("failed-precondition", "Kod można wpisać tylko w ciągu " + CLAIM_WINDOW_DAYS + " dni od założenia konta.");
    if (!r.exists) throw new HttpsError("not-found", "Nie ma takiego kodu polecającego.");
    const owner = r.data().uid;
    if (owner === a.uid) throw new HttpsError("failed-precondition", "Nie możesz polecić samego siebie 🙂");
    const oRef = db().doc("users/" + owner);
    const [o, sMe, sO] = await Promise.all([tx.get(oRef), tx.get(db().doc("subs/" + a.uid)), tx.get(db().doc("subs/" + owner))]);
    if (!o.exists || o.data().blocked || o.data().trashed) throw new HttpsError("not-found", "Ten kod jest nieaktywny.");
    if (String(o.data().email || "").toLowerCase() === String(m.email || "").toLowerCase()) throw new HttpsError("failed-precondition", "Nie możesz polecić samego siebie 🙂");
    const ownerGets = (o.data().refN || 0) < REF_MAX;
    const pMe = bonusPlan(sMe.exists ? sMe.data() : null, REF_DAYS);
    const pO = ownerGets ? bonusPlan(sO.exists ? sO.data() : null, REF_DAYS) : null;
    const now = admin.firestore.FieldValue.serverTimestamp();
    tx.set(meRef, { refBy: owner, refAt: now }, { merge: true });
    tx.set(oRef, { refN: admin.firestore.FieldValue.increment(1) }, { merge: true });
    tx.set(db().collection("reflog").doc(), { from: owner, to: a.uid, code, at: now, ownerGets });
    if (pMe.set) tx.set(db().doc("subs/" + a.uid), pMe.set, { merge: true });
    if (pO && pO.set) tx.set(db().doc("subs/" + owner), pO.set, { merge: true });
    return { owner, sMe: pMe.stripe, sO: pO && pO.stripe };
  });
  // Subskrypcje w Stripe: przesunięcie najbliższej płatności (po zatwierdzeniu transakcji).
  for (const [uid, sid] of [[a.uid, res.sMe], [res.owner, res.sO]]) {
    if (!sid) continue;
    try { await stripeBonus(uid, sid, REF_DAYS); }
    catch (e) {
      console.error("claimRef stripe", uid, e && e.message);
      const s = await db().doc("subs/" + uid).get();
      const d = s.exists ? s.data() : {};
      const b = Math.max(Date.now(), ms(d.accessUntil), ms(d.bonusUntil)) + REF_DAYS * DAY;
      await db().doc("subs/" + uid).set({ bonusUntil: TS(b), accessUntil: TS(b) }, { merge: true });
    }
  }
  try { await db().doc("stats/d_" + new Date().toISOString().slice(0, 10)).set({ ref: admin.firestore.FieldValue.increment(1) }, { merge: true }); } catch (e) {}
  return { ok: true, days: REF_DAYS };
});

// ---------- Statystyki dla panelu admina ----------
exports.adminStats = onCall({ region: REGION, timeoutSeconds: 120 }, async req => {
  const a = need(req);
  if (a.token.email !== ADMIN_EMAIL) throw new HttpsError("permission-denied", "Brak uprawnień.");
  const DAYS = 30, now = Date.now(), since = now - DAYS * DAY;
  const dk = t => new Date(t).toISOString().slice(0, 10);
  const days = {};
  for (let i = DAYS - 1; i >= 0; i--) days[dk(now - i * DAY)] = { ex: 0, res: 0, sign: 0, ref: 0, act: {} };
  const seen = {}, exN = {}, exNew = {}, resN = {};
  const bump = (uid, t) => { if (t && (!seen[uid] || seen[uid] < t)) seen[uid] = t; };

  const [pan, exs, users, feed, st] = await Promise.all([
    db().collection("panels").get(),
    db().collection("ex").select("owner", "at").get(),
    db().collection("users").select("createdAt").get(),
    db().collection("feed").get(),
    db().collection("stats").where(admin.firestore.FieldPath.documentId(), ">=", "d_" + dk(since)).get(),
  ]);
  pan.forEach(d => { const u = +d.data().upd || 0; bump(d.id, u); const k = dk(u); if (u >= since && days[k]) days[k].act[d.id] = 1; });
  exs.forEach(d => {
    const o = d.data().owner, t = ms(d.data().at); if (!o) return;
    exN[o] = (exN[o] || 0) + 1; bump(o, t);
    if (t >= since) { exNew[o] = (exNew[o] || 0) + 1; const k = dk(t); if (days[k]) { days[k].ex++; days[k].act[o] = 1; } }
  });
  users.forEach(d => { const t = ms(d.data().createdAt); const k = dk(t); if (t >= since && days[k]) days[k].sign++; });
  feed.forEach(d => { resN[d.id] = +d.data().n || 0; bump(d.id, ms(d.data().at)); });
  st.forEach(d => {
    const k = d.id.slice(2); if (!days[k]) return;
    const x = d.data(); days[k].res = +x.res || 0; days[k].ref = +x.ref || 0;
    Object.keys(x.o || {}).forEach(u => days[k].act[u] = 1);
  });
  const act = n => Object.values(seen).filter(t => t >= now - n * DAY).length;
  return {
    days: Object.entries(days).map(([d, v]) => ({ d, ex: v.ex, res: v.res, sign: v.sign, ref: v.ref, act: Object.keys(v.act).length })),
    a1: act(1), a7: act(7), a30: act(30),
    seen, exN, exNew, resN,
  };
});
