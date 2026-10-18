// UI wiring for the sign-in helper page. See login.js for the protocol.

import {
  HANDLER_SCHEME,
  PENDING_TTL_MS,
  codeFromTokenLink,
  moodleLaunchUrl,
  parseStartParams,
} from "./login.js";

const STORAGE_KEY = "moodle-student-mcp.pending";

const STRINGS = {
  pt: {
    startTitle: "Entrar no Moodle",
    startIntro: "Seu assistente de IA quer se conectar a",
    startHow: "Entre lá normalmente. No final, esta página mostra um código para você colar de volta no chat.",
    continue: "Continuar para o Moodle",
    handlerNote: "Se o navegador perguntar se esta página pode abrir links “web+moodlestudent”, permita: assim o código aparece sozinho.",
    fallback: "Ainda sem código? Na página do Moodle, clique com o botão direito (ou toque e segure) em “Clique aqui para abrir o aplicativo”, copie o link e cole aqui:",
    getCode: "Gerar código",
    doneTitle: "Quase lá",
    doneIntro: "Copie este código e cole no chat com o seu assistente de IA:",
    copy: "Copiar código",
    copied: "Copiado",
    doneNote: "O código é criptografado para a sessão do seu assistente e expira em 15 minutos. Ele não é a sua senha e não serve para mais ninguém.",
    idleTitle: "Assistente de login do Moodle",
    idleIntro: "Esta página faz o login no Moodle para o moodle-student-mcp. Abra-a pelo link que o seu assistente de IA enviou.",
    errorTitle: "Algo deu errado",
    badLink: "Isso não parece um link do Moodle. Ele deve começar com “moodlemobile://token=” ou “web+moodlestudent://token=”.",
    noPending: "Não há login em andamento neste navegador (ou ele expirou). Volte ao seu assistente e peça um novo link.",
    badStart: "O link de login está incompleto. Volte ao seu assistente e peça um novo link.",
  },
};

const lang = (navigator.language || "en").slice(0, 2).toLowerCase();
const t = (key, fallback) => STRINGS[lang]?.[key] ?? fallback;

function localize() {
  if (!STRINGS[lang]) return;
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll("[data-i18n]")) {
    const text = STRINGS[lang][el.dataset.i18n];
    if (text) el.textContent = text;
  }
}

const $ = (id) => document.getElementById(id);

function show(id) {
  for (const section of ["start", "done", "idle", "error"]) $(section).hidden = section !== id;
}

function fail(message) {
  $("errorText").textContent = message;
  show("error");
}

function loadPending() {
  try {
    const pending = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (pending && Date.now() - pending.savedAt < PENDING_TTL_MS) return pending;
  } catch {
    // Storage blocked or corrupt.
  }
  return null;
}

function savePending(pending) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
  } catch {
    // Without storage the automatic hand-off cannot work; the paste fallback on this tab still does.
  }
}

function clearPending() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore.
  }
}

async function showCode(link, pending) {
  const code = await codeFromTokenLink(link, pending);
  if (!code) return false;
  clearPending();
  $("code").textContent = code;
  show("done");
  return true;
}

function renderStart(pending, { resumed = false } = {}) {
  $("site").textContent = pending.site;
  // Coming back to this page mid-login: offer the paste box right away.
  $("fallback").hidden = !resumed;
  show("start");

  $("go").addEventListener("click", () => {
    try {
      navigator.registerProtocolHandler?.(HANDLER_SCHEME, `${location.origin}${location.pathname}#callback=%s`);
    } catch {
      // Unsupported (Safari, mobile): the paste fallback covers it.
    }
    window.open(moodleLaunchUrl(pending.site, pending.passport), "_blank", "noopener");
    $("fallback").hidden = false;
  });

  $("make").addEventListener("click", async () => {
    const ok = await showCode($("link").value, pending);
    $("linkError").hidden = ok;
    if (!ok) $("linkError").textContent = t("badLink", "That does not look like the Moodle link. It should start with “moodlemobile://token=” or “web+moodlestudent://token=”.");
  });
}

$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("code").textContent);
    $("copied").hidden = false;
  } catch {
    getSelection()?.selectAllChildren($("code"));
  }
});

async function main() {
  localize();
  const params = new URLSearchParams(location.hash.slice(1));
  // Drop secrets and keys from the address bar and this tab's history.
  if (location.hash) history.replaceState(null, "", location.pathname);

  if (params.has("callback")) {
    const pending = loadPending();
    if (!pending) return fail(t("noPending", "There is no sign-in in progress in this browser (or it expired). Go back to your assistant and ask for a new link."));
    if (!(await showCode(params.get("callback"), pending))) return fail(t("badLink", "That does not look like the Moodle link."));
    return;
  }

  if (params.has("pk")) {
    const start = parseStartParams(params);
    if (!start) return fail(t("badStart", "The sign-in link is incomplete. Go back to your assistant and ask for a new link."));
    const pending = { ...start, savedAt: Date.now() };
    savePending(pending);
    return renderStart(pending);
  }

  const pending = loadPending();
  if (pending) return renderStart(pending, { resumed: true });
  show("idle");
}

main().catch((error) => fail(String(error?.message ?? error)));
