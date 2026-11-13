// Flowork – e-maile przez Resend: weryfikacja konta, reset hasła, powiadomienie o wyniku ucznia.
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");

const REGION = "europe-west1";
const RESEND_KEY = defineSecret("RESEND_API_KEY");
const FROM = "Flowork <powiadomienia@flowork.pl>";
const REPLY_TO = "wkwebstudio@gmail.com";
const SITE = "https://flowork.pl";
const DAILY_CAP = 30; // maks. powiadomień o wynikach na nauczyciela na dobę

const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function send(to, subject, html, text) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + RESEND_KEY.value(), "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], reply_to: REPLY_TO, subject, html, text })
  });
  if (!r.ok) throw new Error("Resend " + r.status + " " + (await r.text()).slice(0, 200));
}

const layout = (title, body, btn, url) => `<!doctype html><html lang="pl"><body style="margin:0;background:#f5f3fb;font-family:Arial,Helvetica,sans-serif;color:#16132b">
<div style="max-width:520px;margin:0 auto;padding:28px 16px"><div style="font-size:22px;font-weight:700;margin-bottom:18px">Flowork</div>
<div style="background:#fff;border-radius:18px;padding:28px">
<h1 style="font-size:21px;margin:0 0 12px">${esc(title)}</h1>
<div style="font-size:15px;line-height:1.6;color:#3b3857">${body}</div>
${btn ? `<p style="margin:24px 0 6px"><a href="${esc(url)}" style="background:#6340ff;color:#fff;text-decoration:none;font-weight:700;padding:13px 24px;border-radius:99px;display:inline-block">${esc(btn)}</a></p>` : ""}
</div><p style="font-size:12px;color:#8a87a0;margin:16px 6px">Flowork · flowork.pl · KUL-TRANS Paweł Kuldanek</p></div></body></html>`;

// Prosty limit: minimalny odstęp między mailami danego typu do danego klucza.
async function throttle(key, gapMs) {
  const ref = admin.firestore().doc("mailrl/" + crypto.createHash("sha256").update(key).digest("hex").slice(0, 40));
  return admin.firestore().runTransaction(async tx => {
    const s = await tx.get(ref);
    const last = s.exists ? s.data().t : 0;
    if (Date.now() - last < gapMs) return false;
    tx.set(ref, { t: Date.now() });
    return true;
  });
}

const cont = "https://flowork.pl/logowanie.html";

// Ponowne/pierwsze wysłanie linku weryfikacyjnego (użytkownik zalogowany, jeszcze niepotwierdzony).
exports.sendVerification = onCall({ region: REGION, secrets: [RESEND_KEY] }, async req => {
  if (!req.auth || !req.auth.token.email) throw new HttpsError("unauthenticated", "Zaloguj się.");
  if (req.auth.token.email_verified) return { ok: true, already: true };
  const email = req.auth.token.email;
  if (!(await throttle("v:" + req.auth.uid, 60000))) throw new HttpsError("resource-exhausted", "Poczekaj minutę przed kolejną wiadomością.");
  const link = await admin.auth().generateEmailVerificationLink(email, { url: cont });
  await send(email, "Potwierdź adres e-mail w Flowork",
    layout("Potwierdź swój adres e-mail", "Dziękujemy za założenie konta. Kliknij przycisk, aby potwierdzić adres. Po potwierdzeniu zaczyna się 3-godzinny okres próbny.<br><br>Jeśli to nie Ty zakładałeś konto, zignoruj tę wiadomość.", "Potwierdź e-mail", link),
    "Potwierdź adres e-mail w Flowork: " + link);
  return { ok: true };
});

// Reset hasła – zawsze odpowiada „ok”, żeby nie zdradzać, czy konto istnieje.
exports.sendReset = onCall({ region: REGION, secrets: [RESEND_KEY] }, async req => {
  const email = String((req.data && req.data.email) || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) throw new HttpsError("invalid-argument", "Nieprawidłowy adres e-mail.");
  if (!(await throttle("r:" + email, 60000))) return { ok: true };
  try {
    const link = await admin.auth().generatePasswordResetLink(email, { url: cont });
    await send(email, "Zmiana hasła w Flowork",
      layout("Zmiana hasła", "Otrzymaliśmy prośbę o zmianę hasła do Twojego konta. Jeśli to nie Ty, zignoruj tę wiadomość.", "Ustaw nowe hasło", link),
      "Ustaw nowe hasło w Flowork: " + link);
  } catch (e) {
    if (!(e && e.code === "auth/user-not-found")) console.error("sendReset", e && e.message);
  }
  return { ok: true };
});

// Powiadomienie dla nauczyciela, gdy uczeń zakończy ćwiczenie.
exports.notifyResult = onDocumentCreated({ document: "res/{exId}/items/{rid}", region: REGION, secrets: [RESEND_KEY] }, async ev => {
  const d = ev.data && ev.data.data();
  if (!d || !d.owner) return;
  const db = admin.firestore();
  // Sygnał dla panelu nauczyciela: nowy wynik (panel nasłuchuje dokumentu feed/<uid> i od razu pobiera wyniki).
  try { await db.doc("feed/" + d.owner).set({ at: admin.firestore.FieldValue.serverTimestamp(), ex: ev.params.exId, n: admin.firestore.FieldValue.increment(1) }, { merge: true }); } catch (e) { console.error("feed", e && e.message); }
  const prefs = await db.doc("prefs/" + d.owner).get();
  if (prefs.exists && prefs.data().notify === false) return;
  const user = await db.doc("users/" + d.owner).get();
  if (!user.exists || !user.data().email) return;

  const day = new Date().toISOString().slice(0, 10);
  const capRef = db.doc("mailrl/cap_" + d.owner + "_" + day);
  const ok = await db.runTransaction(async tx => {
    const s = await tx.get(capRef);
    const n = s.exists ? s.data().n : 0;
    if (n >= DAILY_CAP) return false;
    tx.set(capRef, { n: n + 1 });
    return true;
  });
  if (!ok) return;

  let title = "ćwiczenie";
  try {
    const ex = await db.doc("ex/" + d.lk).get();
    if (ex.exists) { const p = JSON.parse(ex.data().p); title = p.t || p.title || p.ti || title; }
  } catch (e) {}
  const name = String(d.n || "Uczeń").slice(0, 60);
  const score = d.t ? `${+d.c || 0} / ${+d.t}` : "";
  const body = `<b>${esc(name)}</b> ukończył(a) ćwiczenie „${esc(title)}”.` + (score ? `<br><br>Wynik: <b>${esc(score)}</b>` : "") +
    `<br><br><span style="font-size:13px;color:#8a87a0">Powiadomienia możesz wyłączyć w panelu (przycisk 🔔 na dole ekranu).</span>`;
  await send(user.data().email, `${name} ukończył(a): ${title}`, layout("Nowy wynik ucznia", body, "Zobacz w panelu", SITE + "/panel.html"),
    `${name} ukończył(a) ćwiczenie „${title}”.` + (score ? " Wynik: " + score : "") + " " + SITE + "/panel.html");
});
