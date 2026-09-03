using System;

namespace Parkomat.Agent.Core.Configuration;

/// <summary>
/// ברירות המחדל של הארגון — הדברים שזהים בכל 16 האתרים.
///
/// ⚠️ <b>שלושה מארבעת השדות מעולם לא היו צריכים להיות שדות.</b> הכתובת
/// והמפתח זהים לכל האתרים, והאימייל נגזר מקוד האתר שהסוכן כבר מחזיק.
/// דרישה להקליד אותם בכל אתר אינה גמישות — היא שלוש הזדמנויות לשגיאת
/// הקלדה שמתגלה רק כשמישהו שם לב שאתר לא מדווח.
///
/// ⚠️ <b>והמפתח אינו סוד</b>: הוא נשלח לכל דפדפן שפותח את הדשבורד
/// (<c>VITE_SUPABASE_PUBLISHABLE_KEY</c>). RLS הוא מה שמגן, לא הסתרתו.
/// </summary>
public static class SupabaseDefaults
{
    public const string Url = "https://xvfsikwaaaohnmldjbtv.supabase.co";
    public const string AnonKey = "sb_publishable_9SiMCLeQj6FLUT3RpMsEZQ_pTYSL2WP";

    /// <summary>שם המשתמש של אתר — חייב להסכים עם <c>emailFor</c> בכלי ההנפקה.</summary>
    public static string EmailFor(string siteId) =>
        string.IsNullOrWhiteSpace(siteId) ? "" : $"site-{siteId.Trim()}@parkomat.co.il";
}

/// <summary>
/// כתיבה ישירה ל-Supabase — <b>כבויה עד שמזינים סיסמה</b>.
///
/// <para>
/// ⚠️ <b>שדה אחד, לא ארבעה.</b> הכתובת והמפתח זהים בכל 16 האתרים ולכן הם
/// ב-<see cref="SupabaseDefaults"/>; שם המשתמש נגזר מקוד האתר שהסוכן כבר
/// מחזיק. הדבר היחיד ששונה בין אתר לאתר — ולכן הדבר היחיד שמקלידים — הוא
/// <b>הסיסמה</b>. הפעלה היא הדבקה אחת; כיבוי הוא מחיקתה.
/// </para>
///
/// <para>
/// ⚠️ <b>המסלול הזה חי לצד MQTT, ולא במקומו.</b> כל עוד הסיסמה ריקה
/// (<see cref="Enabled"/> = false) הסוכן מתנהג בדיוק כמו קודם, ואפשר לשגר
/// את הגרסה ל-16 האתרים בלי לשנות דבר בהתנהגותם.
/// </para>
///
/// <para>
/// ⚠️ זה אותו דפוס בדיוק שכבר קיים בפרויקט: מתג <c>VITE_SUPABASE_DIRECT</c>
/// בדשבורד וספק ההזדהות הרדום. מסלול חדש שמחליף את הישן ביום אחד בכל
/// האתרים אינו מיגרציה אלא הימור.
/// </para>
///
/// <para>
/// ⚠️ <b>לכל אתר משתמש משלו</b>, ולא קרדנציאל משותף. היום כל 16 האתרים
/// חולקים שם משתמש וסיסמה אחת מול HiveMQ, בטקסט גלוי, שניתנת לחילוץ מכל
/// installer ב-<c>strings</c> — דליפה מאתר אחד פותחת את כולם. כאן הזהות
/// מתוחמת לאתר אחד, והשרת גוזר את האתר <b>ממנה</b> ולא מהמטען.
/// </para>
///
/// <para>
/// ⚠️ <b>וזו הסיבה שהסיסמה לבדה אינה נצרבת ל-build</b>, בניגוד לכתובת
/// ולמפתח: היא שונה לכל אתר, ואין לה ערך ברירת-מחדל שאפשר לצרוב. סיסמה
/// משותפת צרובה הייתה משחזרת בדיוק את הכשל של HiveMQ.
/// </para>
/// </summary>
public class SupabaseConfig
{
    /// <summary>
    /// קוד האתר. ⚠️ <b>אינו נשמר ב-config</b> — הוא כבר יושב ב-<c>SiteConfig.SiteId</c>,
    /// ושני עותקים של אותו ערך הם שני עותקים שיכולים להיפרד. <c>ConfigStore</c>
    /// מטביע אותו כאן בטעינה.
    /// </summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public string SiteId { get; set; } = "";

