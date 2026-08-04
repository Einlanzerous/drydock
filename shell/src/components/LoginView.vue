<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { authMessage, authMode, authNeedsSetup, signIn } from "../lib/auth.js";

// The door (DRY-27). Rendered INSTEAD of the desk, not over it: a login form on
// top of a live desktop implies the desk behind it is yours to look at, and the
// whole point is that until this succeeds the shell has no idea whose it is.

const emit = defineEmits<{ (e: "signed-in"): void }>();

const name = ref("");
const password = ref("");
const busy = ref(false);
const error = ref<string | null>(null);
const nameEl = ref<HTMLInputElement | null>(null);
const passwordEl = ref<HTMLInputElement | null>(null);

/**
 * One account means one name, and it is host config — so asking for it is a
 * quiz about somebody's `.env`. The field is still THERE (a rename shouldn't
 * lock anybody out) but it starts collapsed behind a link, and the daemon
 * defaults a missing name to the configured owner.
 */
const single = computed(() => authMode.value === "single");
const showName = ref(false);

onMounted(async () => {
  await nextTick();
  (single.value ? passwordEl.value : nameEl.value)?.focus();
});

async function submit() {
  if (busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    await signIn(name.value.trim(), password.value);
    emit("signed-in");
  } catch (e) {
    error.value = String((e as Error).message ?? e);
    // The password is cleared and the field re-focused, the name is not: a
    // mistyped password is the common case and retyping the name for it is the
    // small indignity that makes people shorten their passwords.
    password.value = "";
    await nextTick();
    passwordEl.value?.focus();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="gate">
    <form class="card" @submit.prevent="submit">
      <div class="brand">
        <svg width="34" height="34" viewBox="0 0 48 34" aria-hidden="true">
          <g stroke="#3f5468" stroke-width="1" fill="none" stroke-linecap="round">
            <path d="M5 6 V20 H2 V28 H46 V20 H43 V6" />
            <line x1="2" y1="28" x2="46" y2="28" />
          </g>
          <g fill="#5b7794">
            <rect x="13" y="25" width="3" height="3" />
            <rect x="22" y="25" width="3" height="3" />
            <rect x="31" y="25" width="3" height="3" />
          </g>
          <path fill="#7aa6cc" d="M9 15 L9 21 Q9 25 13 25 L34 25 L41 18 L41 16 L13 16 Z" />
          <path fill="#7aa6cc" d="M19 16 L19 9 L22 9 L22 16 Z M24 16 L24 11 L29 11 L29 16 Z" />
          <line x1="20.5" y1="9" x2="20.5" y2="4" stroke="#7aa6cc" stroke-width="1" />
        </svg>
        <div class="word">
          <span class="name">Drydock</span>
          <span class="tagline">watch the agents work</span>
        </div>
      </div>

      <!-- Multi-user with no account and nothing to seed one from. A password
           box here would be a puzzle with no answer, and it looks exactly like
           a forgotten password — so it says what to do instead. -->
      <p v-if="authNeedsSetup" class="setup">
        This Drydock has no accounts yet. Set <code>DRYDOCK_AUTH_PASSWORD</code> (and optionally
        <code>DRYDOCK_AUTH_USER</code>) in the daemon's environment and restart it — the first
        account is seeded from there.
      </p>

      <template v-else>
        <p v-if="authMessage" class="notice">{{ authMessage }}</p>

        <label v-if="!single || showName" class="field">
          <span>Name</span>
          <input
            ref="nameEl"
            v-model="name"
            autocomplete="username"
            spellcheck="false"
            :disabled="busy"
          />
        </label>

        <label class="field">
          <span>Password</span>
          <input
            ref="passwordEl"
            v-model="password"
            type="password"
            autocomplete="current-password"
            :disabled="busy"
          />
        </label>

        <button v-if="single && !showName" type="button" class="link" @click="showName = true">
          Sign in as a different name
        </button>

        <p v-if="error" class="error">{{ error }}</p>

        <button class="go" type="submit" :disabled="busy || !password">
          {{ busy ? "Signing in…" : "Sign in" }}
        </button>
      </template>
    </form>
  </div>
</template>

<style scoped>
.gate {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0a0c0f;
  color: #d5dde6;
  font-family: system-ui, sans-serif;
}
.card {
  width: 340px;
  max-width: 90%;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 26px 24px 22px;
  background: #13171d;
  border: 1px solid #ffffff1c;
  border-radius: 13px;
  box-shadow: 0 24px 70px #000000aa;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 4px;
}
.word {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
}
.name {
  font-size: 17px;
  font-weight: 600;
  color: #eaf0f6;
}
.tagline {
  font-size: 11px;
  color: #5a636f;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.field span {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #7a8593;
}
.field input {
  background: #0a0c0f;
  border: 1px solid #ffffff12;
  border-radius: 7px;
  padding: 9px 11px;
  color: #d5dde6;
  font-size: 14px;
  font-family: system-ui, sans-serif;
  outline: none;
}
.field input:focus {
  border-color: #2a557d;
}
.go {
  margin-top: 4px;
  padding: 9px 12px;
  border-radius: 7px;
  background: #16314a;
  border: 1px solid #2a557d;
  color: #cfe3f5;
  font-size: 14px;
  cursor: pointer;
}
.go:disabled {
  opacity: 0.5;
  cursor: default;
}
.link {
  align-self: flex-start;
  border: 0;
  background: none;
  padding: 0;
  color: #7fa8cf;
  font-size: 12px;
  cursor: pointer;
}
.error {
  margin: 0;
  padding: 8px 10px;
  border-radius: 7px;
  background: #2a1416;
  color: #f0c9c4;
  font-size: 12.5px;
}
.notice,
.setup {
  margin: 0;
  padding: 8px 10px;
  border-radius: 7px;
  background: #21201a;
  color: #d8c9a3;
  font-size: 12.5px;
  line-height: 1.45;
}
.setup code {
  font-family: "JetBrains Mono", monospace;
  font-size: 11.5px;
  color: #eadfbe;
}
</style>
