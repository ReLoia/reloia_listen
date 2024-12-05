// Base Requirements
import dotenv from "dotenv";
import fs from "fs";
import {getBaseURL, handleErrors} from "./utils.js";
// Server Requirements
import {SpotifyAPI} from "./spotifyAPI.js";

import express from "express";
import canvas from "canvas";
import cors from "cors";
// Websocket stuff
import http from "http";
import {WebSocketServer} from "ws";
import {listeningWidget} from "./listeningWidget.js";

dotenv.config();

// Constants
const BASE_URL = getBaseURL();

const app = express();

const {createCanvas, loadImage} = canvas;

app.use(express.json());

app.use(cors());
app.use((req, res, next) => {
    console.log(`[${req.method}] [${new Date().toLocaleString("it")}] ${req.url}`)
    next();
})

const server = http.createServer(app);

const wss = new WebSocketServer({server});


server.listen(process.env.PORT || 3000, () => console.log(`Server started on ${BASE_URL}\nAlternatively on http://localhost:${process.env.PORT || 3000}`));

const spotify = new SpotifyAPI();

// Main app Loop
setInterval(async () => {
    if (!spotify.refreshToken) return console.log("Non c'è un refresh token");

    const newData = await spotify.getData();

    if (newData?.status == 401) return console.log(`3. Errore nel refresh token: ${newData?.status}`, newData.response);

    if (
        (spotify?.data?.song_link != newData?.song_link) ||
        (spotify?.data?.playing != newData?.playing) ||
        (Math.abs(newData?.progress - spotify?.data?.progress) >= 15000)
    ) {
        wss.clients.forEach(client => {
            // if the number of clients has changed, send it
            if (!spotify.data.clients || spotify.data.clients != wss.clients.size) newData.clients = wss.clients.size;
            newData.type = "listening-status";

            client.send(JSON.stringify(newData));
        });
    }
    spotify.data = newData;
}, 5000);

let recentMessages = [];
let onCooldown = [];

wss.on("connection", ws => {
    const data = {...spotify.data};

    ws.send(JSON.stringify({listening: {...data, clients: wss.clients.size}, recentMessages, type: "init"}));

    ws.on("message", (message) => {
        console.log(`Received message from client: ${message}`);
        try {
            const received = JSON.parse(message);

            if (onCooldown.includes(ws)) return;
            onCooldown.push(ws);
            setTimeout(() => onCooldown.splice(onCooldown.indexOf(ws), 1), 2500);

            if (received.type == "chat") {
                recentMessages.push({username: received.username, message: received.message});
                setTimeout(() => recentMessages.shift(), 1000 * 60 * 60);
                Array.from(wss.clients).forEach(client => {
                    client.send(JSON.stringify({
                        type: "chat",
                        clients: wss.clients.size,
                        username: received.username,
                        message: received.message
                    }));
                });
            }
        } catch (err) {
            console.error(err);
        }
    });
});

app.get("/", (req, res) => handleErrors(res, 200, `You shouldn't be here... Please go to https://reloia.github.io/ or the api endpoint : ${BASE_URL}/api`));
app.get("/api", async (_, res) => {
    if (!spotify.accessToken) return handleErrors(res, 401, "Not logged in to Spotify or the Refresh Token has expired");
    res.send(spotify.data);
});

app.get("/log-in", (req, res) => {
    if (spotify.refreshToken) return handleErrors(res, 403, "Already logged in.");

    res.redirect("https://accounts.spotify.com/authorize?" + (new URLSearchParams({
        response_type: "code",
        client_id: process.env.CLIENT_ID,
        scope: "user-read-private user-read-email user-read-playback-state user-read-currently-playing user-read-recently-played user-top-read user-read-playback-position",
        redirect_uri: `${BASE_URL}/callback`,
        state: (`${Math.random().toString(36)}00000000000000000`).slice(2, 12 + 2),
    })).toString());
});

