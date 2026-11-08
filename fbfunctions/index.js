// Flowork – funkcje serwerowe: płatności Stripe i dostęp do panelu.
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const Stripe = require("stripe");
 
admin.initializeApp();
const db = admin.firestore();
 
const REGION = "europe-west1";
const STRIPE_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WH = defineSecret("STRIPE_WEBHOOK_SECRET");
 
const ADMIN_EMAIL = "wkwebstudio@gmail.com";
const PRICES = {
  monthly: "price_1UZc31R3KgPkCvZg9866e63N",
  quarterly: "price_1UZc5jR3KgPkCvZgKofUYMk1",
  yearly: "price_1UZc5TR3KgPkCvZgJxU7yCGI",
};
const PLAN_BY_PRICE = Object.fromEntries(Object.entries(PRICES).map(([k, v]) => [v, k]));
 
// Adresy, na które Stripe może odesłać użytkownika po płatności.
const ORIGINS = [
  "https://flowork.wkwebstudio.workers.dev",
  "https://flowork.pl",
  "https://www.flowork.pl",
];
const pickOrigin = req => {
  const o = req.rawRequest && req.rawRequest.headers && req.rawRequest.headers.origin;
  return ORIGINS.includes(o) ? o : ORIGINS[0];
};
 
const need = req => {
  if (!req.auth || !req.auth.token.email_verified) throw new HttpsError("unauthenticated", "Zaloguj się i potwierdź e-mail.");
  return req.auth;
};
 
// ---------- Zakup: tworzy sesję Stripe Checkout ----------
exports.createCheckout = onCall({ region: REGION, secrets: [STRIPE_KEY] }, async req => {
  const auth = need(req);
  const plan = req.data && req.data.plan;
  const price = PRICES[plan];
  if (!price) throw new HttpsError("invalid-argument", "Nieznany plan.");
 
  const subRef = db.doc("subs/" + auth.uid);
  const snap = await subRef.get();
  const cur = snap.exists ? snap.data() : {};
  const until = cur.accessUntil && cur.accessUntil.toMillis ? cur.accessUntil.toMillis() : 0;
  if (cur.subscriptionId && ["active", "trialing", "past_due"].includes(cur.status) && !cur.cancelAtPeriodEnd && until > Date.now()) {
    throw new HttpsError("already-exists", "Masz już aktywną subskrypcję. Zarządzaj nią przyciskiem „Zarządzaj subskrypcją”.");
  }
 
  const stripe = new Stripe(STRIPE_KEY.value(), { apiVersion: '2025-03-31.basil' });
  const origin = pickOrigin(req);
  const mk = useCustomer => stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    customer: useCustomer && cur.customerId ? cur.customerId : undefined,
    customer_email: useCustomer && cur.customerId ? undefined : auth.token.email,
    client_reference_id: auth.uid,
    metadata: { uid: auth.uid },
    subscription_data: { metadata: { uid: auth.uid } },
    success_url: origin + "/konto.html?paid=1",
    cancel_url: origin + "/konto.html",
    locale: "pl",
    allow_promotion_codes: true,
    consent_collection: { terms_of_service: "required" },
    managed_payments: { enabled: false },
    custom_text: { terms_of_service_acceptance: { message: "Akceptuję [Regulamin](https://flowork.pl/regulamin.html) i [Politykę prywatności](https://flowork.pl/prywatnosc.html). Zgadzam się na natychmiastowe rozpoczęcie świadczenia usługi cyfrowej i przyjmuję do wiadomości utratę prawa do odstąpienia od umowy." } },
  });
  let session;
  try {
    try {
      session = await mk(true);
    } catch (e) {
      // Zapamiętany klient z innego trybu Stripe (np. testowego) – próbujemy bez niego.
      if (cur.customerId && e && (e.code === "resource_missing" || /No such customer/i.test(e.message || ""))) session = await mk(false);
      else throw e;
    }
  } catch (e) {
    console.error("createCheckout", e && e.type, e && e.code, e && e.message);
    throw new HttpsError("internal", "Płatność chwilowo niedostępna: " + String((e && e.message) || e).slice(0, 180));
  }
  return { url: session.url };
});
 
