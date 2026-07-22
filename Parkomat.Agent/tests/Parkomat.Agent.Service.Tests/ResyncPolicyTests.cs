using Parkomat.Agent.Core.Protocol;
using Parkomat.Agent.Service.Logic;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// בדיקות להחלטת ה-resync / הודעת-הלידה (ResyncPolicy). מכסות את מקרי-הקצה
/// שהופכים את ה-birth message לחסין: ירי-פעם-אחת, דחייה ב-init, fallback
/// ל-lastKnown, וטריגרי החזרה-להתחבר.
///
/// חתימה: Decide(birthMessageSent, mqttWasConnected, plcJustRecovered,
///                bridgeJustReconnected, currentState, lastKnownState)
/// </summary>
public class ResyncPolicyTests
{
    // ===== birth בעלייה =====

    [Fact]
    public void FreshStartup_MappedState_PublishesBirth()
    {
        var d = ResyncPolicy.Decide(false, true, false, false, SiteState.Ready, null);
        Assert.True(d.ShouldPublish);
        Assert.Equal(SiteState.Ready, d.State);
        Assert.Equal("startup birth message", d.Reason);
    }

    [Fact]
    public void FreshStartup_Maintenance_PublishesRealState()
    {
        // ה-birth משדר את המצב האמיתי, לא "ממציא" ready.
        var d = ResyncPolicy.Decide(false, true, false, false, SiteState.Maintenance, null);
        Assert.True(d.ShouldPublish);
        Assert.Equal(SiteState.Maintenance, d.State);
    }

    [Fact]
    public void FreshStartup_InitMode_DefersBirth()
    {
        // MODE 4 → currentState null, אין lastKnown → לא משדרים (birth נדחה).
        var d = ResyncPolicy.Decide(false, true, false, false, null, null);
        Assert.False(d.ShouldPublish);
    }

    [Fact]
    public void AfterBirth_NoTrigger_DoesNotRepublish()
    {
        // birth כבר נשלח ואין טריגר אחר → לא חוזר (יורה פעם אחת בלבד).
        var d = ResyncPolicy.Decide(true, true, false, false, SiteState.Ready, SiteState.Ready);
        Assert.False(d.ShouldPublish);
    }

    // ===== fallback ל-lastKnown (התאוששות-לתוך-init) =====

    [Fact]
    public void RecoveryIntoInit_UsesLastKnownState()
    {
        // PLC התאושש אבל חזר ל-MODE 4 (currentState null); משדרים את האחרון הידוע
        // כדי לא להשאיר את השרת תקוע על error.
        var d = ResyncPolicy.Decide(true, true, true, false, null, SiteState.Ready);
        Assert.True(d.ShouldPublish);
        Assert.Equal(SiteState.Ready, d.State);
        Assert.Equal("PLC recovered", d.Reason);
    }

    [Fact]
    public void InitMode_TriggerButNoLastKnown_DoesNotPublish()
    {
        // טריגר קיים (plcJustRecovered) אבל אין שום מצב ממופה → אין מה לשדר.
        var d = ResyncPolicy.Decide(true, true, true, false, null, null);
        Assert.False(d.ShouldPublish);
    }

    // ===== טריגרי חיבור-מחדש =====

    [Fact]
    public void BrokerReconnect_Publishes()
    {
        var d = ResyncPolicy.Decide(true, false, false, false, SiteState.Operating, SiteState.Operating);
        Assert.True(d.ShouldPublish);
        Assert.Equal(SiteState.Operating, d.State);
        Assert.Equal("reconnected to broker", d.Reason);
    }

    [Fact]
    public void BridgeReconnect_Publishes()
    {
        var d = ResyncPolicy.Decide(true, true, false, true, SiteState.Ready, SiteState.Ready);
        Assert.True(d.ShouldPublish);
        Assert.Equal("HiveMQ bridge reconnected", d.Reason);
    }

    // ===== עדיפות התוויות =====

    [Fact]
    public void Birth_TakesPriorityOverOtherReasons_InLabel()
    {
        // כשכמה טריגרים דולקים יחד — התווית מציגה "birth" (נבדק ראשון).
        var d = ResyncPolicy.Decide(false, false, true, true, SiteState.Ready, SiteState.Ready);
        Assert.True(d.ShouldPublish);
        Assert.Equal("startup birth message", d.Reason);
    }

    [Fact]
    public void CurrentState_PreferredOverLastKnown()
    {
        // כשיש מצב נוכחי ממופה — הוא מנצח את ה-lastKnown.
        var d = ResyncPolicy.Decide(false, true, false, false, SiteState.Error, SiteState.Ready);
        Assert.True(d.ShouldPublish);
        Assert.Equal(SiteState.Error, d.State);
    }
}
