/************************************************************
 * YT Growth Engine Backend
 * Copy-Paste Ready Version (Improved + Stable)
 ************************************************************/

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { google } = require("googleapis");
const crypto = require("crypto");

/* ================= ENV VALIDATION ================= */

if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be exactly 32 characters.");
}

/* ================= EXPRESS SETUP ================= */

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

/* ================= FIREBASE ADMIN ================= */

const serviceAccount = require("./firebase-service-account.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

/* ================= GOOGLE OAUTH ================= */

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
);

/* ================= ENCRYPTION ================= */

const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY);
const IV_LENGTH = 16;

function encrypt(text) {
    if (!text) return null;

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);

    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");

    return iv.toString("hex") + ":" + encrypted;
}

/* ================= HEALTH CHECK ================= */

app.get("/", (req, res) => {
    res.send("✅ YT Engine Backend Running");
});

/* =====================================================
   EP1 — CONNECT YOUTUBE ACCOUNT
===================================================== */

app.post("/api/youtube/connect", async (req, res) => {
    try {
        const { authCode, userId } = req.body;

        if (!authCode || !userId) {
            return res.status(400).json({ error: "Missing authCode or userId" });
        }

        /* Exchange auth code */
        const { tokens } = await oauth2Client.getToken({
            code: authCode,
            redirect_uri: "postmessage",
        });

        oauth2Client.setCredentials(tokens);

        /* Auto refresh token listener */
        oauth2Client.on("tokens", async (newTokens) => {
            if (newTokens.refresh_token) {
                await db.collection("youtube_tokens").doc(userId).update({
                    refresh_token: encrypt(newTokens.refresh_token),
                });
            }
        });

        /* Save encrypted tokens */
        await db.collection("youtube_tokens").doc(userId).set(
            {
                access_token: encrypt(tokens.access_token),
                refresh_token: encrypt(tokens.refresh_token),
                expiry_date: tokens.expiry_date,
                updated_at: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
        );

        /* Fetch channels */
        const youtube = google.youtube({
            version: "v3",
            auth: oauth2Client,
        });

        const response = await youtube.channels.list({
            part: "snippet,statistics",
            mine: true,
        });

        if (!response.data.items?.length) {
            return res.status(404).json({
                error: "No YouTube channels found.",
            });
        }

        const channels = response.data.items.map((item) => ({
            channel_id: item.id,
            title: item.snippet.title,
            thumbnail: item.snippet.thumbnails.default.url,
            subscriber_count: item.statistics.subscriberCount,
            video_count: item.statistics.videoCount,
        }));

        res.json({ success: true, channels });
    } catch (error) {
        console.error("Connect Error:", error);
        res.status(500).json({ error: "YouTube connection failed." });
    }
});

/* =====================================================
   EP2 — SELECT CHANNEL + START SYNC
===================================================== */

app.post("/api/youtube/select-channel", async (req, res) => {
    try {
        const { userId, channelId, channelData } = req.body;

        await db.collection("users").doc(userId).set(
            {
                connected_channel_id: channelId,
                channel_connected: true,
            },
            { merge: true }
        );

        await db.collection("channels").doc(channelId).set({
            user_id: userId,
            channel_id: channelId,
            title: channelData.title,
            thumbnail: channelData.thumbnail,
            subscriber_count: channelData.subscriber_count,
            created_at: admin.firestore.FieldValue.serverTimestamp(),
        });

        /* Run background job (non-blocking) */
        runInitialSyncJob(userId, channelId).catch(console.error);

        res.json({
            status: "connected",
            initial_sync_started: true,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Channel selection failed." });
    }
});

/* =====================================================
   BACKGROUND SYNC WORKER (Placeholder)
===================================================== */

async function runInitialSyncJob(userId, channelId) {
    console.log(`🚀 Starting sync for ${channelId}`);

    // TODO:
    // Fetch videos
    // Fetch analytics
    // Save metrics

    await db.collection("sync_logs").add({
        user_id: userId,
        channel_id: channelId,
        status: "started",
        created_at: admin.firestore.FieldValue.serverTimestamp(),
    });
}

/* ================= SERVER START ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});