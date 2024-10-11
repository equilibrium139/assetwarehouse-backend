const express = require("express");
const multer = require("multer");
const fs = require("fs");
const cors = require("cors");
const app = express();
const port = 8080;
const pg = require("pg");
const Pool = pg.Pool;
const pool = new Pool();

pool.on("error", (err, client) => {
    console.error("Unexpected error on idle client", err);
    process.exit(-1);
});

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

app.use(cors());
app.use(express.json());

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

app.use(express.static("public"));

const dummyAssets = [
    {
        id: 1,
        name: "teapot",
        description: "A wonderful teapot",
        file_url: "teapot.obj",
        thumbnail_url: "teapot.jpg",
        created_by: 1,
        created_at: "2024-10-07T20:29:07.474437-04:00",
        updated_at: "2024-10-07T20:29:07.474437-04:00",
        tags: ["3D", "amazing", "teapot"],
        is_public: true,
        downloads: 0,
        views: 1,
    },
    {
        id: 2,
        name: "bunny",
        description: "A beautiful bunny",
        file_url: "bunny.obj",
        thumbnail_url: "bunny.jpg",
        created_by: 1,
        created_at: "2024-10-07T20:40:28.642942-04:00",
        updated_at: "2024-10-07T20:40:28.642942-04:00",
        tags: ["furry", "cute"],
        is_public: true,
        downloads: 0,
        views: 2,
    },
    {
        id: 3,
        name: "dragon",
        description: "A dangerous dragon",
        file_url: "dragon.obj",
        thumbnail_url: "dragon.jpg",
        created_by: 1,
        created_at: "2024-10-07T20:41:42.450059-04:00",
        updated_at: "2024-10-07T20:41:42.450059-04:00",
        tags: ["scaly", "ferocious", "big", "scary"],
        is_public: true,
        downloads: 0,
        views: 3,
    },
    {
        id: 4,
        name: "monkey",
        description: "A goofy monkey named Suzanne",
        file_url: "monkey.obj",
        thumbnail_url: "monkey.jpg",
        created_by: 1,
        created_at: "2024-10-07T20:42:45.852391-04:00",
        updated_at: "2024-10-07T20:42:45.852391-04:00",
        tags: ["goofy", "blender", "big eyes"],
        is_public: true,
        downloads: 0,
        views: 4,
    },
    {
        id: 5,
        name: "buddha",
        description: "Some zen guy",
        file_url: "buddha.obj",
        thumbnail_url: "buddha.jpg",
        created_by: 1,
        created_at: "2024-10-07T20:45:31.257504-04:00",
        updated_at: "2024-10-07T20:45:31.257504-04:00",
        tags: ["zen", "buddhist", "fatty"],
        is_public: true,
        downloads: 0,
        views: 0,
    },
    {
        id: 6,
        name: "duck",
        description: "Quack",
        file_url: "duck.obj",
        thumbnail_url: "duck.jpg",
        created_by: 2,
        created_at: "2024-10-07T20:48:26.057556-04:00",
        updated_at: "2024-10-07T20:48:26.057556-04:00",
        tags: ["quack", "yellow"],
        is_public: true,
        downloads: 0,
        views: 0,
    },
    {
        id: 7,
        name: "cube",
        description: "Just a boring old cube",
        file_url: "cube.obj",
        thumbnail_url: "cube.jpg",
        created_by: 2,
        created_at: "2024-10-07T20:49:44.789352-04:00",
        updated_at: "2024-10-07T20:49:44.789352-04:00",
        tags: ["6 faces", "8 vertices"],
        is_public: true,
        downloads: 0,
        views: 0,
    },
    {
        id: 8,
        name: "cesium man",
        description: "A curious character",
        file_url: "cesium-man.obj",
        thumbnail_url: "cesium-man.jpg",
        created_by: 2,
        created_at: "2024-10-07T20:50:42.283171-04:00",
        updated_at: "2024-10-07T20:50:42.283171-04:00",
        tags: ["animated", "textured"],
        is_public: true,
        downloads: 0,
        views: 0,
    },
];
