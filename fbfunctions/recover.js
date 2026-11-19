// Flowork – odzyskiwanie ćwiczeń: lista ćwiczeń opublikowanych pod linkami przez zalogowanego nauczyciela.
// Zwraca tylko krótkie dane (bez treści). Treść panel pobiera sam, po identyfikatorze linku.
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const REGION = "europe-west1";

exports.exMine = onCall({ region: REGION, memory: "512MiB", timeoutSeconds: 120 }, async req => {
  if (!req.auth || !req.auth.token.email_verified) throw new HttpsError("unauthenticated", "Zaloguj się i potwierdź e-mail.");
  const snap = await admin.firestore().collection("ex").where("owner", "==", req.auth.uid).get();
  const out = [];
  snap.forEach(d => {
    let o = null;
    try { o = JSON.parse(d.get("p")); } catch (e) {}
    if (!o || typeof o !== "object") return;
    const at = d.get("at");
    out.push({
      lk: d.id,
      i: String(o.i || "").slice(0, 40),
      k: String(o.k || "").slice(0, 4),
      md: String(o.md || "").slice(0, 10),
      t: String(o.t || "").slice(0, 120),
      at: at && at.toMillis ? at.toMillis() : 0,
    });
  });
  out.sort((a, b) => b.at - a.at);
  return { items: out.slice(0, 1500) };
});
