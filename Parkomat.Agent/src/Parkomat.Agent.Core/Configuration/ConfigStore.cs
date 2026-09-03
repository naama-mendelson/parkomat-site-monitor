using System.Text.Json;

namespace Parkomat.Agent.Core.Configuration;

/// <summary>
/// אחראי על קריאה וכתיבה של קובץ ההגדרות config.json מהדיסק.
/// גם ה-Service וגם ה-Tray משתמשים בו כדי לקרוא/לעדכן את אותו קובץ.
/// </summary>
public static class ConfigStore
{
    // אפשרויות לקריאה/כתיבה של JSON:
    // WriteIndented -> הקובץ יהיה קריא לבני אדם (עם רווחים ושורות).
    // PropertyNameCaseInsensitive -> קריאה סלחנית לגבי אותיות גדולות/קטנות.
    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true
    };

    /// <summary>
    /// טוען את ההגדרות מהדיסק.
    /// אם הקובץ לא קיים עדיין — יוצר קובץ ברירת מחדל ומחזיר אותו,
    /// כדי שבהרצה ראשונה במחשב חדש לא ניפול.
    /// </summary>
    public static SiteConfig Load()
    {
        AgentPaths.EnsureBaseFolderExists();

        // סימון איפוס מהמתקין (מונח בכל התקנה): מאפסים את ההגדרות לברירות המחדל
        // אך *שומרים את ה-SiteId* — אחרת עדכון היה מוחק את זהות האתר (topics ריקים
        // sites// שהשרת דוחה, ו-remote_clientid ריק שמתנגש בין אתרים משוכפלים).
        ApplyResetMarkerIfPresent();

        SiteConfig result;
        if (!File.Exists(AgentPaths.ConfigFile))
        {
            result = new SiteConfig();
            Save(result);
        }
        else
        {
            string json = File.ReadAllText(AgentPaths.ConfigFile);
            SiteConfig? config;
            try
            {
                config = JsonSerializer.Deserialize<SiteConfig>(json, Options);
            }
            catch (JsonException)
            {
                // קובץ פגום (קטוע בנפילת חשמל באמצע כתיבה, או עריכה ידנית שגויה):
                // Deserialize זורק JsonException. בלי התפיסה הזו החריגה בורחת מ-Load,
                // מ-Worker.ExecuteAsync ומפילה את ה-host ל-crash-loop. חוזרים לברירת
                // מחדל כדי שהשירות ימשיך לתקשר.
                config = null;
            }
            result = config ?? new SiteConfig();
        }

        // מהדקים את קצב הדגימה לטווח שפוי — **בכל מסלול, כולל first-run**. קובץ
        // תקין-תחבירית עם ערך שלילי עובר את הגנת ה-JsonException, ואז Task.Delay
        // (שלילי) זורק ומחזיר את ה-crash-loop דרך הדלת האחורית. ההידוק סוגר זאת.
        result.PollIntervalMs = ClampPollIntervalMs(result.PollIntervalMs);

        // אותו נימוק בדיוק, ולנקודה הזו יש עוקץ משלה: מרווח סנכרון גדול מ-~24.8
        // ימים גורם ל-Task.Delay לזרוק ArgumentOutOfRangeException. הלולאה שמשתמשת
        // בו היא משימת רקע מנותקת, ולכן החריגה הייתה הופכת ל-unobserved ו**משתיקה
        // את סנכרון השעון לצמיתות בלי שום שורה בלוג** — כשל שקט לגמרי.
        result.NtpSyncIntervalMinutes = ClampNtpSyncIntervalMinutes(result.NtpSyncIntervalMinutes);

        // ⚠️ מטביעים את קוד האתר בהגדרות Supabase. שם המשתמש שם **נגזר** ממנו
        // (site-{code}@parkomat.co.il) כדי שלא יהיה שדה שמקלידים, ובלי ההטבעה
        // הזו הוא היה נגזר ממחרוזת ריקה — כלומר Enabled=false לנצח, בלי שום
        // שגיאה: הכתיבה הישירה פשוט לא הייתה קורית, והלוג היה שקט.
        //
        // ⚠️ וזה נעשה **כאן** ולא ב-Worker, כי Load הוא הדלת היחידה לקובץ —
        // ההטבעה בצרכן הייתה מתפספסת אצל הצרכן הבא (הטופס ב-Tray).
        result.Supabase.SiteId = result.SiteId;
        return result;
    }

    // אם המתקין הניח דגל איפוס: כותב config עם ברירות המחדל אך שומר את זהות
    // האתר, ומוחק את הדגל. כך "אילוץ ברירות מחדל בכל התקנה" מרענן את שאר
    // ההגדרות בלי למחוק את מה שמזהה את האתר הזה. ההחלטה עצמה נמצאת ב-
    // BuildResetConfig (טהורה וניתנת לבדיקה); כאן רק ה-I/O.
    // best-effort — כשל בו לא מפיל את הסוכן.
    private static void ApplyResetMarkerIfPresent()
    {
        try
        {
            if (!File.Exists(AgentPaths.ResetToDefaultsFlag))
                return;

            SiteConfig? old = null;
            if (File.Exists(AgentPaths.ConfigFile))
            {
                try
                {
                    old = JsonSerializer.Deserialize<SiteConfig>(
                        File.ReadAllText(AgentPaths.ConfigFile), Options);
                }
                catch { /* config פגום — מתחילים נקי */ }
            }

            Save(BuildResetConfig(old));

            // הדגל בוצע — מסירים כדי שלא נאפס שוב בעליות הבאות.
            File.Delete(AgentPaths.ResetToDefaultsFlag);
        }
        catch
        {
            // איפוס הוא nice-to-have; כשל בו לא ישבש את עליית הסוכן.
        }
    }

    /// <summary>
    /// בונה את ה-config שאחרי איפוס-לברירות-מחדל: הכל טרי, חוץ ממה שמזהה את
    /// האתר הזה ואי אפשר לגזור מחדש. פונקציה טהורה — בלי דיסק.
    ///
    /// ==========================================================
    /// מה שורד איפוס, ולמה גם שם המשתמש והסיסמה
    /// ==========================================================
    /// עד כה שרד רק ה-SiteId, ופרטי ה-HiveMQ נדרסו בברירות המחדל המהודרות
    /// בכל התקנה. כשברירת המחדל של הסיסמה ריקה, המשמעות היא ש**כל שדרוג
    /// גרסה מוחק את הסיסמה של האתר** והטכנאי חייב להקליד אותה מחדש בשטח —
    /// אחרת הגשר לא מתחבר ל-HiveMQ והאתר מפסיק לדווח.
    ///
    /// זה בדיוק הלחץ שהוליד ניסיון להדביק את הסיסמה בקוד המקור, במאגר
    /// ציבורי. התיקון הנכון הוא לא ברירת מחדל חזקה יותר אלא הכרה בכך
    /// ש**פרטי ההזדהות הם זהות האתר, לא העדפה**: בדיוק כמו SiteId, הם הוזנו
    /// פעם אחת ואין שום דרך לגזור אותם מחדש. לכן הם שורדים.
    ///
    /// שדה ריק בקובץ הישן *אינו* שורד — הוא נופל לברירת המחדל המהודרת, כדי
    /// שהתקנה על מכונה שמעולם לא הוגדרה תקבל את הערך שנצרב ב-build.
    ///
    /// PLC וכל השאר כן נדרסים: הם ניתנים לגזירה מחדש מברירות המחדל, וזו כל
    /// מטרת האיפוס — לנקות סחף הגדרות מהתקנות ישנות.
    /// </summary>
    public static SiteConfig BuildResetConfig(SiteConfig? old)
    {
        var fresh = new SiteConfig();

        if (old is null)
            return fresh;

        fresh.SiteId = Keep(old.SiteId, fresh.SiteId);
        fresh.Mqtt.Username = Keep(old.Mqtt?.Username, fresh.Mqtt.Username);
        fresh.Mqtt.Password = Keep(old.Mqtt?.Password, fresh.Mqtt.Password);

        return fresh;

        // ערך ישן שיש בו ממש גובר; ריק/רווחים/null נופל לברירת המחדל.
        static string Keep(string? previous, string fallback)
            => string.IsNullOrWhiteSpace(previous) ? fallback : previous;
    }

    /// <summary>
    /// מהדק את קצב הדגימה לטווח שפוי: לא פחות מ-100ms (0/שלילי = crash-loop או
    /// לולאה חמה) ולא יותר מ-60s. פונקציה טהורה — ניתנת לבדיקה בנפרד.
    /// </summary>
    public static int ClampPollIntervalMs(int ms) => Math.Clamp(ms, 100, 60000);

    /// <summary>
    /// מהדק את מרווח סנכרון ה-NTP לטווח שפוי: דקה אחת עד 24 שעות.
    ///
    /// הרצפה מגינה על שרתי ה-NTP הציבוריים — סנכרון כל שנייה הוא שימוש לרעה
    /// (pool.ntp.org חוסם על כך), ומיותר לחלוטין: היסט לא משתנה בקצב כזה.
    ///
    /// התקרה היא 24 שעות, בהתאמה ל-AgentClock.MaxPersistedAge: מעבר לזה ההיסט
    /// ממילא נחשב לא-אמין. היא גם מונעת את ה-ArgumentOutOfRangeException של
    /// Task.Delay (מעל ~24.8 ימים), שהיה הורג את לולאת הסנכרון בשקט.
    /// </summary>
    public static int ClampNtpSyncIntervalMinutes(int minutes) => Math.Clamp(minutes, 1, 1440);

    /// <summary>
    /// שומר את ההגדרות לדיסק, בכתיבה בטוחה:
    /// כותבים קודם לקובץ זמני ואז מחליפים, כדי שאם החשמל נופל
    /// באמצע הכתיבה — קובץ ההגדרות המקורי לא נהרס.
    /// </summary>
    public static void Save(SiteConfig config)
    {
        AgentPaths.EnsureBaseFolderExists();

        string json = JsonSerializer.Serialize(config, Options);

        string tempFile = AgentPaths.ConfigFile + ".tmp";
        File.WriteAllText(tempFile, json);

        // החלפה אטומית: או שהקובץ הישן נשאר, או שהחדש נכנס במלואו.
        File.Move(tempFile, AgentPaths.ConfigFile, overwrite: true);
    }
}