app.get("/callback", async (req, res) => {
    const code = req.query.code;

    if (code) {
        const resp = await fetch("https://accounts.spotify.com/api/token", {
            method: "POST",
            body: new URLSearchParams({
                code,
                redirect_uri: `${BASE_URL}/callback`,
                grant_type: "authorization_code"
            }),
            headers: {Authorization: `Basic ${(Buffer.from(`${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`)).toString("base64")}`,}
        })

        console.log(resp.status);
        const text = await resp.text();

        // const data = await resp.json();
        const data = JSON.parse(text);

        if (data.error) return handleErrors(res, 400, "The server has given the erorr: " + data.error_description);
        spotify.accessToken = data.access_token;
        spotify.refreshToken = data.refresh_token;
    }

    res.send('<a href="/">Goto home</a>');
});

// SOTD Stuff
const maxSongs = Infinity;

app.get("/sotd", async (_, res) => {
    if (!fs.existsSync("./data/sotd.json")) return handleErrors(res, 204, "No songs of the day");
    const data = JSON.parse(fs.readFileSync("./data/sotd.json")).reverse();
    res.send(data);
})
app.post("/sotd/clear", async (req, res) => {
    if (!code) return handleErrors(res, 400, 'Missing parameters');
    if (req.headers.authorization !== process.env.SECRET) return handleErrors(res, 401, "Wrong code");

    fs.writeFileSync("./data/sotd.json", "[]");

    res.send({message: "Songs cleared"});
})
app.post("/sotd/remove", async (req, res) => {
    const {index} = req.body;

    if (index == undefined) return handleErrors(res, 400, 'Missing parameters');
    if (req.headers.authorization !== process.env.SECRET) return handleErrors(res, 401, "Wrong code");

    const sotd = JSON.parse(fs.readFileSync("./data/sotd.json"));

    if (index < 0 || index > sotd.length) return handleErrors(res, 400, "Index out of range");
    sotd.splice(index, 1);
    fs.writeFileSync("./data/sotd.json", JSON.stringify(sotd));

    res.send({message: `Song removed`});
})

function appendToSotd(data) {
    let songs = 1;
    if (fs.existsSync("./data/sotd.json")) {
        const sotd = JSON.parse(fs.readFileSync("./data/sotd.json"));
        if (sotd.length >= maxSongs) sotd.shift();
        sotd.push(data);
        songs = sotd.length;

        fs.writeFileSync("./data/sotd.json", JSON.stringify(sotd));

        if (process.env.WEBHOOK) fetch(`https://discord.com/api/webhooks/1245796818755915816/${process.env.WEBHOOK}`, {
            method: "POST",
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(sotd)
        });
    } else fs.writeFileSync("./data/sotd.json", JSON.stringify([data]));

    return {
        message: `Song added: ${data.name} by ${data.author}, date: ${data.date} with album cover ${data.album}`,
        songs
    };
}

app.post("/sotd/url", async (req, res) => {
    const {url} = req.body;

    if (!url) return handleErrors(res, 400, 'Missing parameters');
    if (req.headers.authorization !== process.env.SECRET) return handleErrors(res, 401, "Wrong code");

    const it = new URL(url).pathname;
    const response = await spotify.makeRequest(`tracks/${it.slice(it.lastIndexOf("/") + 1)}?market=IT`)
    if (response.status !== 200) return handleErrors(res, 500, "The server is not responding correctly");

    const json = await response.json()

    return res.send(appendToSotd({
        name: json.name,
        author: json.artists.map(a => a.name).join(", "),
        date: Date.now(),
        album: json.album.images[0].url
    }))
})
app.post("/sotd", async (req, res) => {
    const {name, author, date, album} = req.body;

    if (!name || !author || !date || !album) return handleErrors(res, 400, 'Missing parameters');
    if (req.headers.authorization !== process.env.SECRET) return handleErrors(res, 401, "Wrong code");

    return res.send(appendToSotd({name, author, date, album}))
})

// Paint canvas
// TODO: Add a cooldown to the paint canvas
let paintCanvas = {
    loaded: false,
    _status: new Array(300),
    // returns the current status of the canvas, if empty, load it from local storage
    get status() {
        if (!this.loaded) {
            if (fs.existsSync("./data/paintcanvas.json")) this._status = JSON.parse(fs.readFileSync("./data/paintcanvas.json"));
            else fs.writeFileSync("./data/paintcanvas.json", JSON.stringify(this._status));

            this.loaded = true;
        }
        return this._status;
    },
    set status(data) {
        this._status = data;
        // console.log("Data updated", data);
        // fs.writeFileSync("./data/paintcanvas.json", JSON.stringify(data));
    }
}
app.get("/paintcanvas/status", async (req, res) => {
    res.send(paintCanvas.status);
})
/**
 * Paint a pixel in the canvas with the specified color using the index calculated in the frontend.
 */
app.post("/paintcanvas", async (req, res) => {
    const {x, y, color} = req.body;

    if (x == undefined || y == undefined || color == undefined) return handleErrors(res, 400, 'Missing parameters');
    if (x < 0 || x > 30 || y < 0 || y > 10) return handleErrors(res, 400, 'Out of bounds');

    // if a pixel is being added before the canvas is loaded, load it
    if (!paintCanvas.loaded) paintCanvas.status;

    paintCanvas.status[y * 30 + x] = {x: x, y: y, color};

    fs.writeFileSync("./data/paintcanvas.json", JSON.stringify(paintCanvas.status));

    Array.from(wss.clients).forEach(client => {
        client.send(JSON.stringify({type: "paintcanvas", x: x, y: y, color}));
    });
    res.send({message: "Pixel added"});
})

// Widgets
app.get('/widgets/listening', (req, res) => listeningWidget(req, res, spotify));
