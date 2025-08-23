// Configuration loader - fetches config from server
let CONFIG = null;

async function loadConfig() {
  if (CONFIG) return CONFIG;
  
  try {
    const response = await fetch('/api/config');
    CONFIG = await response.json();
    return CONFIG;
  } catch (error) {
    console.error('Failed to load configuration:', error);
    // Fallback - should not be used in production
    CONFIG = {
      googleApiKey: null,
      googleClientId: null,
      apiUrl: window.location.hostname === 'localhost' ? 'http://localhost:4000' : ''
    };
    console.error('Failed to load server config - Google Drive features will not work');
    return CONFIG;
  }
}

// Helper function to get config values
async function getConfig() {
  return await loadConfig();
}
