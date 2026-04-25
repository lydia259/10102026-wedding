// Shared frontend config for the wedding site.
// Safe to commit — contains no secrets.
window.WEDDING_CONFIG = {
  // Apps Script Web App /exec URL (deployed with "Anyone" access).
  // Public by design: the script itself enforces auth on admin reads.
  ENDPOINT: 'https://script.google.com/macros/s/AKfycbzRmicWWLw6lwv750w63Bo9OOI0YzsVS4kM9PrhBkIC4GRvx7zTywd5vgaFMREZB_ax/exec'
};
