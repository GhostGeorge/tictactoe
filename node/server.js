const version = "1.0.0.0";

require('colors');

// === .env Setup ===
const dotenv = require('dotenv');
dotenv.config({ path: '../.env' }); // The .env file is outside the ./server.js folder root.

// === .env checking ===
const requiredEnvVars = ['SESSION_KEY', 'NODE_ENV', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'EXPRESS_PORT'];
const missingVars = requiredEnvVars.filter((key) => !process.env[key] || process.env[key].trim() === '');
if (missingVars.length > 0) {
    console.error('(app.js) Missing required environment variables (.env file):'.red, missingVars.join(', ').yellow);
    process.exit(1);
    return;
}
if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'development') { 
	console.log("A .env file is needed with NODE_ENV = 'development' OR 'production'".red); 
	process.exit(1); 
}
if (process.env.NODE_ENV === 'development') {
  console.log(`WARNING: Project in development`.yellow);
}

// === Import app.js ===
const app = require('./app');

// === Create HTTP server ===
const http = require('http');
const server = http.createServer(app);

// === Attach Socket.IO server ===
const { Server } = require('socket.io');
const io = new Server(server, {
    cors: {
        origin: "*", // TODO: Replace * with actual client origin for production
        methods: ["GET", "POST"]
    }
});

// === Load all socket event handlers from socket.js ===
require('./src/socket/socket')(io);

const PORT = process.env.EXPRESS_PORT || 3000;

// === Start HTTP + WebSocket server ===
server.listen(PORT, () => {
    console.log(`Server Version: ${version}`);
    console.log(`App listening on port ${PORT}`.green);
});