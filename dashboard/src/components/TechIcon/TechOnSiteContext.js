// components/TechIcon/TechOnSiteContext.js — מי עומד עכשיו באתר, לכרטיסי האתרים בלוח (21/10/2026).
// הערך: Map site_id → [{ name, since, noSignal }] (techOnSiteBySite), או null — לא נטען / כבוי. App טוען כל 2 דקות.
import { createContext, useContext } from "react";

export const TechOnSiteContext = createContext(null);

/** הרשימה של אתר אחד, או null כשאין שם טכנאי. */
export function useTechOnSite(siteId) {
  const map = useContext(TechOnSiteContext);
  return (siteId != null && map?.get(siteId)) || null;
}
