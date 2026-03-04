/************************************************************
 * YT Growth Engine Backend
 * Production-Ready Version (Concurrency, Tokens & Sync)
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

const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT
);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

/* ================= GOOGLE OAUTH (Global Config) ================= */

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

/* ================= ENCRYPTION / DECRYPTION ================= */

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

function decrypt(text) {
    if (!text) return null;
    const textParts = text.split(":");
    const iv = Buffer.from(textParts.shift(), "hex");
    const encryptedText = Buffer.from(textParts.join(":"), "hex");
    const decipher = crypto.createDecipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encryptedText, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
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

        const scopedOauth2Client = new google.auth.OAuth2(
            GOOGLE_CLIENT_ID,
            GOOGLE_CLIENT_SECRET,
            ""
        );

        const { tokens } = await scopedOauth2Client.getToken({
            code: authCode,
        });

        scopedOauth2Client.setCredentials(tokens);

        const tokenDataToSave = {
            access_token: encrypt(tokens.access_token),
            expiry_date: tokens.expiry_date,
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
        };

        if (tokens.refresh_token) {
            tokenDataToSave.refresh_token = encrypt(tokens.refresh_token);
        }

        await db.collection("youtube_tokens").doc(userId).set(
            tokenDataToSave,
            { merge: true }
        );

        const youtube = google.youtube({
            version: "v3",
            auth: scopedOauth2Client,
        });

        const response = await youtube.channels.list({
            part: "snippet,statistics",
            mine: true,
        });

        if (!response.data.items?.length) {
            return res.status(404).json({ error: "No YouTube channels found." });
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
            { connected_channel_id: channelId, channel_connected: true },
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

        // Run background job (non-blocking)
        runInitialSyncJob(userId, channelId).catch(console.error);

        res.json({ status: "connected", initial_sync_started: true });
    } catch (error) {
        console.error("Select Channel Error:", error);
        res.status(500).json({ error: "Channel selection failed." });
    }
});

/* =====================================================
   BACKGROUND SYNC WORKER (The Real Implementation)
===================================================== */

async function runInitialSyncJob(userId, channelId) {
    console.log(`🚀 Starting sync for channel: ${channelId}`);

    const logRef = await db.collection("sync_logs").add({
        user_id: userId,
        channel_id: channelId,
        status: "started",
        created_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    try {
        // 1. Retrieve & Decrypt Refresh Token
        const tokenDoc = await db.collection("youtube_tokens").doc(userId).get();
        if (!tokenDoc.exists) throw new Error("No tokens found for user");

        const encryptedRefreshToken = tokenDoc.data().refresh_token;
        if (!encryptedRefreshToken) throw new Error("No refresh token available");

        const refreshToken = decrypt(encryptedRefreshToken);

        // 2. Initialize OAuth Client for Background Task
        const authClient = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, "");
        authClient.setCredentials({ refresh_token: refreshToken });

        const youtube = google.youtube({ version: "v3", auth: authClient });
        const analytics = google.youtubeAnalytics({ version: "v2", auth: authClient });

        const batch = db.batch();

        // ---------------------------------------------------------
        // A. FETCH LAST 50 VIDEOS (via Uploads Playlist)
        // ---------------------------------------------------------

        // Find the "uploads" playlist ID for this channel
        const channelRes = await youtube.channels.list({
            part: "contentDetails",
            id: channelId,
        });
        const uploadsPlaylistId = channelRes.data.items[0].contentDetails.relatedPlaylists.uploads;

        // Fetch up to 50 videos from the uploads playlist
        const playlistRes = await youtube.playlistItems.list({
            part: "contentDetails",
            playlistId: uploadsPlaylistId,
            maxResults: 50,
        });

        if (playlistRes.data.items && playlistRes.data.items.length > 0) {
            const videoIds = playlistRes.data.items.map(item => item.contentDetails.videoId);

            // Fetch detailed statistics for those 50 videos
            const videosRes = await youtube.videos.list({
                part: "snippet,statistics",
                id: videoIds.join(","),
            });

            // Add videos to Firestore batch
            videosRes.data.items.forEach(vid => {
                const vidRef = db.collection("videos").doc(vid.id);
                batch.set(vidRef, {
                    channel_id: channelId,
                    video_id: vid.id,
                    title: vid.snippet.title,
                    published_at: vid.snippet.publishedAt,
                    thumbnail: vid.snippet.thumbnails?.high?.url || "",
                    views: parseInt(vid.statistics.viewCount || 0),
                    likes: parseInt(vid.statistics.likeCount || 0),
                    comments: parseInt(vid.statistics.commentCount || 0),
                    updated_at: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
            });
        }

        // ---------------------------------------------------------
        // B. FETCH LAST 30 DAYS OF ANALYTICS
        // ---------------------------------------------------------

        // YouTube Analytics API requires YYYY-MM-DD format
        const endDate = new Date().toISOString().split("T")[0];
        const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

        const metricsRes = await analytics.reports.query({
            ids: `channel==${channelId}`,
            startDate: startDate,
            endDate: endDate,
            metrics: "views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost",
            dimensions: "day",
            sort: "day",
        });

        // Add daily metrics to Firestore batch
        if (metricsRes.data.rows) {
            metricsRes.data.rows.forEach(row => {
                const dateStr = row[0]; // e.g., "2024-05-14"
                const metricRef = db.collection("channels").doc(channelId).collection("daily_metrics").doc(dateStr);

                batch.set(metricRef, {
                    date: dateStr,
                    views: row[1],
                    watch_time_minutes: row[2],
                    avg_view_duration_seconds: row[3],
                    subs_gained: row[4],
                    subs_lost: row[5],
                    net_subs: row[4] - row[5]
                }, { merge: true });
            });
        }

        // 3. Commit all writes to database at once
        await batch.commit();

        // 4. Mark job as complete
        await logRef.update({
            status: "completed",
            completed_at: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`✅ Sync complete for channel: ${channelId}`);

    } catch (err) {
        console.error(`❌ Sync failed for ${channelId}:`, err);
        await logRef.update({
            status: "failed",
            error: err.message,
            failed_at: admin.firestore.FieldValue.serverTimestamp(),
        });
    }
}

/* ================= SERVER START ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
