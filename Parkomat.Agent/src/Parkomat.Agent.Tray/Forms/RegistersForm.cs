using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Core.Modbus;
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
    // ⚠️ מערכת שנייה — 0 בכל אתר חוץ מפלורנטין
    // ============================================================
    // באתר פלורנטין יש שני ParkManager בבקר אחד. מונה המחזורים נשאר
    // אחד — הוא של האתר — ולכן אין לו זוג.
    private readonly NumericUpDown _modeReg2 = new();
    private readonly NumericUpDown _cardReg2 = new();

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

    // ============================================================
    // RTU טורי (1.0.61, 20/10/2026) — הפורט והגדרות התקשורת
    // ============================================================
    // בקר בלי Ethernet, בכבל USB-Serial למחשב האתר. השורות מוצגות רק כש-"RTU טורי" נבחר, וכתובת ה-IP
    // שבטופס הראשי אינה בשימוש אז. הפורט הוא רשימה **שאפשר להקליד בה**: היא מציעה את הפורטים שקיימים
    // במחשב עכשיו, אבל טכנאי שמגדיר לפני שחיבר את הכבל צריך להקליד COM6 בעצמו. הערך נבדק באישור.
    private readonly ComboBox _comPort = new();
    private readonly ComboBox _baud = new();
    private readonly ComboBox _parity = new();
    private readonly ComboBox _stopBits = new();
    private readonly List<Control> _rtuRow = new();

    // הכיתוב בדיוק כפי שהוא בתקן ובתיעוד של יצרן הבקר.
    private const string FC04 = "0x04 — Input Registers";
    private const string FC03 = "0x03 — Holding Registers";
    private const string RTU = "RTU טורי";
    private static readonly string[] Bauds = { "1200", "2400", "4800", "9600", "19200", "38400", "57600", "115200" };
    private static readonly string[] Parities = { "None", "Even", "Odd" };

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
        ClientSize = new Size(430, 540);

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

        foreach (var n in new[] { _modeReg, _cardReg, _cycleReg, _modeReg2, _cardReg2 })
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
        _transport.Items.AddRange(new object[] { "TCP", "UDP", RTU });

        _comPort.DropDownStyle = ComboBoxStyle.DropDown;
        _comPort.Width = 120;
        _comPort.Items.AddRange(SerialRtuPort.PresentPorts());
        _baud.DropDownStyle = ComboBoxStyle.DropDownList;
        _baud.Width = 120;
        _baud.Items.AddRange(Bauds);
        _parity.DropDownStyle = ComboBoxStyle.DropDownList;
        _parity.Width = 120;
        _parity.Items.AddRange(Parities);
        _stopBits.DropDownStyle = ComboBoxStyle.DropDownList;
        _stopBits.Width = 120;
        _stopBits.Items.AddRange(new object[] { "1", "2" });

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
        // שורות ה-RTU מיד אחרי התעבורה — מוסתרות כש-TCP/UDP נבחר (ToggleRtuRows)
        _rtuRow.Add(AddRow(table, 1, "פורט COM:", _comPort));
        _rtuRow.Add(AddRow(table, 2, "מהירות (baud):", _baud));
        _rtuRow.Add(AddRow(table, 3, "זוגיות:", _parity));
        _rtuRow.Add(AddRow(table, 4, "ביטי עצירה:", _stopBits));
        _rtuRow.AddRange(new Control[] { _comPort, _baud, _parity, _stopBits });
        AddRow(table, 5, "פקודת קריאה:", _funcCode);
        AddRow(table, 6, "כתובת MODE:", _modeReg);
        AddRow(table, 7, "כתובת כרטיס:", _cardReg);
        AddRow(table, 8, "כתובת Cycle Counter:", _cycleReg);

        // ⚠️ **הכיתוב אומר במפורש ש-0 מכבה.** שדה מספרי בלי הסבר היה
        // מזמין להקליד בו משהו "ליתר ביטחון", ואתר חד-מערכתי שמדווח
        // מערכת שנייה מדומה הוא בדיוק סוג הכשל השקט שאין לו מסך.
        AddRow(table, 9, "כתובת MODE 2 (0 = אין):", _modeReg2);
        AddRow(table, 10, "כתובת כרטיס 2 (0 = אין):", _cardReg2);
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
        _modeReg2.Value = Math.Clamp(current.ModeRegister2, (int)_modeReg2.Minimum, (int)_modeReg2.Maximum);
        _cardReg2.Value = Math.Clamp(current.CardRegister2, (int)_cardReg2.Minimum, (int)_cardReg2.Maximum);

        // ⚠️ נגזר מ-UseUdp ולא מהמחרוזת הגולמית, כדי שהחלונית תראה את מה
        // שהסוכן **באמת יעשה**. קובץ עם "UDP " היה מציג UDP בזמן שהסוכן
        // קורא TCP — כלומר הממשק היה מאשר את הטעות במקום לחשוף אותה.
        _transport.SelectedItem = current.UseRtu ? RTU : current.UseUdp ? "UDP" : "TCP";

        // ⚠️ נגזר מ-UseHoldingRegisters ולא מהמספר הגולמי, מאותה סיבה:
        // קובץ עם FunctionCode=7 היה מציג 7 בזמן שהסוכן קורא ב-0x04.
        _funcCode.SelectedItem = current.UseHoldingRegisters ? FC03 : FC04;

        // RTU — מהערכים המנורמלים (current.Rtu), מאותה סיבה: מה שמוצג הוא מה שהסוכן יעשה
        var rtu = current.Rtu;
        _comPort.Text = rtu.PortName;
        if (!_baud.Items.Contains(rtu.BaudRate.ToString())) _baud.Items.Add(rtu.BaudRate.ToString());
        _baud.SelectedItem = rtu.BaudRate.ToString();
        _parity.SelectedItem = rtu.Parity == "even" ? "Even" : rtu.Parity == "odd" ? "Odd" : "None";
        _stopBits.SelectedItem = rtu.StopBits.ToString();
        _transport.SelectedIndexChanged += (s, e) => ToggleRtuRows();
        ToggleRtuRows();
    }

    private bool RtuChosen => (_transport.SelectedItem as string) == RTU;

    private void ToggleRtuRows()
    {
        foreach (var c in _rtuRow) c.Visible = RtuChosen;
    }

    private void OnOk()
    {
        // ⚠️ RTU בלי פורט תקין — לא נשמר. "rtu" עם פורט ריק או "com 6" היה אתר שנראה מוגדר ואינו קורא כלל.
        string com = (_comPort.Text ?? "").Trim().ToUpperInvariant().Replace(" ", "");
        if (RtuChosen && !System.Text.RegularExpressions.Regex.IsMatch(com, "^COM[0-9]{1,3}$"))
        {
            MessageBox.Show(this, "יש לבחור פורט COM תקין, למשל COM6.", "פורט COM",
                MessageBoxButtons.OK, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button1,
                MessageBoxOptions.RtlReading | MessageBoxOptions.RightAlign);
            return;
        }

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

        // ⚠️ **חצי הגדרה נזרקת, ולא נשמרת חצי.** מצב בלי רכב אינו
        // חצי-תכונה אלא הגדרה שבורה: `HasSecondSystem` היה false בכל
        // מקרה, אבל הקובץ היה נושא מספר שנראה כאילו הוא עושה משהו.
        int m2 = (int)_modeReg2.Value;
        int c2 = (int)_cardReg2.Value;
        bool bothGiven = m2 > 0 && c2 > 0;

        Result.ModeRegister2 = bothGiven ? m2 : 0;
        Result.CardRegister2 = bothGiven ? c2 : 0;
        Result.Transport = RtuChosen ? "rtu" : (_transport.SelectedItem as string) == "UDP" ? "udp" : "tcp";
        Result.FunctionCode = (_funcCode.SelectedItem as string) == FC03 ? 3 : 4;

        // ⚠️ הגדרות הפורט נשמרות רק כש-RTU נבחר. מעבר ל-TCP משאיר אותן כפי שהיו (עריכה במקום) — חזרה
        // ל-RTU לא תדרוש להקליד הכול מחדש.
        if (RtuChosen)
        {
            Result.ComPort = com;
            Result.BaudRate = int.TryParse(_baud.SelectedItem as string, out int baud) ? baud : 9600;
            Result.Parity = ((_parity.SelectedItem as string) ?? "None").ToLowerInvariant();
            Result.StopBits = (_stopBits.SelectedItem as string) == "2" ? 2 : 1;
        }

        DialogResult = DialogResult.OK;
        Close();
    }

    /// <returns>התווית — כדי שאפשר יהיה להסתיר שורה שלמה (שורות ה-RTU).</returns>
    private static Label AddRow(TableLayoutPanel t, int row, string label, Control input)
    {
        var l = new Label
        {
            Text = label,
            AutoSize = true,
            Anchor = AnchorStyles.Right,
            Padding = new Padding(0, 6, 0, 0)
        };
        t.Controls.Add(l, 0, row);
        t.Controls.Add(input, 1, row);
        return l;
    }
}