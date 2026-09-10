namespace Parkomat.Agent.Core.Configuration;

/// <summary>
/// שורת הלוג שמתארת **מה הסוכן באמת קורא** מהבקר.
///
/// <para>⚠️ <b>למה זו פונקציה ולא מחרוזת בתוך הלוגר.</b> היא הייתה
/// ‏<c>LogInformation</c> עם שמונה ארגומנטים — <b>ושניים מהם ישבו במקום
/// הלא נכון</b>. באתר אמיתי היא הדפיסה:</para>
///
/// <code>PLC target: UDP 03:192.168.0.250 | FC=0x502</code>
///
/// <para>קוד הפונקציה (03) נחת במקום הכתובת, והפורט (502) נחת במקום קוד
/// הפונקציה. הקומפיילר אינו בודק התאמה בין מצייני מקום לארגומנטים בלוגר,
/// ולכן זה עבר בשקט.</para>
///
/// <para>⚠️ <b>וזה מסוכן במיוחד דווקא כאן.</b> תעבורה שגויה או פקודת
/// קריאה שגויה נכשלות <b>בדיוק כמו כתובת שגויה</b> — timeout, בלי שום
/// רמז. השורה הזו היא התשובה היחידה לשאלה "מה הסוכן מנסה לקרוא", וכל עוד
/// היא הייתה בתוך הלוגר איש לא יכול היה לבדוק אותה. עכשיו היא מחרוזת
/// שמוחזרת, כלומר טענה שאפשר להשוות אליה.</para>
/// </summary>
public static class PlcTargetLine
{
    /// <summary>מנסח את שורת היעד. טהורה — בלי לוגר ובלי דיסק.</summary>
    public static string Format(SiteConfig config)
    {
        PlcConfig plc = config.Plc;

        string transport = plc.UseUdp ? "UDP" : "TCP";
        // ⚠️ שתי ספרות תמיד: "FC=0x3" אינו הניסוח שמופיע בתיעוד של יצרני
        // הבקרים ובתקן, ומי שמשווה מול modpoll מחפש בדיוק "FC3"/"0x03".
        string fc = plc.UseHoldingRegisters ? "03" : "04";

        return $"PLC target: {transport} {plc.IpAddress}:{plc.Port} | FC=0x{fc} | "
             + $"registers MODE={plc.ModeRegister} Card={plc.CardRegister} "
             + $"Cycle={plc.CycleRegister} | poll={config.PollIntervalMs}ms";
    }
}
