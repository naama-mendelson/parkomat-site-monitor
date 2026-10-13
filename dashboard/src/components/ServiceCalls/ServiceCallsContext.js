// components/ServiceCalls/ServiceCallsContext.js — מספר הקריאות הפתוחות בוויזנט לכל אתר, ופתיחת החלון.
// ⚠️ null = התכונה כבויה (VITE_SERVICE_CALLS), מצב שרת, או שהמספרים עוד לא נטענו — אין סימון בכרטיס.
import { createContext, useContext } from "react";

export const ServiceCallsContext = createContext(null);
export const useServiceCalls = () => useContext(ServiceCallsContext);
