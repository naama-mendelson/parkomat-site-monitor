const db = require("../db/db");
(async () => {
  await db.init();
  const ids = (await db.prepare("SELECT id FROM sites").all()).map(r => r.id);
  const to = new Date().toISOString(), from = new Date(Date.now() - 365*86400000).toISOString();
  const buckets = [];
  for (let i = 0; i < 365; i++) {
    const s = new Date(Date.parse(from) + i*86400000);
    buckets.push({ from: s.toISOString(), to: new Date(s.getTime()+86400000).toISOString() });
  }
  buckets.push({ from, to });
  const r = await db.prepare(`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE operations=0 AND errors=0 AND entries=0 AND exits=0
                         AND COALESCE(maintenance_hours,0)=0 AND COALESCE(measured_hours,0)=0)::int AS strict_empty,
      COUNT(*) FILTER (WHERE COALESCE(measured_hours,0)=0 AND COALESCE(maintenance_hours,0)>0)::int AS maint_only,
      COUNT(*) FILTER (WHERE operations=0 AND (entries>0 OR exits>0))::int AS ops0_but_dir
    FROM public.executive_series(?, ?, ?, ?::jsonb)`).get(ids, from, to, JSON.stringify(buckets));
  console.log(`סך שורות          : ${r.total}`);
  console.log(`ריקות במסנן קפדני : ${r.strict_empty} (${(100*r.strict_empty/r.total).toFixed(0)}%)`);
  console.log(`נשארות            : ${r.total - r.strict_empty}`);
  console.log(`\nמלכודות שנבדקו:`);
  console.log(` דליים שכולם תחזוקה (measured=0, maint>0) : ${r.maint_only}  ${r.maint_only ? "⚠️ קיימים בייצור" : ""}`);
  console.log(` operations=0 אך יש כניסות/יציאות          : ${r.ops0_but_dir}`);
  process.exit(0);
})();
