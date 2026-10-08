// components/Compliance/PmTab.jsx — לשונית "תחזוקה מונעת" בחלון האתר.
//
// מה יש כאן, מלמעלה למטה:
//   • מנורה ומשפט מצב — הביקור האחרון, עד מתי הבא, כמה ימים נשארו;
//   • כרטיס הטיוטה ("ביקור בתהליך…" + המשך / התחלה מחדש), או "התחלת ביקור";
//   • טופס הביקור (PmVisitForm) — כשממשיכים טיוטה, הוא תופס את הלשונית;
//   • היסטוריית הביקורים, וצפייה בכל אחד (PmVisitView);
//   • כלי מנהל: העלאת דוחות היסטוריים ועריכת רשימת הבדיקה.
//
// ============================================================
// ⚠️ הסטטוס כאן מגיע מהשרת ולא מחושב
// ============================================================
// "בתוקף / בקרוב / באיחור" ותאריך היעד מגיעים משורת compliance_rows שבתוך
// pm_site — אותה שורה שהכרטיס והתראה קוראים. עותק של חישוב "6 חודשים" כאן
// היה נותן יום שבו הכרטיס צהוב והלשונית ירוקה.
//
// ============================================================
// ⚠️ שומר הסגירה
// ============================================================
// `onDirtyChange(reason)` — סיבה בעברית כל עוד סגירת החלון תאבד עבודה או
// תשאיר אותה תקועה במכשיר: תיבת היוצאים של הטיוטה אינה ריקה, תמונה בעיבוד
// או שנכשלה, הערה בהשהיה, חתימה שלא נשלחה, העלאה היסטורית בדרך, רשימת
// בדיקה שלא נשמרה. ההורה מציג window.confirm(reason). null כשנקי ובפירוק.
//
// ⚠️ "תקועה" ולא רק "אבודה": מה שבתיבה שורד סגירה (localStorage + IndexedDB),
// אבל נשלח רק כשהלשונית הזו פתוחה. מי שסוגר בלי קליטה משאיר את הסימונים
// במכשיר שלו — ואם הוא בטלפון של חבר, הם לא יגיעו לעולם.
//
// ============================================================
// ⚠️ "דורות" שליפה, ושעת ההתחלה שלה
// ============================================================
// כל שליפה של pm_site מקבלת מספר עולה. תשובה ישנה שמגיעה אחרי חדשה נזרקת.
// בנוסף נשמרת **שעת ההתחלה** של השליפה (`_fetchedAt`, גם במצב השמור): הטופס
// משתמש בה כדי לדעת מתי תשובת שרת "מכסה" וי שאושר — ראה PmVisitForm. שעון
// קיר ולא המונה: המונה מתאפס ברענון, והאישורים שורדים אותו.
//
// ============================================================
// ⚠️ טיוטה שנעלמה — מה קרה לה, ומה אבד
// ============================================================
// טיוטה יכולה להיעלם מתחת לטכנאי: הוגשה (אולי על ידו — והתשובה אבדה),
// בוטלה, או הוחלפה ממכשיר אחר. הלשונית בודקת כל תשובת שרת טרייה: אם הטיוטה
// שהטופס פתוח עליה — או זו שהייתה על הכרטיס — איננה, היא מחפשת אותה
// בהיסטוריה ("הוגש ע״י X") וסופרת מה מהמכשיר הזה לא נשמר (ממתין + נזרק).
// בלי זה ההגשה של הטכנאי עצמו נקראה "בוטל ממכשיר אחר", ושינויים שאבדו
// כשהיה בסקירה פשוט נעלמו בלי מילה.
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../../hooks/useAuth";
import { fetchPmSite, startPmVisit, pmOutboxSenders } from "../../services/dataSource";
import {
  clearVisit, droppedCount, isPersistent, pendingCount, setOwner, startAutoDrain, subscribe,
} from "../../utils/pmOutbox";
import {
  DRAFT_STALE_MS, daysText, formatDateIL, formatStampIL, stateLabel, toCompliance,
} from "../../utils/compliance";
import PmVisitForm from "./PmVisitForm";
import PmVisitView from "./PmVisitView";
import PmHistoricalUpload from "./PmHistoricalUpload";
import PmTemplateEditor from "./PmTemplateEditor";
import PmSiteLists from "./PmSiteLists";
import { PmLamp } from "./PmCommon";
import {
  DISCARD_IDLE_MS, agoText, countText, idleMs, readMe, readStore, sameName, submitReqKey, writeMe, writeStore,
} from "./PmUtils";
import "./PmTab.css";

