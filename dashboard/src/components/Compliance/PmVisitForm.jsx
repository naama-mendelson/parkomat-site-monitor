// components/Compliance/PmVisitForm.jsx — מילוי ביקור תחזוקה מונעת, בטלפון, בחניון.
//
// ============================================================
// ⚠️ המכשיר שומר קודם, השרת מתעדכן אחר כך — ושום וי לא חוזר לאחור
// ============================================================
// הטופס הזה ממולא בחניון תת-קרקעי, שם הקליטה נופלת באמצע פריט. כל וי,
// הערה ותמונה נכתבים קודם לתיבת היוצאים במכשיר (utils/pmOutbox.js) ומוצגים
// מיד; הסנכרון לשרת רץ ברקע. הסדר בתצוגה, מהחלש לחזק:
//
//     שרת (pm_site)  <  "נשלח ואושר, השרת עוד לא נקרא מחדש"  <  ממתין בתיבה
//
// ⚠️ השכבה האמצעית היא לא קישוט, והיא **בתיבה ולא כאן**. בלעדיה, ברגע
// שהתיבה מקבלת אישור ומוציאה את הרשומה — ולפני שקריאה חדשה של pm_site
// מצליחה — המסך היה מציג את מצב השרת **הישן**: וי שנעלם, תמונה שלא נספרת.
// כשהיא חיה בטופס, "חזרה לסקירה" → "המשך" או רענון היו מוחקים אותה. ערך
// שאושר נשאר עד שמגיעה תשובת שרת ש**התחילה אחרי** האישור (`serverAt`).
//
// ⚠️ תמונות: PhotoPicker מציג "נשמר" לכל מה שמגיע ב-initial. לכן ל-initial
// נכנסות **רק** תמונות שהשרת מכיר (או שאישר). תמונה שממתינה במכשיר והטופס
// לא מכיר (אחרי רענון / לשונית שנהרגה) מוצגת ברשת נפרדת, באותו עיצוב, עם
// "נשמר במכשיר · ממתין לסנכרון" — ולא כ"✓ נשמר" ירוק על משהו שלא הגיע לשרת.
//
// ⚠️ הגשה דורשת חיבור ותיבה ריקה. מה שחסר לשליחה מוצג כרשימה מעל הכפתור —
// כפתור מושבת בלי הסבר הוא "לא עובד". ובזמן ההגשה הכול נעול: שינוי שנכנס
// לתיבה באמצע היה נמחק בשקט ב-clearVisit — או נכנס לביקור החתום בלי שנראה.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  submitPmVisit, discardPmVisit, deletePmPhoto, fetchComplianceThumbs, pmOutboxSenders,
} from "../../services/dataSource";
import {
  subscribe, pendingFor, pendingCount, ackedFor, pruneAcked, forgetAckedPhoto, thumbFor, isPersistent,
  enqueueCheck, enqueueNote, enqueuePhoto, removePhoto, retryStuck, discardStuck, discardForeign, clearVisit,
  drain, refreshIndex,
} from "../../utils/pmOutbox";
import { formatDateIL, formatStampIL } from "../../utils/compliance";
import { newId } from "../../utils/complianceFiles";
import PhotoPicker from "./PhotoPicker";
import SignaturePad from "./SignaturePad";
import { CameraIcon, ReasonForm } from "./PmCommon";
import {
  DISCARD_IDLE_MS, ITEM_NOTE_MAX, MAX_PHOTOS_PER_ITEM, NAME_KEY, NAME_MAX, VISIT_NOTE_MAX,
  agoText, countText, idleMs, readStore, sameName, submitDateRange, submitReqKey, writeStore,
} from "./PmUtils";

const NOTE_DEBOUNCE_MS = 800;
const ENTRY_KIND = { check: "סימון", note: "הערה", photo: "תמונה", undo: "מחיקת תמונה" };
// ⚠️ קבוע ולא `[]` בכל רינדור: אפקטים כאן תלויים ב-items, ומערך חדש בכל
// רינדור היה מריץ אותם שוב ושוב — ואחד מהם מעדכן state.
const NO_ITEMS = [];

