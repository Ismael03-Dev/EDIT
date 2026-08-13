const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const axios = require("axios");
const { Redis } = require("@upstash/redis");
const { waitUntil } = require("@vercel/functions");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DYNA_API_KEY = process.env.DYNA_API_KEY;
const JOB_PREFIX = "image-edit-job:";
const JOB_TTL_SECONDS = 60 * 60;

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const DYNA_API_URL = "https://api.dynapictures.com/v1/renders";

async function getJob(jobId) {
        const raw = await redis.get(`${JOB_PREFIX}${jobId}`);
        if (!raw) return null;
        return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function saveJob(jobId, data) {
        await redis.set(`${JOB_PREFIX}${jobId}`, JSON.stringify(data), { ex: JOB_TTL_SECONDS });
}

async function runEdit(jobId, imageUrl, prompt, model) {
        try {
                const payload = {
                        template_id: model || "default",
                        variables: {
                                image: imageUrl,
                                prompt: prompt
                        }
                };

                const response = await axios.post(DYNA_API_URL, payload, {
                        headers: {
                                "Authorization": `Bearer ${DYNA_API_KEY}`,
                                "Content-Type": "application/json"
                        },
                        timeout: 60000
                });

                if (!response.data || !response.data.imageUrl) {
                        throw new Error("Aucune image générée par DynaPictures");
                }

                const imgRes = await axios.get(response.data.imageUrl, {
                        responseType: "arraybuffer",
                        timeout: 30000
                });

                const resultBuffer = Buffer.from(imgRes.data);

                if (resultBuffer.length > MAX_IMAGE_BYTES) {
                        await saveJob(jobId, {
                                status: "error",
                                error: `Image générée trop volumineuse (${(resultBuffer.length / 1024 / 1024).toFixed(1)}MB > limite ${(MAX_IMAGE_BYTES / 1024 / 1024).toFixed(1)}MB)`,
                                updatedAt: Date.now()
                        });
                        return;
                }

                await saveJob(jobId, {
                        status: "done",
                        image: resultBuffer.toString("base64"),
                        mimeType: imgRes.headers["content-type"] || "image/png",
                        updatedAt: Date.now()
                });
        } catch (error) {
                const errorMsg = error.response?.data?.message || error.response?.data?.error || error.message || "Erreur inconnue pendant l'édition";
                await saveJob(jobId, {
                        status: "error",
                        error: `DynaPictures: ${errorMsg}`,
                        updatedAt: Date.now()
                });
        }
}

app.get("/", (req, res) => {
        res.json({
                message: "Image Edit API opérationnelle (DynaPictures)",
                version: "1.1",
                endpoints: {
                        "POST /api/image/edit": "Lance une édition { imageUrl, prompt, model? } -> { jobId }",
                        "GET /api/image/status/:jobId": "Statut du job (processing | done | error)",
                        "GET /api/image/raw/:jobId": "Renvoie l'image éditée une fois prête"
                }
        });
});

app.post("/api/image/edit", async (req, res) => {
        const { imageUrl, prompt, model } = req.body;

        if (!DYNA_API_KEY) {
                return res.status(500).json({ success: false, error: "DYNA_API_KEY non configuré côté serveur" });
        }
        if (!imageUrl || typeof imageUrl !== "string") {
                return res.status(400).json({ success: false, error: "imageUrl (URL publique d'une image) est requis" });
        }
        if (!prompt || typeof prompt !== "string") {
                return res.status(400).json({ success: false, error: "prompt (description de l'édition souhaitée) est requis" });
        }

        const jobId = crypto.randomUUID();
        const chosenModel = model || "default";

        await saveJob(jobId, {
                status: "processing",
                model: chosenModel,
                createdAt: Date.now(),
                updatedAt: Date.now()
        });

        res.json({
                success: true,
                data: {
                        jobId,
                        model: chosenModel,
                        statusUrl: `${req.protocol}://${req.get("host")}/api/image/status/${jobId}`
                }
        });

        waitUntil(runEdit(jobId, imageUrl, prompt, chosenModel));
});

app.get("/api/image/status/:jobId", async (req, res) => {
        try {
                const job = await getJob(req.params.jobId);
                if (!job) return res.status(404).json({ success: false, error: "Job introuvable ou expiré" });

                if (job.status === "done") {
                        return res.json({
                                success: true,
                                data: {
                                        status: "done",
                                        imageUrl: `${req.protocol}://${req.get("host")}/api/image/raw/${req.params.jobId}`
                                }
                        });
                }

                res.json({ success: true, data: { status: job.status, error: job.error } });
        } catch (error) {
                res.status(500).json({ success: false, error: error.message });
        }
});

app.get("/api/image/raw/:jobId", async (req, res) => {
        try {
                const job = await getJob(req.params.jobId);
                if (!job) return res.status(404).send("Job introuvable ou expiré");
                if (job.status === "error") return res.status(422).send(`Édition échouée: ${job.error}`);
                if (job.status !== "done") return res.status(409).send("Image pas encore prête");

                const buffer = Buffer.from(job.image, "base64");
                res.setHeader("Content-Type", job.mimeType || "image/png");
                res.send(buffer);
        } catch (error) {
                res.status(500).send("Erreur serveur: " + error.message);
        }
});

app.use((req, res) => {
        res.status(404).json({ success: false, error: "Route not found" });
});

module.exports = app;