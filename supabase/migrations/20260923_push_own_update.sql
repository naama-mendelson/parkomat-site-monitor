-- ============================================================
-- push_subscriptions — מדיניות UPDATE חסרה, ולכן כל אימות מחדש נכשל
-- ============================================================
-- ⚠️ ל-20260819_push_notifications.sql יש SELECT, INSERT ו-DELETE — ואין
-- UPDATE, אף שה-GRANT שם כולל UPDATE. הדשבורד שומר מינוי ב-
-- `upsert(..., { onConflict: "endpoint" })`, כלומר `INSERT … ON CONFLICT DO
-- UPDATE`, ומכשיר שכבר רשום **תמיד** מגיע לענף ה-UPDATE. בלי מדיניות RLS
-- מחזיר שם שגיאה, ולא מדלג על השורה.
--
-- נמדד בייצור ב-23/09/2026, בטרנזקציה שהתגלגלה אחורה, בהתחזות לבעל כל
-- מינוי: שני המינויים הקיימים נכשלו ב-"new row violates row-level security
-- policy (USING expression)". התסמין היה ש-`ensurePushSubscription` החזיר
-- save-failed בכל פתיחה, ו-`verified_at` לא התקדם מאז 06/09 — אחרי שבעה
-- ימים כל מכשיר נראה "לא מאומת".
--
-- ⚠️ **USING וגם WITH CHECK, שניהם על הבעלים.** USING לבדו היה מאפשר
-- לעדכן שורה שלי כך שתשויך למשתמש אחר; WITH CHECK לבדו היה מאפשר upsert
-- על endpoint של מישהו אחר ולהשתלט על המכשיר שלו — בדיוק מה שה-RLS כאן
-- קיים כדי למנוע (ראה ההערה במיגרציה המקורית: endpoint הוא מכשיר אישי).
DROP POLICY IF EXISTS push_own_update ON push_subscriptions;
CREATE POLICY push_own_update ON push_subscriptions
  FOR UPDATE TO authenticated
  USING (app_user_id = (SELECT u.id FROM app_users u
                         WHERE u.supabase_uid::text = app.current_actor()
                           AND u.is_active))
  WITH CHECK (app_user_id = (SELECT u.id FROM app_users u
                              WHERE u.supabase_uid::text = app.current_actor()
                                AND u.is_active));