const POLL_MS = 20_000;
const HISTORY_FIRST = 8;
const CACHE_KEY = (code) => `pm.site.${code}`;

function readCache(code) {
  try { return JSON.parse(readStore("localStorage", CACHE_KEY(code)) || "null"); } catch { return null; }
}

// טיוטה שהמכשיר הזה הגיש / ביטל / החליף — יוצאת מהתצוגה ומהמצב השמור מיד,
// ולא כשהשליפה הבאה תצליח (ראה onSubmitted).
const withoutDraft = (d, id) => (d?.draft && String(d.draft.id) === String(id) ? { ...d, draft: null } : d);

// מי עדכן פריט בטיוטה לאחרונה (אין "עודכן ע״י" ברמת הביקור) — להודעת "השתנתה בינתיים"
function lastEditor(d) {
  let best = null;
  for (const it of d?.items || []) if (it.updated_at && (!best || it.updated_at > best.updated_at)) best = it;
  return best?.updated_by || null;
}

function useOnline() {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  return online;
}

// המשפט שליד המנורה: מתי היה הביקור האחרון, ועד מתי הבא.
function statusLine(pm) {
  if (!pm) return "";
  if (!pm.lastOn) return pm.missing && pm.state !== "none" ? "אין ביקור רשום — נדרש ביקור" : "אין ביקור רשום";
  const due = formatDateIL(pm.dueOn);
  const left = pm.daysLeft != null ? ` · ${daysText(pm.daysLeft)}` : "";
  if (pm.state === "expired") return `ביקור אחרון ${formatDateIL(pm.lastOn)} · הבא נדרש עד ${due} — באיחור${left}`;
  return `ביקור אחרון ${formatDateIL(pm.lastOn)} · הבא עד ${due}${left}`;
}

/**
 * @param {object} props
 * @param {{id:number, code:string, site_name:string}} props.site
 * @param {number} [props.complianceRev] — עולה באירוע compliance של האתר → טעינה מחדש
 * @param {(reason:string|null) => void} [props.onDirtyChange]
 * @param {() => void} [props.onChanged] — אחרי כל כתיבה מוצלחת (ההורה שולף את שורת הרמזור)
 */
