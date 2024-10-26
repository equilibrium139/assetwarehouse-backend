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
const sessionLifeDays = 7;

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
    console.log(`Asset warehouse listening on port ${port}`);
});

async function getUserBySessionID(sessionID) {
    try {
        const sessionQuery = {
            text: `SELECT expiration, user_id FROM sessions WHERE sessions.id=$1`,
            values: [sessionID]
        };
        const sessionQueryRes = await pool.query(sessionQuery);
        if (sessionQueryRes.rowCount == 0) {
            return null;
        }
        const session = sessionQueryRes.rows[0];
        const expirationDate = new Date(session.expiration);
        const now = new Date();
        if (expirationDate < now) {
            console.log("Expired session ", sessionID);
            return null;
        }
        const userQuery = {
            text: `SELECT id, username, email FROM users WHERE id=$1`,
            values: [session.user_id]
        };
        const userQueryRes = await pool.query(userQuery);
        const user = userQueryRes.rows[0];
        return user;
    } catch (error) {
        console.log(error);
        return null;
    }
}

app.get("/api/user/assets", async (req, res) => {
    try {
        const user = await getUserBySessionID(req.cookies[sessionIDKey]);
        if (!user) {
            return res.status(401).json({ error: "Unauthorized user (session expired or invalid session)" });
        }
        const userAssetsQuery = {
            text: `SELECT a.id, a.name, a.description, a.file_url, a.thumbnail_url, a.created_by, a.created_at, a.updated_at, a.tags, a.downloads, a.views
                   FROM assets AS a
                   WHERE a.created_by=$1
                   ORDER BY a.created_at DESC`,
            values: [user.id]
        };
        const queryRes = await pool.query(userAssetsQuery);
        return res.status(200).json(queryRes.rows);
    } catch (error) {
        console.log(error);
        return res.status(500).json({ message: "Failed to fetch user data, try again" });
    }
})

app.put("/api/assets/:id", upload.none(), async (req, res) => {
    try {
        const assetID = parseInt(req.params.id, 10);
        if (isNaN(assetID) || assetID <= 0) {
            return res.status(400).json({ error: "Invalid id parameter" });
        }
        const { name, description } = req.body;
        if (!name || !description) {
            return res.status(400).json({ error: "Name and description are required" });
        }

        const user = await getUserBySessionID(req.cookies[sessionIDKey]);
        if (!user) {
            return res.status(401).json({ error: "Unauthorized user (session expired or invalid session)" });
        }
        const getAssetCreatorByIDQuery = {
            text: `SELECT created_by FROM assets WHERE id=$1`,
            values: [assetID]
        };
        const queryResult = await pool.query(getAssetCreatorByIDQuery);
        if (queryResult.rows == 0) {
            return res.status(400).json({ error: "Asset not found" });
        }
        const asset = queryResult.rows[0];
        if (asset.created_by !== user.id) {
            return res.status(401).json({ error: "Unauthorized user" });
        }

        const updateAssetQuery = {
            text: `UPDATE assets SET name=$1, description=$2 WHERE id=$3`,
            values: [name, description, assetID]
        };
        await pool.query(updateAssetQuery);
        res.status(201).json({ message: "Successfully updated asset" });
    }
    catch (error) {
        console.log(error);
        return res.status(500).json({ message: "Failed to modify asset, try again" });
    }
})

app.get("/api/assets/popular/:count", async (req, res) => {
    try {
        const count = parseInt(req.params.count, 10);
        if (isNaN(count) || count <= 0) {
            return res.status(400).json({ error: "Invalid count parameter" });
        }
        const popularAssetsQuery = {
            text: `SELECT a.id, a.name, a.description, a.file_url, a.thumbnail_url, a.created_by, a.created_at, a.updated_at, a.tags, a.downloads, a.views,
                          u.username 
                   FROM (assets AS a INNER JOIN users AS u ON a.created_by = u.id) 
                   WHERE a.is_public=true
                   ORDER BY a.views DESC
                   LIMIT $1`,
            values: [count]
        };
        const result = await pool.query(popularAssetsQuery);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ message: "Failed to find assets" });
    }
});

