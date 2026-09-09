namespace Parkomat.Agent.Core.Configuration;

/// <summary>
/// האם מופע שני של הטריי צריך <b>להשתלט</b> על הראשון, או לצאת בשקט.
///
/// <para>⚠️ <b>החור שזה סוגר: אף אחד לא משגיח על המשגיח.</b> ה-Tray מפעיל
/// מחדש את הסוכן ואת Mosquitto, והמשימה המתוזמנת מפעילה מחדש את ה-Tray —
/// אבל <c>Program.Main</c> מסיים מופע שני בשקט ברגע שה-Mutex תפוס. אז
/// Tray <b>תקוע</b> (התהליך חי, הלולאה לא מסתובבת) חוסם את המשימה כל חמש
/// דקות לנצח, והאתר מת עם "טריי רץ".</para>
///
/// <para>⚠️ <b>וזה לא תיאורטי:</b> אותו כשל בדיוק כבר תועד בשכבה שמתחת —
/// הסוכן נהרג 12 שניות לפני שהספיק לדווח תקלת PLC, וההריגה איפסה את מונה
/// הכשלים. שם התשובה הייתה <c>WatchdogPolicy</c>; כאן היא אותה תשובה,
/// שכבה אחת מעל.</para>
///
/// <para>⚠️ <b>והשאלה הנשאלת היא על הסוכן, לא על ה-Tray.</b> אין דרך
/// חיצונית לדעת אם לולאת ה-Tray מסתובבת — ואין צורך: מה שחשוב הוא
/// <b>האם האתר מדווח</b>. קובץ החיוּת נכתב בכל סיבוב של הסוכן, ולכן
/// "הסוכן מת או תקוע זמן רב" הוא בדיוק המצב שבו Tray שמתפקד היה כבר
/// מפעיל אותו מחדש. אם הוא לא עשה זאת — הוא אינו מתפקד.</para>
/// </summary>
public static class TakeoverPolicy
{
    /// <summary>מה מופע שני צריך לעשות.</summary>
    public enum Action
    {
        /// <summary>לצאת בשקט — יש טריי מתפקד.</summary>
        Exit,

        /// <summary>להרוג את הטריי הקיים ולתפוס את מקומו.</summary>
        TakeOver,
    }

    /// <summary>
    /// ⚠️ <b>פי שלושה מסף התקיעה, ובכוונה.</b> ה-Tray עצמו מפעיל מחדש את
    /// הסוכן ברגע שהוא תקוע; אם ניקח את אותו סף, מופע שני היה משתלט
    /// באמצע התאוששות תקינה — כלומר הורג טריי שעושה בדיוק את עבודתו.
    ///
    /// <para>הכפולה נותנת לו שלוש הזדמנויות מלאות להתאושש לפני שמסיקים
    /// שהוא אינו מתפקד. ⚠️ <b>ומכיוון שהמשימה רצה כל חמש דקות</b>, זמן
    /// ההשבתה במקרה הגרוע הוא הסף הזה ועוד עד חמש דקות — לא יותר.</para>
    /// </summary>
    public const int WedgedMultiplier = 3;

    /// <param name="agentProcessAlive">האם תהליך הסוכן קיים.</param>
    /// <param name="livenessAgeSeconds">
    /// גיל קובץ החיוּת — מתי לולאת הסוכן הסתובבה לאחרונה.
    /// <c>null</c> = אין קובץ.
    /// </param>
    /// <param name="pollIntervalMs">קצב הדגימה, שממנו נגזר הסף.</param>
    public static Action Decide(
        bool agentProcessAlive, long? livenessAgeSeconds, int pollIntervalMs)
    {
        int wedged = RestartPolicy.WedgedAfterSeconds(pollIntervalMs) * WedgedMultiplier;

        // ⚠️ **אין קובץ חיוּת ⇒ לא משתלטים.** זה המצב של התקנה טרייה
        // שטרם השלימה סיבוב, ושל גרסה ישנה שאינה כותבת את הקובץ כלל.
        // השתלטות כאן הייתה הופכת כל הפעלה של המשימה להריגת הטריי —
        // לולאת הרג כל חמש דקות, בדיוק ההפך מהמטרה. נכשל-סגור.
        if (livenessAgeSeconds is not long age) return Action.Exit;

        // ⚠️ **שעון שקפץ אחורה מטופל על ידי ההשוואה עצמה**, ולא בשומר
        // נפרד. NTP או שינוי אזור זמן מייצרים קובץ "מהעתיד", כלומר גיל
        // שלילי — והוא לעולם אינו גדול מהסף, אז התוצאה היא `Exit`.
        //
        // ⚠️ **וכאן עמד `if (age < 0) return Action.Exit;` — והוסר.**
        // מוטציה שהסירה אותו לא שינתה שום תוצאה, כלומר הוא היה ענף שאי
        // אפשר להבחין בו. ענף כזה נראה כמו הגנה ואינו מגן על דבר, והוא
        // גם מזמין את ההנחה שמישהו כבר בדק אותו.
        // `AClockThatWentBackwardsDoesNotKillAnything` מקבע את ההתנהגות.

        // הסוכן מת, והטריי לא הפעיל אותו מחדש בזמן שהיה לו — הוא אינו מתפקד.
        if (!agentProcessAlive && age > wedged) return Action.TakeOver;

        // הסוכן חי אבל הלולאה שלו עומדת, והטריי לא הרג אותו בזמן שהיה לו.
        if (agentProcessAlive && age > wedged) return Action.TakeOver;

        return Action.Exit;
    }

    /// <summary>הסף בפועל, לשימוש בהודעות ובבדיקות.</summary>
    public static int TakeoverAfterSeconds(int pollIntervalMs) =>
        RestartPolicy.WedgedAfterSeconds(pollIntervalMs) * WedgedMultiplier;
}