    /// <summary>
    /// עקיפה לכתובת הפרויקט. <b>ריק = ברירת המחדל</b>, וזה המצב הרגיל.
    ///
    /// ⚠️ <b>השדה נשאר קיים אף שאיש אינו ממלא אותו — זו דלת היציאה.</b>
    /// כתובת צרובה ב-16 סוכנים פירושה שמעבר ל-Postgres אחר הוא 16 התקנות.
    /// עם השדה הזה זה שינוי שדה אחד, מרחוק, בלי לגעת ב-installer.
    /// </summary>
    public string Url { get; set; } = "";

    /// <summary>עקיפה למפתח הפומבי. ריק = ברירת המחדל.</summary>
    public string AnonKey { get; set; } = "";

    /// <summary>
    /// עקיפה לשם המשתמש. <b>ריק = נגזר מקוד האתר</b> (<c>site-2438@parkomat.co.il</c>).
    /// </summary>
    public string Email { get; set; } = "";

    /// <summary>הכתובת בפועל — העקיפה אם מולאה, אחרת ברירת המחדל.</summary>
    public string EffectiveUrl =>
        string.IsNullOrWhiteSpace(Url) ? SupabaseDefaults.Url : Url.Trim();

    /// <summary>המפתח בפועל.</summary>
    public string EffectiveAnonKey =>
        string.IsNullOrWhiteSpace(AnonKey) ? SupabaseDefaults.AnonKey : AnonKey.Trim();

    /// <summary>שם המשתמש בפועל — העקיפה אם מולאה, אחרת נגזר מקוד האתר.</summary>
    public string EffectiveEmail =>
        string.IsNullOrWhiteSpace(Email) ? SupabaseDefaults.EmailFor(SiteId) : Email.Trim();

    /// <summary>
    /// הסיסמה של משתמש האתר.
    ///
    /// ⚠️ מונפקת ב-<c>tools/provision-agent-user.js</c> ומוצגת <b>פעם אחת
    /// בלבד</b> — Supabase מחזיק גיבוב בלבד. שורה שנסגרה בלי להעתיק אותה
    /// משמעה הנפקה מחדש, וההנפקה מנתקת את האתר עד שה-config מתעדכן.
    /// </summary>
    public string Password { get; set; } = "";

    /// <summary>
    /// האם הכתיבה הישירה פעילה. <b>נגזר, לא נשמר</b>.
    ///
    /// ⚠️ דגל בוליאני נפרד היה מאפשר מצב "מופעל אבל בלי פרטים" — כלומר
    /// סוכן שמנסה לכתוב, נכשל בכל סבב, וממלא את הלוג. כאן המצב הזה אינו
    /// ניתן לביטוי.
    /// </summary>
    /// ⚠️ <b>ומה שמדליק אותו הוא הסיסמה בלבד.</b> שאר השלושה נגזרים או
    /// צרובים, ולכן הם תמיד מלאים — הם נבדקים כאן כהגנה בעומק, לא כדרישה
    /// מהטכנאי: השדה היחיד שממתין למישהו הוא הסיסמה, ו<b>מחיקתה מכבה</b>.
    public bool Enabled =>
        !string.IsNullOrWhiteSpace(Password) &&
        IsSecureUrl(EffectiveUrl) &&
        !string.IsNullOrWhiteSpace(EffectiveAnonKey) &&
        !string.IsNullOrWhiteSpace(EffectiveEmail);

    /// <summary>
    /// הכתובת חייבת להיות <b>https</b> מוחלטת.
    ///
    /// ⚠️ <b>הכתיבה הישירה שולחת סיסמה בגוף הבקשה ואסימון בכותרת.</b>
    /// ב-<c>http</c> שניהם עוברים בטקסט גלוי ברשת החניון — יחד עם היכולת
    /// לכתוב לאתר הזה. עד כה לא הייתה כאן שום בדיקה: הכתובת נלקחה מהטופס
    /// כמות שהיא, וטכנאי שהקליד <c>http://</c> היה מקבל סוכן שעובד —
    /// ובדיוק זה מה שהופך את הכשל לבלתי נראה.
    ///
    /// ⚠️ ולמה זה מכבה ולא זורק: אותו נימוק כמו שאר <c>Enabled</c> —
    /// "מופעל אבל שגוי" אינו מצב שניתן לביטוי כאן. כתובת לא בטוחה פירושה
    /// שהמסלול הישיר כבוי, וה-MQTT ממשיך כרגיל. הטופס מסביר למה.
    /// </summary>
    public static bool IsSecureUrl(string? url) =>
        Uri.TryCreate((url ?? "").Trim(), UriKind.Absolute, out Uri? u)
        && u.Scheme == Uri.UriSchemeHttps;
}
