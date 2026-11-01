const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'local-steam-game-tracker-secret-key-12345';

const isVercel = process.env.VERCEL === '1' || process.env.VERCEL === 'true' || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
const USERS_FILE = isVercel ? path.join('/tmp', 'users.json') : path.join(__dirname, 'users.json');
const GAMES_FILE = isVercel ? path.join('/tmp', 'games.json') : path.join(__dirname, 'games.json');

// Auto-seed /tmp files from bundled files on cold start if running on Vercel
if (isVercel) {
  try {
    const bundledUsers = path.join(__dirname, 'users.json');
    const bundledGames = path.join(__dirname, 'games.json');
    if (!fs.existsSync(USERS_FILE) && fs.existsSync(bundledUsers)) {
      fs.writeFileSync(USERS_FILE, fs.readFileSync(bundledUsers, 'utf8'));
    }
    if (!fs.existsSync(GAMES_FILE) && fs.existsSync(bundledGames)) {
      fs.writeFileSync(GAMES_FILE, fs.readFileSync(bundledGames, 'utf8'));
    }
  } catch (err) {
    console.error('Error initializing /tmp files on Vercel:', err);
  }
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Custom CORS Middleware to support VS Code Live Server, local files, etc.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Helper functions for file I/O
function readJSONFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify([]));
      return [];
    }
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data || '[]');
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err);
    return [];
  }
}

function writeJSONFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`Error writing ${filePath}:`, err);
    return false;
  }
}

// Authentication Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

// Auth Endpoints
app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const trimmedUsername = username.trim().toLowerCase();
  if (trimmedUsername.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters long' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long' });
  }

  const users = readJSONFile(USERS_FILE);
  const userExists = users.some(u => u.username.toLowerCase() === trimmedUsername);

  if (userExists) {
    return res.status(400).json({ error: 'Username already exists' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  users.push({ username: trimmedUsername, passwordHash });
  writeJSONFile(USERS_FILE, users);

  res.status(201).json({ message: 'User registered successfully' });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const trimmedUsername = username.trim().toLowerCase();
  const users = readJSONFile(USERS_FILE);
  const user = users.find(u => u.username.toLowerCase() === trimmedUsername);

  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username: user.username });
});

// Steam Store Search Proxy
app.get('/api/search', async (req, res) => {
  const { term } = req.query;

  if (!term || term.trim() === '') {
    return res.json({ total: 0, items: [] });
  }

  try {
    const steamUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`;
    const response = await fetch(steamUrl);
    if (!response.ok) {
      throw new Error(`Steam API responded with status ${response.status}`);
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Error fetching from Steam API:', err);
    res.status(500).json({ error: 'Failed to search Steam games' });
  }
});

// Known fallback game covers to ensure images always render
const KNOWN_COVERS = {
  'detroit': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1222140/header.jpg',
  'ghost of tsushima': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2215430/header.jpg',
  'a way out': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1222700/header.jpg',
  'clair obscur': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1903380/header.jpg',
  'expedition 33': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1903380/header.jpg',
  'uncharted': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1659420/header.jpg',
  'the last of us part ii': 'https://image.api.playstation.com/vulcan/ap/rnd/202311/1717/74087195d733cf621cfad2f3b92d7747e9cb6ab2a343eb89.png',
  'the last of us': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1888930/header.jpg',
  'red dead redemption 2': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1174180/header.jpg',
  'rdr2': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1174180/header.jpg'
};

function enrichGame(game) {
  if (!game) return game;
  let img = game.image;
  if (!img || img.includes('placeholder.com') || img.includes('via.placeholder')) {
    const lower = (game.name || '').toLowerCase();
    for (const [key, url] of Object.entries(KNOWN_COVERS)) {
      if (lower.includes(key)) {
        img = url;
        break;
      }
    }
  }
  return { ...game, image: img || 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1174180/header.jpg' };
}

// Public Share Endpoint (No authentication required - read-only list for sharing)
app.get('/api/public/games/:username', (req, res) => {
  const targetUsername = req.params.username.trim().toLowerCase();
  const games = readJSONFile(GAMES_FILE);
  const userGames = games.filter(g => g.username.toLowerCase() === targetUsername);

  // Sort descending by addedAt
  userGames.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));

  res.json({
    username: req.params.username,
    count: userGames.length,
    games: userGames.map(enrichGame)
  });
});

// Route for share page
app.get('/share/:username', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

app.get('/share', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

// Games CRUD Endpoints (Protected)
app.get('/api/games', authenticateToken, (req, res) => {
  const games = readJSONFile(GAMES_FILE);
  const userGames = games.filter(g => g.username === req.user.username);
  
  // Sort games by added date descending
  userGames.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
  
  res.json(userGames.map(enrichGame));
});

app.post('/api/games', authenticateToken, (req, res) => {
  const { appid, name, image, favoriteCharacter, thoughts, rating, hours, customFields } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Game name is required' });
  }

  const games = readJSONFile(GAMES_FILE);
  
  const newGame = {
    id: crypto.randomUUID(),
    username: req.user.username,
    appid: appid || null,
    name: name.trim(),
    image: image || 'https://via.placeholder.com/460x215.png?text=No+Cover+Image',
    favoriteCharacter: favoriteCharacter ? favoriteCharacter.trim() : '',
    thoughts: thoughts ? thoughts.trim() : '',
    rating: typeof rating === 'number' ? rating : 0,
    hours: typeof hours === 'number' ? hours : 0,
    customFields: customFields || {},
    addedAt: new Date().toISOString()
  };

  games.push(newGame);
  writeJSONFile(GAMES_FILE, games);

  res.status(201).json(newGame);
});

app.put('/api/games/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const { name, image, favoriteCharacter, thoughts, rating, hours, customFields } = req.body;

  const games = readJSONFile(GAMES_FILE);
  const gameIndex = games.findIndex(g => g.id === id && g.username === req.user.username);

  if (gameIndex === -1) {
    return res.status(404).json({ error: 'Game not found or unauthorized' });
  }

  const existingGame = games[gameIndex];
  
  const updatedGame = {
    ...existingGame,
    name: name ? name.trim() : existingGame.name,
    image: image !== undefined ? image : existingGame.image,
    favoriteCharacter: favoriteCharacter !== undefined ? favoriteCharacter.trim() : existingGame.favoriteCharacter,
    thoughts: thoughts !== undefined ? thoughts.trim() : existingGame.thoughts,
    rating: typeof rating === 'number' ? rating : existingGame.rating,
    hours: typeof hours === 'number' ? hours : existingGame.hours,
    customFields: customFields !== undefined ? customFields : existingGame.customFields,
    updatedAt: new Date().toISOString()
  };

  games[gameIndex] = updatedGame;
  writeJSONFile(GAMES_FILE, games);

  res.json(updatedGame);
});

app.delete('/api/games/:id', authenticateToken, (req, res) => {
  const { id } = req.params;

  const games = readJSONFile(GAMES_FILE);
  const gameIndex = games.findIndex(g => g.id === id && g.username === req.user.username);

  if (gameIndex === -1) {
    return res.status(404).json({ error: 'Game not found or unauthorized' });
  }

  games.splice(gameIndex, 1);
  writeJSONFile(GAMES_FILE, games);

  res.json({ message: 'Game deleted successfully' });
});

// Fallback for HTML5 client routing (if any) or simple index service
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server locally (Vercel manages this as a serverless function)
if (!isVercel) {
  app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
  });
}

// Export for Vercel Serverless
module.exports = app;
