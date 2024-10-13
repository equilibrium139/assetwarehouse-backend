const express = require("express");
const multer = require("multer");
const fs = require("fs");
const cors = require("cors");
const app = express();
const bcrypt = require("bcrypt");
const cookieParser = require("cookie-parser");
const port = 8080;
const pg = require("pg");
const Pool = pg.Pool;
const pool = new Pool();

pool.on("error", (err, client) => {
    console.error("Unexpected error on idle client", err);
    process.exit(-1);
});

const uniqueViolationCode = "23505";
const sessionIDKey = "awsid";

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        if (file.fieldname === 'asset') {
            cb(null, 'public/assets/models/');
        }
        else if (file.fieldname === 'thumbnail') {
            cb(null, 'public/assets/thumbnails/');
        }
        else {
            cb(null, 'public/assets/others/');
        }
    },
    filename: function (req, file, cb) {
        cb(null, file.originalname);
    }
})

const upload = multer({ storage: storage });

app.use(cors({
    origin: "http://localhost:3000",
    credentials: true
}));
app.use(express.json());
app.use(cookieParser());

app.get("/", (req, res) => {
    res.send("Hello World!");
});

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});

app.get("/api/assets/popular/:count", async (req, res) => {
    pool.query("SELECT * FROM assets", (error, results) => {
        if (error) {
            throw error;
        }
        const count = req.params.count;
        let popularAssets = [...results.rows]
            .sort((a, b) => {
                return b.views - a.views;
            })
            .slice(0, count);
        res.json(popularAssets);
    });
});

app.post("/api/assets/upload", upload.fields([{ name: 'asset', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]), async (req, res) => {
    try {
        const { name, description } = req.body;
        const assetFile = req.files['asset'] ? req.files['asset'][0] : null;
        const thumbnailFile = req.files['thumbnail'] ? req.files['thumbnail'][0] : null;

        if (!name || !description || !thumbnailFile || !assetFile) {
            throw new Error("Name, description, thumbnail and asset are required");
        }

        const query = {
            text: `INSERT INTO 
                    assets(name, description, file_url, thumbnail_url, created_by, created_at, updated_at, tags, is_public, downloads, views)
                    VALUES($1, $2, $3, $4, 1, clock_timestamp(), clock_timestamp(), '{"cool", "beans"}', true, 0, 0)`,
            values: [name, description, assetFile.originalname, thumbnailFile.originalname]
        };

        await pool.query(query);
        res.status(201).json({ message: 'Asset uploaded successfully' });
    } catch (error) {
        if (req.files) {
            const files = Object.values(req.files).flat();
            for (const file of files) {
                fs.unlink(file.path, (err) => {
                    if (err) {
                        console.error("Error deleting file ${file.path}: ", err);
                    } else {
                        console.log("Deleted file ${file.path}");
                    }
                })
            }
        }
        console.error("Error uploading asset: ", error);
        res.status(500).json({ error: "Server error" });
    }
});

app.post("/signup", async (req, res) => {
    try {
        const password_hash = await bcrypt.hash(req.body.password, 10);
        const query = {
            text: `INSERT INTO 
                    users(username, email, password_hash, created_at, updated_at)
                    VALUES($1, $2, $3, clock_timestamp(), clock_timestamp())`,
            values: [req.body.username, req.body.email, password_hash]
        };
        const queryResult = await pool.query(query);
        const newUser = queryResult.rows[0];
        res.status(200).cookie(sessionIDKey, crypto.randomUUID(), { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, secure: true, sameSite: "none" })
            .json({ id: newUser.id, username: newUser.username, email: newUser.email });
    } catch (error) {
        console.error("Error registering user: ", error);
        let errorMessage = "Unknown error";
        if (error.code === uniqueViolationCode) {
            if (error.constraint === "unique_username") {
                errorMessage = "Username already exists";
            }
            else if (error.constraint === "unique_email") {
                errorMessage = "Email already exists";
            }
        }
        res.status(400).json({ error: errorMessage });
    }
});

app.use(express.static("public"));