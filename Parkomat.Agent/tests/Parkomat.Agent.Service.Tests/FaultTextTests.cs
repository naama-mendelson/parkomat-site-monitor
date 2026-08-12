using Parkomat.Agent.Service.Modbus;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// פענוח טקסט התקלה מהבקר.
///
/// ============================================================
/// למה זה נבדק בכלל
/// ============================================================
/// עד היום כל התקלות נראו זהות — "מושבת". אין דרך לדעת אם זו תקלת חיישן,
/// כרטיס שלא נקרא או תקלה מכנית. הטקסט מהבקר הוא ההבדל בין מספר לאבחון.
///
/// והפענוח הוא **המקום היחיד שאפשר לטעות בו בשקט**: פרשנות שגויה של
/// הבתים אינה קורסת — היא מחזירה טקסט שנראה סביר. לכן הוא מופרד מהתקשורת
/// ונבדק בלי בקר.
///
/// ============================================================
/// הפורמט
/// ============================================================
///   תו אחד לכל register · מסתיים באפס · מתחיל בכתובת 2.
///   **הערך הוא נקודת קוד יוניקוד** (1488=א .. 1514=ת), לא בית.
///
/// ⚠️ השורה האחרונה תוקנה אחרי מדידה מול בקר אמיתי. הבדיקות כאן היו כולן
/// ירוקות בזמן שהשטח החזיר `?א?? ?א???` — כי הן קידדו את הקלט לפי אותה
/// הנחה שגויה שהקוד פענח לפיה. **בדיקה שבונה את הקלט שלה מאשרת עקביות,
/// לא נכונות.** לכן נוספה כאן בדיקה אחת עם ערכים גולמיים מהשטח.
/// </summary>
public class FaultTextTests
{
    /// <summary>עוזר: ממיר מחרוזת ל-registers כפי שהבקר היה חושף אותם.</summary>
    private static ushort[] Encode(string s, int pad = 0)
    {
        var list = new List<ushort>();
        foreach (char c in s) list.Add((ushort)c);
        list.Add(0);                                  // הסיום, כמו ב-C
        for (int i = 0; i < pad; i++) list.Add(0);
        return list.ToArray();
    }

    [Fact]
    public void Decodes_PlainAsciiMessage()
    {
        var r = FaultTextDecoder.Decode(Encode("ERROR 12"));
        Assert.Equal("ERROR 12", r.Text);
        Assert.False(r.HadUnknown);
    }

    [Fact]
    public void StopsAtTerminator_AndIgnoresTrailingZeros()
    {
        // הבקר מרפד באפסים אחרי הסיום — הם אינם חלק מהטקסט.
        var r = FaultTextDecoder.Decode(Encode("CARD", pad: 70));
        Assert.Equal("CARD", r.Text);
    }

    [Fact]
    public void StaleTailAfterTerminator_IsNotAppended()
    {
        // ⚠️ הבדיקה החשובה כאן. הבקר אינו מבטיח שהחוצץ נוקה: הודעה קצרה
        // אחרי ארוכה משאירה את הזנב של הקודמת. סריקה עד סוף המערך הייתה
        // מדביקה אותו — ויוצרת תקלה שנראית אמיתית לגמרי.
        var regs = new List<ushort>();
        foreach (char c in "NEW") regs.Add((ushort)c);
        regs.Add(0);                                   // סיום
        foreach (char c in "OLDMESSAGE") regs.Add((ushort)c);   // זנב ישן

        Assert.Equal("NEW", FaultTextDecoder.Decode(regs.ToArray()).Text);
    }

    [Fact]
    public void EmptyString_WhenFirstRegisterIsZero()
    {
        // אין תקלה = register ראשון אפס. מחזיר "" ולא null, כדי שהקורא
        // לא יצטרך להבדיל בין "אין תקלה" לבין "לא נקרא".
        Assert.Equal("", FaultTextDecoder.Decode(new ushort[] { 0, 0, 0 }).Text);
        Assert.Equal("", FaultTextDecoder.Decode(Array.Empty<ushort>()).Text);
        Assert.Equal("", FaultTextDecoder.Decode(null).Text);
    }

    [Fact]
    public void RealController_Jabotinsky91_DecodesHebrewMessage()
    {
        // ============================================================
        // הערכים האמיתיים מהבקר בז'בוטינסקי 91 (Takalolek_ErrorString)
        // ============================================================
        // ⚠️ **זו הבדיקה היחידה כאן שנלקחה ממכונה אמיתית ולא נבנתה על ידי.**
        // כל השאר מקודדות עם Encode(), כלומר בודקות את הפענוח מול ההנחה
        // שלי על הפורמט — ואם ההנחה שגויה, הן ירוקות והמערכת שבורה. וזה
        // בדיוק מה שקרה: כל הבדיקות עברו בעוד השטח החזיר `?א?? ?א???`.
        //
        // הערכים הועתקו מטבלת המיפוי של הבקר, והמחרוזת המצופה היא מה שמסך
        // הבקר הציג באותו רגע.
        var regs = new ushort[]
        {
            1502, 1504, 1492, 1500,   32,               // מנהל
            1495, 1504, 1497, 1493, 1503,   32,         // חניון
              45,   32,                                 // -
            1491, 1500, 1514, 1493, 1514,   32,         // דלתות
            1495, 1504, 1497, 1493, 1503,   32,         // חניון
            1508, 1514, 1493, 1495, 1493, 1514,         // פתוחות
               0
        };

        var r = FaultTextDecoder.Decode(regs);

        Assert.Equal("מנהל חניון - דלתות חניון פתוחות", r.Text);
        Assert.False(r.HadUnknown);      // אף ערך לא הפך ל-'?'
    }

