using System.Text.RegularExpressions;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// הטפסים נושאים את <b>כל</b> הגדרות ה-PLC, ולא רשימה שדה-שדה.
///
/// ============================================================
/// ⚠️ הבאג שהיה כאן פעמיים, ובשני קבצים שנכתבו בנפרד
/// ============================================================
/// גם <c>SettingsForm.OnSave</c> וגם <c>RegistersForm.OnOk</c> בנו
/// <c>new PlcConfig { ... }</c> עם חמישה שדות מתוך שמונה. התוצאה:
/// <c>FaultTextRegister</c> ו-<c>FaultTextMaxChars</c> <b>נמחקו בכל שמירה</b>
/// וחזרו לברירת המחדל. מי שכיבה את טקסט התקלה כי הבקר שלו אינו תומך —
/// קיבל אותו בחזרה, בלי הודעה ובלי דרך לדעת.
///
/// ⚠️ <b>וזו בדיוק המחלקה של <c>Mqtt.Disabled</c></b>, שהתאפס באותו
/// <c>OnSave</c> ונראה בשטח כאילו המתקין מוחק אותו. שלוש פעמים אותו כשל
/// מלמדות שהתבנית היא הבעיה: רשימה שצריך לזכור להאריך היא רשימה שישכחו.
///
/// לכן הבדיקות כאן אוסרות את <b>התבנית</b> ולא סופרות שדות. שדה חדש
/// ב-<c>PlcConfig</c> נישא מעכשיו מעצמו, ואיש אינו צריך לזכור כלום.
///
/// ⚠️ <b>למה מבנית.</b> הטפסים יושבים בפרויקט <c>net10.0-windows</c> ואין
/// WinForms בריצת הבדיקות — אותו נימוק בדיוק כמו <c>SettingsFormWiringTests</c>.
/// היא מוכיחה חיווט, לא רינדור.
/// </summary>
public class PlcFormWiringTests
{
    private static string Source(string file)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);

        string path = Path.Combine(dir!.FullName, "src", "Parkomat.Agent.Tray", "Forms", file);
        Assert.True(File.Exists(path), $"קובץ חסר: {path}");
        return File.ReadAllText(path);
    }

    /// <summary>
    /// אותו מקור, בלי שורות הערה.
    ///
    /// ⚠️ <b>נדרש, ולא ניקיון.</b> הגרסה הראשונה של הבדיקה למטה נכשלה על
    /// <b>ההערה שמסבירה את התיקון</b> — היא מצטטת את התבנית האסורה כדי
    /// לתעד מה עמד שם. כלומר הבדיקה הייתה אדומה על קוד תקין, בגלל
    /// ההסבר שנכתב במיוחד כדי שהבאג לא יחזור. בדיקה כזו מלמדים להתעלם
    /// ממנה, וזה בדיוק מה שהופך אותה לחסרת ערך.
    ///
    /// חיתוך שורות הערה בלבד (ולא ניתוח מלא של C#) מספיק כאן: הטענה היא
    /// על תבנית קוד, ואין בקבצים האלה מחרוזת שמכילה "//".
    /// </summary>
    private static string CodeOnly(string file) =>
        string.Join("\n", Source(file)
            .Split('\n')
            .Where(l => !l.TrimStart().StartsWith("//")));

    // ⚠️ **הטענה המרכזית, ובשני הקבצים.** `new PlcConfig` בטופס הוא
    // בהגדרה רשימה חלקית — אין דרך לכתוב אותו נכון לאורך זמן, כי הוא
    // נשאר נכון רק עד שמישהו מוסיף שדה. האיסור הוא על התבנית.
    [Theory]
    [InlineData("SettingsForm.cs")]
    [InlineData("RegistersForm.cs")]
    public void TheFormNeverRebuildsPlcConfigFromScratch(string file)
    {
        Assert.DoesNotMatch(new Regex(@"new\s+PlcConfig\s*\{"), CodeOnly(file));
    }

    /// <summary>
    /// ⚠️ ...ובלי זה, בדיקת החיתוך עצמה עיוורת: קובץ שכולו הערות היה עובר
    /// אותה. כאן נדרש ש<b>הקוד</b> אחרי החיתוך עדיין מכיל את מה שהבדיקות
    /// האחרות מחפשות — כלומר שהמסננת לא בלעה את הנושא.
    /// </summary>
    [Fact]
    public void StrippingCommentsDoesNotStripTheCode()
    {
        Assert.Contains("_plc", CodeOnly("SettingsForm.cs"));
        Assert.Contains("Result.Transport", CodeOnly("RegistersForm.cs"));
    }

    [Fact]
    public void SettingsFormCarriesTheWholePlcObjectThrough()
    {
        // ⚠️ שתי טענות ולא אחת. "אין new PlcConfig" לבדו היה עובר גם על
        // קובץ שאיבד את השורה הזו לגמרי ולא שומר PLC בכלל.
        Assert.Matches(new Regex(@"Plc\s*=\s*_plc\s*,"), Source("SettingsForm.cs"));
    }

    [Fact]
    public void SettingsFormStillWritesTheAddressFieldsIntoThatObject()
    {
        // העריכה במקום חייבת באמת לקרות, אחרת מה שנשמר הוא ה-IP הישן
        // בזמן שהטכנאי רואה את החדש בטופס.
        string form = Source("SettingsForm.cs");
        Assert.Matches(new Regex(@"_plc\.IpAddress\s*=\s*_plcIp\.Text\.Trim\(\)"), form);
        Assert.Matches(new Regex(@"_plc\.Port\s*=\s*\(int\)_plcPort\.Value"), form);
    }

    [Fact]
    public void SettingsFormLoadsThePlcObjectFromTheSavedConfig()
    {
        // ⚠️ **בלי זה העריכה במקום גרועה יותר מהבנייה מחדש.** `_plc` מאותחל
        // ל-`new PlcConfig()`, ולכן טופס שלא טוען אותו מהקובץ היה שומר
        // ברירות מחדל על אתר מוגדר — כלומר "התיקון" היה מוחק את ההגדרות
        // בוודאות במקום רק לפעמים.
        Assert.Matches(new Regex(@"_plc\s*=\s*c\.Plc\s*;"), Source("SettingsForm.cs"));
    }

    // ============================================================
    // בורר התעבורה
    // ============================================================

    [Fact]
    public void TheRegistersDialogOffersTheTransportChoice()
    {
        string form = Source("RegistersForm.cs");
        Assert.Matches(new Regex(@"_transport\.Items\.AddRange"), form);
        Assert.Matches(new Regex("\"TCP\""), form);
        Assert.Matches(new Regex("\"UDP\""), form);
    }

    [Fact]
    public void TheChoiceCannotBeTypedByHand()
    {
        // ⚠️ `DropDownList` ולא `DropDown`: תיבה שאפשר להקליד בה מייצרת
        // "Udp " ו-"tcp/udp", שהסוכן בולע ל-TCP (ראה PlcConfig.UseUdp).
        // אתר שנראה מוגדר ל-UDP וקורא ב-TCP הוא בדיוק הכשל שאין דרך
        // לאבחן מרחוק — ופקד סגור מונע אותו במקום לתקן אותו אחר כך.
        Assert.Matches(
            new Regex(@"_transport\.DropDownStyle\s*=\s*ComboBoxStyle\.DropDownList"),
            Source("RegistersForm.cs"));
    }

    [Fact]
    public void TheChoiceIsWrittenBackInLowercase()
    {
        // הקובץ מחזיק "tcp"/"udp"; הפקד מציג "TCP"/"UDP". כתיבה של התצוגה
        // כמות שהיא הייתה עדיין עובדת (UseUdp מנרמל), אבל היא הייתה
        // מייצרת קובץ שנראה אחרת בכל אתר לפי מי ערך אותו לאחרונה.
        Assert.Matches(
            new Regex(@"Result\.Transport\s*=.*\?\s*""udp""\s*:\s*""tcp"""),
            Source("RegistersForm.cs"));
    }

    // ============================================================
    // בורר פקודת הקריאה — אותם שלושה כללים בדיוק
    // ============================================================

    [Fact]
    public void TheRegistersDialogOffersTheFunctionCodeChoice()
    {
        string form = Source("RegistersForm.cs");
        Assert.Matches(new Regex(@"_funcCode\.Items\.AddRange"), form);
        // ⚠️ המספרים כפי שהם בתקן ובתיעוד של יצרן הבקר. "Input"/
        // "Holding" לבדם היו תרגום שלנו, ומי שמקבל הוראה בטלפון
        // מהחשמלאי שומע "0x03", לא "החזקה".
        Assert.Matches(new Regex(@"0x04"), form);
        Assert.Matches(new Regex(@"0x03"), form);
    }

    [Fact]
    public void TheFunctionCodeCannotBeTypedByHand()
    {
        Assert.Matches(
            new Regex(@"_funcCode\.DropDownStyle\s*=\s*ComboBoxStyle\.DropDownList"),
            Source("RegistersForm.cs"));
    }

    [Fact]
    public void TheFunctionCodeIsWrittenBackAsANumber()
    {
        // הקובץ מחזיק 3/4; הפקד מציג מחרוזת עם הסבר.
        Assert.Matches(
            new Regex(@"Result\.FunctionCode\s*=.*\?\s*3\s*:\s*4"),
            Source("RegistersForm.cs"));
    }

    [Fact]
    public void TheDialogShowsTheFunctionCodeTheAgentWillActuallyUse()
    {
        // ⚠️ נגזר מ-`UseHoldingRegisters` ולא מהמספר הגולמי: קובץ עם
        // FunctionCode=7 היה מוצג כ-7 בזמן שהסוכן קורא ב-0x04.
        Assert.Matches(
            new Regex(@"_funcCode\.SelectedItem\s*=\s*current\.UseHoldingRegisters"),
            Source("RegistersForm.cs"));
    }

    [Fact]
    public void TheDialogShowsWhatTheAgentWillActuallyDo()
    {
        // ⚠️ נגזר מ-`UseUdp` ולא מהמחרוזת הגולמית. קובץ עם "UDP " היה
        // מוצג כ-UDP בזמן שהסוכן קורא TCP — הממשק מאשר את הטעות במקום
        // לחשוף אותה, וזה גרוע יותר מלא להציג כלום.
        Assert.Matches(
            new Regex(@"_transport\.SelectedItem\s*=\s*current\.UseUdp"),
            Source("RegistersForm.cs"));
    }
}
