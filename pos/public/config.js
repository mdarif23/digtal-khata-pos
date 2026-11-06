// Runtime configuration for the ezPos POS SPA (multi-terminal Phase 2).
// CLOUD deployments: leave as-is. LAN deployments: edit apiUrl to the
// local server, e.g. window.ezposConfig = { apiUrl: "http://192.168.1.10:8080/api" };
// This file is served same-origin and loaded before the app bundle, so a
// LAN server works without rebuilding the frontend.
window.ezposConfig = window.ezposConfig || {};