function readOutbox(visitId, snap) {
  const v = String(visitId);
  return {
    count: pendingCount(visitId),
    mine: pendingFor(visitId),
    acked: ackedFor(visitId),
    persistent: snap ? !!snap.persistent : isPersistent(),
    foreign: snap?.foreign ?? 0,
    draining: !!snap?.draining,
    dropped: (snap?.dropped || []).filter((d) => String(d.visitId) === v),
  };
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
// ממוזערת שכבר אצלנו: צולמה בטופס הזה, או נשמרה בתיבה כשהתמונה אושרה
const thumbOf = (local, cid) => (cid ? local.get(cid) ?? thumbFor(cid) : null);

// requestId של ההגשה — אחד לביקור, ושורד טופס חדש ורענון (ראה submitReqKey)
function requestIdFor(visitId) {
  const k = submitReqKey(visitId);
  const old = readStore("sessionStorage", k);
  if (old) return old;
  const id = newId();
  writeStore("sessionStorage", k, id);
  return id;
}

/**
 * @param {object} p
 * @param {object} p.draft — הטיוטה מ-pm_site
 * @param {number} p.serverAt — מתי **התחילה** השליפה שהביאה את draft (שעון המכשיר; 0 = לא ידוע)
 * @param {() => Promise<object|null>} p.onReload — שליפה שקטה של pm_site; מחזירה את התוצאה
 * @param {(res) => void} p.onSubmitted
 * @param {(visitId) => void} p.onDiscarded
 */
export default function PmVisitForm({
  draft, serverAt = 0, user, me, isManager, online, refreshError, cached = false,
  onReload, onSubmitted, onDiscarded, onDirty, onBack,
}) {
  const visitId = draft.id;
  const items = Array.isArray(draft.items) ? draft.items : NO_ITEMS;

  // ---------------- תיבת היוצאים ----------------
  const [ob, setOb] = useState(() => readOutbox(visitId, null));
  useEffect(() => subscribe((s) => setOb(readOutbox(visitId, s))), [visitId]);
  const obRef = useRef(ob);
  useEffect(() => { obRef.current = ob; }, [ob]);

  const kick = useCallback(() => { drain(pmOutboxSenders).catch(() => {}); }, []);
  const onReloadRef = useRef(onReload);
  useEffect(() => { onReloadRef.current = onReload; }, [onReload]);
  const reloadTimer = useRef(null);
  const scheduleReload = useCallback(() => {
    clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => { onReloadRef.current?.(); }, 400);
  }, []);
  useEffect(() => () => clearTimeout(reloadTimer.current), []);

  // רשומה שיצאה מהתיבה (אושרה, נזרקה, או שוויתרו עליה) → קריאה חדשה של השרת,
  // כדי שהשכבה "אושר" תתחלף במצב השרת בהקדם.
  const prevKeysRef = useRef(null);
  useEffect(() => {
    const keys = new Set();
    for (const [itemId, e] of Object.entries(ob.mine.items)) for (const f of Object.keys(e)) keys.add(`f|${itemId}|${f}`);
    for (const p of ob.mine.photos) keys.add(`p|${p.clientId}`);
    for (const u of ob.mine.undo) keys.add(`u|${u.clientId}`);
    const prev = prevKeysRef.current;
    prevKeysRef.current = keys;
    if (prev && [...prev].some((k) => !keys.has(k))) scheduleReload();
  }, [ob, scheduleReload]);

  // תשובת שרת חדשה מכסה כל אישור שקדם לשליפה שלה
  useEffect(() => { if (serverAt > 0) pruneAcked(visitId, serverAt); }, [visitId, serverAt]);
  // אישור "טרי" = מאוחר מהשליפה שהביאה את מצב השרת המוצג
  const fresh = useCallback((x) => !!x && !(serverAt > 0 && !(x.at >= serverAt)), [serverAt]);

  // ---------------- תמונות: ממוזערות ומחיקות ----------------
  const [thumbs, setThumbs] = useState(() => new Map());       // file id → thumb
  const localThumbs = useRef(new Map());                         // client_id → thumb (צולם כאן)
  const thumbsTried = useRef(new Set());
  const thumbsBusy = useRef(false);
  // נמחקו כאן — לא יחזרו מרשימה ישנה. ref לקריאה מיידית, ו-state כדי לרנדר
  // (ול-PhotoPicker, שמוריד אותן מהרשימה שלו — prop `gone`).
  const removedCids = useRef(new Set());
  const [gone, setGone] = useState(() => new Set());
  const markRemoved = useCallback((cid) => {
    if (!cid || removedCids.current.has(cid)) return;
    removedCids.current.add(cid);
    setGone(new Set(removedCids.current));
  }, []);

  const undoSet = useMemo(() => new Set(ob.mine.undo.map((u) => u.clientId)), [ob]);
  const isRemoved = useCallback((cid) => !!cid && (gone.has(cid) || undoSet.has(cid)), [gone, undoSet]);

  // ⚠️ ממוזערות נשלפות רק כשיש בשרת תמונה שאין לנו — לא בכל סקירה של 20
  // שניות. 40 ממוזערות של עד 40KB בכל סקירה היו ~5MB בדקה, על מכסת תעבורה
  // שכבר נחרגה. תמונה שצולמה כאן כבר ממוזערת אצלנו (localThumbs / התיבה).
  useEffect(() => {
    const ids = [];
    for (const it of items) {
      for (const ph of it.photos || []) {
        if (!thumbs.has(ph.id) && !thumbOf(localThumbs.current, ph.client_id) && !thumbsTried.current.has(ph.id)) ids.push(ph.id);
      }
    }
    if (!ids.length || thumbsBusy.current) return;
    thumbsBusy.current = true;
    fetchComplianceThumbs("pm_visit", visitId)
      .then((rows) => {
        for (const id of ids) thumbsTried.current.add(id);
        setThumbs((prev) => {
          const next = new Map(prev);
          for (const r of rows) if (r.thumb) next.set(r.id, r.thumb);
          return next;
        });
      })
      .catch(() => { /* בלי קליטה — ננסה בתשובת השרת הבאה */ })
      .finally(() => { thumbsBusy.current = false; });
  }, [items, thumbs, visitId]);

  // תמונות שאושרו לכל פריט ועוד לא בתשובת השרת
  const ackedPhotosOf = useCallback((itemId, serverCids) => ob.acked.photos.filter((ph) =>
    ph.itemId === itemId && fresh(ph) && !isRemoved(ph.clientId) && !serverCids.has(ph.clientId)), [ob, fresh, isRemoved]);

  // initial לכל פריט — רק מה שהשרת מכיר או אישר (ראה הכותרת). יציב בין רינדורים.
  const [initialByItem, setInitialByItem] = useState(() => new Map());
  useEffect(() => {
    setInitialByItem((prev) => {
      const next = new Map();
      let changed = prev.size !== items.length;
      for (const it of items) {
        const key = String(it.id);
        const server = (it.photos || [])
          .filter((ph) => !isRemoved(ph.client_id))
          .map((ph) => ({ id: ph.id, client_id: ph.client_id, thumb: thumbs.get(ph.id) ?? thumbOf(localThumbs.current, ph.client_id) }));
        const known = new Set(server.map((s) => s.client_id).filter(Boolean));
        const acked = ackedPhotosOf(key, known)
          .map((ph) => ({ id: ph.fileId ?? undefined, client_id: ph.clientId, thumb: thumbOf(localThumbs.current, ph.clientId) ?? ph.thumb }));
        const list = [...server, ...acked];
        const old = prev.get(key);
        const same = old && old.length === list.length
          && old.every((o, i) => o.id === list[i].id && o.client_id === list[i].client_id && o.thumb === list[i].thumb);
        if (!same) changed = true;
        next.set(key, same ? old : list);
      }
      // ⚠️ אותה מפה כשדבר לא השתנה — PhotoPicker מתאם מחדש על כל initial חדש
      return changed ? next : prev;
    });
  }, [items, thumbs, isRemoved, ackedPhotosOf]);

  // מה ש-PhotoPicker של כל פריט מכיר כרגע (כדי לדעת אילו ממתינות "יתומות")
  const [pickers, setPickers] = useState({});
  const onPickerChange = useCallback((itemId, s) => {
    const next = {
      cids: s.items.map((i) => i.clientId),
      busy: !!s.busy,
      failed: s.items.filter((i) => i.status === "failed" && i.compressed).length,
    };
    setPickers((prev) => {
      const cur = prev[itemId];
      if (cur && cur.busy === next.busy && cur.failed === next.failed && sameList(cur.cids, next.cids)) return prev;
      return { ...prev, [itemId]: next };
    });
  }, []);

  const serverIdFor = (data, clientId) => {
    for (const it of data?.draft?.items || data?.items || []) {
      for (const ph of it.photos || []) if (ph.client_id === clientId) return ph.id;
    }
    return null;
  };

  const removeServerOrPending = async (clientId, knownId) => {
    const pending = clientId && obRef.current.mine.photos.some((p) => p.clientId === clientId);
    if (pending) {
      // ⚠️ התיבה מחליטה: תמונה שאולי כבר בשרת (נשלחה / בדרך) נרשמת כ"ביטול"
      // שממתין לסנכרון — ולא נעלמת מקומית בלבד.
      markRemoved(clientId);
      await removePhoto(clientId);
      return;
    }
    const acked = clientId ? obRef.current.acked.photos.find((p) => p.clientId === clientId) : null;
    let fid = knownId ?? acked?.fileId ?? (clientId ? serverIdFor({ draft }, clientId) : null);
    if (fid == null && clientId) {
      // אושרה בתיבה אבל בלי id — שולפים ומחפשים שוב
      fid = serverIdFor(await onReloadRef.current?.(), clientId);
    }
    if (fid == null) throw new Error("התמונה עוד לא סונכרנה — נסו שוב בעוד רגע");
    await deletePmPhoto(fid);
    if (clientId) {
      markRemoved(clientId);
      forgetAckedPhoto(visitId, clientId);
    }
    scheduleReload();
  };

  // ---------------- הערות: השהיה של 800ms לתוך התיבה ----------------
  const [noteDrafts, setNoteDrafts] = useState({});           // itemId → טקסט שעוד בהשהיה
  // ⚠️ itemId → {text, typed}: השדה בזמן שיש בו פוקוס. השרת שומר הערה **מנורמלת**
  // (btrim), ותשובה שלו שמגיעה באמצע הקלדה הייתה דורסת את השדה — "בדקתי "
  // הופך ל"בדקתי", והמילה הבאה נדבקת. לכן אחרי הקלדה השדה הוא הסמכות.
  // ⚠️ אבל **רק** אחרי הקלדה. שדה שקיבל פוקוס ועוד לא הוקלד בו גובר על
  // השרת רק כשההבדל הוא רווחים בלבד (אותה הערה, מנורמלת). אחרת הערה חדשה של
  // טכנאי אחר (D16 — שניים על אותו ביקור) הייתה מוסתרת מתחת לסמן, וההקלדה
  // הראשונה הייתה דורסת אותה בשרת בלי שאיש ראה אותה.
  const [noteEdit, setNoteEdit] = useState({});
  const noteTimers = useRef(new Map());                        // itemId → {timer, text}
  const [noteOpen, setNoteOpen] = useState(() => new Set());
  const [justOpened, setJustOpened] = useState(null);         // הערה שנפתחה בלחיצה — מקבלת פוקוס

  const flushNote = useCallback((itemId) => {
    const t = noteTimers.current.get(itemId);
    if (!t) return;
    clearTimeout(t.timer);
    noteTimers.current.delete(itemId);
    enqueueNote(visitId, itemId, t.text);
    setNoteDrafts((d) => {
      const n = { ...d };
      delete n[itemId];
      return n;
    });
    kick();
  }, [visitId, kick]);

  const flushRef = useRef(flushNote);
  useEffect(() => { flushRef.current = flushNote; }, [flushNote]);
  // ⚠️ סגירה באמצע הקלדה: ההערה נכנסת לתיבה עכשיו, לא נזרקת עם הטיימר.
  useEffect(() => () => {
    for (const id of [...noteTimers.current.keys()]) flushRef.current(id);
  }, []);

  const onNoteChange = (itemId, text) => {
    setNoteEdit((e) => ({ ...e, [itemId]: { text, typed: true } }));
    setNoteDrafts((d) => ({ ...d, [itemId]: text }));
    // השדה נשאר פתוח גם כשנמחק עד הסוף — אחרת היה נעלם מתחת לאצבע
    setNoteOpen((s) => (s.has(itemId) ? s : new Set(s).add(itemId)));
    const t = noteTimers.current.get(itemId);
    if (t) clearTimeout(t.timer);
    noteTimers.current.set(itemId, { text, timer: setTimeout(() => flushRef.current(itemId), NOTE_DEBOUNCE_MS) });
  };
  const onNoteFocus = (itemId, current) => setNoteEdit((e) => (itemId in e ? e : { ...e, [itemId]: { text: current, typed: false } }));
  const onNoteBlur = (itemId) => {
    flushRef.current(itemId);
    setNoteEdit((e) => {
      if (!(itemId in e)) return e;
      const n = { ...e };
      delete n[itemId];
      return n;
    });
    setJustOpened((j) => (j === itemId ? null : j));
  };

  // ---------------- וי ----------------
  const toggle = (itemId, next) => {
    enqueueCheck(visitId, itemId, next);       // מיידי, ולעולם אינו מוחזר לאחור
    kick();
  };

  // ---------------- המצב הממוזג של כל פריט ----------------
  const myName = me || user?.email || null;
  const stuckPhoto = new Map(ob.mine.stuck.filter((s) => s.kind === "photo").map((s) => [s.clientId, s.error]));
  const merged = items.map((it) => {
    const id = String(it.id);
    const p = ob.mine.items[id] || {};
    const a = ob.acked.items[id] || {};
    const ac = fresh(a.checked) ? a.checked : null;
    const an = fresh(a.note) ? a.note : null;
    const checked = "checked" in p ? !!p.checked : ac ? !!ac.value : !!it.checked;
    const baseNote = "note" in p ? p.note : an ? an.value : (it.note ?? "");
    const ed = noteEdit[id];
    const note = ed && (ed.typed || ed.text.trim() === String(baseNote ?? "").trim())
      ? ed.text
      : noteDrafts[id] ?? baseNote;
    const serverPhotos = (it.photos || []).filter((ph) => !isRemoved(ph.client_id));
    const serverCids = new Set(serverPhotos.map((ph) => ph.client_id).filter(Boolean));
    const ackedPhotos = ackedPhotosOf(id, serverCids);
    const pendingPhotos = ob.mine.photos.filter((ph) => String(ph.itemId) === id && !isRemoved(ph.clientId));
    // ⚠️ תמונה שהשרת דחה אינה "ממתינה" ואינה ממלאת את min_photos — היא לא תגיע לבד
    const livePending = pendingPhotos.filter((ph) => !stuckPhoto.has(ph.clientId));
    const known = new Set(pickers[id]?.cids || []);
    const orphans = pendingPhotos.filter((ph) => !known.has(ph.clientId));
    const photoN = new Set([
      ...serverPhotos.map((ph) => ph.client_id ?? `id:${ph.id}`),
      ...ackedPhotos.map((ph) => ph.clientId),
      ...livePending.map((ph) => ph.clientId),
    ]).size;
    const needsCheck = it.kind !== "photo";
    const missing = !!it.required && ((needsCheck && !checked) || photoN < (it.min_photos || 0));
    const stuck = ob.mine.stuck.filter((s) => String(s.itemId) === id);
    const undoHere = ob.mine.undo.some((u) => u.itemId === id);
    const localTouched = "checked" in p || "note" in p || !!ac || !!an || noteDrafts[id] != null
      || pendingPhotos.length > 0 || ackedPhotos.length > 0;
    const pending = "checked" in p || "note" in p || noteDrafts[id] != null || livePending.length > 0
      || undoHere || !!pickers[id]?.busy;
    const onServer = !!it.checked || !!it.note || serverPhotos.length > 0;
    let status = null;
    if (stuck.length) status = { cls: "error", text: "השרת דחה שינוי בפריט — ראו למעלה" };
    else if (pending) status = { cls: "pending", text: "נשמר במכשיר · ממתין לסנכרון" };
    else if (onServer || ac || an || ackedPhotos.length) status = { cls: "saved", text: "✓ נשמר" };
    const byOther = !localTouched && it.updated_by && !sameName(it.updated_by, myName) ? it.updated_by : null;
    const rejected = new Map(pendingPhotos.filter((ph) => stuckPhoto.has(ph.clientId)).map((ph) => [ph.clientId, stuckPhoto.get(ph.clientId)]));
    return { it, id, checked, note, serverPhotos, pendingPhotos, orphans, photoN, missing, status, byOther, rejected };
  });

  const missing = merged.filter((m) => m.missing);
  const requiredN = merged.filter((m) => m.it.required).length;
  const doneN = merged.filter((m) => m.it.required && !m.missing).length;
  const pickerBusy = Object.values(pickers).some((p) => p.busy);
  const pickerFailed = Object.values(pickers).reduce((n, p) => n + p.failed, 0);
  const noteDraftN = Object.keys(noteDrafts).length;
  const stuckN = ob.mine.stuck.length;
  const waitN = ob.mine.waiting;

  // ---------------- קבוצות (07/10/2026) ----------------
  // במסמך סוטפין: "4 שורות לביצוע הטכנאי — מעלית, שאטל, דולי, לובי. לחיצה פותחת פירוט; אם
  // ביצע את כולם השורה ירוקה, ואז הוא ייכנס לשורה הבאה". קבוצה = רצף פריטים עם אותו section,
  // שצולם בפתיחת הביקור (הקבוצה של הפריט, או שם הרשימה). קבוצה אחת, או ביקור מלפני הקבוצות —
  // רשימה אחת בלי כותרת, כמו קודם.
  // ⚠️ פריטים של קבוצה סגורה נשארים מורכבים (hidden) ולא מוסרים: PhotoPicker שמתפרק באמצע
  // דחיסה היה מאבד את התמונה.
  const groups = [];
  for (const m of merged) {
    const name = m.it.section || "";
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.items.push(m);
    else groups.push({ key: m.id, name, items: [m] });
  }
  for (const g of groups) {
    g.required = g.items.filter((m) => m.it.required).length;
    g.missing = g.items.filter((m) => m.missing).length;
    g.done = g.missing === 0;
    // "סיים את השורה" = אין חובה חסרה וגם כל וי (כולל רשות) סומן — רק אז עוברים לבאה,
    // כדי לא לסגור לטכנאי קבוצה שבה עוד נשאר לו פריט רשות.
    g.finished = g.done && g.items.every((m) => m.it.kind === "photo" || m.checked);
  }
  const grouped = groups.length > 1 && groups.some((g) => g.name);
  const [openGroups, setOpenGroups] = useState(() => {
    const first = groups.find((g) => !g.done);
    return new Set(first ? [first.key] : []);
  });
  const toggleGroup = (key) => setOpenGroups((s) => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });
  // מעבר לשורה הבאה: קבוצה **פתוחה** שהסתיימה עכשיו נסגרת, והבאה שלא הושלמה נפתחת.
  // רק במעבר (לא-גמור → גמור) — קבוצה שנפתחה מחדש אחרי שהושלמה נשארת פתוחה.
  const finishedSig = groups.map((g) => (g.finished ? "1" : "0")).join("");
  const prevFinished = useRef(null);
  useEffect(() => {
    const before = prevFinished.current;
    prevFinished.current = new Map(groups.map((g) => [g.key, g.finished]));
    if (!before || !grouped) return;
    const g = groups.find((x) => x.finished && before.get(x.key) === false && openGroups.has(x.key));
    if (!g) return;
    const i = groups.indexOf(g);
    const next = groups.slice(i + 1).find((x) => !x.done) || groups.find((x) => !x.done);
    setOpenGroups((s) => {
      const n = new Set(s);
      n.delete(g.key);
      if (next) n.add(next.key);
      return n;
    });
    requestAnimationFrame(() => document.getElementById(`pm-group-${visitId}-${g.key}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [finishedSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const [scrollTo, setScrollTo] = useState(null);

  // ---------------- סיום וחתימה ----------------
  const range = submitDateRange(draft.started_at);
  const [performerName, setPerformerName] = useState(() => readStore("localStorage", NAME_KEY) || "");
  const [performedOn, setPerformedOn] = useState(range.max);
  const [visitNote, setVisitNote] = useState("");
  const [sig, setSig] = useState({ empty: true, acceptable: false });
  const padRef = useRef(null);
  // ⚠️ אחד לביקור (sessionStorage), לא לטופס: ניסיון חוזר מטופס חדש = אותה הגשה
  const [requestId] = useState(() => requestIdFor(visitId));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);    // {kind:'refused'|'unknown'|'done', text}
  const [discardOpen, setDiscardOpen] = useState(false);
  const footerRef = useRef(null);
  const discardBtnRef = useRef(null);
  const discardWasOpen = useRef(false);
  useEffect(() => {
    if (discardWasOpen.current && !discardOpen) discardBtnRef.current?.focus();
    discardWasOpen.current = discardOpen;
  }, [discardOpen]);

  const nameOk = performerName.trim().length >= 2;
  const dateOk = !!performedOn && performedOn >= range.min && performedOn <= range.max;

  const blockers = [];
  // ⚠️ "סנכרון עכשיו" נאמר כאן במפורש: תמונה שתם זמנה בקישור חלש מחכה להשהיה
  // שלה, וטכנאי שכבר עלה לרחוב לא יודע שיש כפתור שמדלג עליה.
  if (waitN > 0) {
    blockers.push(`${countText(waitN, "פריט אחד ממתין", "פריטים ממתינים")} לסנכרון`
      + (online ? " — „סנכרון עכשיו” למעלה שולח מיד" : ""));
  }
  if (stuckN > 0) blockers.push(`${countText(stuckN, "שינוי אחד נדחה", "שינויים נדחו")} ע״י השרת — „נסה שוב” או „ותר” בראש הטופס`);
  if (noteDraftN > 0) blockers.push("הערה בהקלדה עוד לא נשמרה");
  if (pickerBusy) blockers.push("תמונה עדיין בעיבוד");
  if (missing.length > 0) blockers.push(missing.length === 1 ? "חסר פריט חובה אחד" : `חסרים ${missing.length} פריטי חובה`);
  if (!nameOk) blockers.push("יש לציין את שם המבצע");
  if (!dateOk) blockers.push(`תאריך הביצוע חייב להיות בין ${formatDateIL(range.min)} ל-${formatDateIL(range.max)}`);
  if (!sig.acceptable) blockers.push(sig.empty ? "חסרה חתימה" : "החתימה קטנה מדי — חתמו על רוב המשטח");
  if (!online) blockers.push("אין חיבור לאינטרנט — ההגשה דורשת חיבור");

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // ⚠️ לשונית אחרת (PWA + דפדפן) אולי הכניסה תמונה שהלשונית הזו לא ראתה.
      // הגשה עכשיו הייתה חותמת ביקור בלעדיה — ו-clearVisit היה מוחק אותה.
      await refreshIndex();
      if (pendingCount(visitId) > 0) {
        const e = new Error("יש במכשיר שינויים שעוד לא סונכרנו (אולי מלשונית אחרת) — המתינו לסנכרון ונסו שוב");
        e.local = true;
        throw e;
      }
      const signatureB64 = padRef.current?.toPngBase64();
      if (!signatureB64) {
        const e = new Error("החתימה אינה מספיקה — חתמו שוב, על רוב המשטח");
        e.local = true;
        throw e;
      }
      const res = await submitPmVisit(visitId, {
        performerName: performerName.trim(),
        signatureB64,
        performedOn,
        note: visitNote.trim() || null,
        requestId,
      });
      writeStore("localStorage", NAME_KEY, performerName.trim());
      writeStore("sessionStorage", submitReqKey(visitId), null);
      await clearVisit(visitId);
      onSubmitted?.({ ...res, visitId: res?.visitId ?? visitId });
    } catch (err) {
      // ⚠️ שלושה מצבים שונים, ולא "לא הוגש" לכולם:
      //   • אין תשובה (רשת / זמן קצוב) — ייתכן שהשרת כבר שמר. "לא הוגש" כאן
      //     הוא שקר שמחזיר טכנאי לחניון. לחיצה חוזרת = replay (אותו requestId).
      //   • PT409 — הביקור כבר הוגש: הטעינה מחדש סוגרת את הטופס ואומרת ע״י מי.
      //   • דחייה — באנר שנשאר, לא הודעה שנעלמת: טכנאי שהטלפון בכיס צריך לראות
      //     כשהוא חוזר שהביקור **לא** הוגש, ולמה.
      const unknown = !err?.local && (!!err?.network || err?.status === 0);
      if (unknown) {
        setSubmitError({
          kind: "unknown",
          at: Date.now(),
          text: "לא התקבלה תשובה מהשרת — ייתכן שהביקור כבר הוגש. לחיצה חוזרת על „שליחה” בטוחה: היא לא תיצור הגשה כפולה.",
        });
      } else if (err?.code === "PT409") {
        setSubmitError({ kind: "done", text: "הביקור כבר הוגש — בודק מול השרת…" });
      } else {
        setSubmitError({ kind: "refused", text: err?.message || "ההגשה נכשלה" });
      }
      if (unknown || err?.code === "PT409" || err?.code === "PT404") onReloadRef.current?.();
      setSubmitting(false);
    }
  };

  // ⚠️ "ייתכן שהוגש" הוא מצב ביניים, לא מסקנה. שליפה שהתחילה **אחרי** הכישלון
  // והחזירה את הטיוטה עונה על השאלה: הטופס מורכב רק כל עוד הטיוטה קיימת (הגשה
  // שנקלטה סוגרת אותו ב-PmTab), ולכן serverAt חדש כאן = הביקור עדיין טיוטה.
  // בלי זה טכנאי בקליטה מקרטעת (navigator.onLine אמת, החבילה אבדה) קורא "אולי
  // הוגש", עולה מהחניון — והביקור נשאר טיוטה לא חתומה. לחיצה חוזרת עדיין בטוחה
  // (אותו requestId), והגשה שנקלטה באיחור עדיין נתפסת בהודעת ההיעלמות של PmTab.
  useEffect(() => {
    if (submitError?.kind === "unknown" && serverAt > 0 && serverAt >= submitError.at) {
      setSubmitError({ kind: "refused", text: "השרת עדיין מציג את הביקור כטיוטה — ההגשה לא נקלטה. לחצו „שליחה” שוב." });
    }
  }, [serverAt, submitError]);

  const discard = async (reason) => {
    await discardPmVisit(visitId, reason);
    // ⚠️ הערה שעוד בהשהיה הייתה נשפכת לתיבה בפירוק — לביקור שכבר אינו קיים
    for (const t of noteTimers.current.values()) clearTimeout(t.timer);
    noteTimers.current.clear();
    writeStore("sessionStorage", submitReqKey(visitId), null);
    await clearVisit(visitId);
    onDiscarded?.(visitId);
  };

  // ---------------- שומר הסגירה (החלק של הטופס; התיבה עצמה — ב-PmTab) ----------------
  const reasons = [];
  if (pickerBusy) reasons.push("תמונה עדיין בעיבוד ותאבד.");
  if (pickerFailed > 0) reasons.push(`${pickerFailed} תמונות נכשלו וממתינות לניסיון חוזר.`);
  if (noteDraftN > 0) reasons.push("הערה בהקלדה עוד לא נשמרה.");
  if (!sig.empty) reasons.push("החתימה עוד לא נשלחה — היא תימחק.");
  if (submitting) reasons.push("ההגשה עדיין בדרך.");
  const reason = reasons.join("\n") || null;
  const onDirtyRef = useRef(onDirty);
  useEffect(() => { onDirtyRef.current = onDirty; }, [onDirty]);
  useEffect(() => { onDirtyRef.current?.(reason); }, [reason]);
  useEffect(() => () => onDirtyRef.current?.(null), []);

  // ⚠️ לא בזמן הגשה: הטופס היה מתפרק, ותשובת השרת — גם דחייה — לא הייתה
  // מוצגת לאף אחד. רק הצלחה (callback של PmTab) הייתה מגיעה למסך.
  const back = () => {
    if (submitting) return;
    if (!sig.empty && !window.confirm("החתימה עוד לא נשלחה ותימחק. לחזור לסקירה?")) return;
    onBack?.();
  };

  // גלילה **ופוקוס**: קורא מסך או מקלדת ממשיכים מהפריט, לא מתחתית הטופס
  // ⚠️ פריט בקבוצה סגורה מוסתר — קודם פותחים אותה, וגוללים אחרי הרינדור (scrollTo).
  const goToItem = (id) => {
    const g = groups.find((x) => x.items.some((m) => m.id === String(id)));
    if (grouped && g && !openGroups.has(g.key)) {
      setOpenGroups((s) => new Set(s).add(g.key));
      setScrollTo(String(id));
      return;
    }
    scrollToItem(id);
  };
  useEffect(() => {
    if (scrollTo == null) return;
    scrollToItem(scrollTo);
    setScrollTo(null);
  }, [scrollTo, openGroups]); // eslint-disable-line react-hooks/exhaustive-deps
  const scrollToItem = (id) => {
    const el = document.getElementById(`pm-item-${visitId}-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.querySelector("input.pm-checkbox:not(:disabled), .pp-btn:not(:disabled)")?.focus({ preventScroll: true });
  };

  const idle = idleMs(draft.last_activity_at);
  const labelOf = (itemId) => items.find((i) => String(i.id) === String(itemId))?.label || `פריט ${itemId}`;
  const lock = submitting;

  let pill;
  if (waitN > 0) pill = { cls: "pending", text: `${countText(waitN, "שינוי אחד ממתין", "שינויים ממתינים")} לסנכרון${ob.draining ? " · שולח…" : ""}` };
  else if (stuckN > 0) pill = { cls: "error", text: `${countText(stuckN, "שינוי אחד נדחה", "שינויים נדחו")} ע״י השרת` };
  else pill = { cls: "ok", text: "✓ כל השינויים נשמרו בשרת" };

  const renderItem = (m) => (
    <li key={m.id} id={`pm-item-${visitId}-${m.id}`}
      className={`pm-item${m.missing ? " pm-item--todo" : ""}${m.status?.cls === "error" ? " pm-item--error" : ""}`}>
      <div className="pm-item-head">
        {m.it.kind !== "photo" ? (
          <label className="pm-check">
            <input type="checkbox" className="pm-checkbox" checked={m.checked} disabled={lock}
              onChange={(e) => toggle(m.id, e.target.checked)} />
            <span className="pm-check-label">{m.it.label}</span>
          </label>
        ) : (
          <div className="pm-check pm-check--photo">
            <span className="pm-check-ico"><CameraIcon size={20} /></span>
            <span className="pm-check-label">{m.it.label}</span>
          </div>
        )}
      </div>
      {m.it.hint && <p className="pm-hint">{m.it.hint}</p>}

      <div className="pm-tags">
        {m.it.required
          ? <span className="pm-tag pm-tag--req">חובה</span>
          : <span className="pm-tag">רשות</span>}
        {m.it.kind !== "check" && (
          <span className={`pm-tag${m.it.min_photos > 0 && m.photoN < m.it.min_photos ? " pm-tag--short" : ""}`}>
            {m.it.min_photos > 0 ? `${m.photoN}/${m.it.min_photos} תמונות` : `${m.photoN} תמונות`}
          </span>
        )}
      </div>

      {m.it.kind !== "check" && (
        <div className="pm-photos">
          <PhotoPicker
            max={Math.max(0, MAX_PHOTOS_PER_ITEM - m.orphans.length)}
            initial={initialByItem.get(m.id)}
            disabled={lock}
            gone={gone}
            rejected={m.rejected}
            onPick={({ clientId, compressed }) => { localThumbs.current.set(clientId, compressed.thumb); }}
            upload={async ({ clientId, compressed }) => {
              localThumbs.current.set(clientId, compressed.thumb);
              const r = await enqueuePhoto(visitId, m.it.id, clientId, compressed);
              kick();
              return r;
            }}
            onRemove={(p) => removeServerOrPending(
              p.clientId && !String(p.clientId).startsWith("id:") ? p.clientId : null, p.id ?? null)}
            onChange={(s) => onPickerChange(m.id, s)}
          />
          {m.orphans.length > 0 && (
            <ul className="pp-list pm-orphans" aria-label="תמונות שממתינות במכשיר">
              {m.orphans.map((ph) => {
                const refused = m.rejected.has(ph.clientId);
                return (
                  <li key={ph.clientId} className={`pp-item ${refused ? "pp-item--failed" : "pp-item--queued"}`}>
                    {ph.thumb
                      ? <img className="pp-thumb" src={`data:image/jpeg;base64,${ph.thumb}`} alt="" />
                      : <span className="pp-thumb pp-thumb--empty" aria-hidden="true" />}
                    <span className="pp-status">{refused ? "השרת דחה את התמונה — ראו למעלה" : "נשמר במכשיר · ממתין לסנכרון"}</span>
                    <button type="button" className="pp-remove" aria-label="הסרת התמונה" title="הסרה" disabled={lock}
                      onClick={() => removeServerOrPending(ph.clientId, null).catch(() => {})}>×</button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {noteOpen.has(m.id) || m.note ? (
        <label className="pm-field pm-note">
          <span>הערה</span>
          <textarea className="pm-input pm-textarea" rows={2} maxLength={ITEM_NOTE_MAX} value={m.note}
            disabled={lock} autoFocus={justOpened === m.id}
            onFocus={() => onNoteFocus(m.id, m.note)}
            onChange={(e) => onNoteChange(m.id, e.target.value)}
            onBlur={() => onNoteBlur(m.id)} />
        </label>
      ) : (
        // ⚠️ הכפתור מתחלף בשדה — בלי פוקוס על השדה, בכפפות צריך עוד הקשה
        // כדי להתחיל להקליד, ומקלדת / קורא מסך נופלים ל-body.
        <button type="button" className="pm-btn pm-btn--ghost pm-btn--inline" disabled={lock}
          onClick={() => { setNoteOpen((s) => new Set(s).add(m.id)); setJustOpened(m.id); }}>
          + הוספת הערה
        </button>
      )}

      <div className="pm-item-foot">
        {m.status && <span className={`pm-status pm-status--${m.status.cls}`}>{m.status.text}</span>}
        {m.byOther && (
          <span className="pm-by">
            עודכן ע״י {m.byOther}{m.it.updated_at ? ` · ${formatStampIL(m.it.updated_at)}` : ""}
          </span>
        )}
      </div>
    </li>
  );

  return (
    <div className="pm-form">
      {/* ===== סרגל עליון: חזרה + מצב הסנכרון ===== */}
      <div className="pm-form-bar">
        <button type="button" className="pm-btn pm-btn--ghost" onClick={back} disabled={submitting}>→ חזרה לסקירה</button>
        <span className={`pm-sync pm-sync--${pill.cls}`} role="status">{pill.text}</span>
        {ob.count > 0 && online && (
          <button type="button" className="pm-btn" disabled={lock}
            onClick={() => drain(pmOutboxSenders, { force: true }).catch(() => {})}>
            סנכרון עכשיו
          </button>
        )}
      </div>

      <div className="pm-card pm-form-head">
        <h3 className="pm-h3">ביקור תחזוקה מונעת</h3>
        <p className="pm-meta">
          נפתח ע״י {draft.started_by || "—"} ב-{formatStampIL(draft.started_at)}
          {" · "}עודכן לאחרונה {agoText(draft.last_activity_at)}
        </p>
        {requiredN > 0 && (
          <div className="pm-progress" aria-label={`${doneN} מתוך ${requiredN} פריטי חובה הושלמו`}>
            <span className="pm-progress-bar" style={{ width: `${Math.round((doneN / requiredN) * 100)}%` }} />
            <span className="pm-progress-text">{doneN}/{requiredN} פריטי חובה</span>
          </div>
        )}
      </div>

      {/* ===== באנרים ===== */}
      {!ob.persistent && (
        <div className="pm-banner pm-banner--error" role="alert">
          <strong>המכשיר אינו שומר טיוטה — אל תסגרו את הדף.</strong>
          {" "}הסימונים נשמרים בזיכרון הלשונית בלבד עד שיגיעו לשרת.
        </div>
      )}
      {/* כשהלשונית כבר אומרת "מוצג המצב השמור" — באנר שני על אותו דבר רק דוחף את הפריטים למטה */}
      {!online && !cached && (
        <div className="pm-banner pm-banner--warn" role="status">
          אין קליטה. אפשר להמשיך לסמן ולצלם — הכול נשמר במכשיר ויישלח כשהקליטה תחזור.
        </div>
      )}
      {online && refreshError && (
        <div className="pm-banner pm-banner--warn" role="status">
          לא ניתן לרענן מהשרת ({refreshError}) — מוצג המצב האחרון שנטען.
        </div>
      )}
      {stuckN > 0 && (
        <div className="pm-banner pm-banner--error" role="alert">
          <strong>השרת דחה {stuckN} שינויים. הם שמורים במכשיר ולא יישלחו שוב לבד.</strong>
          <ul className="pm-stuck">
            {ob.mine.stuck.map((s) => (
              <li key={s.key}>
                <span className="pm-stuck-what">{ENTRY_KIND[s.kind] || "שינוי"} · {labelOf(s.itemId)}</span>
                <span className="pm-stuck-why">{s.error}</span>
                <span className="pm-row">
                  <button type="button" className="pm-btn" disabled={lock}
                    onClick={() => { retryStuck(s.key); kick(); }}>נסה שוב</button>
                  <button type="button" className="pm-btn pm-btn--danger" disabled={lock}
                    onClick={() => {
                      // ⚠️ תמונה: גם ה-PhotoPicker צריך לדעת — אחרת היא נשארת שם
                      // "ממתין לסנכרון" לנצח, ונספרת מול המכסה של הפריט.
                      if (s.kind === "photo") markRemoved(s.clientId);
                      discardStuck(s.key);
                    }}>ותר</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {ob.dropped.length > 0 && (
        <div className="pm-banner pm-banner--warn" role="status">
          {ob.dropped.length} שינויים לא נשמרו כי הביקור כבר אינו פתוח לעריכה.
        </div>
      )}
      {ob.foreign > 0 && (
        <div className="pm-banner pm-banner--warn" role="status">
          במכשיר הזה יש {ob.foreign} שינויים של משתמש אחר שלא נשלחו. הם לא יישלחו בשמך.
          <button type="button" className="pm-btn pm-btn--danger pm-btn--inline" disabled={lock}
            onClick={() => { if (window.confirm(`למחוק ${ob.foreign} שינויים של משתמש אחר מהמכשיר? אי אפשר לשחזר.`)) discardForeign(); }}>
            מחיקתם
          </button>
        </div>
      )}

      {/* ===== הפריטים ===== */}
      {grouped ? (
        <div className="pm-groups">
          {groups.map((g) => {
            const isOpen = openGroups.has(g.key);
            const listId = `pm-group-items-${visitId}-${g.key}`;
            return (
              <section key={g.key} id={`pm-group-${visitId}-${g.key}`}
                className={`pm-group${g.done ? " pm-group--done" : ""}${isOpen ? " pm-group--open" : ""}`}>
                <button type="button" className="pm-group-head" aria-expanded={isOpen} aria-controls={listId}
                  onClick={() => toggleGroup(g.key)}>
                  <span className="pm-group-mark" aria-hidden="true">{g.done ? "✓" : ""}</span>
                  <span className="pm-group-name">{g.name || "כללי"}</span>
                  <span className="pm-group-count">
                    {g.required > 0 ? `${g.required - g.missing}/${g.required}` : `${g.items.length} רשות`}
                  </span>
                  <span className="pm-group-chev" aria-hidden="true">{isOpen ? "▴" : "▾"}</span>
                </button>
                <ol className="pm-items" id={listId} hidden={!isOpen}>
                  {g.items.map(renderItem)}
                </ol>
              </section>
            );
          })}
        </div>
      ) : (
        <ol className="pm-items">{merged.map(renderItem)}</ol>
      )}

      {/* ===== סיום וחתימה ===== */}
      <section className="pm-card pm-footer" ref={footerRef}>
        <h3 className="pm-h3">סיום וחתימה</h3>

        {missing.length > 0 && (
          <div className="pm-missing">
            <span>חסרים פריטי חובה:</span>
            <ul>
              {missing.map((m) => (
                <li key={m.id}>
                  <button type="button" className="pm-link" onClick={() => goToItem(m.id)}>{m.it.label}</button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <label className="pm-field">
          <span>שם המבצע</span>
          <input className="pm-input" type="text" value={performerName} maxLength={NAME_MAX} disabled={lock}
            autoComplete="name" onChange={(e) => setPerformerName(e.target.value)} />
        </label>

        <label className="pm-field">
          <span>תאריך הביצוע</span>
          <input className="pm-input" type="date" value={performedOn} min={range.min} max={range.max} disabled={lock}
            onChange={(e) => setPerformedOn(e.target.value)} />
        </label>
        {range.tooOld && (
          <p className="pm-hint pm-hint--warn">
            הביקור נפתח ב-{formatDateIL(range.min)}, לפני יותר משבוע — אפשר להגיש רק עם תאריך ביצוע
            עד {formatDateIL(range.max)}. אם העבודה נעשתה מאוחר יותר, יש להתחיל ביקור חדש.
          </p>
        )}

        <label className="pm-field">
          <span>הערה כללית <em>(רשות)</em></span>
          <textarea className="pm-input pm-textarea" rows={2} maxLength={VISIT_NOTE_MAX} value={visitNote} disabled={lock}
            onChange={(e) => setVisitNote(e.target.value)} />
        </label>

        <div className="pm-field">
          <span>חתימת המבצע</span>
          <div className="pm-sig">
            <SignaturePad ref={padRef} onChange={setSig} disabled={submitting} />
          </div>
        </div>

        {submitError && (
          submitError.kind === "refused" ? (
            <div className="pm-banner pm-banner--error" role="alert">
              <strong>הביקור עדיין לא הוגש</strong> — {submitError.text}
            </div>
          ) : (
            <div className="pm-banner pm-banner--warn" role="alert">{submitError.text}</div>
          )
        )}

        {blockers.length > 0 && !submitting && (
          <ul className="pm-blockers" aria-label="מה חסר כדי לשלוח">
            {blockers.map((b) => <li key={b}>{b}</li>)}
          </ul>
        )}

        <button type="button" className="pm-btn pm-btn--primary pm-btn--wide"
          disabled={submitting || blockers.length > 0} onClick={submit}>
          {submitting ? "שולח…" : "שליחה"}
        </button>
      </section>

      {/* ===== ביטול הביקור ===== */}
      <section className="pm-card pm-danger-zone">
        {discardOpen ? (
          <ReasonForm
            text="ביטול הביקור מוחק את כל הסימונים, ההערות והתמונות שבו. אי אפשר לשחזר."
            confirmLabel="ביטול הביקור"
            onConfirm={discard}
            onCancel={() => setDiscardOpen(false)}
          />
        ) : (
          <>
            <button type="button" className="pm-btn pm-btn--danger" ref={discardBtnRef} disabled={lock}
              onClick={() => setDiscardOpen(true)}>
              ביטול הביקור
            </button>
            {/* ⚠️ הכפתור מוצג לכולם, והשרת מכריע (pm_may_discard). הדפדפן אינו
                יודע בוודאות מי פתח את הביקור — רק השם — ובדיקה כאן הייתה נראית
                כמו הגנה בלי להיות כזו. */}
            {!isManager && idle <= DISCARD_IDLE_MS && (
              <p className="pm-hint">מותר למי שפתח את הביקור, למנהל, או לכל אחד אחרי 48 שעות ללא פעילות.</p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
