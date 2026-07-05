// Runtime daemon endpoint config — loaded by index.html before the app bundle.
// This checked-in copy is the DEV default (empty ⇒ same host as the page, port
// 4317). The prod image overwrites it at container start from DRYDOCK_DAEMON_URL
// / DRYDOCK_DAEMON_PORT (see shell/docker/20-drydock-config.sh), which is how
// one GHCR image serves any deployment without baking URLs in at build time.
window.__DRYDOCK__ = {};
