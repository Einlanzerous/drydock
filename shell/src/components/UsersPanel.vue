<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import {
  authUser,
  changePassword,
  createAccount,
  listAccounts,
  removeAccount,
  type AccountRow,
} from "../lib/auth.js";

// Managing accounts (DRY-27), on the tier that can have more than one.
//
// Flat by design — the ticket's own non-goal list rules out roles — so anybody
// signed in can ADD or REMOVE anybody. That is honest rather than lax: every
// account here can already spawn a process as the host user, so a permission
// system over this list would be guarding the shed beside an open house.
//
// Setting a password is the one thing that is NOT flat, and the line is worth
// stating: removal ends somebody's access and they notice. Changing their
// password takes it over — their desk, their history, their agents' transcripts
// — and they find out when they can't sign in. The daemon refuses it; this
// panel doesn't offer it.

const emit = defineEmits<{ (e: "close"): void }>();

const rows = ref<AccountRow[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const busy = ref(false);

const newName = ref("");
const newPassword = ref("");
const nameEl = ref<HTMLInputElement | null>(null);

/**
 * The change-password row, which is only ever YOUR OWN.
 *
 * The daemon refuses to set another account's password — that is silent
 * takeover, not the "add or remove" this panel is for — so offering the control
 * on somebody else's row would be a button that exists to report an error.
 * Removing them is the way to end their access, and a removal is something they
 * notice.
 */
const changing = ref<string | null>(null);
const changed = ref("");
const current = ref("");

const me = computed(() => authUser.value?.id);

onMounted(async () => {
  await refresh();
  await nextTick();
  nameEl.value?.focus();
});

async function refresh() {
  loading.value = true;
  try {
    rows.value = await listAccounts();
    error.value = null;
  } catch (e) {
    // Kept on screen rather than closing the panel: the usual cause is the
    // accounts store being briefly unreachable, and a panel that vanishes on a
    // blip reads as the feature being broken.
    error.value = String((e as Error).message ?? e);
  } finally {
    loading.value = false;
  }
}

async function run(work: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    await work();
    await refresh();
  } catch (e) {
    error.value = String((e as Error).message ?? e);
  } finally {
    busy.value = false;
  }
}

const add = () =>
  run(async () => {
    await createAccount(newName.value.trim(), newPassword.value);
    newName.value = "";
    newPassword.value = "";
  });

function remove(row: AccountRow) {
  // The one destructive control here, and the only confirmation in the panel.
  // Their desk and their session history survive — the daemon deliberately
  // leaves those rows — so this ends access rather than deleting work, and the
  // wording says so.
  if (!window.confirm(`Remove the account "${row.name}"? Their saved desk is kept.`)) return;
  void run(() => removeAccount(row.id));
}

const setPassword = (row: AccountRow) =>
  run(async () => {
    // Signs this browser out on success — the token's epoch moved with the
    // password — so there is nothing to refresh afterwards.
    await changePassword(row.id, current.value, changed.value);
    changing.value = null;
    changed.value = "";
    current.value = "";
  });
</script>

<template>
  <div class="scrim" @click.self="emit('close')">
    <div class="panel">
      <header>
        <span class="title">Accounts</span>
        <button class="x" title="Close" @click="emit('close')">✕</button>
      </header>

      <p v-if="error" class="error">{{ error }}</p>

      <div v-if="loading" class="muted">Loading…</div>

      <ul v-else class="rows">
        <li v-for="row in rows" :key="row.id">
          <div class="row">
            <span class="who">
              {{ row.name }}
              <span v-if="row.id === me" class="you">you</span>
            </span>
            <div class="acts">
              <button
                v-if="row.id === me"
                @click="changing = changing === row.id ? null : row.id; changed = ''; current = ''"
              >
                Password
              </button>
              <button
                class="danger"
                :disabled="row.id === me || rows.length < 2"
                :title="row.id === me ? 'You cannot remove the account you are signed in as' : ''"
                @click="remove(row)"
              >
                Remove
              </button>
            </div>
          </div>
          <form v-if="changing === row.id" class="inline" @submit.prevent="setPassword(row)">
            <input
              v-model="current"
              type="password"
              placeholder="Current password"
              autocomplete="current-password"
            />
            <input
              v-model="changed"
              type="password"
              placeholder="New password"
              autocomplete="new-password"
            />
            <!-- Said out loud because it is surprising: changing a password
                 moves the token epoch, so every browser signed in as this
                 account is signed out — including this one. -->
            <span class="hint">Signs you out everywhere</span>
            <button type="submit" :disabled="busy || !current || changed.length < 8">Set</button>
          </form>
        </li>
      </ul>

      <form class="add" @submit.prevent="add">
        <input ref="nameEl" v-model="newName" placeholder="New account name" spellcheck="false" />
        <input
          v-model="newPassword"
          type="password"
          placeholder="Password"
          autocomplete="new-password"
        />
        <button type="submit" :disabled="busy || !newName.trim() || newPassword.length < 8">
          Add
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: absolute;
  inset: 0;
  background: #060709b3;
  backdrop-filter: blur(3px);
  display: flex;
  justify-content: center;
  padding-top: 96px;
  z-index: 10000;
}
.panel {
  width: 460px;
  max-width: 90%;
  height: max-content;
  background: #13171d;
  border: 1px solid #ffffff1c;
  border-radius: 13px;
  box-shadow: 0 24px 70px #000000aa;
  overflow: hidden;
  font-family: system-ui, sans-serif;
  color: #d5dde6;
}
header {
  display: flex;
  align-items: center;
  padding: 13px 15px;
  border-bottom: 1px solid #ffffff10;
}
.title {
  flex: 1;
  font-size: 14px;
  color: #eaf0f6;
}
.x {
  border: 0;
  background: none;
  color: #7a8593;
  cursor: pointer;
  font-size: 13px;
}
.rows {
  list-style: none;
  margin: 0;
  padding: 6px 0;
}
.rows li {
  padding: 4px 15px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 0;
}
.who {
  flex: 1;
  font-size: 13.5px;
}
.you {
  margin-left: 7px;
  padding: 1px 6px;
  border-radius: 999px;
  background: #1d2a38;
  color: #9dc0e0;
  font-size: 10.5px;
}
.acts {
  display: flex;
  gap: 6px;
}
button {
  padding: 4px 9px;
  border-radius: 6px;
  background: #13171c;
  border: 1px solid #ffffff14;
  color: #b9c3cf;
  font-size: 12px;
  cursor: pointer;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
.danger:not(:disabled) {
  color: #f0c9c4;
}
.inline,
.add {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 0 8px;
}
.add {
  padding: 11px 15px 14px;
  border-top: 1px solid #ffffff10;
}
input {
  flex: 1;
  min-width: 0;
  background: #0a0c0f;
  border: 1px solid #ffffff12;
  border-radius: 6px;
  padding: 6px 9px;
  color: #d5dde6;
  font-size: 12.5px;
  font-family: system-ui, sans-serif;
  outline: none;
}
input:focus {
  border-color: #2a557d;
}
.hint {
  font-size: 11px;
  color: #5a636f;
  white-space: nowrap;
}
.muted {
  padding: 14px 15px;
  color: #5a636f;
  font-size: 13px;
}
.error {
  margin: 10px 15px 0;
  padding: 8px 10px;
  border-radius: 7px;
  background: #2a1416;
  color: #f0c9c4;
  font-size: 12.5px;
}
</style>
