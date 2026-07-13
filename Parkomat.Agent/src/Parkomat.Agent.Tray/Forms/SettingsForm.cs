using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Tray.Services;
using System.Windows.Forms;

namespace Parkomat.Agent.Tray.Forms;

/// <summary>
/// חלון עריכת ההגדרות. טוען את config.json לשדות, ומאפשר לערוך ולשמור.
/// בנוי בעברית RTL, מחולק לשלוש קבוצות: כללי, PLC, ו-MQTT.
/// כתובות ה-registers נערכות בחלונית נפרדת (RegistersForm).
/// </summary>
public class SettingsForm : Form
{
    // שדות הקלט — נשמור הפניה אליהם כדי לקרוא/לכתוב ערכים.
    private readonly TextBox _siteId = new();
    private readonly NumericUpDown _pollInterval = new();

    private readonly TextBox _plcIp = new();
    private readonly NumericUpDown _plcPort = new();

    private readonly TextBox _mqttHost = new();
    private readonly NumericUpDown _mqttPort = new();
    private readonly TextBox _mqttUser = new();
    private readonly TextBox _mqttPass = new();
    private readonly CheckBox _mqttTls = new() { Text = "השתמש ב-TLS (חובה ל-HiveMQ בענן)", AutoSize = true };

    // מחזיק את הגדרות ה-PLC (כולל הכתובות) בזיכרון, נערך דרך חלונית הכתובות.
    private PlcConfig _plc = new();

    // לשליטה בשירותים בעת "שמור" (החלה מיידית בלי restart ידני).
    private readonly ServiceManager _service = new();

    public SettingsForm()
    {
        // --- הגדרות החלון עצמו ---
        Text = "הגדרות — Parkomat Agent";
        RightToLeft = RightToLeft.Yes;
        RightToLeftLayout = true;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        AutoScaleMode = AutoScaleMode.Font;
        ClientSize = new Size(440, 620);

        // פריסה אנכית: כל הקבוצות זו מתחת לזו.
        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(12),
            ColumnCount = 1,
            AutoSize = true
        };

        // --- קבוצת "כללי" ---
        layout.Controls.Add(BuildGeneralGroup());
        // --- קבוצת "PLC" ---
        layout.Controls.Add(BuildPlcGroup());
        // --- קבוצת "MQTT" ---
        layout.Controls.Add(BuildMqttGroup());
        // --- כפתורים ---
        layout.Controls.Add(BuildButtons());

        Controls.Add(layout);

