namespace FMMatchLens.Plugin.Memory;

/// <summary>
/// macOS (Apple Silicon, arm64) values for the offsets that differ from Windows. The Windows values in
/// Offsets.cs are untouched; these replace them on macOS only, when each class is first used. Every other
/// offset has the same value on both platforms. The macOS build uses the Itanium C++ ABI, so several objects
/// are laid out slightly differently (e.g. GAME_MATCH fields sit 0x10 lower, and a person is read through a
/// different subobject, hence the negative name offsets).
/// </summary>
internal static partial class Offsets
{
    public static partial class GameMatch
    {
        static GameMatch()
        {
            if (!MacNative.IsMacOS) return;
            Competition = 0x670;
            CompetitionId = 0x67C;
            CompetitionPrimaryColour = 0x684;
            CompetitionSecondaryColour = 0x688;
            CompetitionTertiaryColour = 0x68C;
            EventRewardBranch = 0xACA;
            BallPosition = 0x12A30;
            MomentumEventSource = 0x14E98;
            WaitingReceiver = 0x12E60;
            HomeTeam = 0x15370;
            AwayTeam = 0x15378;
            PreviousBallHolder = 0x15388;
            CurrentBallHolder = 0x15390;
            Referee = 0x153E0;
            StadiumColourObject = 0x153E8;
            PossessionTeam = 0x15430;
            AssistantRefereeOne = 0x15340;
            AssistantRefereeTwo = 0x15348;
            FourthOfficialOne = 0x15350;
            FourthOfficialTwo = 0x15358;
            DisplayTick = 0x15454;
            Tick = 0x154DC;
            RatingBaseCondition = 0x154F0;
            Period = 0x15537;
            LifecycleStateA = 0x15558;
            LifecycleStateB = 0x15559;
            LifecycleStateC = 0x1555A;
            LifecycleStateD = 0x1555B;
            PlayerOfMatch = 0x153A0; // new in 27.1; 0x10 lower like the rest of GAME_MATCH (unverified)
        }
    }

    public static partial class MomentumEventSource
    {
        static MomentumEventSource()
        {
            if (!MacNative.IsMacOS) return;
            HalfPitchWidth = 0x100;
            HalfPitchLength = 0x104;
            FirstHalfEndTick = 0x108;
            FullTimeEndTick = 0x10C;
            ExtraTimeFirstHalfEndTick = 0x110;
            ExtraTimeFlag = 0x114;
        }
    }

    public static partial class Team
    {
        static Team()
        {
            if (!MacNative.IsMacOS) return;
            Manager = 0x640;
            PlayerTable = 0x140;
            PlayerTableCount = 0x73D;
            PlayerCount = 0x73E;
            ContainerUniqueId = 0x9C;
            LogoNumber = 0x13B;
            DbTeam = 0xB8;
            PlayerListUnconfirmed = 0x208;
            TeamBase = 0x6A0;
        }
    }

    public static partial class Manager
    {
        static Manager()
        {
            if (!MacNative.IsMacOS) return;
            Person = 0x20;
        }
    }

    public static partial class MatchPlayer
    {
        static MatchPlayer()
        {
            if (!MacNative.IsMacOS) return;
            Person = 0x20;
            ShirtNumber = 0x122C;
            Sharpness = 0x1220;
            Morale = 0x1233;
            // From the stats pointer on, 0x10 lower than Windows (27.1).
            Stats = 0x1E10;
            RatingEventsBegin = 0x2038;
            RatingEventsEnd = 0x2040;
            CategoryHistoryBegin = 0x2050;
            CategoryHistoryEnd = 0x2058;
            SpecialW2C = 0x207D;
            SpecialW2E = 0x207E;
            SpecialW2D = 0x207F;
            InternalW25 = 0x214C;
            InternalW24 = 0x21D8;
            RawInternalRating = 0x22E8;
            SpecialW2F = 0x23DA;
            SpecialW30 = 0x23DB;
            SpecialW31 = 0x23DC;
            TacticalRosterSlot = 0x23B7;
            TacticalFormationSlot = 0x23E1;
            Condition = 0x2204;
        }
    }

    public static partial class Person
    {
        static Person()
        {
            if (!MacNative.IsMacOS) return;
            FirstName = -0xF0;
            SecondName = -0xE8;
            CommonName = -0xE0;
            Nation = -0xD8;
            City = -0xC0;
            DateOfBirth = -0xB8;
            FullContract = -0x98;
            Traits = -0x80;
            InternationalApps = -0xC;
            InternationalGoals = -0xA;
            YouthApps = -0x8;
            YouthGoals = -0x6;
        }
    }
}
