using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Tray.Forms;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// "שמור" בטופס ההגדרות — <b>התנהגות</b>, על הקוד שהטופס באמת קורא לו.
///
/// <para>⚠️ <b>הבאג.</b> ‏<c>OnSave</c> בנה <c>new SiteConfig { ... }</c> משדות
/// הטופס, וכל שדה בלי פקד נמחק בכל שמירה: ‏<c>NtpServer</c> (אתר עם UDP/123
/// חסום שהוגדר לו שרת פנימי חזר ל-pool.ntp.org — והשעון הפסיק להסתנכרן, עד
/// שהשרת התחיל לדחות הודעות על סטייה של 300 שניות), ‏<c>NtpSyncIntervalMinutes</c>,
/// ‏<c>SiteName</c>.</para>
///
/// <para>⚠️ <b>והבדיקות שהיו על הטופס קראו טקסט</b> — הן וידאו ששדות
/// הנשיאה שמישהו זכר קיימים, ולא יכלו לראות את מה שאיש לא זכר.
/// <c>SettingsFormEdit</c> מקושר לפרויקט הבדיקות (כמו <c>ConnectionTester</c>),
/// ולכן כאן נבדקת השמירה עצמה.</para>
/// </summary>
public class SettingsFormEditTests
{
    /// <summary>ערכי טופס טיפוסיים. משותף גם לבדיקות החיווט.</summary>
    internal static SettingsFormValues Values(
        string siteId = "2438", string supabasePassword = "", PlcConfig? plc = null) => new()
    {
        SiteId = siteId,
        PollIntervalMs = 1000,
        Plc = plc ?? new PlcConfig(),
        MqttHost = "example.s1.eu.hivemq.cloud",
        MqttPort = 8883,
        MqttUsername = "agent",
        MqttPassword = "mqtt-pw",
        SupabasePassword = supabasePassword,
    };

    // ============================================================
    // ⚠️ הבאג עצמו: שדות בלי פקד
    // ============================================================
    [Fact]
    public void FieldsWithoutAControlSurviveASave()
    {
        var loaded = new SiteConfig
        {
            SiteId = "2438",
            SiteName = "מגדל 1",
            NtpServer = "ntp.parkomat.internal",
            NtpSyncIntervalMinutes = 15,
        };

        SiteConfig saved = SettingsFormEdit.Apply(loaded, Values());

        Assert.Equal("מגדל 1", saved.SiteName);
        Assert.Equal("ntp.parkomat.internal", saved.NtpServer);
        Assert.Equal(15, saved.NtpSyncIntervalMinutes);
    }

    // ⚠️ **ודרך הדיסק**, כי זה מה שקורה: שדה ששרד בזיכרון ונעלם בהמרה
    // נראה בדיוק כמו שדה ששרד.
    [Fact]
    public void AndTheySurviveTheRoundTripToDisk()
    {
        var loaded = new SiteConfig { SiteId = "2438", NtpServer = "ntp.parkomat.internal" };
        loaded.Mqtt.Disabled = true;
        loaded.Supabase.Url = "https://postgrest.parkomat.internal";

        SiteConfig saved = SettingsFormEdit.Apply(loaded, Values(supabasePassword: "pw"));
        SiteConfig onDisk = ConfigStore.FromJson(ConfigStore.ToJson(saved))!;

        Assert.Equal("ntp.parkomat.internal", onDisk.NtpServer);
        Assert.True(onDisk.Mqtt.Disabled);
        Assert.Equal("https://postgrest.parkomat.internal", onDisk.Supabase.Url);
    }

    // ============================================================
    // מה שהטופס כן מחזיק — נכתב
    // ============================================================
    [Fact]
    public void WhatTheFormHoldsIsWritten()
    {
        var loaded = new SiteConfig { SiteId = "1111", PollIntervalMs = 5000 };
        var plc = new PlcConfig { IpAddress = "10.0.0.7", Port = 5020 };

        SiteConfig saved = SettingsFormEdit.Apply(loaded, new SettingsFormValues
        {
            SiteId = "2438",
            PollIntervalMs = 750,
            Plc = plc,
            MqttHost = "h",
            MqttPort = 1,
            MqttUsername = "u",
            MqttPassword = "p",
            SupabasePassword = "s",
        });

        Assert.Equal("2438", saved.SiteId);
        Assert.Equal(750, saved.PollIntervalMs);
        Assert.Same(plc, saved.Plc);
        Assert.Equal("h", saved.Mqtt.Host);
        Assert.Equal(1, saved.Mqtt.Port);
        Assert.Equal("u", saved.Mqtt.Username);
        Assert.Equal("p", saved.Mqtt.Password);
        Assert.Equal("s", saved.Supabase.Password);
        Assert.Equal("2438", saved.Supabase.SiteId);
    }

    // ⚠️ ומחיקת הסיסמה בטופס **מכבה** — כך נכתב בטופס עצמו ("מחיקתה מכבה").
    // עריכה במקום אסור שתהפוך שדה ריק ל"לא נגעו בו".
    [Fact]
    public void ClearingThePasswordInTheFormTurnsTheDirectPathOff()
    {
        var loaded = new SiteConfig { SiteId = "2438" };
        loaded.Supabase.Password = "issued-once";

        SiteConfig saved = SettingsFormEdit.Apply(loaded, Values(supabasePassword: ""));

        Assert.Equal("", saved.Supabase.Password);
        Assert.False(saved.Supabase.Enabled);
    }

    // ⚠️ קובץ ישן או ערוך ביד יכול להגיע עם סעיף null. עריכה במקום של null
    // הייתה זורקת בדיוק ברגע שהטכנאי לוחץ "שמור".
    [Fact]
    public void AMissingSectionDoesNotCrashTheSave()
    {
        var loaded = new SiteConfig { SiteId = "2438", Mqtt = null!, Supabase = null! };

        SiteConfig saved = SettingsFormEdit.Apply(loaded, Values(supabasePassword: "pw"));

        Assert.Equal("example.s1.eu.hivemq.cloud", saved.Mqtt.Host);
        Assert.Equal("pw", saved.Supabase.Password);
    }
}
