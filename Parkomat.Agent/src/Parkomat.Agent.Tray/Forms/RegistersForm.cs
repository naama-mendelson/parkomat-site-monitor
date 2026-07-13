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
        ClientSize = new Size(360, 320);

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

        AddRow(table, 0, "כתובת MODE:", _modeReg);
        AddRow(table, 1, "כתובת כרטיס:", _cardReg);
        AddRow(table, 2, "כתובת Cycle Counter:", _cycleReg);
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

        // טוענים את הערכים הנוכחיים.
        _modeReg.Value = current.ModeRegister;
        _cardReg.Value = current.CardRegister;
        _cycleReg.Value = current.CycleRegister;
    }

    private void OnOk()
    {
        // בונים PlcConfig מעודכן — שומרים את שדות החיבור כמו שהיו,
        // ומעדכנים רק את הכתובות.
        Result = new PlcConfig
        {
            IpAddress = Result.IpAddress,
            Port = Result.Port,
            ModeRegister = (int)_modeReg.Value,
            CardRegister = (int)_cardReg.Value,
            CycleRegister = (int)_cycleReg.Value
        };
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