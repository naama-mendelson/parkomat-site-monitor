namespace Parkomat.Agent.Core.Configuration;

/// <summary>
/// כתיבה ישירה ל-Supabase — <b>כבויה עד שממלאים אותה</b>.
///
/// <para>
/// ⚠️ <b>המסלול הזה חי לצד MQTT, ולא במקומו.</b> כל עוד השדות ריקים
/// (<see cref="Enabled"/> = false) הסוכן מתנהג בדיוק כמו קודם, ואפשר לשגר
/// את הגרסה ל-16 האתרים בלי לשנות דבר בהתנהגותם. הפעלה היא מילוי ארבעה
/// שדות באתר <b>אחד</b>, וכיבוי הוא מחיקתם.
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
/// ⚠️ <b>ה-anon key אינו סוד</b> ואין בעיה שיישב כאן: הוא נועד לדפדפן,
/// ו-RLS הוא מה שמגן. מה שכן סוד היא הסיסמה — והיא לעולם לא נצרבת ל-build
/// (בניגוד ל-MqttPassword), כי היא <b>שונה לכל אתר</b> ואין לה ערך
/// ברירת-מחדל שאפשר לצרוב.
/// </para>
/// </summary>
public class SupabaseConfig
{
    /// <summary>כתובת הפרויקט, למשל https://xxxx.supabase.co. ריק = כבוי.</summary>
    public string Url { get; set; } = "";

    /// <summary>המפתח הפומבי (anon / publishable). אינו סוד.</summary>
    public string AnonKey { get; set; } = "";

    /// <summary>כתובת המשתמש של האתר, למשל site-2438@parkomat.co.il.</summary>
    public string Email { get; set; } = "";

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
    public bool Enabled =>
        !string.IsNullOrWhiteSpace(Url) &&
        !string.IsNullOrWhiteSpace(AnonKey) &&
        !string.IsNullOrWhiteSpace(Email) &&
        !string.IsNullOrWhiteSpace(Password);
}
