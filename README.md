Tic-Tac-Toe Multiplayer Server
A Node.js and Express-based multiplayer Tic-Tac-Toe server with real-time matchmaking and gameplay powered by Socket.io. Designed to work both with and without Docker.

Features
User authentication with Google OAuth or guest mode

Real-time matchmaking queue with instant game creation

Live game state updates via WebSockets (Socket.io)

Responsive EJS views for gameplay and queue status

Clean project structure with modular routes, controllers, and middlewares

Environment-configured for development and production

Docker-ready for easy deployment

Requirements
Node.js (v16 or higher recommended)

npm (comes with Node.js)

Optional: Docker & Docker Compose for containerized deployment

Installation and Setup
1. Clone the repository
bash
Copy
Edit
git clone https://github.com/JacobMS2020/node-express-webserver-template.git
cd node-express-webserver-template
2. Create .env file
In the root folder (same level as server.js), create a .env file with these variables:

env
Copy
Edit
SESSION_KEY=your_session_secret_key_here
NODE_ENV=development  # or 'production'
GOOGLE_CLIENT_ID=your_google_oauth_client_id
GOOGLE_CLIENT_SECRET=your_google_oauth_client_secret
Make sure to replace placeholders with your actual keys.

Running the Server
Using Node.js
bash
Copy
Edit
npm install
node server.js
Then open your browser at http://localhost:3000

Using Docker (optional)
Make sure Docker is installed and running.

bash
Copy
Edit
sudo docker compose up -d
Open your browser at http://localhost:3000

Project Structure Overview
bash
Copy
Edit
node/
├── server.js               # Entry point to start the app
├── app.js                  # Express app setup and middleware
├── .env                    # Environment variables
├── public/                 # Static assets (CSS, images, error pages)
│   ├── styles/
│   │   └── main.css
│   ├── 404.html
│   └── 500.html
├── src/
│   ├── controllers/        # Controller logic for routes
│   │   └── indexController.js
│   ├── middlewares/        # Custom middleware (logging, error handling, auth protection)
│   │   ├── errorHandler.js
│   │   └── logger.js
│   ├── routes/             # Express routes
│   │   └── mainRoutes.js
├── views/                  # EJS view templates
│   └── index.ejs
How to Play
Visit the landing page and login via Google or choose to play as a guest

Join the ranked queue or play with a friend via provided options

Once matched, play Tic-Tac-Toe in real-time against your opponent

The board updates live, and you receive game results instantly