    [Fact]
    public void PackedTwoChars_ProduceObviousGarbage_NotHalfReadableText()
    {
        // ⚠️ **הכרה במגבלה, לא התנהגות רצויה.** register שאורז שני תווים
        // אינו ניתן להבחנה מנקודת קוד יוניקוד גדולה — 0x4142 הוא גם "AB
        // ארוזים" וגם התו 䅂. אין דרך להכריע מהערך לבדו.
        //
        // הבחירה היא **ג'יבריש גלוי על פני קריא-למחצה**: 䅂 גורם למי
        // שרואה אותו לדווח על בעיה. "BD" (הבית הנמוך בלבד) נראה כמו קוד
        // תקלה אמיתי, ומישהו היה מאמין לו — וזו בדיוק המלכודת שהפילה את
        // הגרסה הקודמת בשטח.
        var r = FaultTextDecoder.Decode(new ushort[] { 0x4142, 0x4344, 0 });

        Assert.Equal("䅂䍄", r.Text);
        Assert.DoesNotContain("BD", r.Text);
    }

    [Fact]
    public void ControlCharacters_BecomeQuestionMark_AndLengthIsKept()
    {
        // תו בקרה שובר JSON ולוגים, ו-\0 באמצע חותך מחרוזת בשקט לאורך
        // המסלול. מחליפים ולא זורקים: האורך נשמר, ומי שרואה "A?B" יודע
        // שהיה שם משהו — במקום להסיק שהבקר שלח "AB".
        var r = FaultTextDecoder.Decode(new ushort[] { (ushort)'A', 7, (ushort)'B', 0 });
        Assert.Equal("A?B", r.Text);
    }

    [Fact]
    public void PaddingSpaces_AreTrimmed()
    {
        // בקרים מרפדים שדות ברווחים — רעש, לא תוכן.
        Assert.Equal("JAM", FaultTextDecoder.Decode(Encode("  JAM   ")).Text);
    }

    [Fact]
    public void NoTerminator_ReadsToEndOfBuffer()
    {
        // הודעה שמילאה את כל התקרה בלי מקום לסיום. עדיין מחזירים אותה —
        // חיתוך בתקרה עדיף על איבוד הטקסט כולו.
        var full = new ushort[80];
        for (int i = 0; i < full.Length; i++) full[i] = (ushort)'X';

        Assert.Equal(80, FaultTextDecoder.Decode(full).Text.Length);
    }

    // ============================================================
    // עברית — הבקר ישראלי, וזה התרחיש הסביר
    // ============================================================
    // ⚠️ הגרסה הראשונה סיננה כל בית מעל 126 ל-'?'. הודעה בעברית הייתה
    // מגיעה כשורת סימני שאלה, ומי שרואה את זה מסיק **שהקוד שבור** — ולא
    // שהקידוד שונה. תקלה שמתחזה לבאג במקום אחר.
    [Fact]
    public void HebrewInWindows1255_IsDecoded()
    {
        // Windows-1255: 0xE0 = א, ומשם ברצף **כולל הסופיות** — ך ם ן ף ץ
        // יושבות בתוך הרצף ולא אחריו. ולכן ת היא 0xFA ולא 0xEA.
        //
        // ⚠️ הבדיקה הזו נפלה בגרסה הראשונה שלה, וזה היה שווה: **הבדיקה
        // הייתה שגויה, לא הקוד.** כתבתי 0xEA עבור ת וקיבלתי ך — כלומר
        // בדיוק ההזזה שהסופיות יוצרות. אילו הייתי "מתקן" את המיפוי לפי
        // הציפייה השגויה, כל טקסט עברי מהבקר היה יוצא מוזז באות.
        var regs = new ushort[] { 0xFA, 0xF7, 0xEC, 0xE4, 0 };   // ת ק ל ה
        Assert.Equal("תקלה", FaultTextDecoder.Decode(regs).Text);
    }

    [Fact]
    public void MixedHebrewAndAscii_BothSurvive()
    {
        var regs = new ushort[]
        {
            (ushort)'E', (ushort)'2', (ushort)' ',
            0xF9, 0xE2, 0xE9, 0xE0, 0xE4, 0            // ש ג י א ה
        };
        Assert.Equal("E2 שגיאה", FaultTextDecoder.Decode(regs).Text);
    }

    [Fact]
    public void AsciiIsUnaffectedByTheHebrewMapping()
    {
        // ⚠️ אם הבקר שולח אנגלית בלבד, תמיכת העברית אינה משנה דבר.
        Assert.Equal("SENSOR FAIL", FaultTextDecoder.Decode(Encode("SENSOR FAIL")).Text);
    }

    [Fact]
    public void RealisticMessage_RoundTrips()
    {
        const string msg = "E-204 CARD READER TIMEOUT (LANE 2)";
        Assert.Equal(msg, FaultTextDecoder.Decode(Encode(msg, pad: 45)).Text);
    }
}
