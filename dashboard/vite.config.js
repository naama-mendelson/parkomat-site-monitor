import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// ============================================================
// ⚠️ קבצי העזר של pdfjs — בנתיב קבוע, בלי hash
// ============================================================
// סריקות משרדיות נדחסות ב-JBIG2 (שחור-לבן) או JPEG2000, ו-pdfjs מפענח
// אותן ב-wasm שהוא טוען בעצמו: `${wasmUrl}jbig2.wasm`. בלי wasmUrl הוא רק
// כותב warn() — והעמוד "מצויר בהצלחה" **בלי התמונה**. עמוד לבן, בלי שגיאה,
// בדיוק בתסקירים הסרוקים שבהם התצוגה היא הדבר היחיד שהמנהל קורא ממנו.
// אותו דבר לגופנים הסטנדרטיים ול-CMaps (טקסט בגופני CID).
//
// pdfjs משרשר בסיס + שם קובץ, ולכן hash לכל קובץ (מה ש-Vite עושה ל-assets)
// לא יעבוד. התוסף מגיש את הקבצים מ-node_modules בפיתוח, ומעתיק אותם
// ל-dist/pdfjs/ בבנייה — כך הם תמיד מאותה גרסה כמו הספרייה עצמה, ואין
// עותק ב-public/ שיכול להתיישן אחרי שדרוג.
const PDFJS_ASSETS = {
  wasm: /^(jbig2|openjpeg)(\.wasm|_nowasm_fallback\.js)$|^qcms_bg\.wasm$|^LICENSE/,
  standard_fonts: /\.(pfb|ttf)$|^LICENSE/,
  cmaps: /\.bcmap$|^LICENSE$/,
  iccs: /\.icc$|^LICENSE$/,
};
const PDFJS_MIME = { '.wasm': 'application/wasm', '.js': 'text/javascript', '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.icc': 'application/vnd.iccprofile' };

const pdfjsAssets = () => {
  const root = fileURLToPath(new URL('./node_modules/pdfjs-dist/', import.meta.url));
  const list = () => Object.entries(PDFJS_ASSETS).flatMap(([dir, re]) =>
    readdirSync(join(root, dir)).filter((f) => re.test(f)).map((f) => [dir, f]));
  return {
    name: 'pdfjs-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/pdfjs\/([a-z_]+)\/([^/?#]+)/.exec(req.url || '');
        if (!m || !PDFJS_ASSETS[m[1]] || !PDFJS_ASSETS[m[1]].test(m[2])) return next();
        try {
          const body = readFileSync(join(root, m[1], m[2]));
          res.setHeader('Content-Type', PDFJS_MIME[extname(m[2])] || 'application/octet-stream');
          res.end(body);
        } catch {
          next();
        }
      });
    },
    generateBundle() {
      for (const [dir, f] of list()) {
        this.emitFile({ type: 'asset', fileName: `pdfjs/${dir}/${f}`, source: readFileSync(join(root, dir, f)) });
      }
    },
  };
};

export default defineConfig({
  plugins: [react(), serveFixflowIndex(), pdfjsAssets()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
})
