// Drydock daemon entry point. Owns AI-CLI PTYs per host; the browser is a viewer.
import "./env.js"; // load .env before anything reads process.env (config, tracker)
import "./server.js";
