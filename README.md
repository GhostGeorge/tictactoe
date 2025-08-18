Tic-Tac-Toe Multiplayer Server
A Node.js and Express-based multiplayer Tic-Tac-Toe server with real-time matchmaking and gameplay powered by Socket.io. Designed to work both with and without Docker.

Features
User authentication with Google OAuth or guest mode

Real-time matchmaking queue with instant game creation

Live game state updates via WebSockets (Socket.io)

Responsive EJS views for gameplay and queue status

Environment-configured for development and production

Docker-ready for easy deployment

Requirements
Node.js (v16 or higher recommended)

npm (comes with Node.js)

Optional: Docker & Docker Compose for containerized deployment

Installation and Setup
1. Clone the repository
2. Create .env file in project root

.env template
#Server required environment variables
SESSION_KEY=
NODE_ENV=development/production
EXPRESS_PORT=
SESSION_SECRET=

#Google Auth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

#Supabase Auth
SUPABASE_URL=
SUPABASE_DB_URL=
SUPABASE_SERVICE_KEY=
SUPABASE_PASSWORD=

Running the Server
cd node
node server.js
(make sure to port foward the express port)