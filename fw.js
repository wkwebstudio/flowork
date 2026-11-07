
// Warstwa danych panelu i ćwiczeń: tłumaczy stare zapytania (styl Realtime Database) na Firestore.
//   /ex/<id>     – ćwiczenie dla uczniów (czyta każdy, kto zna link, o ile właściciel ma aktywny dostęp)
//   /res/<id>    – wyniki uczniów (kolekcja res/<id>/items)
//   /panel/<key> – stan panelu nauczyciela (tylko właściciel, dzielony na kawałki)
import { db, serverTimestamp, doc, getDoc, setDoc } from "/fb.js";
import { collection, addDoc, getDocs } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
 
const maps = {}; // id ćwiczenia -> { owner, lk }, zapamiętane przy odczycie linku przez ucznia
const CH = 600000; // znaków na kawałek (limit dokumentu to ok. 1 MB)
 
export function makeReq(uid) {
  return async function req(path, method, body) {
    const seg = String(path).split("/").filter(Boolean);
    if (seg[0] === "ex" && seg.length === 2) {
      if (seg[1] === "_test") return { ok: 1 };
      const ref = doc(db, "ex", seg[1]);
      if (method === "PUT") {
        if (!uid) throw new Error("Brak logowania");
        await setDoc(ref, { owner: uid, p: JSON.stringify(body), at: serverTimestamp() });
        return body;
      }
      try {
        const s = await getDoc(ref);
        if (!s.exists()) return null;
        const o = JSON.parse(s.data().p);
        if (o && o.i) maps[o.i] = { owner: s.data().owner, lk: seg[1] };
        return o;
      } catch (e) {
        if (e && e.code === "permission-denied") throw new Error("inactive");
        throw e;
      }
    }
    if (seg[0] === "res" && seg.length === 2) {
      const col = collection(db, "res", seg[1], "items");
      if (method === "POST") {
        const m = maps[seg[1]];
        if (!m) throw new Error("Brak kontekstu linku");
        const o = { owner: m.owner, lk: m.lk, n: String(body.n || "").slice(0, 60), c: +body.c || 0, t: +body.t || 0, d: String(body.d || ""), at: serverTimestamp() };
        if (body.a !== undefined) o.aj = JSON.stringify(body.a);
        await addDoc(col, o);
        return { name: "ok" };
      }
      const q = await getDocs(col);
      const out = {};
      q.forEach(d => {
        const v = d.data();
        const r = { n: v.n, c: v.c, t: v.t, d: v.d };
        if (v.aj) { try { r.a = JSON.parse(v.aj); } catch (e) {} }
        out[d.id] = r;
      });
      return Object.keys(out).length ? out : null;
    }
    if (seg[0] === "panel") {
      if (!uid) throw new Error("Brak logowania");
      const head = doc(db, "panels", uid);
      if (method === "PUT") {
        const s = JSON.stringify(body);
        const n = Math.max(1, Math.ceil(s.length / CH));
        for (let i = 0; i < n; i++) await setDoc(doc(db, "panels", uid, "chunks", String(i)), { s: s.slice(i * CH, (i + 1) * CH) });
        await setDoc(head, { n, upd: +body.upd || Date.now() });
        return body;
      }
      const h = await getDoc(head);
      if (!h.exists()) return null;
      const n = h.data().n || 1;
      let s = "";
      for (let i = 0; i < n; i++) {
        const c = await getDoc(doc(db, "panels", uid, "chunks", String(i)));
        if (!c.exists()) return null;
        s += c.data().s;
      }
      return JSON.parse(s);
    }
    throw new Error("Nieznana ścieżka " + path);
  };
}
 