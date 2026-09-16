import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// ============================================================
// ⚠️ `/fixflow/` בשרת הפיתוח החזיר את הדשבורד
// ============================================================
// מסך FixFlow יושב ב-`public/fixflow/`, ו-Vite מגיש את `public/` מהשורש.
// אבל שרת הפיתוח **אינו פותר תיקייה ל-`index.html`**: בקשה ל-`/fixflow/`
// לא מתאימה לאף קובץ, ולכן ה-fallback של ה-SPA תופס אותה ומחזיר את
// `index.html` של הדשבורד.
//
// ⚠️ **וזה נראה בדיוק כמו באג בקישור.** לוחצים "תקלות ופתרונות" ומגיעים
// לדשבורד — בלי שגיאה, בלי 404, בלי שום סימן שמשהו לא נמצא.
//
// ⚠️ **ובבנייה זה עבד.** נמדד: `/fixflow/` מחזיר את FixFlow גם ב-`vite
// preview` וגם ב-Cloudflare Pages. כלומר ההבדל הוא בין סביבת הפיתוח לבין
// מה שרץ בשטח — וזו בדיוק הצורה שבה באג נבדק, נמצא תקין, ומדווח כשבור.
const serveFixflowIndex = () => ({
  name: 'fixflow-dir-index',
  apply: 'serve',
  configureServer(server) {
    // ⚠️ `pre` — לפני ה-fallback של ה-SPA, אחרת אין למה להקדים.
    server.middlewares.use((req, _res, next) => {
      if (req.url === '/fixflow' || req.url === '/fixflow/') req.url = '/fixflow/index.html';
      else if (req.url?.startsWith('/fixflow/#')) req.url = '/fixflow/index.html';
      next();
    });
  },
});

export default defineConfig({
  plugins: [react(), serveFixflowIndex()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
})
