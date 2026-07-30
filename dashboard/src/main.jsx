// main.jsx — נקודת כניסה
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import AuthGate from "./components/Login/AuthGate";
import "./components/Login/Login.css";

// ============================================================
// השער עוטף את App ואינו בתוכו
// ============================================================
// כך App אינו יודע שאימות קיים, ואינו צריך לטפל ב"מה אם אין משתמש" בכל
// hook שמביא נתונים. הדשבורד קורא את בסיס הנתונים ישירות, ו-RLS מתיר
// קריאה למאומתים בלבד — כלומר App בלי session אינו "מוגבל" אלא ריק.
createRoot(document.getElementById("root")).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>
);
