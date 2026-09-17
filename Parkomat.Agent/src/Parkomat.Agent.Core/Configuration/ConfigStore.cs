using System.Globalization;
using System.Text;
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
    private static void ApplyResetMarkerIfPresent() =>
        ApplyResetMarker(AgentPaths.ConfigFile, AgentPaths.ResetToDefaultsFlag);

    /// <summary>
    /// צריכת דגל האיפוס על נתיבים נתונים. ⚠️ <b>הנתיבים הם פרמטר בשביל
    /// בדיקות</b>: המסלול האמיתי יושב ב-<c>C:\ProgramData</c>, שאסור לבדיקה
    /// לגעת בו — ובלי התפר הזה ההחלטה "מה עושים בקובץ שאינו ניתן לפענוח"
    /// הייתה נבדקת רק באתר.
    /// </summary>
    public static void ApplyResetMarker(string configPath, string flagPath)
    {
        try
        {
            if (!File.Exists(flagPath))
                return;

            // ============================================================
            // ⚠️ קובץ שאינו ניתן לפענוח אינו "אין הגדרות קודמות"
            // ============================================================
            // כאן עמד `catch { /* config פגום — מתחילים נקי */ }`, ואחריו
            // `Save(BuildResetConfig(null))` — כלומר ברירות מחדל **מעל** הקובץ.
            // מזהה האתר, סיסמת HiveMQ, וסיסמת Supabase — שמוצגת פעם אחת
            // בהנפקה ואין מאיפה להעתיק אותה — נמחקו בהתקנה שגרתית. קובץ פגום
            // ניתן לתיקון ביד; קובץ שנדרס אינו ניתן לתיקון בכלל.
            //
            // ⚠️ ושתי סיבות שונות לגמרי הגיעו לאותו catch:
            //   • **קריאה שנכשלה** (אנטי-וירוס מחזיק את הקובץ ברגע העלייה) —
            //     לא ידוע מה בקובץ, ולכן לא נוגעים בכלום, **גם לא בדגל**:
            //     האיפוס שההתקנה ביקשה יקרה בעלייה הבאה.
            //   • **פענוח שנכשל** — הקובץ נשמר כמות שהוא, עותק לצדו, ואדם
            //     מחליט. ה-Worker אומר זאת בשורת Critical (ראה שם).
            SiteConfig? old = null;
            bool unparseable = false;
            if (File.Exists(configPath))
            {
                string json;
                try
                {
                    json = File.ReadAllText(configPath);
                }
                catch
                {
                    return;
                }

                try { old = FromJson(json); }
                catch { old = null; }
                unparseable = old is null;
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
                File.Delete(flagPath);
            }
            catch
            {
                // לא הצלחנו למחוק — יוצאים בלי לאפס, אחרת ניכנס ללולאה.
                return;
            }

            // ⚠️ הדגל **נצרך** גם כאן, ובכוונה: האיפוס שייך להתקנה, ואדם
            // שתיקן את הקובץ ביד אחריה אמור לקבל אותו כפי שכתב — לא איפוס
            // מושהה שקופץ ברגע שהקובץ נעשה קריא.
            if (unparseable)
            {
                PreserveIfUnreadable(configPath);
                return;
            }

            Save(BuildResetConfig(old), configPath);
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

        // ==========================================================
        // ⚠️ **בלוק ה-PLC שורד את ההתקנה** — וזה היפוך של החלטה קודמת
        // ==========================================================
        // עד 1.0.48 רק התעבורה ופקודת הקריאה שרדו; הכתובת, הפורט
        // ושלושת הרגיסטרים חזרו לברירת המחדל בכל התקנה. הנימוק היה
        // ש"הם ניתנים להקלדה מחדש בטופס".
        //
        // ⚠️ **נמדד ב-10/09/2026, ובגללו זה השתנה.** באתר 2222 שדרוג
        // אחד החזיר את הכתובת ל-192.168.1.3 ואת הרגיסטרים ל-290/291/292
        // — ברירות המחדל הצרובות — והאתר שידר לכתובת שאין בה דבר. באותו
        // יום זה קרה **שלוש פעמים**, וכל פעם עלתה בהקלדה מחדש של ארבעה
        // שדות שאיש אינו זוכר בעל פה.
        //
        // ⚠️ **והנימוק הישן היה שגוי בנקודה אחת.** נטען שכתובת שגויה
        // "נכשלת בקול" ולכן ניתנת לתיקון. היא אכן נכשלת בקול **בלוג**,
        // אבל בשום מסך: האתר נראה מותקן, הסמל עולה, ואין שום דבר שאומר
        // "הכתובת שהוקלדה נמחקה בשדרוג". זהו בדיוק הכשל השקט שהמערכת
        // הזו קיימת כדי למנוע — והוא **נגרם** על ידי השדרוג.
        //
        // כל אלה הן החלטות **לאתר הזה** שאין ממה לגזור מחדש, בדיוק כמו
        // התעבורה. `FaultTextMaxChars` ממשיך להתאפס: הוא מספר כוונון עם
        // ברירת מחדל סבירה, ולא זהות של אתר.
        //
        // ⚠️ **אבל התעבורה שונה מהם במהות, ולכן היא לא "עוד שדה PLC".**
        // כתובת שגויה נכשלת בקול — הלוג אומר timeout, והסמל אפור. תעבורה
        // שגויה נכשלת **באותה צורה בדיוק**, אבל הסיבה אינה מופיעה בשום
        // מקום: הכתובת נכונה, הרגיסטרים נכונים, והבקר פשוט אינו עונה
        // בפרוטוקול שמדברים אליו. אין שדה בקובץ שמעיד שמישהו בחר אחרת,
        // כי האיפוס מחק אותו.
        //
        // וזה גם לא ערך שאפשר "לנחש נכון": ברירת המחדל TCP היא הנכונה
        // ל-21 האתרים הקיימים ו**שגויה** לאתר UDP, כלומר איפוס תמיד פוגע
        // בדיוק באתרים שבשבילם התכונה נבנתה.
        //
        // אותו נימוק בדיוק כמו `Mqtt.Disabled` מיד למטה: החלטה **לאתר
        // הזה** שאין ממה לגזור מחדש — להבדיל מהעדפה שאפשר להקליד שוב.
        if (old.Plc is not null && !string.IsNullOrWhiteSpace(old.Plc.Transport))
            fresh.Plc.Transport = old.Plc.Transport;

        // ⚠️ **ופקודת הקריאה, מאותו נימוק בדיוק.** בקר שחושף רק Holding
        // Registers אינו עונה ל-FC 04, והכשל נראה **זהה** לכתובת שגויה:
        // timeout, בלי שום רמז שמישהו בחר פקודה אחרת ושהאיפוס מחק אותה.
        //
        // ו-4 אינה ברירת מחדל ניטרלית — היא נכונה ל-21 האתרים הקיימים
        // ושגויה בדיוק לאלה שבשבילם התכונה נבנתה, כמו TCP למעלה.
        //
        // ⚠️ התנאי הוא `> 0` ולא "מוכר": קובץ ישן שאין בו את השדה כלל
        // מגיע כ-0 (מאתחל-המאפיין רץ רק כשהמאפיין **נעדר** מה-JSON), ואז
        // צריך ליפול לברירת המחדל 4 ולא לשמר אפס.
        if (old.Plc is not null && old.Plc.FunctionCode > 0)
            fresh.Plc.FunctionCode = old.Plc.FunctionCode;

        // ⚠️ ריק/אפס **אינו** נשמר: קובץ פגום או שדה שלא מולא חוזר
        // לברירת המחדל, אחרת שדרוג היה מקבע מחרוזת ריקה ככתובת PLC.
        if (old.Plc is not null)
        {
            fresh.Plc.IpAddress = Keep(old.Plc.IpAddress, fresh.Plc.IpAddress);

            if (old.Plc.Port > 0) fresh.Plc.Port = old.Plc.Port;
            if (old.Plc.ModeRegister > 0) fresh.Plc.ModeRegister = old.Plc.ModeRegister;
            if (old.Plc.CardRegister > 0) fresh.Plc.CardRegister = old.Plc.CardRegister;
            if (old.Plc.CycleRegister > 0) fresh.Plc.CycleRegister = old.Plc.CycleRegister;

            // ⚠️ **ורגיסטרי המערכת השנייה, מאותו נימוק בדיוק.** `HasSecondSystem`
            // נגזר משניהם, וברירת המחדל היא 0 — כלומר שדרוג שלא נושא אותם
            // הופך אתר דו-מערכתי (פלורנטין) לחד-מערכתי בשקט מוחלט: הבקר
            // עונה, הסמל ירוק, והמערכת השנייה פשוט מפסיקה לדווח.
            if (old.Plc.ModeRegister2 > 0) fresh.Plc.ModeRegister2 = old.Plc.ModeRegister2;
            if (old.Plc.CardRegister2 > 0) fresh.Plc.CardRegister2 = old.Plc.CardRegister2;

            // ⚠️ אפס כאן פירושו "התכונה כבויה" ולא "לא הוגדר" (ראה
            // PlcReader.ReadFaultText), ולכן הוא נשמר כמו כל ערך אחר.
            if (old.Plc.FaultTextRegister >= 0)
                fresh.Plc.FaultTextRegister = old.Plc.FaultTextRegister;
        }

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

    public static void Save(SiteConfig config) => Save(config, AgentPaths.ConfigFile);

    /// <summary>
    /// שמירה לנתיב נתון. ⚠️ <b>הנתיב הוא פרמטר בשביל בדיקות</b> — ראה
    /// <see cref="ApplyResetMarker"/>.
    /// </summary>
    public static void Save(SiteConfig config, string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);

        // ⚠️ **עותק לפני דריסה של קובץ שאינו ניתן לפענוח.** `Load` מחזירה
        // עליו ברירות מחדל, טופס ההגדרות מציג אותן, והטכנאי מקליד מזהה אתר
        // ולוחץ "שמור" — השמירה לגיטימית, אבל בלי העותק הקובץ המקורי (וסיסמת
        // Supabase שבתוכו) נעלם לתמיד. עותק שנכשל זורק, והשמירה נכשלת בקול:
        // עדיף "השמירה נכשלה" על מסך מאשר מחיקה שקטה.
        PreserveIfUnreadable(path);

        string json = ToJson(config);

        // ⚠️ **Flush(true) לפני ה-Move, ולא WriteAllText.** ‏`WriteAllText` חוזר
        // כשהבייטים במטמון של Windows; ה-Move שאחריו נרשם ביומן NTFS מיד.
        // נפילת חשמל בחלון הזה משאירה `config.json` **ריק** — כלומר ה-tmp+Move
        // הגן מפני קובץ חצי-כתוב ולא מפני קובץ שתוכנו מעולם לא הגיע לדיסק.
        string tempFile = path + ".tmp";
        using (var fs = new FileStream(tempFile, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            fs.Write(new UTF8Encoding(encoderShouldEmitUTF8Identifier: false).GetBytes(json));
            fs.Flush(flushToDisk: true);
        }

        // החלפה אטומית: או שהקובץ הישן נשאר, או שהחדש נכנס במלואו.
        File.Move(tempFile, path, overwrite: true);
    }

    /// <summary>
    /// אם הקובץ קיים <b>ואינו ניתן לפענוח</b> — שומר עותק שלו לצדו
    /// (<c>config.json.corrupt-yyyyMMdd-HHmmss</c>) ומחזיר את נתיב העותק.
    /// אחרת (אין קובץ, קובץ תקין, או קובץ שלא ניתן לקרוא כרגע) — <c>null</c>.
    ///
    /// <para>⚠️ <b>"לא נקרא" אינו "פגום".</b> קובץ שמוחזק ברגע הזה בידי
    /// אנטי-וירוס אינו מעיד דבר על תוכנו, ועותק שלו אינו אפשרי ממילא.</para>
    ///
    /// <para>⚠️ <b>עותק זהה אינו נוצר פעמיים.</b> סוכן שעולה שוב ושוב על
    /// אותו קובץ פגום היה ממלא את התיקייה בעותקים זהים, ומי שמאבחן היה צריך
    /// להשוות אותם ביד כדי לגלות שאין ביניהם הבדל.</para>
    /// </summary>
    /// <exception cref="IOException">הקובץ פגום ולא ניתן היה לשמור עותק.</exception>
    public static string? PreserveIfUnreadable(string path)
    {
        byte[] bytes;
        try
        {
            if (!File.Exists(path)) return null;
            bytes = File.ReadAllBytes(path);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }

        if (IsParseable(bytes)) return null;

        string full = Path.GetFullPath(path);
        string dir = Path.GetDirectoryName(full)!;
        string prefix = Path.GetFileName(full) + ".corrupt-";

        foreach (string existing in Directory.GetFiles(dir, prefix + "*"))
        {
            try
            {
                if (File.ReadAllBytes(existing).AsSpan().SequenceEqual(bytes)) return existing;
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // עותק שלא נקרא אינו הוכחה שיש עותק — ממשיכים ויוצרים חדש.
            }
        }

        string stamp = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture);
        for (int n = 0; ; n++)
        {
            string copy = Path.Combine(dir, prefix + stamp + (n == 0 ? "" : "-" + n));
            try
            {
                // CreateNew: לעולם לא דורסים עותק קודם, גם אם שמו זהה.
                using var fs = new FileStream(copy, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                fs.Write(bytes);
                fs.Flush(flushToDisk: true);
                return copy;
            }
            catch (IOException) when (n < 100 && File.Exists(copy))
            {
                // השם תפוס (אותה שנייה, תוכן אחר) — מנסים את הבא.
            }
        }
    }

    // ⚠️ אותו פענוח בדיוק כמו Load: ReadAllText מזהה BOM, ולכן גם כאן. קובץ
    // שנשמר ב-Notepad עם BOM הוא תקין, ו"עותק פגום" שלו היה אזעקת שווא.
    private static bool IsParseable(byte[] bytes)
    {
        try
        {
            using var reader = new StreamReader(new MemoryStream(bytes), Encoding.UTF8,
                detectEncodingFromByteOrderMarks: true);
            return FromJson(reader.ReadToEnd()) is not null;
        }
        catch
        {
            return false;
        }
    }
}