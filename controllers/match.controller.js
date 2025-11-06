import { ObjectId } from "mongodb";
import z, { ZodError } from "zod";
import {
    clubMembers,
    matches,
    rounds,
    stages,
    teams,
    tournaments,
} from "../config/db.js";

/** @type {import("express").RequestHandler<{ matchId: string }>} */
export async function getMatch(req, res) {
    try {
        const matchId = new ObjectId(req.params.matchId);

        const match = await matches.findOne({ _id: matchId });
        if (match == null) {
            return res.status(404).json({ message: "Match not found" });
        }

        const round = await rounds.findOne({
            _id: match.roundId,
        });
        if (round == null) {
            return res.status(404).json({ message: "Round not found" });
        }

        const stage = await stages.findOne({
            _id: round.stageId,
        });
        if (stage == null) {
            return res.status(404).json({ message: "Stage not found" });
        }

        const tournament = await tournaments.findOne({
            _id: stage.tournamentId,
        });
        if (tournament == null) {
            return res.status(404).json({
                message: "Tournament not found",
            });
        }

        const membership = await clubMembers.findOne({
            clubId: tournament.clubId,
            userId: new ObjectId(req.user.id),
        });

        if (membership == null) {
            return res.status(403).json({
                message: "You are not a member of this club",
            });
        }

        res.status(200).json(match);
    } catch (error) {
        console.error("Error during getting match:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
}

const UPDATE_MATCH_SCHEMA = z.object({
    score: z.object({
        team1: z.number().min(0),
        team2: z.number().min(0),
    }),
}).strict();

/** @type {import("express").RequestHandler<{ matchId: string }>} */
export async function updateMatch(req, res) {
    try {
        const parsed = UPDATE_MATCH_SCHEMA.parse(req.body);
        const matchId = new ObjectId(req.params.matchId);

        const match = await matches.findOne({ _id: matchId });
        if (match == null) {
            return res.status(404).json({ message: "Match not found" });
        }

        const round = await rounds.findOne({
            _id: match.roundId,
        });
        if (round == null) {
            return res.status(404).json({ message: "Round not found" });
        }

        const stage = await stages.findOne({
            _id: round.stageId,
        });
        if (stage == null) {
            return res.status(404).json({ message: "Stage not found" });
        }

        const tournament = await tournaments.findOne({
            _id: stage.tournamentId,
        });
        if (tournament == null) {
            return res.status(404).json({
                message: "Tournament not found",
            });
        }

        const membership = await clubMembers.findOne({
            clubId: tournament.clubId,
            userId: new ObjectId(req.user.id),
            role: { $in: ["admin", "owner"] },
        });
        if (membership == null) {
            return res.status(403).json({
                message: "You have no permission to do that",
            });
        }

        const { modifiedCount } = await matches.updateOne(
            { _id: matchId },
            {
                $set: {
                    ...(match.startTime == null
                        ? { startTime: new Date() }
                        : {}),
                    score: {
                        team1Score: parsed.score.team1,
                        team2Score: parsed.score.team2,
                    },
                },
            },
        );

        if (modifiedCount === 0) {
            return res.status(400).json({
                message: "Failed to update match",
            });
        }

        const updatedMatch = await matches.findOne({ _id: matchId });
        res.status(200).json(updatedMatch);
    } catch (error) {
        if (error instanceof ZodError) {
            console.log(error.issues);
            const message = error.issues.length == 0
                ? "Invalid inputs"
                : error.issues[0].message;
            return res.status(400).json({ message: message });
        }

        console.error("Error during updating match winner:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
}

async function updateTeamStats(winnerId, loserId, match, tournament) {
    const rankingConfig = tournament.settings?.rankingConfig || {
        winPoints: 3,
        drawPoints: 1,
        lossPoints: 0,
        addScorePoints: false,
    };

    const isWinnerTeam1 = match.participant1.toString() === winnerId.toString();

    const winnerGoalsFor = isWinnerTeam1
        ? match.score.team1Score
        : match.score.team2Score;
    const winnerGoalsAgainst = isWinnerTeam1
        ? match.score.team2Score
        : match.score.team1Score;
    const loserGoalsFor = isWinnerTeam1
        ? match.score.team2Score
        : match.score.team1Score;
    const loserGoalsAgainst = isWinnerTeam1
        ? match.score.team1Score
        : match.score.team2Score;

    await teams.updateOne(
        { _id: winnerId },
        {
            $inc: {
                "teamStats.matchesPlayed": 1,
                "teamStats.wins": 1,
                "teamStats.points": rankingConfig.winPoints,
                "teamStats.goalsFor": winnerGoalsFor,
                "teamStats.goalsAgainst": winnerGoalsAgainst,
            },
        },
    );

    await teams.updateOne(
        { _id: loserId },
        {
            $inc: {
                "teamStats.matchesPlayed": 1,
                "teamStats.losses": 1,
                "teamStats.points": rankingConfig.lossPoints,
                "teamStats.goalsFor": loserGoalsFor,
                "teamStats.goalsAgainst": loserGoalsAgainst,
            },
        },
    );
}

async function updateDrawStats(team1Id, team2Id, match, tournament) {
    const rankingConfig = tournament.settings?.rankingConfig || {
        winPoints: 3,
        drawPoints: 1,
        lossPoints: 0,
        addScorePoints: false,
    };

    await teams.updateOne(
        { _id: team1Id },
        {
            $inc: {
                "teamStats.matchesPlayed": 1,
                "teamStats.draws": 1,
                "teamStats.points": rankingConfig.drawPoints,
                "teamStats.goalsFor": match.score.team1Score,
                "teamStats.goalsAgainst": match.score.team2Score,
            },
        },
    );

    await teams.updateOne(
        { _id: team2Id },
        {
            $inc: {
                "teamStats.matchesPlayed": 1,
                "teamStats.draws": 1,
                "teamStats.points": rankingConfig.drawPoints,
                "teamStats.goalsFor": match.score.team2Score,
                "teamStats.goalsAgainst": match.score.team1Score,
            },
        },
    );
}

const END_MATCH_SCHEMA = z.object({
    winnerId: z.string().trim().min(1).optional().nullable(),
    score: z.object({
        team1: z.number().min(0),
        team2: z.number().min(0),
    }),
}).strict();

/** @type {import("express").RequestHandler<{ matchId: string }>} */
export async function endMatch(req, res) {
    try {
        const parsed = END_MATCH_SCHEMA.parse(req.body);
        const matchId = new ObjectId(req.params.matchId);

        const match = await matches.findOne({ _id: matchId });
        if (match == null) {
            return res.status(404).json({ message: "Match not found" });
        }

        if (match.endTime) {
            return res.status(400).json({ message: "Match already ended" });
        }

        if (!match.participant1 || !match.participant2) {
            return res.status(400).json({
                message: "Match participants not set",
            });
        }

        let winnerId = null;

        if (parsed.score.team1 > parsed.score.team2) {
            winnerId = match.participant1;
        } else if (parsed.score.team2 > parsed.score.team1) {
            winnerId = match.participant2;
        } else {
            winnerId = null;
        }

        const round = await rounds.findOne({
            _id: match.roundId,
        });
        if (round == null) {
            return res.status(404).json({ message: "Round not found" });
        }

        const stage = await stages.findOne({
            _id: round.stageId,
        });
        if (stage == null) {
            return res.status(404).json({ message: "Stage not found" });
        }

        const tournament = await tournaments.findOne({
            _id: stage.tournamentId,
        });
        if (tournament == null) {
            return res.status(404).json({
                message: "Tournament not found",
            });
        }

        const membership = await clubMembers.findOne({
            clubId: tournament.clubId,
            userId: new ObjectId(req.user.id),
            role: { $in: ["owner", "admin"] },
        });
        if (membership == null) {
            return res.status(403).json({
                message: "You have no permission to do that",
            });
        }

        const { modifiedCount } = await matches.updateOne(
            { _id: matchId },
            {
                $set: {
                    winnerId: winnerId,
                    ...(match.startTime == null
                        ? { startTime: new Date() }
                        : {}),
                    endTime: new Date(),
                    score: {
                        team1Score: parsed.score.team1,
                        team2Score: parsed.score.team2,
                    },
                },
            },
        );

        if (modifiedCount === 0) {
            return res.status(400).json({
                message: "Failed to end match",
            });
        }

        if (winnerId !== null) {
            const loserId =
                match.participant1.toString() === winnerId.toString()
                    ? match.participant2
                    : match.participant1;
            await updateTeamStats(winnerId, loserId, match, tournament);
        } else {
            await updateDrawStats(
                match.participant1,
                match.participant2,
                match,
                tournament,
            );
        }

        const updatedMatch = await matches.findOne({ _id: matchId });
        res.status(200).json(updatedMatch);
    } catch (error) {
        if (error instanceof ZodError) {
            console.log(error.issues);
            const message = error.issues.length === 0
                ? "Invalid inputs"
                : error.issues[0].message;
            return res.status(400).json({ message: message });
        }
        console.error("Error during ending match:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
}
