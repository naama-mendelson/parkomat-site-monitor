using Parkomat.Agent.Core.Configuration;
using System.Windows.Forms;

namespace Parkomat.Agent.Tray.Forms;

/// <summary>
/// חלונית ייעודית לעריכת כתובות ה-registers של ה-PLC.
/// בנויה עם גלילה כדי שתוכל לגדול בעתיד עם עוד כתובות.
/// עורכת עותק של PlcConfig ומחזירה אותו למי שקרא לה.
/// </summary>
public class RegistersForm : Form
{
    private readonly NumericUpDown _modeReg = new();
    private readonly NumericUpDown _cardReg = new();
    private readonly NumericUpDown _cycleReg = new();

    // ============================================================
    // ⚠️ הבורר יושב כאן ולא בטופס הראשי, וזו החלטה
    // ============================================================
    // TCP/UDP נקבע פעם אחת בהתקנה לפי הבקר שבאתר, בדיוק כמו כתובות
    // הרגיסטרים — ולא משנים אותו ביום-יום. הטופס הראשי הוא מה שנפתח
    // כדי לשנות סיסמה או כתובת, ומתג שמנתק את הסוכן מהבקר לגמרי אינו
    // צריך לשבת שם. אותו שיקול שהוציא את תיבת ה-TLS ואת Mqtt.Disabled.
    //
    // אבל **כן בממשק ולא רק בקובץ**, בניגוד להם: זו הגדרת חומרה שטכנאי
    // חייב להזין באתר, ולא החלטת מדיניות שמקבלים פעם אחת מהמשרד.
    private readonly ComboBox _transport = new();
    private readonly ComboBox _funcCode = new();

    // הכיתוב בדיוק כפי שהוא בתקן ובתיעוד של יצרן הבקר.
    private const string FC04 = "0x04 — Input Registers";
    private const string FC03 = "0x03 — Holding Registers";

    // ה-PlcConfig שאנחנו עורכים. נחשף למי שקורא אחרי סגירה.
    public PlcConfig Result { get; private set; }

    public RegistersForm(PlcConfig current)
    {
        Result = current;

        Text = "הגדרת כתובות PLC";
        RightToLeft = RightToLeft.Yes;
        RightToLeftLayout = true;
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        AutoScaleMode = AutoScaleMode.Font;
        // ⚠️ רחב מספיק לכיתוב המלא של פקודת הקריאה. רשימה שחותכת
        // את הטקסט מאלצת לנחש מה נבחר, וזו הטעות שהרשימה הסגורה באה למנוע.
        ClientSize = new Size(430, 340);

        // אזור גלילה — כאן ייכנסו כל הכתובות. כשנוסיף עוד, הגלילה תופיע לבד.
        var scroll = new Panel
        {
            Dock = DockStyle.Fill,
            AutoScroll = true,
            Padding = new Padding(12)
        };

        var table = new TableLayoutPanel
        {
            ColumnCount = 2,
            AutoSize = true,
            Dock = DockStyle.Top
        };

        foreach (var n in new[] { _modeReg, _cardReg, _cycleReg })
        {
            n.Minimum = 0;
            n.Maximum = 65535;
            n.Width = 120;
        }

        // רשימה סגורה ולא תיבת טקסט: ‏"UDP ", "Udp", "tcp/udp" הם ערכים
        // שהסוכן היה בולע ל-TCP (ראה PlcConfig.UseUdp), כלומר אתר שנראה
        // מוגדר ל-UDP וקורא ב-TCP. פקד שלא מאפשר להקליד מונע את זה מראש.
        _transport.DropDownStyle = ComboBoxStyle.DropDownList;
        _transport.Width = 120;
        _transport.Items.AddRange(new object[] { "TCP", "UDP" });

        // ⚠️ **פקודת הקריאה, ולא "סוג רגיסטר".** מה שכתוב כאן חייב להיות
        // מה שכתוב בתיעוד של יצרן הבקר ובתקן — 0x04 / 0x03 — כי זה מה
        // שמישהו יקרא בטלפון מהחשמלאי. "Input"/"Holding" הוא תרגום שלנו,
        // והוא מוסיף שלב שבו אפשר לטעות.
        //
        // ורשימה סגורה, מאותה סיבה כמו התעבורה: ערך חופשי היה נופל בשקט
        // ל-FC 04 (ראה PlcConfig.UseHoldingRegisters), כלומר אתר שנראה
        // מוגדר ל-0x03 וקורא ב-0x04.
        _funcCode.DropDownStyle = ComboBoxStyle.DropDownList;
        _funcCode.Width = 190;
        _funcCode.Items.AddRange(new object[] { FC04, FC03 });

        AddRow(table, 0, "תעבורה:", _transport);
        AddRow(table, 1, "פקודת קריאה:", _funcCode);
        AddRow(table, 2, "כתובת MODE:", _modeReg);
        AddRow(table, 3, "כתובת כרטיס:", _cardReg);
        AddRow(table, 4, "כתובת Cycle Counter:", _cycleReg);
        // כשנוסיף registers בעתיד — פשוט נוסיף כאן עוד שורות, והגלילה תטפל.

        scroll.Controls.Add(table);

        // כפתורים בתחתית (מחוץ לאזור הגלילה, תמיד גלויים).
        var buttons = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.LeftToRight,
            Dock = DockStyle.Bottom,
            AutoSize = true,
            Padding = new Padding(12)
        };
        var ok = new Button { Text = "אישור", Width = 90, Height = 30 };
        ok.Click += (s, e) => OnOk();
        var cancel = new Button { Text = "ביטול", Width = 90, Height = 30 };
        cancel.Click += (s, e) => { DialogResult = DialogResult.Cancel; Close(); };
        buttons.Controls.Add(ok);
        buttons.Controls.Add(cancel);

