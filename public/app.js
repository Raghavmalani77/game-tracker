// If accessed via /share/:username, automatically redirect to share.html
(function checkShareRedirect() {
  if (window.location.pathname.includes('/share')) {
    const segments = window.location.pathname.split('/').filter(Boolean);
    const shareIdx = segments.indexOf('share');
    const targetUser = (shareIdx !== -1 && segments[shareIdx + 1]) ? segments[shareIdx + 1] : '';
    window.location.replace(`/share.html?user=${encodeURIComponent(targetUser)}`);
  }
})();

// State Management
let token = localStorage.getItem('token') || '';
let username = localStorage.getItem('username') || '';
let gamesList = [];
let currentCustomFields = []; // Array of { key: string, value: string }
let editCustomFields = [];    // Array of { key: string, value: string }
let autocompleteTimeout = null;

// Determine API Base URL dynamically:
// - If deployed on the cloud / internet, or running on local Express (port 3000): use relative ''
// - Only if developing locally on VS Code Live Server (port 5500) or file://: use 'http://localhost:3000'
const isLocalDevProxy = window.location.port === '5500' || window.location.protocol === 'file:';
const API_BASE = isLocalDevProxy ? 'http://localhost:3000' : '';

// API helper functions
async function apiFetch(endpoint, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...options.headers
  };

  try {
    const response = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
    
    // Check if token expired/invalid
    if (response.status === 401 || response.status === 403) {
      if (token) {
        showToast('Session expired. Please log in again.', 'error');
        logout();
      }
      return null;
    }

    // Safely parse JSON or handle unexpected response formats
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (e) {
      throw new Error(`Server returned invalid response: ${text ? text.substring(0, 100) : 'Empty response'}`);
    }

    if (!response.ok) {
      throw new Error(data.error || 'Something went wrong');
    }
    return data;
  } catch (err) {
    let errorMsg = err.message;
    // Provide user-friendly hint if connection is refused
    if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
      errorMsg = "Cannot connect to the Game Tracker server. Please make sure you have run 'node server.js' in your terminal and that the server is active on port 3000.";
    }
    showToast(errorMsg, 'error');
    console.error(err);
    return null;
  }
}

// Toast Notifications
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  
  let bgClass = 'bg-emerald-600';
  let iconClass = 'fa-circle-check';
  if (type === 'error') {
    bgClass = 'bg-rose-600';
    iconClass = 'fa-circle-exclamation';
  } else if (type === 'info') {
    bgClass = 'bg-sky-600';
    iconClass = 'fa-circle-info';
  }

  toast.className = `flex items-center gap-2.5 ${bgClass} text-white text-sm font-semibold px-4 py-3 rounded-xl shadow-2xl transition-all duration-300 transform translate-y-2 opacity-0 max-w-sm break-words`;
  toast.innerHTML = `<i class="fa-solid ${iconClass}"></i> <span>${message}</span>`;
  
  container.appendChild(toast);
  
  // Animate in
  setTimeout(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  }, 10);

  // Remove after 4s (slightly longer to read detailed error messages if any)
  setTimeout(() => {
    toast.classList.add('translate-y-2', 'opacity-0');
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 4000);
}

// View Toggle Routing
function checkAuth() {
  if (token && username) {
    showDashboardView();
  } else {
    showAuthView();
  }
}

function showAuthView() {
  document.getElementById('auth-view').classList.remove('hidden');
  document.getElementById('app-view').classList.add('hidden');
  document.getElementById('login-form').reset();
  document.getElementById('signup-form').reset();
  toggleAuthForm('login');
}

function showDashboardView() {
  document.getElementById('auth-view').classList.add('hidden');
  document.getElementById('app-view').classList.remove('hidden');
  document.getElementById('nav-username').textContent = username;
  fetchGamesList();
}

function logout() {
  token = '';
  username = '';
  localStorage.removeItem('token');
  localStorage.removeItem('username');
  gamesList = [];
  showAuthView();
}

