// ingestion/state-handler.js — מטפל בהודעת state: מעדכן מצב נוכחי + היסטוריה

const { updateLastSeenIfNewer, applyStateChange, getOpenStatusStartedAt } = require("../db/queries");
const bus = require("../bus");

async function handleState(site, data) {
  const newStatus = data.state;

  let occurredAt;
  if (newStatus === "no_comm") {
    occurredAt = new Date().toISOString();
  } else {
    occurredAt = new Date(data.timestamp * 1000).toISOString();
  }

  // הגנת backfill: הודעה שקרתה לפני תחילת המצב הנוכחי הגיעה מאוחר (סדר הפוך /
  // redelivery). אסור לה לשכתב את הסטטוס — אחרת נוצרת שורת היסטוריה עם משך שלילי
  // ו-last_seen נדחף אחורה. no_comm תמיד עם זמן עכשווי, ולכן לעולם לא ייחסם כאן.
  const openStartedAt = await getOpenStatusStartedAt(site.id);
  if (openStartedAt && occurredAt < openStartedAt) {
    console.log(`[state] אתר ${site.code}: הודעת state מאוחרת (${occurredAt} < ${openStartedAt}) — התעלמנו`);
    return;
  }

  if (newStatus === site.status) {
    // no_comm חוזר (למשל LWT נוסף) לא מרענן last_seen — האתר עדיין לא נשמע.
    if (newStatus === "no_comm") {
      console.log(`[state] אתר ${site.code}: no_comm (ללא שינוי, last_seen לא עודכן)`);
      return;
    }
    await updateLastSeenIfNewer(site.id, occurredAt);
    console.log(`[state] אתר ${site.code}: ${newStatus} (ללא שינוי, עודכן last_seen)`);
    return;
  }

  await applyStateChange(site.id, newStatus, occurredAt);
  console.log(`[state] אתר ${site.code}: ${site.status} → ${newStatus} (שינוי נרשם)`);

  // שידור לכל מי שמאזין (SSE, ועוד בעתיד)
  bus.emit("siteUpdate", {
    type: "state",
    code: site.code,
    oldStatus: site.status,
    newStatus: newStatus,
    occurredAt: occurredAt,
  });
}

module.exports = { handleState };