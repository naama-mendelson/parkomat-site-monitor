// components/SiteInactive/SiteInactiveContext.js — "לא פעיל" (22/10/2026): מי יכול לסמן, ופתיחת החלון לאתר.
// null = אין סימון במצב הזה (מצב שרת) — הכרטיס לא מצייר כפתור. { canEdit, open(site) }.
import { createContext, useContext } from "react";

export const SiteInactiveContext = createContext(null);
export const useSiteInactive = () => useContext(SiteInactiveContext);
