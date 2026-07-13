// hooks/useSSE.js — האזנה ל-Server-Sent Events (עדכונים בזמן אמת)
import { useEffect, useRef } from "react";

// מקבל callback שייקרא בכל עדכון מהשרת
export function useSSE(onUpdate) {
  const callbackRef = useRef(onUpdate);
  callbackRef.current = onUpdate;

  useEffect(() => {
    const source = new EventSource("/api/stream");

    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        callbackRef.current(data);
      } catch (err) {
        console.warn("SSE parse error:", err);
      }
    };

    source.onerror = () => {
      console.warn("SSE disconnected — reconnecting automatically...");
    };

    // ניקוי בעת סגירת הקומפוננטה
    return () => source.close();
  }, []);
}