namespace Parkomat.Agent.Core.Configuration;

/// <summary>
/// האם הסוכן יחזור מעצמו אחרי שהמחשב יעלה — ואם לא, למה.
///
/// <para>⚠️ <b>נולד מ-09/09/2026, אתר 1089.</b> עדכון Windows אתחל את
/// המחשב פעמיים בלילה (שני אירועי 1074 בהפרש שלוש דקות), המשתמש הוחזר
/// לסשן, הערך ב-<c>Run</c> היה קיים ותקין — <b>והטריי לא עלה 5 שעות.</b>
/// האתר היה מת עד שמישהו נכנס פיזית והריץ אותו.</para>
///
/// <para>⚠️ <b>וזו אינה שאלה על אתר אחד.</b> העדכונים מתגלגלים למכונה
/// בנפרד, ולכן זה קורה בזמנים מפוזרים, בלילה, ב-21 אתרים — בדיוק מה
/// שנראה כמו "הרבה אתרים בלי קליטה" בלי סיבה משותפת.</para>
///
/// <para>⚠️ <b>ההערכה טהורה בכוונה</b>, כמו <c>WatchdogPolicy</c> ו-
/// <c>RestartPolicy</c>: הקריאה מהרישום ומ-Task Scheduler היא I/O שאי
/// אפשר לבדוק, וההחלטה עצמה היא כל מה שחשוב — ובלי הפרדה היא הייתה
/// נבדקת רק על המכונה שעליה היא רצה.</para>
/// </summary>
public static class AutoStartHealth
{
    /// <summary>שם המשימה המתוזמנת שהמתקין יוצר.</summary>
    public const string TaskName = "ParkomatAgentKeepAlive";

    /// <summary>שם הערך תחת <c>HKCU\…\Run</c>.</summary>
    public const string RunValueName = "ParkomatAgentTray";

    /// <summary>
    /// מה שנקרא מהמכונה. <c>null</c> פירושו "לא הצלחתי לברר", והוא
    /// <b>אינו</b> זהה ל"לא קיים" — ראה <see cref="Evaluate"/>.
    /// </summary>
    public sealed class Probe
    {
        /// <summary>הערך שנמצא ב-Run, או null אם אין/לא נקרא.</summary>
        public string? RunValue { get; init; }

        /// <summary>הנתיב המלא ל-exe של הטריי, כפי שהוא בפועל.</summary>
        public string TrayPath { get; init; } = "";

        /// <summary>האם המשימה המתוזמנת קיימת. null = לא נבדק.</summary>
        public bool? TaskExists { get; init; }

        /// <summary>האם כניסה אוטומטית מוגדרת. null = לא נבדק.</summary>
        public bool? AutoLogon { get; init; }
    }

    /// <summary>ממצא בודד, בשפה שאפשר לפעול לפיה.</summary>
    public sealed record Finding(string Key, string Message, bool Critical);

    /// <summary>
    /// מעריך את שלוש שכבות ההגנה ומחזיר את מה שחסר.
    ///
    /// <para>⚠️ <b>שלוש שכבות ולא אחת, וכל אחת מכסה כשל אחר:</b></para>
    /// <list type="bullet">
    /// <item><c>Run</c> — מרים מיד בכניסה רגילה.</item>
    /// <item><b>המשימה המתוזמנת</b> — מופעלת ע"י שירות Task Scheduler,
    /// שאינו תלוי ברצף העלייה של המעטפת. זו השכבה שהייתה חסרה ב-1089.</item>
    /// <item><b>כניסה אוטומטית</b> — בלעדיה, מחשב שהתאתחל ואיש לא נכנס
    /// אליו אינו מפעיל <b>אף אחת</b> מהשתיים. זה תרחיש הפסקת החשמל.</item>
    /// </list>
    /// </summary>
    public static IReadOnlyList<Finding> Evaluate(Probe probe)
    {
        var findings = new List<Finding>();

        // ---------- Run ----------
        if (string.IsNullOrWhiteSpace(probe.RunValue))
        {
            findings.Add(new Finding("run_missing",
                "אין ערך הפעלה אוטומטית תחת HKCU\\…\\Run — הסוכן לא יעלה בכניסת המשתמש.",
                Critical: false));
        }
        // ⚠️ ערך שמצביע על **נתיב אחר** גרוע מערך חסר: הוא נראה תקין
        // בכל בדיקה שסופרת קיום, ומפעיל בינארי שאינו קיים או ישן.
        // קרה בפועל אחרי שינוי נתיב התקנה.
        else if (!string.IsNullOrWhiteSpace(probe.TrayPath)
              && !probe.RunValue.Replace("\"", "").Trim()
                     .Equals(probe.TrayPath.Trim(), StringComparison.OrdinalIgnoreCase))
        {
            findings.Add(new Finding("run_wrong_path",
                $"ערך ההפעלה האוטומטית מצביע על '{probe.RunValue}' ולא על '{probe.TrayPath}'.",
                Critical: false));
        }

        // ---------- המשימה המתוזמנת ----------
        if (probe.TaskExists == false)
        {
            findings.Add(new Finding("task_missing",
                $"המשימה המתוזמנת '{TaskName}' אינה קיימת — אחרי אתחול של עדכון Windows "
              + "הסוכן לא יעלה בעצמו. יש להתקין 1.0.38 ומעלה, או ליצור אותה ידנית.",
                Critical: true));
        }

        // ---------- כניסה אוטומטית ----------
        // ⚠️ קריטי, כי בלעדיה שתי השכבות שמעל **אינן רצות כלל**: שתיהן
        // דורשות סשן משתמש. זה תרחיש הפסקת החשמל, והוא זה שהשבית את
        // DELL008 ל-2.5 ימים.
        if (probe.AutoLogon == false)
        {
            findings.Add(new Finding("no_autologon",
                "אין כניסה אוטומטית — מחשב שיתאתחל ואיש לא ייכנס אליו יישאר ללא סוכן.",
                Critical: true));
        }

        return findings;
    }

    /// <summary>
    /// ⚠️ <b>"לא הצלחתי לברר" אינו "תקין".</b> קריאה מהרישום עלולה
    /// להיכשל בהרשאות, ו-<c>schtasks</c> עלול לא לענות. שקט במקרה כזה
    /// היה מדווח מכונה חשופה כמוגנת — כלומר בדיוק הכשל שהמנגנון הזה
    /// קיים כדי לחשוף.
    /// </summary>
    public static bool AnythingUnknown(Probe probe) =>
        probe.TaskExists is null || probe.AutoLogon is null;
}
