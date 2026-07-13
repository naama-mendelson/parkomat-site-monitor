// utils/constants.js — קבועים: מצבים, צבעים, תרגומים

// 5 המצבים האפשריים של אתר
export const STATUSES = ["ready", "operating", "error", "maintenance", "no_comm"];

// תרגום מצבים לעברית
export const STATUS_LABELS = {
  ready: "מוכן",
  operating: "בפעולה",
  error: "מושבת",
  maintenance: "בתחזוקה",
  no_comm: "אין תקשורת",
};

// צבעי מצב — עקביים ונגישים.
//   dot:    צבע מלא לנקודת/פס המצב (אינדיקציה ויזואלית מהירה)
//   bg/text: לתג המצב (רקע כהה עדין + טקסט בהיר קריא)
export const STATUS_COLORS = {
  ready:       { dot: "#22c55e", bg: "rgba(34,197,94,0.16)",  text: "#4ade80", border: "#22c55e" },
  operating:   { dot: "#3b82f6", bg: "rgba(59,130,246,0.16)", text: "#60a5fa", border: "#3b82f6" },
  error:       { dot: "#ef4444", bg: "rgba(239,68,68,0.18)",  text: "#f87171", border: "#ef4444" },
  maintenance: { dot: "#eab308", bg: "rgba(234,179,8,0.16)",  text: "#facc15", border: "#eab308" },
  no_comm:     { dot: "#f97316", bg: "rgba(249,115,22,0.16)", text: "#fb923c", border: "#f97316" },
};

// צבעי כיוון תנועה (כניסה/יציאה).
// מוגדרים בנפרד *במכוון*: כיוון התנועה הוא מושג אחר ממצב האתר, ואסור לו לשאול
// צבע מ-STATUS_COLORS. בעבר "יציאה" השתמשה בצהוב של "תחזוקה" — ומרגע שתחזוקה
// הופיעה באותו לוג ובאותם גרפים, שני דברים שונים לגמרי נראו זהים.
// סגול אינו בשימוש באף אחד מחמשת המצבים.
// שני הצבעים אינם בשימוש באף אחד מחמשת המצבים:
// כניסה = טורקיז (לא כחול — כחול הוא המצב "בפעולה")
// יציאה = סגול   (לא צהוב — צהוב הוא המצב "בתחזוקה")
export const DIRECTION_COLORS = {
  entry: "#06b6d4",   // טורקיז — כניסת רכב
  exit:  "#a855f7",   // סגול — יציאת רכב
};

export const DIRECTION_LABELS = {
  entry: "כניסה",
  exit: "יציאה",
};

// סף צפיפות לרשת הכרטיסים (PRD 12.1)
export const DENSITY = {
  COMPACT_THRESHOLD: 20, // מעל 20 אתרים → כרטיסים compact
  MINI_THRESHOLD: 50,    // מעל 50 אתרים → כרטיסים mini (שם + צבע בלבד)
};
