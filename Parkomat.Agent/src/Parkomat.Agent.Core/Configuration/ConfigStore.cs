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
    /// <summary>
    /// טעינה בעלייה של הסוכן — <b>הדלת היחידה שצורכת את דגל האיפוס</b>.
    ///
    /// ============================================================
    /// ⚠️ למה זו מתודה נפרדת, ולא דגל בתוך <c>Load</c>
    /// ============================================================
    /// האיפוס ישב בתוך <c>Load</c>, כלומר <b>קריאה</b> של ההגדרות הייתה
    /// גם <b>כתיבה</b> שלהן. ו-<c>Load</c> נקראת מארבעה מקומות — ה-Worker,
    /// טופס ההגדרות, <c>StatusForm</c>, ו-<c>ServiceManager</c>, שקורא
    /// אותה <b>בכל בדיקת שומר</b> רק כדי לדעת את קצב הדגימה.
    ///
    /// ⚠️ פונקציה שנקראת כדי לקרוא מספר אחד אינה אמורה לשכתב את
    /// <c>config.json</c>, ובוודאי לא לאפס אותו — וכל אחת מארבע הדלתות
    /// הייתה יכולה לעשות זאת, בכל רגע, גם מתהליך של גרסה קודמת שעדיין
    /// רץ בזמן התקנה. האיפוס הוא אירוע בעלייה, ולכן הוא שייך למי שעולה.
    /// </summary>
    public static SiteConfig LoadAtStartup()
    {
        AgentPaths.EnsureBaseFolderExists();

        // סימון איפוס מהמתקין (מונח בכל התקנה): מאפסים את ההגדרות לברירות המחדל
        // אך *שומרים את ה-SiteId* — אחרת עדכון היה מוחק את זהות האתר (topics ריקים
        // sites// שהשרת דוחה, ו-remote_clientid ריק שמתנגש בין אתרים משוכפלים).
        ApplyResetMarkerIfPresent();

        SiteConfig result = Load();

        // הרצה ראשונה במחשב חדש: יוצרים את הקובץ פעם אחת, כאן ולא ב-Load.
        if (!File.Exists(AgentPaths.ConfigFile))
            Save(result);

        return result;
    }

    public static SiteConfig Load()
    {
        AgentPaths.EnsureBaseFolderExists();

        SiteConfig result;
        if (!File.Exists(AgentPaths.ConfigFile))
        {
            // ⚠️ **מחזירים ברירות מחדל בלי לכתוב אותן.** הכתיבה כאן הייתה
            // דלת הכתיבה הלא-מכוונת האחרונה ב-`Load`: רגע אחד שבו הקובץ
            // אינו קיים — נעילה, סריקת אנטי-וירוס, כתיבה מקבילה — ומי
            // שקרא במקרה (ServiceManager קורא כמה פעמים בדקה) **דורס את
            // ההגדרות בברירות מחדל**. סיסמה שהוקלדה ביד נמחקת בלי שאיש
            // נגע בטופס ובלי שורה בלוג.
            //
            // ⚠️ יצירת הקובץ בהרצה ראשונה נשארת — אבל רק ב-LoadAtStartup,
            // כלומר בידי מי שעולה, פעם אחת. אותו עיקרון: קריאה קוראת.
            result = new SiteConfig();
        }
        else
        {
            string json = File.ReadAllText(AgentPaths.ConfigFile);
            SiteConfig? config;
            try
            {
                config = FromJson(json);
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
                    old = FromJson(File.ReadAllText(AgentPaths.ConfigFile));
                }
                catch { /* config פגום — מתחילים נקי */ }
            }

            // ============================================================
            // ⚠️ הדגל נמחק **לפני** הכתיבה, ולא אחריה
            // ============================================================
            // קודם הסדר היה הפוך, והכול עטוף ב-catch בולע. המשמעות: אם
            // המחיקה נכשלה — או אם Save זרק — הדגל **שורד**, ואז כל קריאה
            // ל-Load מאפסת את ה-config מחדש.
            //
            // ⚠️ וזה לא "פעם נוספת אחת". Load נקראת מארבעה מקומות, ובהם
            // ServiceManager שקורא אותה שוב ושוב רק כדי לקרוא את קצב
            // הדגימה. כלומר "איפוס פעם אחת בהתקנה" הופך ל**איפוס מתמשך**:
            // הטכנאי מקליד סיסמה, לוחץ שמור, והיא נמחקת שניות אחר כך.
            // הטופס נפתח ריק, וזה נראה כאילו "השמירה לא עבדה".
            //
            // הסדר החדש הופך את הכשל לכיוון הבטוח: אם אי אפשר למחוק את
            // הדגל, **לא מאפסים בכלל**. איפוס שהוחמץ הוא אי-נוחות; איפוס
            // שחוזר הוא מחיקה חוזרת של מה שהוקלד ביד.
            try
            {
                File.Delete(AgentPaths.ResetToDefaultsFlag);
            }
            catch
            {
                // לא הצלחנו למחוק — יוצאים בלי לאפס, אחרת ניכנס ללולאה.
                return;
            }

            Save(BuildResetConfig(old));
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
    ///
    /// ⚠️ <b>המבחן הוא "האם אפשר לגזור מחדש", ולא "האם זה סוד".</b> זה מה
    /// שמכניס לרשימה גם את שלוש העקיפות של Supabase, שאינן סודות כלל אבל הן
    /// דלת היציאה — כתובת שהוזנה ידנית אין ממה לגזור מחדש, והתקנה שדורסת
    /// אותה מחזירה אתר שהופנה לשרת אחר אל Supabase בלי שאיש ביקש.
    /// </summary>
    public static SiteConfig BuildResetConfig(SiteConfig? old)
    {
        var fresh = new SiteConfig();

        if (old is null)
            return fresh;

        fresh.SiteId = Keep(old.SiteId, fresh.SiteId);
        fresh.Mqtt.Username = Keep(old.Mqtt?.Username, fresh.Mqtt.Username);
        fresh.Mqtt.Password = Keep(old.Mqtt?.Password, fresh.Mqtt.Password);

        // ⚠️ וגם "האם MQTT כבוי" — זו החלטה **לאתר הזה**, שאין ממה לגזור
        // מחדש. איפוס שהיה מחזיר אותה ל-false פירושו ש**כל שדרוג מדליק
        // מחדש את MQTT** באתר שכובה בכוונה: הוא היה מתחיל לשדר בשני
        // המסלולים בלי שאיש ביקש, והדרך היחידה לגלות היא לשים לב
        // שהברוקר חזר.
        fresh.Mqtt.Disabled = old.Mqtt?.Disabled ?? fresh.Mqtt.Disabled;

        // ==========================================================
        // ⚠️ וגם פרטי Supabase — אותו נימוק בדיוק, ובלעדיו השדרוג מכבה
        // ==========================================================
        // הסיסמה של האתר מונפקת פעם אחת ומוצגת פעם אחת (Supabase שומר גיבוב
        // בלבד), ולכן היא זהות ולא העדפה — בדיוק כמו סיסמת HiveMQ למעלה.
        //
        // ⚠️ **ובלי זה שדרוג גרסה מכבה את המסלול הישיר בשקט מוחלט.**
        // `SupabaseConfig.Enabled` נגזר מהסיסמה, כך שסיסמה שנמחקה אינה
        // שגיאה ואינה שורת לוג — היא פשוט "האתר הזה לא הופעל". האתר ימשיך
        // לדווח דרך MQTT וייראה תקין לגמרי, וביום שיכבו את MQTT הוא ייעלם.
        // וההחזרה אינה הקלדה מחדש: הסיסמה המקורית אינה קיימת בשום מקום, אז
        // צריך להנפיק חדשה — כלומר שדרוג שגרתי הופך לפעולת ניהול.
        //
        // ⚠️ **וגם שלוש העקיפות**, ומאותה סיבה שהן לא בטופס: הן דלת היציאה.
        // אתר שהופנה ל-Postgres אחר היה חוזר ל-Supabase בהתקנה הבאה, בלי
        // שאיש ביקש ובלי שדבר יצביע על כך.
        // ⚠️ והחתמת קוד האתר, בדיוק כמו ב-Load. בלעדיה `Enabled` נשאר false
        // גם כשהסיסמה שרדה — האימייל נגזר מ-SiteId, וגזירה על מחרוזת ריקה
        // מחזירה ריק. בפועל Load מתקן את זה בעלייה הבאה, אבל אז ה-config
        // שנכתב לדיסק מתאר אתר כבוי בזמן שהוא מוגדר: כל מי שיקרא את הקובץ
        // כדי לברר "למה האתר לא כותב" יקבל תשובה שגויה.
        fresh.Supabase.SiteId = fresh.SiteId;
        fresh.Supabase.Password = Keep(old.Supabase?.Password, fresh.Supabase.Password);
        fresh.Supabase.Url = Keep(old.Supabase?.Url, fresh.Supabase.Url);
        fresh.Supabase.AnonKey = Keep(old.Supabase?.AnonKey, fresh.Supabase.AnonKey);
        fresh.Supabase.Email = Keep(old.Supabase?.Email, fresh.Supabase.Email);

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
    /// <summary>
    /// ההמרה לטקסט ובחזרה — <b>שתי פונקציות טהורות, ובכוונה</b>.
    ///
    /// ⚠️ בלעדיהן היה פער שאי אפשר לסגור בבדיקה: <c>BuildResetConfig</c> טהורה
    /// וניתנת לבדיקה, אבל מה שבאמת מגיע לאתר עובר <c>Save</c> ואז <c>Load</c> —
    /// ושתיהן נוגעות ב-<c>C:\ProgramData</c>, שאסור לבדיקה לכתוב אליו. כלומר
    /// שדה שהיה נעלם בהמרה עצמה (מסומן להתעלמות, שם שהשתנה, ‎setter חסר)
    /// היה עובר את כל הבדיקות ונופל רק באתר.
    ///
    /// אותם <c>Options</c> בדיוק שמשמשים את שני המסלולים — לא עותק שלהם.
    /// </summary>
    public static string ToJson(SiteConfig config) =>
        JsonSerializer.Serialize(config, Options);

    /// <inheritdoc cref="ToJson"/>
    public static SiteConfig? FromJson(string json) =>
        JsonSerializer.Deserialize<SiteConfig>(json, Options);

    public static void Save(SiteConfig config)
    {
        AgentPaths.EnsureBaseFolderExists();

        string json = ToJson(config);

        string tempFile = AgentPaths.ConfigFile + ".tmp";
        File.WriteAllText(tempFile, json);

        // החלפה אטומית: או שהקובץ הישן נשאר, או שהחדש נכנס במלואו.
        File.Move(tempFile, AgentPaths.ConfigFile, overwrite: true);
    }
}