app.post("/api/assets/upload", upload.fields([{ name: 'asset', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]), async (req, res) => {
    try {
        const sessionID = req.cookies[sessionIDKey];
        const user = await getUserBySessionID(sessionID);
        if (!user) {
            return res.status(404).json({ message: "Not authorized to upload" });
        }

        const { name, description } = req.body;
        const assetFile = req.files['asset'] ? req.files['asset'][0] : null;
        const thumbnailFile = req.files['thumbnail'] ? req.files['thumbnail'][0] : null;

        if (!name || !description || !thumbnailFile || !assetFile) {
            return res.status(404).json({ message: "Name, description, thumbnail and asset are required" });
        }

        const query = {
            text: `INSERT INTO 
                    assets(name, description, file_url, thumbnail_url, created_by, created_at, updated_at, tags, is_public, downloads, views)
                    VALUES($1, $2, $3, $4, $5, now(), now(), '{"cool", "beans"}', true, 0, 0)`,
            values: [name, description, assetFile.originalname, thumbnailFile.originalname, user.id]
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
        const newUserQuery = {
            text: `INSERT INTO 
                    users(username, email, password_hash, created_at, updated_at)
                    VALUES($1, $2, $3, now(), now())
                    RETURNING id, username, email`,
            values: [req.body.username, req.body.email, password_hash]
        };
        const queryResult = await pool.query(newUserQuery);
        const newUser = queryResult.rows[0];
        const sessionID = crypto.randomUUID();
        const expirationDate = new Date();
        expirationDate.setDate(expirationDate.getDate() + 7);
        const newSessionQuery = {
            text: `INSERT INTO 
                    sessions(id, expiration, user_id)
                    VALUES($1, $2, $3)`,
            values: [sessionID, expirationDate, newUser.id]
        };
        await pool.query(newSessionQuery);
        res.status(200).cookie(sessionIDKey, sessionID, { maxAge: sessionLifeDays * 24 * 60 * 60 * 1000, httpOnly: true, secure: true, sameSite: "none" })
            .json({ ...newUser });
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

app.post("/login", async (req, res) => {
    try {
        const { email, password } = req.body;
        if (email && password) {
            const getUserByEmailQuery = {
                text: `SELECT id, username, email, password_hash FROM users WHERE email=$1`,
                values: [email]
            };
            const queryRes = await pool.query(getUserByEmailQuery);
            if (queryRes.rowCount === 0) {
                return res.status(404).json({ error: "User doesn't exist" });
            }
            else {
                const user = queryRes.rows[0];
                const match = await bcrypt.compare(password, user.password_hash);
                if (match) {
                    const sessionID = crypto.randomUUID();
                    const expirationDate = new Date();
                    expirationDate.setDate(expirationDate.getDate() + 7);
                    const newSessionQuery = {
                        text: `INSERT INTO 
                               sessions(id, expiration, user_id)
                               VALUES($1, $2, $3)
                               RETURNING id, expiration, user_id`,
                        values: [sessionID, expirationDate, user.id]
                    };
                    const newSessionQueryRes = await pool.query(newSessionQuery);
                    const newSession = newSessionQueryRes.rows[0];
                    const responseUser = { id: user.id, username: user.username, email: user.email };
                    return res.status(200).cookie(sessionIDKey, newSession.id, { maxAge: sessionLifeDays * 24 * 60 * 60 * 1000, httpOnly: true, secure: true, sameSite: "none" }).
                        json({ ...responseUser });
                }
                else {
                    return res.status(401).json({ error: "Wrong password" });
                }
            }
        }
        else {
            const sessionID = req.cookies[sessionIDKey];
            if (sessionID) {
                const user = await getUserBySessionID(sessionID);
                if (!user) {
                    return res.status(400).json({ message: "Session expired" });
                }
                else {
                    res.status(200).json({ ...user });
                }
            }
            else {
                return res.status(400).json({ error: "No username and password or session provided" });
            }
        }
    } catch (error) {
        res.status(400).json({ error: error });
    }
})

app.use(express.static("public"));