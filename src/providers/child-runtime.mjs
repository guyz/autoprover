import process from "node:process";

const PORTABLE_ENVIRONMENT_KEYS = new Set(
  [
    "APPDATA",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "COMSPEC",
    "DBUS_SESSION_BUS_ADDRESS",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "LANG",
    "LC_ADDRESS",
    "LC_ALL",
    "LC_COLLATE",
    "LC_CTYPE",
    "LC_IDENTIFICATION",
    "LC_MEASUREMENT",
    "LC_MESSAGES",
    "LC_MONETARY",
    "LC_NAME",
    "LC_NUMERIC",
    "LC_PAPER",
    "LC_TELEPHONE",
    "LC_TIME",
    "LOCALAPPDATA",
    "LOGNAME",
    "NODE_EXTRA_CA_CERTS",
    "NO_COLOR",
    "PATH",
    "PATHEXT",
    "PWD",
    "SHELL",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "SYSTEMROOT",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "TZ",
    "USER",
    "USERPROFILE",
    "WINDIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "XDG_STATE_HOME",
    "__CF_USER_TEXT_ENCODING",
  ].map((key) => key.toUpperCase()),
);

/**
 * Build the deliberately small environment inherited by subscription-backed
 * model CLIs. Authentication remains available through HOME/CODEX_HOME,
 * CLAUDE_CONFIG_DIR, XDG paths, and the platform keychain. Ambient API keys,
 * cloud credentials, database URLs, shell injection hooks, and unrelated
 * tokens are excluded by construction.
 */
export function buildSubscriptionChildEnvironment(
  baseEnvironment = process.env,
  overrides = {},
) {
  const environment = {};
  for (const [key, value] of Object.entries(baseEnvironment ?? {})) {
    if (value === undefined) continue;
    const normalized = key.toUpperCase();
    if (PORTABLE_ENVIRONMENT_KEYS.has(normalized)) {
      environment[key] = String(value);
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) {
      deleteEnvironmentKey(environment, key);
    } else {
      environment[key] = String(value);
    }
  }
  return environment;
}

/**
 * Terminate a child if the parent is interrupted or exits. Signal handlers
 * re-raise the original signal after synchronous cleanup so normal CLI exit
 * semantics are preserved.
 */
export function registerChildProcessCleanup(
  cleanup,
  {
    processRef = process,
    signals = ["SIGINT", "SIGTERM"],
    reraise = true,
  } = {},
) {
  let active = true;
  const listeners = new Map();

  const runCleanup = (signal) => {
    if (!active) return;
    active = false;
    unregister();
    try {
      cleanup(signal);
    } catch {
      // Parent shutdown must continue even if the child already disappeared.
    }
  };

  const exitListener = () => runCleanup("SIGTERM");
  processRef.once("exit", exitListener);

  for (const signal of signals) {
    const listener = () => {
      runCleanup(signal);
      if (reraise) {
        try {
          processRef.kill(processRef.pid, signal);
        } catch {
          // The process is already exiting or the test double cannot re-signal.
        }
      }
    };
    listeners.set(signal, listener);
    processRef.once(signal, listener);
  }

  function unregister() {
    processRef.removeListener("exit", exitListener);
    for (const [signal, listener] of listeners) {
      processRef.removeListener(signal, listener);
    }
  }

  return () => {
    if (!active) return;
    active = false;
    unregister();
  };
}

export function settleWithin(promise, timeoutMs, message) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function deleteEnvironmentKey(environment, target) {
  const normalizedTarget = target.toUpperCase();
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() === normalizedTarget) delete environment[key];
  }
}