function toggleAuthForm(formType) {
  const loginForm = document.getElementById('login-form');
  const signupForm = document.getElementById('signup-form');
  const subtitle = document.getElementById('auth-subtitle');

  if (formType === 'login') {
    loginForm.classList.remove('hidden');
    signupForm.classList.add('hidden');
    subtitle.textContent = 'Sign in to track your gaming journey';
  } else {
    loginForm.classList.add('hidden');
    signupForm.classList.remove('hidden');
    subtitle.textContent = 'Create a free account to track your games';
  }
}

// Local Storage Persistent Cache Helpers
function getLocalCacheKey() {
  return `cached_games_${username || 'user'}`;
}

function saveGamesToLocalCache(games) {
  try {
    localStorage.setItem(getLocalCacheKey(), JSON.stringify(games));
  } catch (e) {
    console.warn('LocalStorage save failed:', e);
  }
}

function getGamesFromLocalCache() {
  try {
    const raw = localStorage.getItem(getLocalCacheKey());
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

// Fetch Games from Server (with auto-rehydration from local cache if Render spun down)
async function fetchGamesList() {
  const cached = getGamesFromLocalCache();
  if (cached && cached.length > 0) {
    gamesList = cached;
    renderGamesGrid();
  }

  const container = document.getElementById('games-list-container');
  if (gamesList.length === 0) {
    container.innerHTML = `
      <div class="col-span-full py-16 text-center text-slate-500">
        <i class="fa-solid fa-spinner animate-spin text-3xl text-brand-lightBlue"></i>
        <p class="mt-2 text-sm">Loading your games...</p>
      </div>
    `;
  }

  const serverGames = await apiFetch('/api/games');
  if (serverGames) {
    const serverGameNames = new Set(serverGames.map(g => (g.name || '').toLowerCase().trim()));
    const missingOnServer = cached.filter(cg => !serverGameNames.has((cg.name || '').toLowerCase().trim()));

    if (missingOnServer.length > 0) {
      console.log(`Auto-rehydrating server with ${missingOnServer.length} local games...`);
      const syncResult = await apiFetch('/api/games/sync', {
        method: 'POST',
        body: JSON.stringify({ games: missingOnServer })
      });
      if (syncResult && syncResult.games) {
        gamesList = syncResult.games;
      } else {
        gamesList = [...serverGames, ...missingOnServer];
      }
    } else {
      gamesList = serverGames;
    }

    saveGamesToLocalCache(gamesList);
    renderGamesGrid();
  }
}

// Render Games Cards
function renderGamesGrid() {
  const container = document.getElementById('games-list-container');
  const filterInput = document.getElementById('local-search-filter').value.toLowerCase().trim();
  
  const filteredGames = gamesList.filter(g => 
    g.name.toLowerCase().includes(filterInput) || 
    (g.favoriteCharacter && g.favoriteCharacter.toLowerCase().includes(filterInput)) ||
    (g.thoughts && g.thoughts.toLowerCase().includes(filterInput))
  );

  document.getElementById('game-count-badge').textContent = filteredGames.length;

  if (filteredGames.length === 0) {
    container.innerHTML = `
      <div class="col-span-full py-16 text-center text-slate-500 flex flex-col items-center justify-center gap-3">
        <i class="fa-solid fa-cubes text-5xl text-slate-700"></i>
        <div>
          <p class="font-bold text-slate-400 text-lg">${filterInput ? 'No matching games' : 'No games tracked yet'}</p>
          <p class="text-sm text-slate-500 mt-1">${filterInput ? 'Try adjusting your search terms.' : 'Start by searching a game on the left side form!'}</p>
        </div>
      </div>
    `;
    return;
  }

  const KNOWN_COVERS = {
    'detroit': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1222140/header.jpg',
    'ghost of tsushima': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2215430/header.jpg',
    'a way out': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1222700/header.jpg',
    'clair obscur': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1903340/header.jpg',
    'expedition 33': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1903340/header.jpg',
    'uncharted': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1659420/header.jpg',
    'the last of us part ii': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2531310/header.jpg',
    'the last of us 2': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2531310/header.jpg',
    'last of us 2': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2531310/header.jpg',
    'the last of us': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1888930/header.jpg',
    'red dead redemption 2': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1174180/header.jpg',
    'rdr2': 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1174180/header.jpg'
  };

  container.innerHTML = filteredGames.map(game => {
    // Convert custom fields keys/values into HTML snippet
    let customFieldsHtml = '';
    if (game.customFields && Object.keys(game.customFields).length > 0) {
      customFieldsHtml = `
        <div class="mt-2 pt-2 border-t border-slate-800/50 space-y-1">
          ${Object.entries(game.customFields).map(([key, val]) => `
            <div class="text-xs">
              <span class="text-slate-400 font-semibold uppercase tracking-wider">${escapeHtml(key)}:</span>
              <span class="text-slate-200">${escapeHtml(val)}</span>
            </div>
          `).join('')}
        </div>
      `;
    }

    let coverUrl = (game.image && !game.image.includes('placeholder.com') && !game.image.includes('via.placeholder')) ? game.image : '';

    // Fix incorrect Food Truck simulator id if saved
    if (game.name && game.name.toLowerCase().includes('clair obscur') && (!coverUrl || coverUrl.includes('1903380'))) {
      coverUrl = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1903340/header.jpg';
    }
    // Fix TLOU Part 2 PlayStation hotlinked image
    if (game.name && (game.name.toLowerCase().includes('last of us') && (game.name.includes('II') || game.name.includes('2')))) {
      if (!coverUrl || coverUrl.includes('playstation')) {
        coverUrl = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2531310/header.jpg';
      }
    }

    if (!coverUrl) {
      const lower = (game.name || '').toLowerCase();
      for (const [key, url] of Object.entries(KNOWN_COVERS)) {
        if (lower.includes(key)) {
          coverUrl = url;
          break;
        }
      }
    }

    const hasImage = Boolean(coverUrl);
    const imageHtml = hasImage 
      ? `<img src="${coverUrl}" alt="${escapeHtml(game.name)}" class="w-full h-full object-cover group-hover:scale-105 transition duration-500" onerror="this.style.display='none'; this.nextElementSibling.classList.remove('hidden');">
         <div class="w-full h-full bg-gradient-to-br from-slate-800 to-slate-950 flex items-center justify-center text-slate-700 hidden">
           <i class="fa-solid fa-gamepad text-5xl opacity-20 text-brand-lightBlue"></i>
         </div>`
      : `<div class="w-full h-full bg-gradient-to-br from-slate-800 to-slate-950 flex items-center justify-center text-slate-700">
           <i class="fa-solid fa-gamepad text-5xl opacity-20 text-brand-lightBlue"></i>
         </div>`;

    return `
      <div class="bg-slate-900 border border-slate-800/80 rounded-2xl overflow-hidden shadow-lg hover:shadow-2xl hover:border-slate-700/80 transition duration-300 flex flex-col h-full min-h-[340px]">
        <!-- Banner Image (shrink-0 prevents image from collapsing or cutting off) -->
        <div class="relative h-40 shrink-0 w-full bg-slate-950 overflow-hidden group">
          ${imageHtml}
          <div class="absolute inset-0 bg-gradient-to-t from-slate-900 via-slate-900/40 to-transparent"></div>
          
          <!-- Rating Overlay Badge -->
          <div class="absolute top-3 right-3 bg-slate-950/85 backdrop-blur-md border border-brand-lightBlue/30 text-brand-lightBlue text-xs font-black px-2.5 py-1 rounded-full shadow flex items-center gap-1 z-10">
            <i class="fa-solid fa-star text-amber-400"></i> ${game.rating}/10
          </div>

          <!-- Title Overlay (Crisp, high-contrast typography) -->
          <div class="absolute bottom-2.5 left-4 right-4 z-10">
            <h3 class="text-white font-black text-lg line-clamp-2 leading-snug drop-shadow-lg" title="${escapeHtml(game.name)}">
              ${escapeHtml(game.name)}
            </h3>
          </div>
        </div>

        <!-- Details -->
        <div class="p-4 flex-1 flex flex-col justify-between">
          <div class="space-y-2">
            <!-- Row 1 details (Hours and Character) -->
            <div class="flex items-center gap-4 text-xs">
              <span class="flex items-center gap-1.5 text-slate-300">
                <i class="fa-regular fa-clock text-slate-400"></i>
                <strong class="text-slate-200 font-medium">${game.hours || 0} hrs</strong>
              </span>
              ${game.favoriteCharacter ? `
                <span class="flex items-center gap-1.5 text-slate-300 truncate max-w-[60%]">
                  <i class="fa-regular fa-user text-slate-400"></i>
                  <strong class="text-slate-200 font-medium truncate" title="${escapeHtml(game.favoriteCharacter)}">${escapeHtml(game.favoriteCharacter)}</strong>
                </span>
              ` : ''}
            </div>

            <!-- Thoughts -->
            ${game.thoughts ? `
              <p class="text-slate-400 text-xs italic line-clamp-3 leading-relaxed mt-2 p-2 bg-slate-950/40 rounded-lg border border-slate-800/40">
                "${escapeHtml(game.thoughts)}"
              </p>
            ` : ''}

            <!-- Custom fields -->
            ${customFieldsHtml}
          </div>

          <!-- Actions (Align Right - No Steam Links) -->
          <div class="flex items-center justify-end mt-4 pt-3 border-t border-slate-800">
            <div class="flex items-center gap-2">
              <button onclick="openEditModal('${game.id}')" class="text-slate-400 hover:text-white p-1.5 hover:bg-slate-800 rounded-lg transition" title="Edit Game">
                <i class="fa-solid fa-pen text-sm"></i>
              </button>
              <button onclick="deleteGame('${game.id}')" class="text-slate-400 hover:text-red-400 p-1.5 hover:bg-slate-850 rounded-lg transition" title="Delete Game">
                <i class="fa-solid fa-trash-can text-sm"></i>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// Render dynamic custom fields inside forms
function renderCustomFieldsForm(context = 'add') {
  const container = document.getElementById(context === 'add' ? 'custom-fields-container' : 'edit-custom-fields-container');
  const fields = context === 'add' ? currentCustomFields : editCustomFields;
  const noFieldsMsg = document.getElementById('no-custom-fields-msg');

  if (context === 'add') {
    if (fields.length === 0) {
      if (noFieldsMsg) noFieldsMsg.classList.remove('hidden');
    } else {
      if (noFieldsMsg) noFieldsMsg.classList.add('hidden');
    }
  }

  container.innerHTML = fields.map((field, idx) => `
    <div class="flex items-center gap-2 bg-slate-950 p-2 rounded-xl border border-slate-850">
      <div class="flex-1 min-w-0">
        <label class="block text-[10px] font-bold uppercase tracking-wider text-brand-lightBlue truncate mb-0.5">${escapeHtml(field.key)}</label>
        <input type="text" value="${escapeHtml(field.value)}" 
          oninput="updateCustomFieldValue('${context}', ${idx}, this.value)"
          class="w-full bg-transparent border-none p-0 text-white placeholder-slate-600 focus:ring-0 text-xs focus:outline-none" 
          placeholder="Enter value...">
      </div>
      <button type="button" onclick="removeCustomField('${context}', ${idx})" class="text-slate-500 hover:text-red-400 p-1 transition self-center">
        <i class="fa-solid fa-circle-minus"></i>
      </button>
    </div>
  `).join('');

  if (context === 'add' && fields.length === 0) {
    container.innerHTML = `<p id="no-custom-fields-msg" class="text-xs text-slate-500 italic">No custom columns added yet.</p>`;
  }
}

// Modify Custom Fields Arrays
function addCustomField(context = 'add') {
  const key = prompt('Enter custom column name (e.g. "Hardest Boss", "Favorite Weapon", "Finished?"):');
  if (!key) return;
  const trimmedKey = key.trim();
  if (trimmedKey === '') return;

  const fields = context === 'add' ? currentCustomFields : editCustomFields;
  
  // Check if exists
  if (fields.some(f => f.key.toLowerCase() === trimmedKey.toLowerCase())) {
    showToast('Column already exists!', 'error');
    return;
  }

  fields.push({ key: trimmedKey, value: '' });
  renderCustomFieldsForm(context);
}

function removeCustomField(context, idx) {
  const fields = context === 'add' ? currentCustomFields : editCustomFields;
  fields.splice(idx, 1);
  renderCustomFieldsForm(context);
}

function updateCustomFieldValue(context, idx, val) {
  const fields = context === 'add' ? currentCustomFields : editCustomFields;
  fields[idx].value = val;
}

// Autocomplete Dropdown Search
async function searchSteamGames(query) {
  const spinner = document.getElementById('search-spinner');
  const dropdown = document.getElementById('autocomplete-dropdown');

  if (!query || query.trim() === '') {
    dropdown.innerHTML = '';
    dropdown.classList.add('hidden');
    spinner.classList.add('hidden');
    return;
  }

  spinner.classList.remove('hidden');

  try {
    const data = await apiFetch(`/api/search?term=${encodeURIComponent(query)}`);
    if (data && data.items) {
      if (data.items.length === 0) {
        dropdown.innerHTML = `
          <div class="p-3 text-xs text-slate-500 italic">No matches found</div>
        `;
      } else {
        dropdown.innerHTML = data.items.map(item => {
          // Clean capsule image URL (or fallback)
          const tinyImage = item.tiny_image || 'https://via.placeholder.com/120x45.png?text=No+Cover';
          return `
            <div onclick="selectGame('${item.id}', '${escapeQuote(item.name)}', '${escapeQuote(tinyImage)}')" 
              class="flex items-center gap-3 p-2.5 hover:bg-slate-800/80 cursor-pointer border-b border-slate-850/50 last:border-0 transition">
              <img src="${tinyImage}" alt="${escapeHtml(item.name)}" class="w-12 h-6 object-cover rounded border border-slate-800">
              <div class="flex-1 min-w-0">
                <p class="text-sm font-semibold text-white truncate">${escapeHtml(item.name)}</p>
              </div>
            </div>
          `;
        }).join('');
      }
      dropdown.classList.remove('hidden');
    }
  } catch (err) {
    console.error(err);
  } finally {
    spinner.classList.add('hidden');
  }
}

// Select Game from Autocomplete
function selectGame(appid, name, tinyImage) {
  document.getElementById('game-search').value = name;
  document.getElementById('selected-appid').value = appid;
  
  // Construct high-quality header image
  const headerImage = appid 
    ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`
    : tinyImage;
  document.getElementById('selected-image').value = headerImage;

  // Render Selected Game Preview
  document.getElementById('preview-image').src = headerImage;
  document.getElementById('preview-title').textContent = name;
  document.getElementById('selected-game-preview').classList.remove('hidden');

  // Hide Autocomplete dropdown
  const dropdown = document.getElementById('autocomplete-dropdown');
  dropdown.innerHTML = '';
  dropdown.classList.add('hidden');
}

function clearSelectedGame() {
  document.getElementById('selected-appid').value = '';
  document.getElementById('selected-image').value = '';
  document.getElementById('selected-game-preview').classList.add('hidden');
  document.getElementById('game-search').value = '';
}

// Submitting Forms
async function handleAddGameSubmit(e) {
  e.preventDefault();
  
  const name = document.getElementById('game-search').value.trim();
  const appid = document.getElementById('selected-appid').value;
  const image = document.getElementById('selected-image').value;
  const favoriteCharacter = document.getElementById('fav-character').value.trim();
  const hours = parseFloat(document.getElementById('hours-played').value) || 0;
  const rating = parseInt(document.getElementById('game-rating').value) || 0;
  const thoughts = document.getElementById('game-thoughts').value.trim();

  // Convert custom fields array back to key-value object
  const customFields = {};
  currentCustomFields.forEach(f => {
    if (f.key.trim() !== '') {
      customFields[f.key.trim()] = f.value.trim();
    }
  });

  // Optional Hardest Boss Checkbox
  const toggleBoss = document.getElementById('toggle-hardest-boss');
  const bossInput = document.getElementById('hardest-boss-input');
  if (toggleBoss && toggleBoss.checked && bossInput && bossInput.value.trim() !== '') {
    customFields['Hardest Boss'] = bossInput.value.trim();
  }

  const payload = {
    appid,
    name,
    image,
    favoriteCharacter,
    hours,
    rating,
    thoughts,
    customFields
  };

  const newGame = await apiFetch('/api/games', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  if (newGame) {
    showToast(`${name} has been added!`, 'success');
    gamesList.unshift(newGame); // Add to beginning of grid
    saveGamesToLocalCache(gamesList);
    renderGamesGrid();
    
    // Reset Form
    document.getElementById('add-game-form').reset();
    clearSelectedGame();
    if (toggleBoss) toggleBoss.checked = false;
    if (bossInput) bossInput.value = '';
    const bossContainer = document.getElementById('hardest-boss-container');
    if (bossContainer) bossContainer.classList.add('hidden');

    currentCustomFields = [];
    renderCustomFieldsForm('add');
    
    // Reset slider value indicator
    document.getElementById('rating-val').textContent = '10/10';
  }
}

// Edit Modal Interactions
function openEditModal(gameId) {
  const game = gamesList.find(g => g.id === gameId);
  if (!game) return;

  document.getElementById('edit-game-id').value = game.id;
  document.getElementById('edit-game-name').value = game.name;
  document.getElementById('edit-fav-character').value = game.favoriteCharacter || '';
  document.getElementById('edit-hours-played').value = game.hours || '';
  document.getElementById('edit-game-rating').value = game.rating || 10;
  document.getElementById('edit-rating-val').textContent = `${game.rating || 10}/10`;
  document.getElementById('edit-game-thoughts').value = game.thoughts || '';

  // Optional Hardest Boss Checkbox for Edit
  const editToggleBoss = document.getElementById('edit-toggle-hardest-boss');
  const editBossInput = document.getElementById('edit-hardest-boss-input');
  const editBossContainer = document.getElementById('edit-hardest-boss-container');

  if (game.customFields && game.customFields['Hardest Boss']) {
    if (editToggleBoss) editToggleBoss.checked = true;
    if (editBossInput) editBossInput.value = game.customFields['Hardest Boss'];
    if (editBossContainer) editBossContainer.classList.remove('hidden');
  } else {
    if (editToggleBoss) editToggleBoss.checked = false;
    if (editBossInput) editBossInput.value = '';
    if (editBossContainer) editBossContainer.classList.add('hidden');
  }

  // Populates edit custom fields state (excluding Hardest Boss so it doesn't duplicate)
  editCustomFields = [];
  if (game.customFields) {
    Object.entries(game.customFields).forEach(([key, value]) => {
      if (key !== 'Hardest Boss') {
        editCustomFields.push({ key, value });
      }
    });
  }
  
  renderCustomFieldsForm('edit');
  document.getElementById('edit-modal').classList.remove('hidden');
}

function closeEditModal() {
  document.getElementById('edit-modal').classList.add('hidden');
  document.getElementById('edit-game-form').reset();
  const editToggleBoss = document.getElementById('edit-toggle-hardest-boss');
  const editBossInput = document.getElementById('edit-hardest-boss-input');
  const editBossContainer = document.getElementById('edit-hardest-boss-container');
  if (editToggleBoss) editToggleBoss.checked = false;
  if (editBossInput) editBossInput.value = '';
  if (editBossContainer) editBossContainer.classList.add('hidden');
  editCustomFields = [];
}

async function handleEditGameSubmit(e) {
  e.preventDefault();
  
  const id = document.getElementById('edit-game-id').value;
  const name = document.getElementById('edit-game-name').value.trim();
  const favoriteCharacter = document.getElementById('edit-fav-character').value.trim();
  const hours = parseFloat(document.getElementById('edit-hours-played').value) || 0;
  const rating = parseInt(document.getElementById('edit-game-rating').value) || 0;
  const thoughts = document.getElementById('edit-game-thoughts').value.trim();

  const customFields = {};
  editCustomFields.forEach(f => {
    if (f.key.trim() !== '') {
      customFields[f.key.trim()] = f.value.trim();
    }
  });

  // Optional Hardest Boss Checkbox for Edit
  const editToggleBoss = document.getElementById('edit-toggle-hardest-boss');
  const editBossInput = document.getElementById('edit-hardest-boss-input');
  if (editToggleBoss && editToggleBoss.checked && editBossInput && editBossInput.value.trim() !== '') {
    customFields['Hardest Boss'] = editBossInput.value.trim();
  }

  const payload = {
    name,
    favoriteCharacter,
    hours,
    rating,
    thoughts,
    customFields
  };

  const updatedGame = await apiFetch(`/api/games/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });

  if (updatedGame) {
    showToast(`${name} has been updated!`, 'success');
    
    // Update local state list
    const index = gamesList.findIndex(g => g.id === id);
    if (index !== -1) {
      gamesList[index] = updatedGame;
    }
    saveGamesToLocalCache(gamesList);
    renderGamesGrid();
    closeEditModal();
  }
}

// Delete Game Card
async function deleteGame(gameId) {
  const game = gamesList.find(g => g.id === gameId);
  if (!game) return;

  if (confirm(`Are you sure you want to remove ${game.name} from your tracked games?`)) {
    const data = await apiFetch(`/api/games/${gameId}`, {
      method: 'DELETE'
    });

    if (data) {
      showToast(`${game.name} has been deleted.`, 'info');
      gamesList = gamesList.filter(g => g.id !== gameId);
      saveGamesToLocalCache(gamesList);
      renderGamesGrid();
    }
  }
}

// Event Listeners Registration
document.addEventListener('DOMContentLoaded', () => {
  checkAuth();

  // Auth Navigation
  document.getElementById('go-to-signup').addEventListener('click', () => toggleAuthForm('signup'));
  document.getElementById('go-to-login').addEventListener('click', () => toggleAuthForm('login'));

  // Auth Forms submission
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const usernameInput = document.getElementById('login-username').value;
    const passwordInput = document.getElementById('login-password').value;

    const data = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: usernameInput, password: passwordInput })
    });

    if (data && data.token) {
      token = data.token;
      username = data.username;
      localStorage.setItem('token', token);
      localStorage.setItem('username', username);
      showToast(`Welcome back, ${username}!`, 'success');
      showDashboardView();
    }
  });

  document.getElementById('signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const usernameInput = document.getElementById('signup-username').value;
    const passwordInput = document.getElementById('signup-password').value;
    const confirmPasswordInput = document.getElementById('signup-confirm-password').value;

    if (passwordInput !== confirmPasswordInput) {
      showToast('Passwords do not match!', 'error');
      return;
    }

    const data = await apiFetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: usernameInput, password: passwordInput })
    });

    if (data) {
      showToast('Account created successfully! Please sign in.', 'success');
      toggleAuthForm('login');
    }
  });

  // Logout button
  document.getElementById('logout-btn').addEventListener('click', logout);

  // Backup Games button
  const backupBtn = document.getElementById('backup-btn');
  if (backupBtn) {
    backupBtn.addEventListener('click', () => {
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(gamesList, null, 2));
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute("href", dataStr);
      downloadAnchor.setAttribute("download", "games.json");
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
      showToast('Downloaded games.json backup! Keep it safe or commit to GitHub.', 'success');
    });
  }

  // Share List button
  const shareListBtn = document.getElementById('share-list-btn');
  if (shareListBtn) {
    shareListBtn.addEventListener('click', async () => {
      if (!username) return;

      // Construct share URL that works both with Express server and Live Server
      let shareUrl = `${window.location.origin}/share.html?user=${encodeURIComponent(username)}`;
      if (window.location.port === '5500') {
        const basePath = window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/') + 1);
        shareUrl = `${window.location.origin}${basePath}share.html?user=${encodeURIComponent(username)}`;
      }

      try {
        await navigator.clipboard.writeText(shareUrl);
        showToast(`Share link copied to clipboard! Anyone with this link can view your list.`, 'success');
      } catch (e) {
        prompt("Copy your public share link:", shareUrl);
      }
    });
  }

  // Autocomplete Search key listener (with Debouncing)
  document.getElementById('game-search').addEventListener('input', (e) => {
    const query = e.target.value;

    // Reset metadata immediately so custom/manual typing does not inherit previous search matches
    document.getElementById('selected-appid').value = '';
    document.getElementById('selected-image').value = '';
    document.getElementById('selected-game-preview').classList.add('hidden');

    // Clear existing timer
    if (autocompleteTimeout) {
      clearTimeout(autocompleteTimeout);
    }

    // If query is cleared, reset values
    if (query.trim() === '') {
      clearSelectedGame();
      document.getElementById('autocomplete-dropdown').classList.add('hidden');
      return;
    }

    // Set debounce timer
    autocompleteTimeout = setTimeout(() => {
      searchSteamGames(query);
    }, 300);
  });

  // Hide autocomplete when clicking outside
  document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('autocomplete-dropdown');
    const searchInput = document.getElementById('game-search');
    if (e.target !== dropdown && e.target !== searchInput) {
      dropdown.classList.add('hidden');
    }
  });

  // Clear selected preview card button
  document.getElementById('clear-selected-game').addEventListener('click', clearSelectedGame);

  // Hardest Boss Checkbox Toggles
  const toggleBoss = document.getElementById('toggle-hardest-boss');
  if (toggleBoss) {
    toggleBoss.addEventListener('change', (e) => {
      const container = document.getElementById('hardest-boss-container');
      const input = document.getElementById('hardest-boss-input');
      if (e.target.checked) {
        container.classList.remove('hidden');
        if (input) input.focus();
      } else {
        container.classList.add('hidden');
        if (input) input.value = '';
      }
    });
  }

  const editToggleBoss = document.getElementById('edit-toggle-hardest-boss');
  if (editToggleBoss) {
    editToggleBoss.addEventListener('change', (e) => {
      const container = document.getElementById('edit-hardest-boss-container');
      const input = document.getElementById('edit-hardest-boss-input');
      if (e.target.checked) {
        container.classList.remove('hidden');
        if (input) input.focus();
      } else {
        container.classList.add('hidden');
        if (input) input.value = '';
      }
    });
  }

  // Custom Fields Buttons
  document.getElementById('add-custom-field-btn').addEventListener('click', () => addCustomField('add'));
  document.getElementById('edit-add-custom-field-btn').addEventListener('click', () => addCustomField('edit'));

  // Slider Indicators
  const ratingInput = document.getElementById('game-rating');
  ratingInput.addEventListener('input', (e) => {
    document.getElementById('rating-val').textContent = `${e.target.value}/10`;
  });

  const editRatingInput = document.getElementById('edit-game-rating');
  editRatingInput.addEventListener('input', (e) => {
    document.getElementById('edit-rating-val').textContent = `${e.target.value}/10`;
  });

  // Submit Game Logs
  document.getElementById('add-game-form').addEventListener('submit', handleAddGameSubmit);
  document.getElementById('edit-game-form').addEventListener('submit', handleEditGameSubmit);

  // Local List filtering search
  document.getElementById('local-search-filter').addEventListener('input', renderGamesGrid);

  // Close Edit Modal buttons
  document.getElementById('close-edit-modal').addEventListener('click', closeEditModal);
  document.getElementById('cancel-edit-btn').addEventListener('click', closeEditModal);
  
  // Close edit modal on clicking backdrop
  document.getElementById('edit-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('edit-modal')) {
      closeEditModal();
    }
  });
});

// Helper HTML Escapers
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Helper Quote Escapers
function escapeQuote(str) {
  if (!str) return '';
  return str.replace(/'/g, "\\'");
}