        // טוענים את ההגדרות הקיימות אל השדות.
        LoadIntoFields();
    }

    // ===== בניית הקבוצות =====

    private GroupBox BuildGeneralGroup()
    {
        var g = NewGroup("כללי");
        var t = NewTable(2);
        AddRow(t, 0, "מזהה אתר:", _siteId);

        _pollInterval.Minimum = 100;
        _pollInterval.Maximum = 600000;
        AddRow(t, 1, "קצב דגימה (מילישניות):", _pollInterval);

        g.Controls.Add(t);
        return g;
    }

    private GroupBox BuildPlcGroup()
    {
        var g = NewGroup("PLC");
        var t = NewTable(3);
        AddRow(t, 0, "כתובת IP:", _plcIp);

        _plcPort.Minimum = 1; _plcPort.Maximum = 65535;
        AddRow(t, 1, "פורט:", _plcPort);

        // כפתור שפותח את חלונית הכתובות (MODE / כרטיס / Cycle, ובעתיד עוד).
        var addrButton = new Button
        {
            Text = "הגדר כתובות...",
            AutoSize = true,
            Anchor = AnchorStyles.Right
        };
        addrButton.Click += (s, e) => OnEditRegisters();

        t.Controls.Add(new Label
        {
            Text = "כתובות registers:",
            AutoSize = true,
            Anchor = AnchorStyles.Right,
            Padding = new Padding(0, 6, 0, 0)
        }, 0, 2);
        t.Controls.Add(addrButton, 1, 2);

        g.Controls.Add(t);
        return g;
    }

    private GroupBox BuildMqttGroup()
    {
        var g = NewGroup("פרטי HiveMQ (ענן)");
        var t = NewTable(5);
        AddRow(t, 0, "כתובת HiveMQ:", _mqttHost);

        _mqttPort.Minimum = 1; _mqttPort.Maximum = 65535;
        AddRow(t, 1, "פורט:", _mqttPort);

        AddRow(t, 2, "שם משתמש:", _mqttUser);

        _mqttPass.UseSystemPasswordChar = true;   // מסתיר את הסיסמה
        AddRow(t, 3, "סיסמה:", _mqttPass);

        // תיבת סימון ל-TLS — משפיעה על קובץ הגישור של Mosquitto.
        t.Controls.Add(new Label(), 0, 4);   // תא ריק ליישור
        t.Controls.Add(_mqttTls, 1, 4);

        g.Controls.Add(t);
        return g;
    }

    private FlowLayoutPanel BuildButtons()
    {
        var panel = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.LeftToRight,
            Dock = DockStyle.Fill,
            AutoSize = true,
            Padding = new Padding(0, 8, 0, 0)
        };

        var save = new Button { Text = "שמור", Width = 90, Height = 30 };
        save.Click += (s, e) => OnSave();

        var cancel = new Button { Text = "ביטול", Width = 90, Height = 30 };
        cancel.Click += (s, e) => Close();

        panel.Controls.Add(save);
        panel.Controls.Add(cancel);
        return panel;
    }

    // ===== עזרי בנייה =====

    private static GroupBox NewGroup(string title) => new()
    {
        Text = title,
        AutoSize = true,
        Dock = DockStyle.Top,
        Padding = new Padding(8),
        Margin = new Padding(0, 0, 0, 8)
    };

    private static TableLayoutPanel NewTable(int rows) => new()
    {
        ColumnCount = 2,
        RowCount = rows,
        Dock = DockStyle.Fill,
        AutoSize = true
    };

    // מוסיף שורה: תווית + שדה קלט.
    private static void AddRow(TableLayoutPanel t, int row, string label, Control input)
    {
        input.Dock = DockStyle.Fill;
        input.Width = 200;
        t.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Right, Padding = new Padding(0, 6, 0, 0) }, 0, row);
        t.Controls.Add(input, 1, row);
    }

    // ===== חלונית הכתובות =====

    private void OnEditRegisters()
    {
        // מעבירים את ה-PLC הנוכחי (כולל IP/פורט מהשדות) לחלונית,
        // וקולטים בחזרה את הכתובות המעודכנות.
        _plc.IpAddress = _plcIp.Text.Trim();
        _plc.Port = (int)_plcPort.Value;

        using var form = new RegistersForm(_plc);
        if (form.ShowDialog(this) == DialogResult.OK)
        {
            _plc = form.Result;
        }
    }

    // ===== טעינה ושמירה =====

    private void LoadIntoFields()
    {
        SiteConfig c = ConfigStore.Load();

        _siteId.Text = c.SiteId;
        _pollInterval.Value = Math.Clamp(c.PollIntervalMs, 100, 600000);

        _plcIp.Text = c.Plc.IpAddress;
        _plcPort.Value = c.Plc.Port;

        // שומרים את כל ה-PLC (כולל הכתובות) בזיכרון לעריכה בחלונית.
        _plc = c.Plc;

        _mqttHost.Text = c.Mqtt.Host;
        _mqttPort.Value = c.Mqtt.Port;
        _mqttUser.Text = c.Mqtt.Username;
        _mqttPass.Text = c.Mqtt.Password;
        _mqttTls.Checked = c.Mqtt.UseTls;
    }

    private async void OnSave()
    {
        // ולידציה בסיסית: מזהה אתר חובה — אחרת ה-topic יוצא "sites//state"
        // וגם קובץ הגישור של Mosquitto יהיה שגוי.
        string siteId = _siteId.Text.Trim();
        if (string.IsNullOrWhiteSpace(siteId))
        {
            MessageBox.Show("יש להזין מזהה אתר.", "Parkomat Agent",
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        // בונים אובייקט הגדרות מהשדות.
        // הכתובות מגיעות מ-_plc (שנערך בחלונית), וה-IP/פורט מהשדות.
        var c = new SiteConfig
        {
            SiteId = siteId,
            PollIntervalMs = (int)_pollInterval.Value,
            Plc = new PlcConfig
            {
                IpAddress = _plcIp.Text.Trim(),
                Port = (int)_plcPort.Value,
                ModeRegister = _plc.ModeRegister,
                CardRegister = _plc.CardRegister,
                CycleRegister = _plc.CycleRegister
            },
            Mqtt = new MqttConfig
            {
                Host = _mqttHost.Text.Trim(),
                Port = (int)_mqttPort.Value,
                Username = _mqttUser.Text.Trim(),
                Password = _mqttPass.Text,
                UseTls = _mqttTls.Checked
            }
        };

        // אפשר להפעיל את Mosquitto רק אם יש פרטי HiveMQ תקינים (host+username),
        // אחרת bridge.conf ייצא עם remote_username ריק ו-Mosquitto ייכשל.
        bool canBridge = !string.IsNullOrWhiteSpace(c.Mqtt.Host)
                      && !string.IsNullOrWhiteSpace(c.Mqtt.Username);

        // מריצים את השמירה + ההחלה על thread רקע, כדי שהחלון לא ייתקע
        // בזמן ההפעלה-מחדש של השירותים (עד כמה שניות).
        Enabled = false;
        UseWaitCursor = true;
        string? error;
        try
        {
            error = await Task.Run(() => SaveAndApply(c, canBridge));
        }
        finally
        {
            UseWaitCursor = false;
            Enabled = true;
        }

        if (error != null)
        {
            MessageBox.Show(error, "Parkomat Agent",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        // הצלחה — ההגדרות נשמרו *והוחלו* מיד, בלי restart ידני.
        string message = canBridge
            ? "ההגדרות נשמרו והוחלו.\nהשירותים הופעלו מחדש עם ההגדרות החדשות."
            : "ההגדרות נשמרו והוחלו.\nשים לב: חסרים פרטי HiveMQ (כתובת/שם משתמש), " +
              "ולכן שירות Mosquitto לא הופעל — נתונים לא יישלחו לענן עד להשלמתם.";
        MessageBox.Show(message, "Parkomat Agent",
            MessageBoxButtons.OK, MessageBoxIcon.Information);
        Close();
    }

    // רץ על thread רקע: שומר config.json, מייצר bridge.conf חדש, ומפעיל מחדש
    // את השירותים בסדר הנכון. מחזיר null בהצלחה, או הודעת שגיאה בעברית.
    private string? SaveAndApply(SiteConfig c, bool canBridge)
    {
        // 1. שמירת ההגדרות לדיסק.
        try
        {
            ConfigStore.Save(c);
        }
        catch (Exception ex)
        {
            return "שמירת ההגדרות נכשלה: " + ex.Message;
        }

        // 2. יצירת bridge.conf מההגדרות החדשות — כדי ש-Mosquitto יקבל username תקין
        //    כבר עכשיו (עוד לפני שה-Agent יכתוב אותו מחדש בעלייתו). מונע race.
        try
        {
            BridgeConfigWriter.Write(c);
        }
        catch (Exception ex)
        {
            return "כתיבת קובץ הגישור (bridge.conf) נכשלה: " + ex.Message;
        }

        // 3. החלה מיידית: הפעלה-מחדש מתוזמנת של שני השירותים.
        return _service.ApplyConfigChange(startMosquitto: canBridge);
    }
}