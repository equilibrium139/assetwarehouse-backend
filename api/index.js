const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const app = express();
const bcrypt = require("bcrypt");
const cookieParser = require("cookie-parser");
const pg = require("pg");
const Pool = pg.Pool;
const { PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3Client = new S3Client({
    endpoint: "https://nyc3.digitaloceanspaces.com", // Find your endpoint in the control panel, under Settings. Prepend "https://".
    forcePathStyle: false, // Configures to use subdomain/virtual calling format.
    region: "us-east-1", // Must be "us-east-1" when creating new Spaces. Otherwise, use the region in your endpoint (for example, nyc3).
    credentials: {
        accessKeyId: process.env.SPACES_ACCESS_KEY, // Access key pair. You can create access key pairs using the control panel or API.
        secretAccessKey: process.env.SPACES_SECRET // Secret access key defined through an environment variable.
    }
});

const pemKey = process.env.AWS_PEM_KEY;
const pool = new Pool({
    ssl: {
        rejectUnauthorized: true,
        ca: pemKey ? pemKey : fs.readFileSync(path.join(process.cwd(), 'us-east-2-bundle.pem')).toString()
    }
});

pool.connect((err, client, release) => {
    if (err) {
        return console.error('Error acquiring client', err.stack);
    }
    console.log('Database connected successfully');
    release();
});

pool.on("error", (err, client) => {
    console.error("Unexpected error on idle client", err);
    process.exit(-1);
});

const uniqueViolationCode = "23505";
const sessionIDKey = "awsid";
const sessionLifeDays = 7;

const allowedOrigins = [
    'http://localhost:3000', // Local frontend
    'https://assetwarehouse.vercel.app', // Deployed frontend
];

app.use(cors({
    origin: allowedOrigins,
    credentials: true,
}));

app.use(express.json());
app.use(cookieParser());

app.get("/", (req, res) => {
    res.send("Hello World!");
});

const port = process.env.PORT || 8080;
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

app.get("/api/search", async (req, res) => {
    const query = req.query.query;
    if (!query) {
        return res.status(400).json({ error: "Missing query parameter" });
    }
    try {
        const searchQuery = {
            text: `SELECT a.id, a.name, a.description, a.file_url, a.thumbnail_url, a.created_by, a.created_at, a.updated_at, a.tags, a.downloads, a.views
               FROM assets AS a
               WHERE document @@ websearch_to_tsquery('english', $1)
               ORDER BY ts_rank(document, websearch_to_tsquery('english', $1)) DESC
               LIMIT 10`,
            values: [query]
        };
        const queryRes = await pool.query(searchQuery);
        return res.status(200).json(queryRes.rows);
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: "Failed to search assets" });
    }
})

app.put("/api/assets/:id", async (req, res) => {
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

app.post("/api/assets/upload", async (req, res) => {
    try {
        const sessionID = req.cookies[sessionIDKey];
        const user = await getUserBySessionID(sessionID);
        if (!user) {
            return res.status(404).json({ message: "Not authorized to upload" });
        }

        const { name, description, assetFilename, thumbnailFilename } = req.body;

        if (!name || !description || !assetFilename || !thumbnailFilename) {
            return res.status(404).json({ message: "Name, description, asset filename and thumbnail filename are required" });
        }

        const query = {
            text: `INSERT INTO 
                    assets(name, description, file_url, thumbnail_url, created_by, created_at, updated_at, tags, is_public, downloads, views)
                    VALUES($1, $2, $3, $4, $5, now(), now(), '{"cool", "beans"}', true, 0, 0)`,
            values: [name, description, assetFilename, thumbnailFilename, user.id]
        };

        await pool.query(query);

        const assetFileURL = user.id + "/" + assetFilename;
        const assetFileKey = "assets/" + assetFileURL;
        const thumbnailFileURL = user.id + "/" + thumbnailFilename;
        const thumbnailFileKey = "thumbnails/" + thumbnailFileURL;
        const assetUploadCommand = new PutObjectCommand({
            Bucket: process.env.SPACES_BUCKET_NAME,
            Key: assetFileKey,
            ACL: "public-read"
        });
        const thumbnailUploadCommand = new PutObjectCommand({
            Bucket: process.env.SPACES_BUCKET_NAME,
            Key: thumbnailFileKey,
            ACL: "public-read"
        })
        const assetUploadURL = await getSignedUrl(s3Client, assetUploadCommand, { expiresIn: 60 });
        const thumbnailUploadURL = await getSignedUrl(s3Client, thumbnailUploadCommand, { expiresIn: 60 });

        res.status(201).json({ assetUploadURL, thumbnailUploadURL });
    } catch (error) {
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

module.exports = app;