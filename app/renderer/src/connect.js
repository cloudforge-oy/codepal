// cloudcode.one connection: the portal flow first, a pasted token as fallback.
import { $ } from "./util.js";

const BANNER_TEXT = {
  disconnected: "Not connected to cloudcode.one — requests to the gateway will fail. Click here to connect.",
  rejected: "Your cloudcode.one key was rejected — it may have been rotated or revoked. Click here to reconnect.",
};

const TOKEN_TEXT = {
  disconnected: "No gateway key was found. Approve CodePal in the cloudcode.one portal to fetch your API key automatically.",
  rejected: "The stored key was rejected — if it was rotated or revoked, reconnect to fetch a fresh one, or forget it and paste a new one.",
  connected: "CodePal has a key for cloudcode.one. Reconnect to replace it with a fresh one, or forget it to disconnect.",
};

const PORTAL_ERRORS = {
  access_denied: "The request was denied in the browser. Try again when you're ready.",
  no_active_key: "No active API key on your account — subscribe or buy credits on the dashboard, then retry.",
  timeout: "Timed out waiting for approval (codes expire after 5 minutes). Try again.",
  network_error: "Couldn't reach the portal — check your connection and try again.",
};

export function createConnect({ api, onConnected, onNotice, onClose }) {
  const banner = $("token-banner");
  const overlay = $("token-overlay");
  const tokenInput = $("token-input");
  const connectBtn = $("portal-connect");
  const portalStatus = $("portal-status");
  const portalError = $("portal-error");
  const dashboardBtn = $("portal-dashboard");
  const forgetBtn = $("token-forget");
  const tokenText = $("token-text");

  const state = { hasToken: false, rejected: false, busy: false };

  function render() {
    let kind = "connected";
    if (!state.hasToken) kind = "disconnected";
    else if (state.rejected) kind = "rejected";
    banner.classList.toggle("hidden", kind === "connected");
    banner.classList.toggle("danger", kind === "rejected");
    if (kind !== "connected") banner.textContent = BANNER_TEXT[kind];
    tokenText.textContent = TOKEN_TEXT[kind];
    connectBtn.textContent = state.hasToken ? "Reconnect with cloudcode.one" : "Connect with cloudcode.one";
    forgetBtn.classList.toggle("hidden", !state.hasToken);
  }

  function open() {
    overlay.classList.remove("hidden");
    connectBtn.focus();
  }

  function close() {
    if (state.busy) api.portalCancel();
    overlay.classList.add("hidden");
    onClose();
  }

  function setBusy(busy) {
    state.busy = busy;
    connectBtn.disabled = busy;
    portalStatus.classList.toggle("hidden", !busy);
    if (busy) {
      portalError.classList.add("hidden");
      dashboardBtn.classList.add("hidden");
    }
  }

  async function portalConnect() {
    if (state.busy) return;
    setBusy(true);
    const res = await api.portalConnect();
    setBusy(false);
    if (res.ok) {
      state.hasToken = true;
      state.rejected = false;
      render();
      close();
      onConnected();
      return;
    }
    if (res.error === "cancelled") return;
    portalError.textContent = PORTAL_ERRORS[res.error] ?? res.message ?? "Something went wrong — try again.";
    portalError.classList.remove("hidden");
    dashboardBtn.classList.toggle("hidden", res.error !== "no_active_key");
  }

  async function saveToken() {
    const value = tokenInput.value.trim();
    if (!value) return;
    const { hasToken } = await api.setToken(value);
    tokenInput.value = "";
    state.hasToken = hasToken;
    state.rejected = false;
    render();
    close();
    if (hasToken) onConnected();
  }

  async function forget() {
    const res = await api.clearToken();
    state.hasToken = res.hasToken;
    state.rejected = false;
    render();
    onConnected(); // refresh the (now empty) balance
    tokenInput.value = "";
    tokenInput.focus();
    if (res.envTokenReturnsOnRestart) {
      onNotice("Key cleared for this run — CLOUDCODE_TOKEN is set in your environment, so it returns on the next launch.");
    }
  }

  connectBtn.addEventListener("click", portalConnect);
  $("portal-cancel").addEventListener("click", () => api.portalCancel());
  dashboardBtn.addEventListener("click", () => api.openDashboard());
  $("token-save").addEventListener("click", saveToken);
  $("token-skip").addEventListener("click", close);
  forgetBtn.addEventListener("click", forget);
  banner.addEventListener("click", open);
  $("account-btn").addEventListener("click", open);
  tokenInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveToken();
    if (e.key === "Escape") close();
  });
  overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  return {
    open,
    init(hasToken) {
      state.hasToken = hasToken;
      render();
      if (!hasToken) open();
    },
    setRejected(rejected) {
      if (state.rejected === rejected) return;
      state.rejected = rejected;
      render();
    },
    get hasToken() { return state.hasToken; },
  };
}
