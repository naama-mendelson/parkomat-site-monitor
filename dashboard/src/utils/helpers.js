// utils/helpers.js — פונקציות עזר

// עיצוב תאריך ISO לתצוגה בעברית
export function formatDate(isoString) {
  if (!isoString) return "—";
  return new Date(isoString).toLocaleString("he-IL", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// "לפני כמה זמן" — מקבל ISO string, מחזיר "לפני 3 דקות" וכו'
export function timeAgo(isoString) {
  if (!isoString) return "לא ידוע";
  const diff = Date.now() - new Date(isoString).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "עכשיו";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `לפני ${minutes} דקות`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `לפני ${hours} שעות`;
  const days = Math.floor(hours / 24);
  return `לפני ${days} ימים`;
}

// חיפוש fuzzy פשוט — בודק אם כל תווי החיפוש מופיעים בסדר בטקסט
export function fuzzyMatch(text, query) {
  if (!query) return true;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let ti = 0;
  for (let qi = 0; qi < lowerQuery.length; qi++) {
    const found = lowerText.indexOf(lowerQuery[qi], ti);
    if (found === -1) return false;
    ti = found + 1;
  }
  return true;
}