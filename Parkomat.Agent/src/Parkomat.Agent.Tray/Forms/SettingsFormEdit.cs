using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Tray.Forms;

/// <summary>
/// מה שהטופס מחזיק בשדות שלו — ורק זה. כל השאר נשאר כפי שנטען מהקובץ.
/// </summary>
public sealed class SettingsFormValues
{
    public required string SiteId { get; init; }
    public required int PollIntervalMs { get; init; }
    public required PlcConfig Plc { get; init; }
    public required string MqttHost { get; init; }
    public required int MqttPort { get; init; }
    public required string MqttUsername { get; init; }
    public required string MqttPassword { get; init; }
    public required string SupabasePassword { get; init; }
}

/// <summary>
/// ממפה את שדות טופס ההגדרות <b>אל תוך ה-config שנטען</b>, ולא אל config חדש.
///
/// ============================================================
/// ⚠️ הבאג שהיה כאן בפעם הרביעית
/// ============================================================
/// ‏<c>SettingsForm.OnSave</c> בנה <c>new SiteConfig { ... }</c> משדות הטופס.
/// כל שדה בלי פקד נמחק בכל "שמור": ‏<c>NtpServer</c> — אתר עם UDP/123 חסום
/// שהוגדר לו שרת NTP פנימי חזר ל-pool.ntp.org, והשעון הפסיק להסתנכרן
/// בשקט; ‏<c>NtpSyncIntervalMinutes</c>; ‏<c>SiteName</c>. ‏<c>Mqtt.Disabled</c>
/// ועקיפות Supabase שרדו רק כי מישהו הוסיף להם שדה נשיאה אחרי שנשרף.
///
/// ⚠️ <b>וזו אותה מחלקה בדיוק כמו <c>new PlcConfig { ... }</c></b>, שתוקן
/// באותו קובץ לעריכה במקום. רשימה שצריך לזכור להאריך היא רשימה שישכחו;
/// עריכה במקום מסירה את הרשימה.
///
/// ⚠️ <b>קובץ נפרד מהטופס, בכוונה.</b> הטופס הוא WinForms ואי אפשר להריץ
/// אותו בבדיקות; הקובץ הזה מקושר לפרויקט הבדיקות (כמו <c>ConnectionTester</c>)
/// ונבדק התנהגותית ב-<c>SettingsFormEditTests</c>.
/// </summary>
public static class SettingsFormEdit
{
    /// <summary>
    /// כותב את ערכי הטופס לתוך <paramref name="loaded"/> ומחזיר אותו.
    /// </summary>
    public static SiteConfig Apply(SiteConfig loaded, SettingsFormValues v)
    {
        ArgumentNullException.ThrowIfNull(loaded);
        ArgumentNullException.ThrowIfNull(v);

        loaded.SiteId = v.SiteId;
        loaded.PollIntervalMs = v.PollIntervalMs;

        // ⚠️ ה-PLC כבר נערך במקום בטופס (ובחלונית הכתובות) — כאן רק מחברים.
        loaded.Plc = v.Plc;

        // ⚠️ `??=`: קובץ ישן או ערוך ביד יכול להגיע עם סעיף null, ועריכה
        // במקום של null הייתה זורקת בדיוק ברגע שהטכנאי לוחץ "שמור".
        loaded.Mqtt ??= new MqttConfig();
        loaded.Mqtt.Host = v.MqttHost;
        loaded.Mqtt.Port = v.MqttPort;
        loaded.Mqtt.Username = v.MqttUsername;
        loaded.Mqtt.Password = v.MqttPassword;
        // ‏`Mqtt.Disabled` אינו נגע — אין לו פקד, בכוונה (ראה SiteConfig.MqttEnabled).

        loaded.Supabase ??= new SupabaseConfig();
        // ⚠️ קוד האתר מהשדה, לא מהקובץ: שם המשתמש נגזר ממנו, ובלעדיו Enabled
        // היה נשאר false אחרי שמירה עד לטעינה הבאה.
        loaded.Supabase.SiteId = v.SiteId;
        loaded.Supabase.Password = v.SupabasePassword;
        // ‏Url / AnonKey / Email (דלת היציאה) אינם נגעים — אין להם פקד.

        return loaded;
    }
}