export default function PmTab({ site, complianceRev = 0, onDirtyChange, onChanged }) {
  const { user, loading: authLoading } = useAuth();
  const isManager = user?.role === "manager";
  const code = site?.code;
  const online = useOnline();

  // ---------------- שליפה ----------------
  const [data, setData] = useState(null);
  const [phase, setPhase] = useState("loading");        // loading | ready | error
  const [loadError, setLoadError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const genRef = useRef(0);
  const shownGenRef = useRef(0);
  const dataRef = useRef(null);
  useEffect(() => { dataRef.current = data; }, [data]);

  const uidRef = useRef(null);
  const load = useCallback(async ({ silent = false } = {}) => {
    if (!code) return null;
    const gen = ++genRef.current;
    const startedAt = Date.now();
    if (!silent && !dataRef.current) setPhase("loading");
    try {
      const res = await fetchPmSite(code);
      if (gen < shownGenRef.current) return res;          // תשובה ישנה שהקדימה אותה חדשה
      shownGenRef.current = gen;
      setData({ ...res, _gen: gen, _fetchedAt: startedAt });
      setPhase("ready");
      setLoadError("");
      setRefreshError("");
      if (uidRef.current) {
        writeStore("localStorage", CACHE_KEY(code),
          JSON.stringify({ uid: uidRef.current, at: Date.now(), fetchedAt: startedAt, data: res }));
      }
      return res;
    } catch (err) {
      if (gen < shownGenRef.current) return null;
      const msg = err?.message || "הנתונים לא נטענו";
      if (dataRef.current) setRefreshError(msg);           // יש מה להציג — לא מוחקים אותו בגלל הבהוב
      else { setLoadError(msg); setPhase("error"); }
      return null;
    }
  }, [code]);

  useEffect(() => { load({ silent: !!dataRef.current }); }, [load, complianceRev]);

  // ============================================================
  // ⚠️ רענון בלי קליטה — המצב השמור במכשיר
  // ============================================================
  // תיבת היוצאים שורדת רענון, אבל בלי רשימת הפריטים אין על מה להציג אותה:
  // טכנאי שהטלפון שלו רענן את הדף במרתף היה מקבל "לא נטען" — והסימונים שלו
  // יושבים במכשיר בלי דרך להמשיך. לכן התשובה האחרונה של pm_site (אין בה
  // בתים — רק מבנה) נשמרת למכשיר, ומשמשת כשהשליפה נכשלת.
  // ⚠️ רק של אותו משתמש, ו-_gen = 0: המצב השמור לעולם אינו "מכסה" וי
  // שאושר, ואינו סוגר טופס פתוח (ראה הבדיקות לפי דור).
  const uid = user?.id ?? null;
  useEffect(() => { uidRef.current = uid; }, [uid]);
  useEffect(() => {
    if (phase !== "error" || !uid || dataRef.current) return;
    const cached = readCache(code);
    if (cached?.uid !== uid || !cached.data) return;      // שמור פגום / של משתמש אחר — נשארים עם "נסה שוב"
    setData({ ...cached.data, _gen: 0, _cachedAt: cached.at, _fetchedAt: cached.fetchedAt || 0 });
    setRefreshError(loadError);
    setPhase("ready");
  }, [phase, uid, code, loadError]);

  // המצב השמור עודכן בעצמנו (הגשה/ביטול/התחלה מחדש) — כך שרענון בלי קליטה
  // לא יחזיר טיוטה שכבר אינה קיימת, עם "אפשר להמשיך לסמן".
  const forgetDraft = useCallback((id) => {
    setData((d) => withoutDraft(d, id));
    const cached = readCache(code);
    if (cached?.data?.draft && String(cached.data.draft.id) === String(id)) {
      writeStore("localStorage", CACHE_KEY(code), JSON.stringify({ ...cached, data: withoutDraft(cached.data, id) }));
    }
  }, [code]);

  // הקליטה חזרה — רענון מיד, בלי לחכות לסקירה הבאה
  useEffect(() => { if (online && dataRef.current) load({ silent: true }); }, [online, load]);

  // ---------------- תיבת היוצאים: בעלים וריקון ----------------
  // ⚠️ setOwner **לפני** הריקון הראשון: בלי בעלים כל רשומה נחשבת "שלי",
  // ורשומות של משתמש קודם במכשיר משותף היו נשלחות בזהות של הנוכחי.
  // ⚠️ הריקון האוטומטי רץ כל עוד הלשונית פתוחה — לא רק בזמן שהטופס פתוח —
  // כדי שסימונים שנתקעו בביקור קודם (בלי קליטה) יישלחו ברגע שמישהו נכנס.
  // בלי רשומות ממתינות הוא אינו פונה לרשת כלל.
  useEffect(() => {
    if (!uid) return undefined;
    setOwner(uid);
    return startAutoDrain(pmOutboxSenders);
  }, [uid]);

  const draft = data?.draft ?? null;
  const draftId = draft?.id ?? null;
  // הטיוטה האחרונה שתשובת שרת טרייה הראתה — ובפתיחה, זו שבמצב השמור: גם מי
  // שסגר את הלשונית וחזר מחר צריך לשמוע שהשינויים שהשאיר במכשיר לא נשמרו.
  const prevDraftRef = useRef(undefined);
  if (prevDraftRef.current === undefined) {
    const c = code ? readCache(code) : null;
    prevDraftRef.current = c?.data?.draft?.id != null ? String(c.data.draft.id) : null;
  }
  const handledRef = useRef(new Set());                 // ביקורים שהמכשיר הזה הגיש / ביטל / החליף
  const [ob, setOb] = useState({ n: 0, persistent: true });
  const draftIdRef = useRef(draftId);
  useEffect(() => {
    draftIdRef.current = draftId;
    const read = (s) => {
      const id = draftIdRef.current;
      const next = { n: id ? pendingCount(id) : 0, persistent: s ? !!s.persistent : isPersistent() };
      setOb((cur) => (cur.n === next.n && cur.persistent === next.persistent ? cur : next));
    };
    read(null);
    return subscribe(read);
  }, [draftId, uid]);

  // ---------------- "אני" — לזיהוי "עודכן ע״י X" ----------------
  const [me, setMe] = useState(() => readMe(uid));
  useEffect(() => { setMe(readMe(uid)); }, [uid]);
  const learnMe = useCallback((name) => {
    if (!uid || !name) return;
    writeMe(uid, name);
    setMe(name);
  }, [uid]);
  const learnFromRef = useRef(null);                     // {kind:'start'|'submit', visitId}
  // ⚠️ השרת אומר מי אני (pm_site.me = השם שהוא כותב ב-updated_by). זה המקור
  // המדויק; הלמידה מפתיחה/הגשה למטה נשארת לגרסת SQL שעוד לא מחזירה אותו.
  useEffect(() => { if (data?.me) learnMe(data.me); }, [data?.me, learnMe]);
  useEffect(() => {
    const l = learnFromRef.current;
    if (!l || !data) return;
    if (l.kind === "start" && data.draft?.id === l.visitId) { learnMe(data.draft.started_by); learnFromRef.current = null; }
    if (l.kind === "submit") {
      const v = (data.visits || []).find((x) => x.id === l.visitId);
      if (v) { learnMe(v.submitted_by); learnFromRef.current = null; }
    }
  }, [data, learnMe]);

  // ---------------- הטופס פתוח? ----------------
  // ⚠️ נזכר ב-sessionStorage: רענון באמצע ביקור (או קריסת הלשונית בטלפון)
  // מחזיר את הטכנאי ישר לטופס, ולא לסקירה שבה עליו למצוא "המשך".
  const formKey = `pm.form.${code}`;
  const [formFor, setFormFor] = useState(() => readStore("sessionStorage", formKey));
  const formSetGenRef = useRef(0);
  const [notice, setNotice] = useState(null);           // {kind:'ok'|'warn', text}
  const rootRef = useRef(null);

  // ⚠️ ההודעה נולדת אחרי לחיצה בתחתית טופס ארוך (שליחה, ביטול) או כשהטופס
  // נסגר מתחת לטכנאי — והיא מוצגת בראש הלשונית, מעל המסך. בלי גלילה ופוקוס
  // הטכנאי רואה רק שהטופס נעלם. block:"center" ולא "start": הכותרת הדביקה
  // של החלון הייתה מכסה אותה.
  const noticeRef = useRef(null);
  useEffect(() => {
    if (!notice) return undefined;
    const raf = requestAnimationFrame(() => {
      noticeRef.current?.scrollIntoView?.({ block: "center" });
      noticeRef.current?.focus?.({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [notice]);

  // ⚠️ שליפה בפתיחה: אין אירוע על שמירת טיוטה (D20), והסקירה מחזיקה את מה
  // שנטען כשנפתחה. בלי זה הטופס הציג עד 20 שניות מצב ישן — והערה שנכתבה
  // בחלון הזה דרסה הערה של טכנאי אחר שלא נראתה.
  const openForm = (visitId) => {
    formSetGenRef.current = genRef.current;
    setFormFor(String(visitId));
    writeStore("sessionStorage", formKey, String(visitId));
    setNotice(null);
    requestAnimationFrame(() => rootRef.current?.scrollIntoView?.({ block: "start" }));
    load({ silent: true });
  };
  const closeForm = useCallback(() => {
    setFormFor(null);
    writeStore("sessionStorage", formKey, null);
  }, [formKey]);

  const formOpen = !!formFor && !!draft && String(draft.id) === String(formFor);

  // טיוטה שנעלמה מהשרת — זו שהטופס פתוח עליה, או זו שהייתה על הכרטיס (ראה הכותרת).
  // ⚠️ רק תשובת שרת טרייה (_gen > 0; המצב השמור אינו מוכיח כלום), ולטופס —
  // רק תשובה שהשליפה שלה התחילה אחרי פתיחתו. אחרת תשובה ישנה (מלפני
  // "התחלת ביקור") הייתה סוגרת טופס שנפתח זה עתה.
  useEffect(() => {
    if (!data || !(data._gen > 0)) return;
    const cur = data.draft ? String(data.draft.id) : null;
    const ff = formFor ? String(formFor) : null;
    const prev = prevDraftRef.current;
    prevDraftRef.current = cur;
    const gone = [];
    if (ff && ff !== cur && data._gen > formSetGenRef.current) { closeForm(); gone.push(ff); }
    if (prev && prev !== cur && prev !== ff) gone.push(prev);
    for (const id of gone) {
      if (handledRef.current.has(id)) continue;
      handledRef.current.add(id);
      // ⚠️ סופרים **לפני** clearVisit: ממתין במכשיר + מה שהתיבה כבר זרקה כי הביקור נסגר
      const lost = pendingCount(id) + droppedCount(id);
      clearVisit(id);
      writeStore("sessionStorage", submitReqKey(id), null);
      if (id !== ff && !lost) continue;         // הכרטיס התחלף ולא אבד כלום — ההיסטוריה מספרת את השאר
      const lostText = lost > 0 ? ` ${countText(lost, "שינוי אחד", "שינויים")} שנעשו במכשיר הזה ולא סונכרנו — לא נשמרו.` : "";
      const v = (data.visits || []).find((x) => String(x.id) === id);
      if (v) {
        // ⚠️ אולי ההגשה של הטכנאי עצמו, שהתשובה שלה אבדה בחניון
        const mine = sameName(v.submitted_by, data.me || me);
        setNotice({
          kind: lost ? "warn" : "ok",
          text: (mine
            ? `הביקור הוגש ונחתם (${formatDateIL(v.performed_on)}).`
            : `הביקור הוגש ע״י ${v.submitted_by || "משתמש אחר"} (${formatDateIL(v.performed_on)}).`) + lostText,
        });
      } else {
        setNotice({ kind: "warn", text: `הביקור כבר אינו פתוח — הוא בוטל או הוחלף בביקור חדש ממכשיר אחר.${lostText}` });
      }
    }
  }, [data, formFor, closeForm, me]);

  // סקירה כל 20 שניות, ובחזרה לחלון — רק בזמן שהטופס פתוח (D16: אין אירוע
  // על שמירת טיוטה, ושני טכנאים עשויים למלא את אותו ביקור).
  useEffect(() => {
    if (!formOpen) return undefined;
    const tick = () => { if (document.visibilityState !== "hidden") load({ silent: true }); };
    const onVis = () => { if (document.visibilityState === "visible") load({ silent: true }); };
    const t = setInterval(tick, POLL_MS);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [formOpen, load]);

  // ---------------- פעולות ----------------
  const [busy, setBusy] = useState(null);               // 'start' | 'restart'
  const [actionError, setActionError] = useState("");
  const changed = useCallback(() => { onChanged?.(); }, [onChanged]);

  const start = async (restart = false) => {
    if (restart && !window.confirm("להתחיל ביקור חדש? הטיוטה הקיימת — כל הסימונים, ההערות והתמונות שבה — תימחק.")) return;
    setBusy(restart ? "restart" : "start");
    setActionError("");
    const oldId = draft?.id != null ? String(draft.id) : null;
    const oldAt = draft?.last_activity_at ?? null;
    try {
      if (restart) {
        // ⚠️ pm_visit_start(restart) זורק את הטיוטה שקיימת **עכשיו**, לא את זו
        // שעל הכרטיס. הכרטיס עלול להיות ישן (window.confirm חוסם, אין אירוע על
        // שמירת טיוטה — D20) — ומנהל היה מוחק טיוטה חדשה של טכנאי אחר, או את
        // אותה טיוטה אחרי שטכנאי חזר לעבוד בה, עם כל העבודה שבה. לכן:
        //   • קודם קוראים את המצב הנוכחי — ועוצרים אם המזהה **או הפעילות** השתנו
        //     (ההחלטה "48 שעות בלי פעילות" התקבלה על הנתונים שעל הכרטיס);
        //   • ולשרת נשלחת הטיוטה שנראתה (מזהה + last_activity_at). הקריאה כאן רק
        //     מצמצמת את החלון; הבדיקה בשרת, תחת הנעילה, סוגרת אותו (PT409).
        const fresh = await load({ silent: true });
        if (!fresh) throw new Error("אין חיבור לשרת — התחלה מחדש דורשת חיבור");
        const now = fresh.draft?.id != null ? String(fresh.draft.id) : null;
        if (now !== oldId) {
          setActionError(now
            ? `הטיוטה השתנתה בינתיים — ${fresh.draft.started_by || "משתמש אחר"} פתח ביקור חדש. בדקו אותו לפני שמתחילים מחדש.`
            : "הטיוטה כבר אינה קיימת — אפשר להתחיל ביקור חדש.");
          return;
        }
        if ((fresh.draft.last_activity_at ?? null) !== oldAt) {
          const by = lastEditor(fresh.draft);
          setActionError(`הטיוטה השתנתה בינתיים — עבדו בה ${agoText(fresh.draft.last_activity_at)}${by ? ` (${by})` : ""}. `
            + "בדקו אותה לפני שמתחילים מחדש.");
          return;
        }
      }
      const r = await startPmVisit(code, restart, restart ? { visitId: oldId, lastActivityAt: oldAt } : null);
      if (oldId && oldId !== String(r.visitId)) {
        handledRef.current.add(oldId);
        await clearVisit(oldId);
        writeStore("sessionStorage", submitReqKey(oldId), null);
        forgetDraft(oldId);      // ⚠️ שליפה שתיכשל עכשיו לא תציע "המשך" על הטיוטה שנמחקה
      }
      if (r.created) learnFromRef.current = { kind: "start", visitId: r.visitId };
      openForm(r.visitId);       // שולף בעצמו
      changed();
    } catch (err) {
      setActionError(err?.message || "פתיחת הביקור נכשלה");
      load({ silent: true });    // סירוב (או מרוץ) — הכרטיס מציג את מה שבאמת קיים
    } finally {
      setBusy(null);
    }
  };

  const onSubmitted = (res) => {
    const id = String(res?.visitId ?? formFor);
    handledRef.current.add(id);
    closeForm();
    forgetDraft(id);
    learnFromRef.current = { kind: "submit", visitId: res?.visitId };
    setNotice({
      kind: "ok",
      text: `הביקור הוגש ונחתם${res?.performedOn ? ` (${formatDateIL(res.performedOn)})` : ""}.`
        + `${res?.nextDueOn ? ` הביקור הבא עד ${formatDateIL(res.nextDueOn)}.` : ""}`,
    });
    changed();
    load({ silent: true });
  };

  const onDiscarded = (visitId) => {
    const id = String(visitId ?? formFor);
    handledRef.current.add(id);
    closeForm();
    forgetDraft(id);
    setNotice({ kind: "ok", text: "הביקור בוטל." });
    changed();
    load({ silent: true });
  };

  // ---------------- היסטוריה וכלי מנהל ----------------
  const [openVisit, setOpenVisit] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [tool, setTool] = useState(null);               // 'upload' | 'template'
  const [mounted, setMounted] = useState(() => new Set());   // כלי שנפתח נשאר חי (מוסתר) — עבודה בו לא נזרקת
  const toolsRef = useRef(null);
  const openTool = (t, scroll = false) => {
    setTool((cur) => (cur === t && !scroll ? null : t));
    setMounted((s) => (s.has(t) ? s : new Set(s).add(t)));
    if (scroll) requestAnimationFrame(() => toolsRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }));
  };

  // ---------------- שומר הסגירה: איחוד הסיבות ----------------
  const [formReason, setFormReason] = useState(null);
  const [uploadReason, setUploadReason] = useState(null);
  const [tplReason, setTplReason] = useState(null);
  let outboxReason = null;
  if (ob.n > 0) {
    const what = countText(ob.n, "שינוי אחד", "שינויים");
    outboxReason = ob.persistent
      ? `${what} בביקור עדיין לא סונכרנו לשרת — הם שמורים במכשיר הזה בלבד, ויישלחו רק כשהלשונית תיפתח שוב עם קליטה.`
      : `המכשיר אינו שומר טיוטה: ${what} שלא סונכרנו יימחקו אם החלון ייסגר.`;
  }
  const reason = [outboxReason, formReason, uploadReason, tplReason].filter(Boolean).join("\n") || null;
  const onDirtyRef = useRef(onDirtyChange);
  useEffect(() => { onDirtyRef.current = onDirtyChange; }, [onDirtyChange]);
  useEffect(() => { onDirtyRef.current?.(reason); }, [reason]);
  useEffect(() => () => onDirtyRef.current?.(null), []);

  // ---------------- תצוגה ----------------
  if (phase === "loading" || (authLoading && !data)) {
    return <p className="pm-state">טוען תחזוקה מונעת…</p>;
  }
  if (phase === "error") {
    return (
      <div className="pm pm-state" role="alert">
        <p className="pm-error-text">התחזוקה המונעת לא נטענה — {loadError}</p>
        <button type="button" className="pm-btn" onClick={() => load()}>נסה שוב</button>
      </div>
    );
  }

  const c = toCompliance(data?.status);
  const pm = c.unknown ? null : c.pm;
  const lamp = c.unknown ? "unknown" : (pm?.state ?? "unknown");
  const visits = Array.isArray(data?.visits) ? data.visits : [];
  const shown = showAll ? visits : visits.slice(0, HISTORY_FIRST);
  const templateCount = data?.template_count ?? 0;
  const idle = draft ? idleMs(draft.last_activity_at) : 0;
  const stale = idle > DRAFT_STALE_MS;
  const restartable = idle > DISCARD_IDLE_MS;

  return (
    <div className="pm" ref={rootRef}>
      {/* ===== מנורה ומצב ===== */}
      <section className={`pm-card pm-summary${formOpen ? " pm-summary--compact" : ""}`}>
        <PmLamp state={lamp} />
        <div className="pm-summary-text">
          <strong>{stateLabel("pm", c)}</strong>
          <span>{c.unknown ? "הסטטוס לא נטען" : statusLine(pm)}</span>
        </div>
      </section>

      {/* אילו רשימות תחזוקה האתר מקבל (07/10/2026) — רק כשאין טופס פתוח */}
      {!formOpen && Array.isArray(data?.templates) && (
        <PmSiteLists code={site.code} templates={data.templates} assigned={!!data.templates_assigned}
          isManager={isManager} onChanged={() => load({ silent: true })} />
      )}

      {notice && (
        <div className={`pm-banner pm-banner--closable pm-banner--${notice.kind === "ok" ? "ok" : "warn"}`} role="status"
          ref={noticeRef} tabIndex={-1}>
          {notice.text}
          <button type="button" className="pm-icon-btn pm-banner-x" aria-label="סגירת ההודעה" onClick={() => setNotice(null)}>×</button>
        </div>
      )}
      {actionError && <div className="pm-banner pm-banner--error" role="alert">{actionError}</div>}
      {data?._cachedAt && (
        <div className="pm-banner pm-banner--warn" role="status">
          <strong>אין חיבור לשרת</strong> — מוצג המצב השמור במכשיר
          (מ-{formatStampIL(new Date(data._cachedAt).toISOString())}). אפשר להמשיך לסמן ולצלם;
          הכול יישלח כשהקליטה תחזור.
        </div>
      )}

      {formOpen ? (
        <PmVisitForm
          key={draft.id}
          draft={draft}
          serverAt={data._fetchedAt || 0}
          user={user}
          me={me}
          isManager={isManager}
          online={online}
          refreshError={data._cachedAt ? "" : refreshError}
          cached={!!data._cachedAt}
          onReload={() => load({ silent: true })}
          onSubmitted={onSubmitted}
          onDiscarded={onDiscarded}
          onDirty={setFormReason}
          onBack={closeForm}
        />
      ) : (
        <>
          {/* ===== הטיוטה / התחלת ביקור ===== */}
          {draft ? (
            <section className={`pm-card pm-draft${stale ? " pm-draft--stale" : ""}`}>
              <div className="pm-draft-head">
                <strong>ביקור בתהליך</strong>
                {stale && <span className="pm-badge pm-badge--red">הביקור לא הוגש</span>}
              </div>
              <p className="pm-draft-text">
                התחיל {draft.started_by || "—"} ב-{formatStampIL(draft.started_at)},
                {" "}עודכן לאחרונה {formatStampIL(draft.last_activity_at)} ({agoText(draft.last_activity_at)})
              </p>
              {ob.n > 0 && (
                <p className="pm-hint pm-hint--warn">
                  {countText(ob.n, "שינוי אחד במכשיר הזה ממתין", "שינויים במכשיר הזה ממתינים")} לסנכרון.
                </p>
              )}
              <div className="pm-row">
                <button type="button" className="pm-btn pm-btn--primary" onClick={() => openForm(draft.id)}
                  disabled={!!busy}>
                  המשך
                </button>
                {restartable && (
                  <button type="button" className="pm-btn" onClick={() => start(true)} disabled={!!busy}>
                    {busy === "restart" ? "פותח…" : "התחלה מחדש"}
                  </button>
                )}
              </div>
              {restartable && (
                <p className="pm-hint">לא היתה פעילות ביותר מ-48 שעות — כל אחד רשאי להתחיל מחדש.</p>
              )}
            </section>
          ) : (
            <section className="pm-card pm-start">
              <button type="button" className="pm-btn pm-btn--primary pm-btn--wide"
                onClick={() => start(false)} disabled={!!busy || templateCount === 0 || !online}>
                {busy === "start" ? "פותח ביקור…" : "התחלת ביקור תחזוקה"}
              </button>
              {templateCount === 0 ? (
                <p className="pm-hint">
                  רשימת הבדיקה ריקה — מנהל צריך להגדיר אותה לפני שאפשר לפתוח ביקור.
                  {isManager && (
                    <>
                      {" "}
                      <button type="button" className="pm-link" onClick={() => openTool("template", true)}>
                        עריכת רשימת הבדיקה
                      </button>
                    </>
                  )}
                </p>
              ) : !online ? (
                <p className="pm-hint">פתיחת ביקור דורשת חיבור. אחרי הפתיחה אפשר לעבוד גם בלי קליטה.</p>
              ) : (
                <p className="pm-hint">{templateCount} פריטים ברשימת הבדיקה. אפשר להמשיך גם בלי קליטה — הכול נשמר במכשיר.</p>
              )}
            </section>
          )}

          {/* ===== היסטוריה ===== */}
          <section className="pm-card">
            <h3 className="pm-h3">היסטוריית ביקורים</h3>
            {visits.length === 0 ? (
              <p className="pm-muted">אין ביקורים רשומים לאתר הזה.</p>
            ) : (
              <ul className="pm-hist">
                {shown.map((v) => {
                  const isOpen = openVisit === v.id;
                  return (
                    <li key={v.id} className={`pm-hist-row${isOpen ? " pm-hist-row--open" : ""}`}>
                      <div className="pm-hist-line">
                        <div className="pm-hist-main">
                          <span className="pm-hist-date">{formatDateIL(v.performed_on)}</span>
                          <span className={`pm-tag pm-tag--${v.source}`}>{v.source === "historical" ? "דוח סרוק" : "טופס דיגיטלי"}</span>
                        </div>
                        <div className="pm-hist-meta">
                          {v.performer_name && <span>{v.performer_name}</span>}
                          {v.vendor && <span>ספק: {v.vendor}</span>}
                          {/* items_done סופר גם פריט צילום (אין לו וי); בלעדיו — "סומנו" מ-items_checked */}
                          {v.source !== "historical" && (v.items_done != null
                            ? <span>{v.items_done}/{v.items_total} בוצעו</span>
                            : <span>{v.items_checked}/{v.items_total} סומנו</span>)}
                          {v.photo_count > 0 && <span>{v.photo_count} תמונות</span>}
                          {v.file && <span>PDF</span>}
                        </div>
                        <button type="button" className="pm-btn pm-hist-btn" aria-expanded={isOpen}
                          onClick={() => setOpenVisit(isOpen ? null : v.id)}>
                          {isOpen ? "סגירה" : "צפייה בביקור"}
                        </button>
                      </div>
                      {isOpen && (
                        <PmVisitView
                          visit={v}
                          isManager={isManager}
                          onDeleted={({ already = false } = {}) => {
                            setOpenVisit(null);
                            setNotice({
                              kind: "ok",
                              text: already
                                ? "הביקור כבר נמחק מההיסטוריה (הניסיון הקודם הצליח — התשובה שלו לא הגיעה)."
                                : "הביקור נמחק מההיסטוריה.",
                            });
                            changed();
                            load({ silent: true });
                          }}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {visits.length > HISTORY_FIRST && (
              <button type="button" className="pm-btn pm-btn--ghost" onClick={() => setShowAll((s) => !s)}>
                {showAll ? "הצגת האחרונים בלבד" : `הצגת כל ${visits.length} הביקורים`}
              </button>
            )}
          </section>
        </>
      )}

      {/* ===== כלי מנהל ===== */}
      {/* ⚠️ מוסתרים בזמן מילוי (hidden) ולא מפורקים: העלאה היסטורית שבדרך או
          רשימה שבעריכה לא נזרקות כי מישהו לחץ "המשך" על הטיוטה. */}
      {isManager && (
        <section className="pm-card pm-tools" ref={toolsRef} hidden={formOpen}>
          <h3 className="pm-h3">כלי מנהל</h3>
          <div className="pm-row">
            <button type="button" className={`pm-btn${tool === "upload" ? " pm-btn--on" : ""}`}
              aria-expanded={tool === "upload"} onClick={() => openTool("upload")}>
              העלאת דוחות היסטוריים
            </button>
            <button type="button" className={`pm-btn${tool === "template" ? " pm-btn--on" : ""}`}
              aria-expanded={tool === "template"} onClick={() => openTool("template")}>
              עריכת רשימת הבדיקה ({templateCount})
            </button>
          </div>
          {mounted.has("upload") && (
            <div hidden={tool !== "upload"}>
              <PmHistoricalUpload site={site} onDirty={setUploadReason}
                onUploaded={() => { changed(); load({ silent: true }); }} />
            </div>
          )}
          {mounted.has("template") && (
            <div hidden={tool !== "template"}>
              <PmTemplateEditor active={tool === "template"} onDirty={setTplReason}
                onSaved={() => { changed(); load({ silent: true }); }} />
            </div>
          )}
        </section>
      )}
    </div>
  );
}