        Controls.Add(scroll);
        Controls.Add(buttons);

        // טוענים את הערכים הנוכחיים — מהודקים לטווח הפקד (0..65535) כדי ש-config
        // חורג (עריכה ידנית) לא יקריס את החלונית ב-ArgumentOutOfRangeException.
        _modeReg.Value = Math.Clamp(current.ModeRegister, (int)_modeReg.Minimum, (int)_modeReg.Maximum);
        _cardReg.Value = Math.Clamp(current.CardRegister, (int)_cardReg.Minimum, (int)_cardReg.Maximum);
        _cycleReg.Value = Math.Clamp(current.CycleRegister, (int)_cycleReg.Minimum, (int)_cycleReg.Maximum);

        // ⚠️ נגזר מ-UseUdp ולא מהמחרוזת הגולמית, כדי שהחלונית תראה את מה
        // שהסוכן **באמת יעשה**. קובץ עם "UDP " היה מציג UDP בזמן שהסוכן
        // קורא TCP — כלומר הממשק היה מאשר את הטעות במקום לחשוף אותה.
        _transport.SelectedItem = current.UseUdp ? "UDP" : "TCP";

        // ⚠️ נגזר מ-UseHoldingRegisters ולא מהמספר הגולמי, מאותה סיבה:
        // קובץ עם FunctionCode=7 היה מציג 7 בזמן שהסוכן קורא ב-0x04.
        _funcCode.SelectedItem = current.UseHoldingRegisters ? FC03 : FC04;
    }

    private void OnOk()
    {
        // ⚠️ **עריכה במקום, לא בנייה מחדש.** כאן עמד `new PlcConfig { ... }`
        // עם חמישה שדות מתוך שמונה, ולכן אישור החלונית **מחק את
        // FaultTextRegister ו-FaultTextMaxChars** והחזיר אותם לברירת המחדל.
        // אותו באג בדיוק היה גם ב-SettingsForm.OnSave, כלומר הוא נכתב
        // פעמיים בנפרד — מה שמלמד שהתבנית עצמה היא הבעיה, ולא ההשמטה.
        //
        // עריכה במקום מבטיחה ששדה חדש ב-PlcConfig נישא מעצמו, בלי שאיש
        // יצטרך לזכור לעדכן שתי רשימות.
        Result.ModeRegister = (int)_modeReg.Value;
        Result.CardRegister = (int)_cardReg.Value;
        Result.CycleRegister = (int)_cycleReg.Value;
        Result.Transport = (_transport.SelectedItem as string) == "UDP" ? "udp" : "tcp";
        Result.FunctionCode = (_funcCode.SelectedItem as string) == FC03 ? 3 : 4;

        DialogResult = DialogResult.OK;
        Close();
    }

    private static void AddRow(TableLayoutPanel t, int row, string label, Control input)
    {
        t.Controls.Add(new Label
        {
            Text = label,
            AutoSize = true,
            Anchor = AnchorStyles.Right,
            Padding = new Padding(0, 6, 0, 0)
        }, 0, row);
        t.Controls.Add(input, 1, row);
    }
}