// ---------- Zarządzanie subskrypcją (anulowanie, zmiana karty, faktury) ----------
exports.createPortal = onCall({ region: REGION, secrets: [STRIPE_KEY] }, async req => {
  const auth = need(req);
  const snap = await db.doc("subs/" + auth.uid).get();
  const customer = snap.exists && snap.data().customerId;
  if (!customer) throw new HttpsError("failed-precondition", "Nie masz jeszcze subskrypcji.");
  const stripe = new Stripe(STRIPE_KEY.value(), { apiVersion: '2025-03-31.basil' });
  const s = await stripe.billingPortal.sessions.create({ customer, return_url: pickOrigin(req) + "/konto.html" });
  return { url: s.url };
});
 
// ---------- Zapis stanu subskrypcji w bazie ----------
const periodEndMs = sub => {
  const it = sub.items && sub.items.data && sub.items.data[0];
  const sec = sub.current_period_end || (it && it.current_period_end) || 0;
  return sec * 1000;
};
 
// Dostęp = opłacony okres + zapas na opóźnienie webhooka; przy nieudanej płatności 3 dni karencji.
function accessFor(sub, now) {
  const end = periodEndMs(sub);
  if (sub.status === "active" || sub.status === "trialing") return end + 6 * 3600e3;
  if (sub.status === "past_due") return end + 3 * 86400e3;
  if (sub.status === "canceled") return end > now ? end : 0;
  return 0; // incomplete, unpaid, itd.
}
 
async function uidFor(sub, hint) {
  if (hint) return hint;
  if (sub.metadata && sub.metadata.uid) return sub.metadata.uid;
  const q = await db.collection("subs").where("customerId", "==", sub.customer).limit(1).get();
  return q.empty ? null : q.docs[0].id;
}
 
async function syncSub(sub, hintUid) {
  const uid = await uidFor(sub, hintUid);
  if (!uid) { console.warn("Brak uid dla subskrypcji", sub.id); return; }
  const it = sub.items.data[0];
  const until = accessFor(sub, Date.now());
  await db.doc("subs/" + uid).set({
    customerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    subscriptionId: sub.id,
    status: sub.status,
    plan: PLAN_BY_PRICE[it.price.id] || "unknown",
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    accessUntil: admin.firestore.Timestamp.fromMillis(until),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}
exports._accessFor = accessFor; // do testów
 
exports.stripeWebhook = onRequest({ region: REGION, secrets: [STRIPE_KEY, STRIPE_WH] }, async (req, res) => {
  const stripe = new Stripe(STRIPE_KEY.value(), { apiVersion: '2025-03-31.basil' });
  let ev;
  try {
    ev = stripe.webhooks.constructEvent(req.rawBody, req.headers["stripe-signature"], STRIPE_WH.value());
  } catch (e) {
    return res.status(400).send("Bad signature");
  }
  try {
    if (ev.type === "checkout.session.completed") {
      const s = ev.data.object;
      if (s.mode === "subscription" && s.subscription) {
        const sub = await stripe.subscriptions.retrieve(s.subscription);
        await syncSub(sub, s.client_reference_id || (s.metadata && s.metadata.uid));
      }
    } else if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(ev.type)) {
      await syncSub(ev.data.object);
    } else if (ev.type === "invoice.paid" || ev.type === "invoice.payment_failed") {
      const inv = ev.data.object;
      const sid = inv.subscription || (inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription);
      if (sid) await syncSub(await stripe.subscriptions.retrieve(sid));
    }
  } catch (e) {
    console.error("webhook error", ev.type, e);
    return res.status(500).send("error"); // Stripe ponowi
  }
  res.json({ received: true });
});
 
// ---------- Panel admina: ręczne przyznanie dni dostępu ----------
exports.adminGrant = onCall({ region: REGION }, async req => {
  const a = need(req);
  if (a.token.email !== ADMIN_EMAIL) throw new HttpsError("permission-denied", "Brak uprawnień.");
  const uid = String((req.data && req.data.uid) || "");
  const days = Math.max(-365, Math.min(365, Math.round(+(req.data && req.data.days) || 0)));
  if (!uid || !days) throw new HttpsError("invalid-argument", "Podaj użytkownika i liczbę dni.");
  const ref = db.doc("subs/" + uid);
  const snap = await ref.get();
  const cur = snap.exists && snap.data().accessUntil && snap.data().accessUntil.toMillis ? snap.data().accessUntil.toMillis() : 0;
  const base = Math.max(cur, Date.now());
  await ref.set({
    accessUntil: admin.firestore.Timestamp.fromMillis(days > 0 ? base + days * 86400e3 : Math.max(0, cur + days * 86400e3)),
    status: (snap.exists && snap.data().status) || "manual",
    manual: true,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return { ok: true };
});
// ---------- E-maile (Resend) ----------
Object.assign(exports, require("./mail"));
