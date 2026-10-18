// components/TasksFilter/TasksFilter.jsx — "משימות" בסינון שבכותרת (18/10/2026).
//
// בעלת המוצר: "להסתיר כשאין משימות פתוחות, ושיהיה סינון מסוג משימות — מלכתחילה שלא יוצגו", ובחרה "לפי סוג משימה".
// אותה רשימה כמו "בודק מוסמך" (FilterPicker): "בלי משימות" — ברירת המחדל, בלי סימון על הכרטיסים; "כל האתרים" —
// הסימון מופיע באתרים עם משימה פתוחה; "כל הפתוחות" וכל סוג — רק האתרים האלה בלוח.
// אין כאן החלטה: המפתחות, הספירה והסינון ב-utils/tasks.js.
import FilterPicker from "../ComplianceFilters/FilterPicker";
import {
  TASK_KINDS, TASK_KIND_LABEL, TASKS_VIEW_ALL, TASKS_VIEW_OFF, TASKS_VIEW_OPEN, tasksFilterCounts,
} from "../../utils/tasks";

function ListIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M4 6h2v2H4V6zm4 .5h12v1.5H8V6.5zM4 11h2v2H4v-2zm4 .5h12V13H8v-1.5zM4 16h2v2H4v-2zm4 .5h12V18H8v-1.5z" />
    </svg>
  );
}

export default function TasksFilter({ sites = [], bySite, value = TASKS_VIEW_OFF, onChange }) {
  const counts = tasksFilterCounts(sites, bySite || {});
  const items = [
    { value: TASKS_VIEW_OFF, label: "בלי משימות", hint: "בלי סימון משימות בכרטיסים", cls: "cf-item--off", mark: "○" },
    { value: TASKS_VIEW_ALL, label: "כל האתרים", n: counts[TASKS_VIEW_ALL], cls: "cf-item--all", mark: <ListIcon /> },
    { value: TASKS_VIEW_OPEN, label: "כל הפתוחות", n: counts[TASKS_VIEW_OPEN], mark: <ListIcon /> },
    ...TASK_KINDS.map((k) => ({ value: k, label: TASK_KIND_LABEL[k], n: counts[k], mark: "•" })),
  ];
  const sel = items.find((it) => it.value === value) ?? items[0];
  const on = sel.value !== TASKS_VIEW_OFF;
  const filtering = on && sel.value !== TASKS_VIEW_ALL;

  return (
    <FilterPicker
      items={items}
      current={sel.value}
      onPick={onChange}
      btnClass={`cf-area-btn tf-btn${on ? " active" : ""}`}
      ariaLabel={`משימות: ${sel.label}`}
      menuLabel="משימות — מה להציג"
      head={(open) => (
        <>
          {filtering ? (
            // מסנן — כמו אריח מצב: המספר הגדול הוא כמה אתרים מוצגים עכשיו
            <span className="filter-count cf-head">{sel.n}</span>
          ) : (
            <span className="filter-count cf-head" aria-hidden="true"><ListIcon size={22} /></span>
          )}
          <span className="filter-label cf-name">
            {filtering ? sel.label : "משימות"}
            <span className={`cf-chevron${open ? " is-open" : ""}`} aria-hidden="true">▾</span>
          </span>
          {filtering && <span className="cf-sub">משימות</span>}
          {on && !filtering && <span className="cf-sub">כל האתרים</span>}
        </>
      )}
    />
  );
}
